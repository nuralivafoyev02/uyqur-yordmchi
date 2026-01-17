const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = 7894854944;

// === /tasks va /report uchun sozlamalar ===
// Mas'ul shaxslar (comma-separated): "789...,123...". Default: ADMIN_ID
const TASK_PLANNERS = (process.env.TASK_PLANNERS || String(ADMIN_ID))
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n));

// Report qaysi Telegram ID'ga yuboriladi (rahbar). Default: ADMIN_ID (xavfsiz fallback)
const BOSS_ID = (() => {
    const v = process.env.BOSS_ID || process.env.MANAGER_ID;
    const n = v ? parseInt(String(v), 10) : NaN;
    return Number.isFinite(n) ? n : ADMIN_ID;
})();

// WebApp URL (fix: avoid https://https://...)
const WEB_APP_URL = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://uyqur-yordmchi.vercel.app';

// Optional: ClickUp status mapping (some workspaces use custom status names)
const CLICKUP_STATUS_PROCESS = process.env.CLICKUP_STATUS_PROCESS || 'in progress';
const CLICKUP_STATUS_DONE = process.env.CLICKUP_STATUS_DONE || 'closed';

// ClickUp API Helper
const clickupRequest = async (endpoint, method = 'GET', body = null) => {
    const url = `https://api.clickup.com/api/v2/${endpoint}`;

    const res = await fetch(url, {
        method,
        headers: {
            'Authorization': process.env.CLICKUP_TOKEN,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });

    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }

    if (!res.ok) {
        const msg = (data && typeof data === 'object' && (data.err || data.error || data.message))
            ? (data.err || data.error || data.message)
            : 'Unknown error';
        const err = new Error(`ClickUp API error ${res.status}: ${msg}`);
        err.status = res.status;
        err.response = data;
        throw err;
    }

    return data;
};

// --- Webhook signature helpers (optional, strict mode via env) ---
const getHeader = (req, name) => {
    const key = name.toLowerCase();
    return req?.headers?.[key] || req?.headers?.[name] || null;
};

const verifyClickUpSignature = (req) => {
    const secret = process.env.CLICKUP_WEBHOOK_SECRET;
    const strict = process.env.CLICKUP_WEBHOOK_VERIFY === 'true';
    if (!secret) return true; // backwards-compatible

    const signature = getHeader(req, 'x-signature');
    if (!signature) return !strict;

    // Prefer raw body if your platform provides it
    const raw = (req && (req.rawBody || req.bodyRaw))
        ? (Buffer.isBuffer(req.rawBody || req.bodyRaw)
            ? (req.rawBody || req.bodyRaw).toString('utf8')
            : String(req.rawBody || req.bodyRaw))
        : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (signature.length !== expected.length) return !strict;

    try {
        const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
        // If strict mode is OFF, don't block production traffic on signature mismatches.
        // Enable strict mode by setting CLICKUP_WEBHOOK_VERIFY=true.
        if (!isValid && !strict) return true;
        return isValid;
    } catch {
        return !strict;
    }
};

const verifyTelegramSecret = (req) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const strict = process.env.TELEGRAM_WEBHOOK_VERIFY === 'true';
    if (!secret) return true; // backwards-compatible

    const token = getHeader(req, 'x-telegram-bot-api-secret-token');
    if (!token) return !strict;
    return token === secret;
};

