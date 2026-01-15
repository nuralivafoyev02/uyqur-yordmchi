const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Matndagi xavfli belgilarni HTML uchun tozalash (Escaping)
const escapeHTML = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const logError = async (ctx, err, stage) => {
    console.error(`Error at ${stage}:`, err);
    // HTML rejimida xatolik xabari
    await ctx.reply(`❌ <b>Xatolik (${stage}):</b> <code>${escapeHTML(err.message)}</code>`, { parse_mode: 'HTML' });
};

bot.start((ctx) => {
    ctx.reply(`👋 <b>Assalomu alaykum, ${ctx.from.first_name}!</b>\nIshlaringizni yozib qoldiring.`, { parse_mode: 'HTML' });
});

bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    try {
        const { error } = await supabase
            .from('reports')
            .insert([{ user_id: ctx.from.id, content: ctx.message.text }]);
        if (error) throw error;
        ctx.reply("✅ Saqlandi.");
    } catch (err) {
        await logError(ctx, err, "Saving");
    }
});

bot.command('send', async (ctx) => {
    const loadingMsg = await ctx.reply("🔍 Hisobotlar tayyorlanmoqda...");

    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) throw error;
        if (!data || data.length === 0) {
            return await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, "📭 Hisobotlar topilmadi.");
        }

        let reportText = `📋 <b>Bugungi ishlaringiz ro'yxati:</b>\n\n`;
        data.forEach((item, index) => {
            // HTML uchun matnni xavfsiz holatga keltiramiz
            const safeContent = escapeHTML(item.content); 
            reportText += `<b>${index + 1}.</b> ${safeContent}\n`;
        });

        const webAppUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://google.com';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Guruhga yuborish", "confirm_send")],
            [Markup.button.webApp("✍️ Tahrirlash", webAppUrl)],
            [Markup.button.callback("❌ Bekor qilish", "cancel_preview")],
            [Markup.button.callback("🗑 Tozalash", "clear_reports")]
        ]);

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        await ctx.reply(reportText, { parse_mode: 'HTML', ...keyboard });

    } catch (err) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        await logError(ctx, err, "Send Command");
    }
});

bot.action('confirm_send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error || !data.length) throw new Error("Ma'lumot topilmadi");

        let finalReport = `📅 <b>KUNLIK HISOBOT</b>\n👤 <b>Xodim:</b> ${ctx.from.first_name}\n` +
                          `──────────────────\n`;
        data.forEach((item, index) => {
            finalReport += `${index + 1}. ${escapeHTML(item.content)}\n`;
        });
        finalReport += `──────────────────\n✅ #hisobot`;

        await ctx.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'HTML' });
        await supabase.from('reports').update({ status: 'sent' }).eq('user_id', ctx.from.id).eq('status', 'pending');
        await ctx.editMessageText("🚀 Hisobot guruhga yuborildi!");
    } catch (err) {
        await logError(ctx, err, "Confirm Send");
    }
});

bot.action('cancel_preview', async (ctx) => {
    try {
        await ctx.editMessageText("⏸ Yuborish bekor qilindi.");
    } catch (err) {
        console.error(err);
    }
});

bot.action('clear_reports', async (ctx) => {
    try {
        await supabase.from('reports').delete().eq('user_id', ctx.from.id).eq('status', 'pending');
        await ctx.editMessageText("🗑 Barcha hisobotlar o'chirildi.");
    } catch (err) {
        await logError(ctx, err, "Clear");
    }
});

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } catch (err) {
            console.error(err);
            res.status(500).send('Error');
        }
    } else {
        res.status(200).send('Bot is working...');
    }
};