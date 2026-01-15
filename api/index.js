const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);

// Xatoliklarni ushlash va foydalanuvchiga bildirish
const handleError = async (ctx, error) => {
    console.error(error);
    await ctx.reply(`❌ Xatolik yuz berdi: ${error.message}\nIltimos, keyinroq urinib ko'ring.`);
};

bot.start((ctx) => ctx.reply("Xush kelibsiz! Kunlik hisobotlarni yozib yuboring. Yig'ilgan malumotlarni istagan partingiz /send buyrug'i bilan ko'rishingiz va guruhga yuborishingiz mumkin."));

// Hisobotni qabul qilish va saqlash
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    try {
        const { error } = await supabase
            .from('reports')
            .insert([{ user_id: ctx.from.id, content: ctx.message.text }]);

        if (error) throw error;
        ctx.reply("✅ Saqlandi. Yana yozishingiz mumkin.");
    } catch (err) {
        await handleError(ctx, err);
    }
});

// Hisobotni yig'ish va ko'rib chiqish
bot.command('send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending');

        if (error) throw error;
        if (data.length === 0) return ctx.reply("Sizda hali yozilgan hisobotlar yo'q.");

        let reportText = `📅 *Kunlik Hisobot*\n\n`;
        data.forEach((item, index) => {
            reportText += `${index + 1}. ${item.content}\n`;
        });

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Tasdiqlash va guruhga yuborish", "confirm_send")],
            [Markup.button.callback("tahrirlash (Mini App)", "open_mini_app", false)], // Mini app linki bo'ladi
            [Markup.button.callback("🗑 Tozalash", "clear_reports")]
        ]);

        ctx.replyWithMarkdown(reportText, keyboard);
    } catch (err) {
        await handleError(ctx, err);
    }
});

// Callback so'rovlarini qayta ishlash
bot.action('confirm_send', async (ctx) => {
    try {
        const { data } = await supabase.from('reports').select('*').eq('user_id', ctx.from.id).eq('status', 'pending');
        
        let finalReport = `📢 *Yangi Hisobot* (Xodim: ${ctx.from.first_name})\n\n`;
        data.forEach((item, index) => { finalReport += `🔹 ${item.content}\n`; });

        // Guruh ID sini o'zgartiring
        await ctx.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'Markdown' });
        
        await supabase.from('reports').update({ status: 'sent' }).eq('user_id', ctx.from.id);
        
        ctx.editMessageText("🚀 Hisobot guruhga yuborildi!");
    } catch (err) {
        await handleError(ctx, err);
    }
});

bot.action('clear_reports', async (ctx) => {
    await supabase.from('reports').delete().eq('user_id', ctx.from.id).eq('status', 'pending');
    ctx.editMessageText("🗑 Barcha hisobotlar tozalandi.");
});

module.exports = async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error');
    }
};