const escapeHTML = (str) => {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

// --- CLICKUP WEBHOOK HANDLER (ASOSIY QISM) ---
// Kutish funksiyasi
const delay = ms => new Promise(res => setTimeout(res, ms));

async function handleClickUpWebhook(req) {
    const { event, task_id } = req.body;

    // Faqat task yaratilganda yoki update bo‘lganda
    // (taskAssigneeUpdated ham qo'llab-quvvatlanadi, agar webhook shu event'ni yuborsa)
    if (event !== 'taskCreated' && event !== 'taskUpdated' && event !== 'taskAssigneeUpdated') {
        return;
    }
    // 🔄 Task data'ni olib kelamiz
    let task;
    for (let i = 0; i < 3; i++) {
        try {
            task = await clickupRequest(`task/${task_id}`);
        } catch (err) {
            console.error(`❌ ClickUp task fetch error (${task_id}):`, err?.message || err);
            return;
        }
        if (task?.assignees?.length) break;
        await new Promise(r => setTimeout(r, 800));
    }

    if (!task?.assignees?.length) {
        console.log('⚠️ Assignee topilmadi');
        return;
    }

    for (const assignee of task.assignees) {
        const { data: userMap } = await supabase
            .from('users_mapping')
            .select('telegram_id')
            .eq('clickup_user_id', assignee.id)
            .single();

        if (!userMap) continue;

        // ✅ Per-assignee lock (task_id + assignee_id) — bu bug'ni tuzatadi
        // Task keyinroq biriktirilsa ham, yangi assignee xabar oladi.
        const lockKey = `${task_id}:${assignee.id}`;
        const { error: lockError } = await supabase
            .from('clickup_notifications')
            .insert([{ task_id: lockKey }]);

        // Agar oldin yuborilgan bo‘lsa → duplicate
        if (lockError) {
            console.log(`⛔ Duplicate notify (lock bor): ${lockKey}`);
            continue;
        }

        const text =
            `📌 <b>Yangi vazifa biriktirildi:</b>\n\n` +
            `<b>Nomi:</b> ${escapeHTML(task.name)}\n` +
            `<b>Status:</b> ${task.status.status.toUpperCase()}\n\n` +
            `<a href="${task.url}">ClickUp'da ochish</a>`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("🚀 Jarayonda", `cu_status_process_${task_id}`)],
            [Markup.button.callback("✅ Yakunlash", `cu_status_done_${task_id}`)]
        ]);

        try {
            await bot.telegram.sendMessage(
                userMap.telegram_id,
                text,
                { parse_mode: 'HTML', ...keyboard }
            );
            console.log(`✅ Task ${task_id} → TG ${userMap.telegram_id}`);
        } catch (err) {
            console.error(`❌ Telegram send error (task ${task_id}):`, err?.message || err);
        }
    }
}


// --- TELEGRAM COMMANDS ---
// Faqat admin ishlata oladigan komanda - foydalanuvchilarni bog'lash
bot.command('bind', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("Siz admin emassiz!");

    // Format: /bind [TG_ID] [ClickUp_ID] [Ism]
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 3) return ctx.reply("Xato! Format: /bind TG_ID ClickUp_ID Ism");

    const [tg_id, cu_id, ...nameParts] = args;
    const fullName = nameParts.join(' ');

    const { error } = await supabase
        .from('users_mapping')
        .upsert({
            telegram_id: parseInt(tg_id),
            clickup_user_id: parseInt(cu_id),
            full_name: fullName
        });

    if (error) {
        ctx.reply(`Xato: ${error.message}`);
    } else {
        ctx.reply(`✅ ${fullName} muvaffaqiyatli bog'landi!`);
    }
});
// =========================
// 📣 ADMIN BROADCAST: /message
// =========================
// Ishlatish:
// 1) /message Salom hammaga! Bugun soat 18:00 da yig'ilish bo'ladi.
// 2) Biror xabarga reply qilib, keyin /message yozsangiz — o'sha xabar hamma user'ga nusxa bo'lib ketadi.
// (copyMessage ishlatiladi, forward belgisisiz.)

// Helper: column bo'yicha barcha satrlarni (pagination bilan) olib kelish
const fetchAllColumn = async (table, column, pageSize = 1000) => {
    let from = 0;
    const rows = [];

    while (true) {
        const { data, error } = await supabase
            .from(table)
            .select(column)
            .range(from, from + pageSize - 1);

        if (error) {
            console.error(`❌ Supabase fetch error (${table}.${column}):`, error.message);
            break;
        }
        if (!data || data.length === 0) break;

        rows.push(...data)

        if (data.length < pageSize) break;
        from += pageSize;
    }

    return rows;
};

const getBroadcastRecipients = async () => {
    const ids = new Set();

    // 1) users_mapping.telegram_id
    try {
        const maps = await fetchAllColumn('users_mapping', 'telegram_id');
        for (const row of maps) {
            const n = parseInt(String(row.telegram_id), 10);
            if (Number.isFinite(n)) ids.add(n);
        }
    } catch (e) {
        console.error('❌ users_mapping fetch failed:', e?.message || e);
    }

    // 2) reports.user_id (botga yozgan userlar ham kirsin)
    try {
        const reps = await fetchAllColumn('reports', 'user_id');
        for (const row of reps) {
            const n = parseInt(String(row.user_id), 10);
            if (Number.isFinite(n)) ids.add(n);
        }
    } catch (e) {
        console.error('❌ reports fetch failed:', e?.message || e);
    }

    return [...ids];
};

