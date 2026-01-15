const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = 7894854944;

// ClickUp API Helper
const clickupRequest = async (endpoint, method = 'GET', body = null) => {
    const res = await fetch(`https://api.clickup.com/api/v2/${endpoint}`, {
        method,
        headers: {
            'Authorization': process.env.CLICKUP_TOKEN,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });
    return res.json();
};

const escapeHTML = (str) => {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

// --- CLICKUP WEBHOOK HANDLER ---
async function handleClickUpWebhook(req) {
    const { event, task_id } = req.body;

    // Faqat yangi task yaratilganda yoki xodim biriktirilganda ishlaydi
    if (event === 'taskCreated' || event === 'taskAssigneeUpdated') {
        try {
            const task = await clickupRequest(`task/${task_id}`);
            if (task.assignees && task.assignees.length > 0) {
                for (let assignee of task.assignees) {
                    const { data: userMap } = await supabase
                        .from('users_mapping')
                        .select('telegram_id')
                        .eq('clickup_user_id', assignee.id)
                        .single();

                    if (userMap) {
                        const text = `🆕 <b>Yangi ClickUp vazifasi biriktirildi!</b>\n\n` +
                                     `📌 <b>${escapeHTML(task.name)}</b>\n` +
                                     `📝 ${escapeHTML(task.description || "Tavsif yo'q")}\n\n` +
                                     `<i>Ishni boshlagach statusni yangilab qo'ying:</i>`;
                        
                        const keyboard = Markup.inlineKeyboard([
                            [Markup.button.callback("🚀 Jarayonda", `cu_status_process_${task_id}`)],
                            [Markup.button.callback("✅ Yakunlash", `cu_status_done_${task_id}`)]
                        ]);

                        await bot.telegram.sendMessage(userMap.telegram_id, text, { parse_mode: 'HTML', ...keyboard });
                    }
                }
            }
        } catch (err) {
            console.error("Webhook Logic Error:", err);
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
            [Markup.button.webApp("✍️ Tahrirlash (Mini App)", `https://${process.env.VERCEL_URL || 'your-app-url.vercel.app'}`)]
        ]);

        await ctx.reply(reportText, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
        console.error("Send command error:", err);
    }
});

// --- ACTIONS & TEXT ---

bot.action(/cu_status_(process|done)_(.+)/, async (ctx) => {
    const [_, action, taskId] = ctx.match;
    const statusName = action === 'process' ? 'in progress' : 'complete';

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
    if (ctx.message.text.startsWith('/')) return;
    try {
        await supabase.from('reports').insert([{ user_id: ctx.from.id, content: ctx.message.text, status: 'pending' }]);
        await ctx.reply("✅ Hisobotga qo'shildi.", { reply_to_message_id: ctx.message.message_id });
    } catch (err) {
        console.error("Text save error:", err);
    }
});

// --- SERVER LOGIC ---
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            // ClickUp Webhook
            if (req.body && req.body.webhook_id) {
                await handleClickUpWebhook(req);
                return res.status(200).send('OK');
            }
            // Telegram Update
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        } catch (err) {
            console.error("Main Handler Error:", err);
            return res.status(200).send('Error Handled');
        }
    }
    res.status(200).send('Bot is active!');
};