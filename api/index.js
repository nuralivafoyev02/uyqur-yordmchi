const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

    if (event === 'taskCreated' || event === 'taskAssigneeUpdated') {
        const task = await clickupRequest(`task/${task_id}`);
        
        if (task.assignees && task.assignees.length > 0) {
            for (let assignee of task.assignees) {
                const { data: userMap } = await supabase
                    .from('users_mapping')
                    .select('telegram_id')
                    .eq('clickup_user_id', assignee.id)
                    .single();

                if (userMap) {
                    const text = `🆕 <b>Yangi ClickUp vazifasi:</b>\n\n` +
                                 `📌 <b>${escapeHTML(task.name)}</b>\n` +
                                 `📝 ${escapeHTML(task.description || "Tavsif yo'q")}\n\n` +
                                 `Sizga biriktirildi. Ishni boshlagach statusni o'zgartiring:`;
                    
                    const keyboard = Markup.inlineKeyboard([
                        [Markup.button.callback("🚀 Jarayonda", `cu_status_process_${task_id}`)],
                        [Markup.button.callback("✅ Yakunlash", `cu_status_done_${task_id}`)]
                    ]);

                    await bot.telegram.sendMessage(userMap.telegram_id, text, { parse_mode: 'HTML', ...keyboard });
                }
            }
        }
    }
}

// --- TELEGRAM ACTIONS ---
bot.action(/cu_status_(process|done)_(.+)/, async (ctx) => {
    const [_, action, taskId] = ctx.match;
    const statusName = action === 'process' ? 'in progress' : 'complete';

    try {
        await clickupRequest(`task/${taskId}`, 'PUT', { status: statusName });

        if (action === 'done') {
            const task = await clickupRequest(`task/${taskId}`);
            // Yakunlangan taskni Supabase-ga 'pending' statusda qo'shamiz (send qilish uchun)
            await supabase.from('reports').insert([{
                user_id: ctx.from.id,
                content: `(ClickUp) ${task.name}`,
                status: 'pending'
            }]);

            await ctx.editMessageText(`✅ <b>Vazifa yakunlandi va hisobotlar ro'yxatiga qo'shildi!</b>`, { parse_mode: 'HTML' });
        } else {
            await ctx.answerCbQuery("Status o'zgardi: Jarayonda");
            await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
                [Markup.button.callback("✅ Yakunlash", `cu_status_done_${taskId}`)]
            ]).reply_markup);
        }
    } catch (err) {
        console.error(err);
        await ctx.answerCbQuery("ClickUp API xatosi!");
    }
});

// Mavjud /send buyrug'i (hammasini guruhga yuboradi)
bot.command('send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error || !data.length) {
            return ctx.reply("📭 Yuborish uchun yangi ishlar yo'q.");
        }

        let reportText = `📋 <b>Sizning hisobotingiz:</b>\n\n`;
        data.forEach((item, index) => {
            reportText += `<b>${index + 1}.</b> ${escapeHTML(item.content)}\n`;
        });

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("🚀 Guruhga yuborish", "confirm_send")],
            [Markup.button.webApp("✍️ Tahrirlash", process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://google.com")]
        ]);

        await ctx.reply(reportText, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
        console.error(err);
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
        console.error(err);
    }
});

// Matn xabarlarini saqlash
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    await supabase.from('reports').insert([{ user_id: ctx.from.id, content: ctx.message.text }]);
    await ctx.reply("✅ Saqlandi.", { reply_to_message_id: ctx.message.message_id });
});

// --- SERVER LOGIC ---
module.exports = async (req, res) => {
    try {
        // ClickUp Webhook kelganini tekshirish
        if (req.body && req.body.webhook_id) {
            await handleClickUpWebhook(req);
            return res.status(200).send('OK');
        }

        // Telegram xabari
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }

        res.status(200).send('Bot is running...');
    } catch (err) {
        console.error("Main Handler Error:", err);
        res.status(200).send('Error ignored');
    }
};