// Serverless timeoutga tushmaslik uchun limit (default 500). Kerak bo'lsa env bilan oshirasiz.
const BROADCAST_MAX = (() => {
    const n = parseInt(process.env.BROADCAST_MAX || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 500;
})();

// Telegram rate limit uchun delay (default 40ms ~ 25 msg/sec)
const BROADCAST_DELAY_MS = (() => {
    const n = parseInt(process.env.BROADCAST_DELAY_MS || '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 40;
})();

bot.command('message', async (ctx) => {
    try {
        if (ctx.from.id !== ADMIN_ID) return ctx.reply('Siz admin emassiz!');

        const reply = ctx.message.reply_to_message;
        const text = ctx.message.text.split(' ').slice(1).join(' ').trim();

        if (!reply && !text) {
            return ctx.reply(
                "Xato! Format:\n/message <matn>\n\nYoki biror xabarga reply qilib /message yozing."
            );
        }

        const recipients = await getBroadcastRecipients();
        if (!recipients.length) {
            return ctx.reply("Hozircha foydalanuvchilar topilmadi (users_mapping/reports bo'sh).\n/bind orqali xodimlarni bog'laganingizga ishonch hosil qiling.");
        }

        const targets = recipients.slice(0, BROADCAST_MAX);
        if (recipients.length > BROADCAST_MAX) {
            await ctx.reply(`⚠️ Juda ko'p user bor: ${recipients.length} ta. Hozir ${BROADCAST_MAX} ta user'ga yuboraman. (BROADCAST_MAX bilan oshirish mumkin)`);
        }

        const startMsg = await ctx.reply(`📣 Yuborilyapti... (${targets.length} ta foydalanuvchi)`);

        let ok = 0;
        let fail = 0;

        for (const userId of targets) {
            try {
                if (reply) {
                    await ctx.telegram.copyMessage(userId, ctx.chat.id, reply.message_id);
                } else {
                    await ctx.telegram.sendMessage(userId, text, { disable_web_page_preview: true });
                }
                ok += 1;
            } catch (e) {
                fail += 1;
                const msg = e?.response?.description || e?.message || String(e);
                console.warn(`⚠️ Broadcast send failed → ${userId}: ${msg}`);
            }

            if (BROADCAST_DELAY_MS) {
                await delay(BROADCAST_DELAY_MS);
            }
        }

        const doneText = `✅ Broadcast tugadi.\n\nYuborildi: ${ok}\nXato: ${fail}`;
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, startMsg.message_id, undefined, doneText);
        } catch {
            await ctx.reply(doneText);
        }

    } catch (err) {
        console.error('Broadcast command error:', err);
        await ctx.reply("Xatolik: broadcast yuborishda muammo bo'ldi.");
    }
});

bot.start(async (ctx) => {
    const welcome = `Assalomu alaykum, <b>${escapeHTML(ctx.from.first_name)}</b>!\n\n` +
        `Men sizning ish hisobotlaringizni yig'ish va ClickUp vazifalaringizni boshqarishda yordam beraman.\n\n` +
        `📖 Buyruqlar va yordam: /help`;
    await ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.help(async (ctx) => {
    const helpText = `🛠 <b>Bot buyruqlari:</b>\n\n` +
        `/send - Saqlangan barcha ishlarni ko'rish va guruhga yuborish\n` +
        `/tasks - Ertangi vazifalarni tayyorlash (mas'ul shaxs)\n` +
        `/report - Ertangi vazifalarni rahbarga yuborish (tasdiqlash bilan)\n\n` +
        `✍️ <b>Matn yozing</b> - Ishlaringizni botga oddiy xabar sifatida yuborsangiz, ular hisobotga qo'shiladi.\n` +
        `📌 <b>ClickUp</b> - Sizga biriktirilgan tasklar avtomatik keladi.\n\n` +
        `<i>Eslatma: ClickUp'da taskni "Yakunlash" bossangiz, u avtomatik hisobotingizga qo'shiladi.</i>`;
    await ctx.reply(helpText, { parse_mode: 'HTML' });
});

bot.command('send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error || !data.length) {
            return ctx.reply("📭 Hozircha yuborish uchun yangi ishlar yo'q.");
        }

        let reportText = `📋 <b>Sizning hisobotingiz (yuborishdan oldin ko'zdan kechiring):</b>\n\n`;
        data.forEach((item, index) => {
            reportText += `<b>${index + 1}.</b> ${escapeHTML(item.content)}\n`;
        });

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("🚀 Guruhga yuborish", "confirm_send")],
            [Markup.button.webApp("✍️ Tahrirlash (Pastdan chap burchakda open tugmasi)", WEB_APP_URL)]
        ]);

        await ctx.reply(reportText, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
        console.error("Send command error:", err);
    }
});

