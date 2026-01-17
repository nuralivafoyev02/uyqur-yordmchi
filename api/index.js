const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = 7894854944;

// WebApp URL (fix: avoid https://https://...)
const WEB_APP_URL = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://uyqur-yordmchi.vercel.app';

// Optional: ClickUp status mapping (some workspaces use custom status names)
const CLICKUP_STATUS_PROCESS = process.env.CLICKUP_STATUS_PROCESS || 'in progress';
const CLICKUP_STATUS_DONE = process.env.CLICKUP_STATUS_DONE || 'complete';

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

bot.start(async (ctx) => {
    const welcome = `Assalomu alaykum, <b>${escapeHTML(ctx.from.first_name)}</b>!\n\n` +
        `Men sizning ish hisobotlaringizni yig'ish va ClickUp vazifalaringizni boshqarishda yordam beraman.\n\n` +
        `📖 Buyruqlar va yordam: /help`;
    await ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.help(async (ctx) => {
    const helpText = `🛠 <b>Bot buyruqlari:</b>\n\n` +
        `/send - Saqlangan barcha ishlarni ko'rish va guruhga yuborish\n` +
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

bot.on('text', async (ctx) => {
    // 1. Agar xabar buyruq bo'lsa (/) o'tkazib yuborish
    if (ctx.message.text.startsWith('/')) return;

    // 2. FAQAT shaxsiy xabarlarni saqlash (Guruh xabarlarini e'tiborsiz qoldirish)
    if (ctx.chat.type !== 'private') return;

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