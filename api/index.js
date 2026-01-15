const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = 7894854944;

// --- CLICKUP API HELPER (MUSTAHKAMLANGAN) ---
const clickupRequest = async (endpoint, method = 'GET', body = null) => {
    try {
        const res = await fetch(`https://api.clickup.com/api/v2/${endpoint}`, {
            method,
            headers: {
                'Authorization': process.env.CLICKUP_TOKEN.trim(),
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : null
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error("ClickUp Request Error:", err);
        return null;
    }
};

const escapeHTML = (str) => {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

// --- CLICKUP WEBHOOK HANDLER (MUKAMMAL) ---
const processedWebhooks = new Set();

async function handleClickUpWebhook(req) {
    const { event, task_id, webhook_id } = req.body;

    // 1. Takrorlanishni va keraksiz hodisalarni filtrlaymiz
    const duplicateKey = `${webhook_id}_${task_id}_${event}`;
    if (processedWebhooks.has(duplicateKey)) return;

    // Faqat xodim biriktirilishi yoki task yaratilishiga e'tibor beramiz
    if (!['taskCreated', 'taskAssigneeUpdated', 'taskStatusUpdated'].includes(event)) return;

    processedWebhooks.add(duplicateKey);
    setTimeout(() => processedWebhooks.delete(duplicateKey), 30000); // 30 soniya kesh

    try {
        // 2. ClickUp ma'lumotlarni yangilab olishi uchun kutamiz (Race condition oldini olish)
        await new Promise(res => setTimeout(res, 3000));

        const task = await clickupRequest(`task/${task_id}`);
        if (!task || !task.name) return;

        // 3. Agar vazifada mas'ullar bo'lsa, xabar yuboramiz
        if (task.assignees && task.assignees.length > 0) {
            for (let assignee of task.assignees) {
                const { data: userMap } = await supabase
                    .from('users_mapping')
                    .select('telegram_id')
                    .eq('clickup_user_id', assignee.id)
                    .single();

                if (userMap) {
                    const statusEmoji = task.status.status.toLowerCase() === 'complete' ? '✅' : '📌';
                    const text = `${statusEmoji} <b>ClickUp Vazifa:</b>\n\n` +
                        `<b>Nomi:</b> ${escapeHTML(task.name)}\n` +
                        `<b>Status:</b> ${task.status.status.toUpperCase()}\n` +
                        `<b>Loyiha:</b> ${task.list.name}\n\n` +
                        `<a href="${task.url}">ClickUp'da ochish</a>`;

                    const keyboard = Markup.inlineKeyboard([
                        [Markup.button.callback("🚀 Jarayonda", `cu_status_process_${task_id}`)],
                        [Markup.button.callback("✅ Yakunlash", `cu_status_done_${task_id}`)]
                    ]);

                    await bot.telegram.sendMessage(userMap.telegram_id, text, {
                        parse_mode: 'HTML',
                        ...keyboard
                    }).catch(e => console.error("TG Send Error:", e));
                }
            }
        }
    } catch (err) {
        console.error("❌ Webhook Logic Error:", err.message);
    }
}

// --- TELEGRAM COMMANDS (Barchasi saqlangan) ---
bot.command('bind', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("Siz admin emassiz!");
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 3) return ctx.reply("Format: /bind TG_ID ClickUp_ID Ism");

    const [tg_id, cu_id, ...nameParts] = args;
    const { error } = await supabase.from('users_mapping').upsert({
        telegram_id: parseInt(tg_id),
        clickup_user_id: parseInt(cu_id),
        full_name: nameParts.join(' ')
    });
    ctx.reply(error ? `Xato: ${error.message}` : "✅ Bog'landi!");
});

bot.start(ctx => ctx.reply(`Assalomu alaykum! /help buyrug'ini ko'ring.`, { parse_mode: 'HTML' }));

bot.command('send', async (ctx) => {
    const { data } = await supabase.from('reports').select('*').eq('user_id', ctx.from.id).eq('status', 'pending');
    if (!data?.length) return ctx.reply("📭 Yangi ishlar yo'q.");

    let reportText = `📋 <b>Hisobotingiz:</b>\n\n` + data.map((item, i) => `<b>${i + 1}.</b> ${escapeHTML(item.content)}`).join('\n');
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Guruhga yuborish", "confirm_send")]
    ]);
    ctx.reply(reportText, { parse_mode: 'HTML', ...keyboard });
});

bot.action(/cu_status_(process|done)_(.+)/, async (ctx) => {
    const [_, action, taskId] = ctx.match;
    const status = action === 'process' ? 'in progress' : 'complete';
    const task = await clickupRequest(`task/${taskId}`, 'PUT', { status });

    if (action === 'done' && task) {
        await supabase.from('reports').insert([{ user_id: ctx.from.id, content: `(ClickUp) ${task.name}`, status: 'pending' }]);
        await ctx.editMessageText(`✅ <b>Vazifa yakunlandi!</b>`, { parse_mode: 'HTML' });
    } else {
        await ctx.answerCbQuery("Status o'zgardi");
    }
});

bot.action('confirm_send', async (ctx) => {
    const { data } = await supabase.from('reports').select('*').eq('user_id', ctx.from.id).eq('status', 'pending');
    if (!data?.length) return;

    let finalReport = `📅 <b>#hisobot</b>\n👤 <b>Xodim:</b> ${ctx.from.first_name}\n\n` + data.map((item, i) => `${i + 1}. ${item.content}`).join('\n');
    await bot.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'HTML' });
    await supabase.from('reports').update({ status: 'sent' }).eq('user_id', ctx.from.id).eq('status', 'pending');
    ctx.editMessageText("🚀 Yuborildi!");
});

bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    await supabase.from('reports').insert([{ user_id: ctx.from.id, content: ctx.message.text, status: 'pending' }]);
    ctx.reply("✅ Saqlandi.", { reply_to_message_id: ctx.message.message_id });
});

// --- SERVER HANDLER (MUHIM!) ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('Active');

    if (req.body && req.body.webhook_id) {
        res.status(200).send('OK'); // ClickUp-ni kuttirmaymiz
        return handleClickUpWebhook(req);
    }

    try {
        await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (err) {
        res.status(200).send('OK');
    }
};