// --- ACTIONS & TEXT ---
bot.action(/cu_status_(process|done)_(.+)/, async (ctx) => {
    const [_, action, taskId] = ctx.match;
    const statusName = action === 'process' ? CLICKUP_STATUS_PROCESS : CLICKUP_STATUS_DONE;

    try {
        await clickupRequest(`task/${taskId}`, 'PUT', { status: statusName });

        if (action === 'done') {
            const task = await clickupRequest(`task/${taskId}`);
            await supabase.from('reports').insert([{
                user_id: ctx.from.id,
                content: `(ClickUp) ${task.name}`,
                status: 'pending'
            }]);
            await ctx.editMessageText(`✅ <b>Vazifa yakunlandi va hisobotga qo'shildi!</b>`, { parse_mode: 'HTML' });
        } else {
            await ctx.answerCbQuery("Status 'Jarayonda'ga o'zgardi");
            await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
                [Markup.button.callback("✅ Yakunlash", `cu_status_done_${taskId}`)]
            ]).reply_markup);
        }
    } catch (err) {
        await ctx.answerCbQuery("Xatolik: ClickUp API bilan bog'lanib bo'lmadi.");
    }
});

bot.action('confirm_send', async (ctx) => {
    try {
        const { data } = await supabase.from('reports').select('*').eq('user_id', ctx.from.id).eq('status', 'pending');
        if (!data?.length) return;

        const dateString = new Date().toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent' });
        let finalReport = `📅 <b>#hisobot ${dateString}</b>\n👤 <b>Xodim:</b> ${escapeHTML(ctx.from.first_name)}\n\n`;

        data.forEach((item, index) => {
            finalReport += `${index + 1}. ${escapeHTML(item.content)}\n`;
        });

        await ctx.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'HTML' });
        await supabase.from('reports').update({ status: 'sent' }).eq('user_id', ctx.from.id).eq('status', 'pending');

        await ctx.editMessageText("🚀 Hisobot guruhga yuborildi!", { parse_mode: 'HTML' });
    } catch (err) {
        console.error("Confirm send error:", err);
    }
});

// ====== /tasks & /report helperlar ======
const isPlanner = (telegramId) => {
    return TASK_PLANNERS.includes(Number(telegramId));
};

const getTashkentISODate = (offsetDays = 0) => {
    const dt = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    // en-CA => YYYY-MM-DD
    return dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
};

const formatUzDate = (isoDate) => {
    // isoDate: YYYY-MM-DD
    try {
        const [y, m, d] = isoDate.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    } catch {
        return isoDate;
    }
};

const sendEmployeePicker = async (ctx, title = "👥 Xodimni tanlang") => {
    const { data: users, error } = await supabase
        .from('users_mapping')
        .select('telegram_id, full_name')
        .order('full_name', { ascending: true });

    if (error || !users?.length) {
        return ctx.reply("❌ Xodimlar ro'yxati topilmadi. Avval /bind bilan xodimlarni bog'lab chiqing.");
    }

    // 2 tadan qilib tugma chiqaramiz
    const rows = [];
    for (let i = 0; i < users.length; i += 2) {
        const row = [];
        row.push(Markup.button.callback(users[i].full_name, `plan_select_${users[i].telegram_id}`));
        if (users[i + 1]) {
            row.push(Markup.button.callback(users[i + 1].full_name, `plan_select_${users[i + 1].telegram_id}`));
        }
        rows.push(row);
    }
    rows.push([Markup.button.callback("❌ Rejimdan chiqish", "plan_exit")]);

    return ctx.reply(title, Markup.inlineKeyboard(rows));
};

// ====== /tasks komandasi ======
// /tasks -> xodim tanlash
// /tasks list -> ertangi draft tasklarni ko'rish
// /tasks stop -> rejimdan chiqish
bot.command('tasks', async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.reply("Bu buyruq faqat mas'ul shaxs uchun.");

    const args = ctx.message.text.split(' ').slice(1);
    const sub = (args[0] || '').toLowerCase();

    // stop
    if (sub === 'stop') {
        await supabase.from('planner_state').delete().eq('creator_id', ctx.from.id);
        return ctx.reply("✅ /tasks rejimi o'chirildi.");
    }

    // list
    if (sub === 'list') {
        const planDate = getTashkentISODate(1);
        const { data: items } = await supabase
            .from('task_plans')
            .select('id, assignee_tg_id, task_text, created_at')
            .eq('creator_id', ctx.from.id)
            .eq('plan_date', planDate)
            .eq('status', 'draft')
            .order('created_at', { ascending: true });

        if (!items?.length) {
            return ctx.reply("📭 Ertangi vazifalar ro'yxati hozircha bo'sh.");
        }

        // ismlar mapping
        const ids = [...new Set(items.map(i => i.assignee_tg_id))];
        const { data: users } = await supabase
            .from('users_mapping')
            .select('telegram_id, full_name')
            .in('telegram_id', ids);

        const nameMap = new Map((users || []).map(u => [u.telegram_id, u.full_name]));

        let text = `📌 <b>Ertangi draft vazifalar</b> (${formatUzDate(planDate)})\n\n`;
        const grouped = {};
        for (const t of items) {
            const key = t.assignee_tg_id;
            grouped[key] = grouped[key] || [];
            grouped[key].push(t.task_text);
        }
        let idx = 1;
        for (const [assigneeId, tasks] of Object.entries(grouped)) {
            const name = escapeHTML(nameMap.get(Number(assigneeId)) || `ID ${assigneeId}`);
            text += `<b>${idx}. ${name}</b> vazifalar:\n`;
            tasks.forEach((tt) => {
                text += `• ${escapeHTML(tt)}\n`;
            });
            text += `\n`;
            idx++;
        }

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("👥 Yana task qo'shish", "plan_change")],
            [Markup.button.callback("📝 /report (preview)", "report_preview")]
        ]);

        return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }

    // default: picker
    // planner_state yaratib qo'yamiz
    const planDate = getTashkentISODate(1);
    await supabase
        .from('planner_state')
        .upsert({ creator_id: ctx.from.id, assignee_tg_id: null, plan_date: planDate, updated_at: new Date().toISOString() });

    return sendEmployeePicker(ctx, `🗓 <b>Ertangi vazifalar</b> (${formatUzDate(planDate)})\n\n👥 Xodimni tanlang:`);
});

// xodim tanlash
bot.action(/plan_select_(\d+)/, async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");

    const assigneeId = parseInt(ctx.match[1], 10);
    const planDate = getTashkentISODate(1);

    await supabase
        .from('planner_state')
        .upsert({ creator_id: ctx.from.id, assignee_tg_id: assigneeId, plan_date: planDate, updated_at: new Date().toISOString() });

    await ctx.answerCbQuery("✅ Tanlandi");

    const { data: user } = await supabase
        .from('users_mapping')
        .select('full_name')
        .eq('telegram_id', assigneeId)
        .single();

    const name = escapeHTML(user?.full_name || String(assigneeId));

    return ctx.editMessageText(
        `✅ <b>${name}</b> tanlandi.\n\nEndi vazifa matnini yozing (har bir xabar = 1 ta task).\n\n` +
        `<i>Rejimdan chiqish:</i> <b>/tasks stop</b>`,
        { parse_mode: 'HTML' }
    );
});

// rejimdan chiqish
bot.action('plan_exit', async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
    await supabase.from('planner_state').delete().eq('creator_id', ctx.from.id);
    await ctx.answerCbQuery("✅ O'chirildi");
    return ctx.editMessageText("✅ /tasks rejimi yopildi.");
});

// xodimni almashtirish (picker)
bot.action('plan_change', async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
    await ctx.answerCbQuery();
    return sendEmployeePicker(ctx, "👥 Xodimni tanlang (task qo'shishda davom etamiz):");
});

// /report preview tugmasi
bot.action('report_preview', async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
    await ctx.answerCbQuery();
    // /report komandasi bilan bir xil ishlaydi
    return bot.telegram.sendMessage(ctx.from.id, "📝 /report buyrug'ini yuboring: /report");
});

// ====== /report komandasi ======
// /report -> preview (faqat yaratgan odam ko'radi) + Tasdiqlash/Bekor qilish
bot.command('report', async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.reply("Bu buyruq faqat mas'ul shaxs uchun.");

    const planDate = getTashkentISODate(1);

    const { data: tasks, error } = await supabase
        .from('task_plans')
        .select('id, assignee_tg_id, task_text, created_at')
        .eq('creator_id', ctx.from.id)
        .eq('plan_date', planDate)
        .eq('status', 'draft')
        .order('created_at', { ascending: true });

    if (error || !tasks?.length) {
        return ctx.reply("📭 Ertangi vazifalar yo'q. Avval /tasks bilan vazifalarni kiriting.");
    }

    const assigneeIds = [...new Set(tasks.map(t => t.assignee_tg_id))];

    const { data: users } = await supabase
        .from('users_mapping')
        .select('telegram_id, full_name')
        .in('telegram_id', assigneeIds);

    const nameMap = new Map((users || []).map(u => [u.telegram_id, u.full_name]));

    // format
    let message = `📌 <b>Ertangi vazifalar</b> (${formatUzDate(planDate)})\n\n`;

    const grouped = {};
    for (const t of tasks) {
        const key = t.assignee_tg_id;
        grouped[key] = grouped[key] || [];
        grouped[key].push(t.task_text);
    }

    let i = 1;
    for (const [assigneeId, items] of Object.entries(grouped)) {
        const name = escapeHTML(nameMap.get(Number(assigneeId)) || `ID ${assigneeId}`);
        message += `<b>${i}. ${name}</b> vazifalar:\n`;
        for (const it of items) {
            message += `• ${escapeHTML(it)}\n`;
        }
        message += `\n`;
        i++;
    }

    // draft saqlab qo'yamiz (confirm bosilganda shu draft yuboriladi)
    const { data: draft, error: draftErr } = await supabase
        .from('task_reports')
        .insert([{
            creator_id: ctx.from.id,
            plan_date: planDate,
            message,
            task_ids: tasks.map(t => t.id),
            status: 'draft'
        }])
        .select('id')
        .single();

    if (draftErr || !draft?.id) {
        console.error('task_reports insert error:', draftErr);
        return ctx.reply("❌ Report draft yaratishda xatolik bo'ldi.");
    }

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("✅ Tasdiqlash va yuborish", `report_confirm_${draft.id}`)],
        [Markup.button.callback("❌ Bekor qilish", `report_cancel_${draft.id}`)]
    ]);

    return ctx.reply(
        `🧾 <b>Rahbarga yuborishdan oldin tekshirib oling:</b>\n\n${message}`,
        { parse_mode: 'HTML', ...keyboard }
    );
});

bot.action(/report_confirm_(.+)/, async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");

    const reportId = ctx.match[1];

    const { data: draft } = await supabase
        .from('task_reports')
        .select('id, creator_id, plan_date, message, task_ids, status')
        .eq('id', reportId)
        .single();

    if (!draft || draft.creator_id !== ctx.from.id) {
        return ctx.answerCbQuery("Draft topilmadi");
    }

    if (draft.status !== 'draft') {
        return ctx.answerCbQuery("Bu report allaqachon yakunlangan");
    }

    try {
        await ctx.telegram.sendMessage(BOSS_ID, draft.message, { parse_mode: 'HTML' });

        // tasklarni sent qilamiz
        if (Array.isArray(draft.task_ids) && draft.task_ids.length) {
            await supabase
                .from('task_plans')
                .update({ status: 'sent' })
                .in('id', draft.task_ids);
        }

        await supabase
            .from('task_reports')
            .update({ status: 'sent' })
            .eq('id', reportId);

        await ctx.answerCbQuery("✅ Yuborildi");
        return ctx.editMessageText("✅ Report rahbarga yuborildi!", { parse_mode: 'HTML' });
    } catch (err) {
        console.error('report_confirm error:', err);
        return ctx.answerCbQuery("Xatolik: yuborib bo'lmadi");
    }
});

bot.action(/report_cancel_(.+)/, async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");

    const reportId = ctx.match[1];

    const { data: draft } = await supabase
        .from('task_reports')
        .select('id, creator_id, status')
        .eq('id', reportId)
        .single();

    if (!draft || draft.creator_id !== ctx.from.id) {
        return ctx.answerCbQuery("Draft topilmadi");
    }

    if (draft.status !== 'draft') {
        return ctx.answerCbQuery("Bu report allaqachon yakunlangan");
    }

    await supabase
        .from('task_reports')
        .update({ status: 'cancelled' })
        .eq('id', reportId);

    await ctx.answerCbQuery("❌ Bekor qilindi");
    return ctx.editMessageText("❌ Report bekor qilindi. (Vazifalar draft holatda qoldi)");
});

bot.on('text', async (ctx) => {
    // 1. Agar xabar buyruq bo'lsa (/) o'tkazib yuborish
    if (ctx.message.text.startsWith('/')) return;

    // 2. FAQAT shaxsiy xabarlarni saqlash (Guruh xabarlarini e'tiborsiz qoldirish)
    if (ctx.chat.type !== 'private') return;

    // 3) Agar mas'ul shaxs /tasks rejimida bo'lsa - task_plans ga yozamiz
    if (isPlanner(ctx.from.id)) {
        const { data: state } = await supabase
            .from('planner_state')
            .select('assignee_tg_id, plan_date')
            .eq('creator_id', ctx.from.id)
            .single();

        if (state?.assignee_tg_id) {
            const content = (ctx.message.text || '').trim();
            if (!content) return;

            const planDate = state.plan_date || getTashkentISODate(1);

            const { error } = await supabase
                .from('task_plans')
                .insert([{
                    creator_id: ctx.from.id,
                    assignee_tg_id: state.assignee_tg_id,
                    task_text: content,
                    plan_date: planDate,
                    status: 'draft'
                }]);

            if (error) {
                console.error('task_plans insert error:', error);
                return ctx.reply("❌ Task saqlanmadi (DB xatolik)");
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback("👥 Xodimni almashtirish", "plan_change")],
                [Markup.button.callback("📋 Ro'yxat", "plan_show_list")],
                [Markup.button.callback("✅ Tayyor /report", "plan_report_hint")]
            ]);

            return ctx.reply(
                `✅ Task qo'shildi (${formatUzDate(planDate)}):\n<b>${escapeHTML(content)}</b>`,
                { parse_mode: 'HTML', ...keyboard }
            );
        }
    }

    // 4) Default: oddiy hisobot (reports)
    try {
        await supabase.from('reports').insert([{
            user_id: ctx.from.id,
            content: ctx.message.text,
            status: 'pending'
        }]);
        await ctx.reply("✅ Hisobotga qo'shildi.", { reply_to_message_id: ctx.message.message_id });
    } catch (err) {
        console.error("Text save error:", err);
    }
});

bot.action('plan_show_list', async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
    await ctx.answerCbQuery();
    return bot.telegram.sendMessage(ctx.from.id, "📋 Ko'rish uchun yozing: /tasks list");
});

bot.action('plan_report_hint', async (ctx) => {
    if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
    await ctx.answerCbQuery();
    return bot.telegram.sendMessage(ctx.from.id, "✅ Preview va yuborish uchun: /report");
});

// --- SERVER LOGIC ---
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            // ⚠️ AGAR BU CLICKUP WEBHOOK BO'LSA
            if (req.body && req.body.webhook_id) {
                // Optional signature verification (strict mode via env)
                const ok = verifyClickUpSignature(req);
                if (!ok) {
                    console.warn('⚠️ ClickUp signature verification failed');
                    return res.status(401).send('Invalid signature');
                }
                await handleClickUpWebhook(req);
                return res.status(200).send('OK');
            }

            // ⚠️ AGAR BU TELEGRAM XABARI BO'LSA
            const tgOk = verifyTelegramSecret(req);
            if (!tgOk) {
                console.warn('⚠️ Telegram secret token verification failed');
                return res.status(401).send('Invalid telegram secret');
            }
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');

        } catch (err) {
            console.error("Main Handler Error:", err);
            return res.status(200).send('OK'); // Vercel xato bermasligi uchun
        }
    }
    res.status(200).send('Bot is active!');
};