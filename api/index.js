const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Bot va Supabase ni sozlash
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. HTML uchun maxsus belgilarni tozalash (Xavfsizlik)
const escapeHTML = (str) => {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

// 2. Markazlashgan xatolarni boshqarish
const logError = async (ctx, err, stage) => {
    console.error(`Error at ${stage}:`, err);
    try {
        await ctx.reply(`❌ <b>Xatolik (${stage}):</b> <code>${escapeHTML(err.message)}</code>. Iltimos xatolikni @uyqur_nurali ga yuboring`, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Xatolik xabarini yuborib bo'lmadi:", e);
    }
};

// 3. Bot buyruqlarini Telegram menyusiga qo'shish
bot.telegram.setMyCommands([
    { command: 'start', description: 'Botni ishga tushirish' },
    { command: 'send', description: 'Hisobotlarni ko\'rish va yuborish' },
    { command: 'clear', description: 'Yozilganlarni tozalash' },
    { command: 'help', description: 'Yordam' }
]);

// --- BUYRUQLAR (COMMANDS) ---

// /start
bot.start((ctx) => {
    ctx.reply(
        `👋 <b>Assalomu alaykum, ${escapeHTML(ctx.from.first_name)}!</b>\n\n` +
        `Men kunlik hisobotlarni yig'uvchi botman.\n` +
        `/help buyrug'i bilan bot commandlarini ko'rishingiz mumkin.\n` +
        `Qilgan ishlaringizni shunchaki yozib qoldiring. Kun oxirida /send buyrug'ini bilan guruhga hisobotni yuborsangiz bo'ladi.`,
        { parse_mode: 'HTML' }
    );
});

// /help
bot.help((ctx) => {
    ctx.reply(
        `📝 <b>Yordam bo'limi:</b>\n\n` +
        `/send - Yozilgan hisobotlarni ko'rish va guruhga yuborish.\n` +
        `/clear - Yuborilmagan barcha hisobotlarni o'chirib tashlash.\n` +
        `\nShunchaki matn yozsangiz, uni hisobot sifatida saqlab qo'yaman va guruhga chiroyli formatda yuboraman.`,
        { parse_mode: 'HTML' }
    );
});

// /clear - Tozalash (Command versiyasi)
bot.command('clear', async (ctx) => {
    try {
        await supabase.from('reports').delete().eq('user_id', ctx.from.id).eq('status', 'pending');
        ctx.reply("🗑 <b>Barcha yuborilmagan hisobotlar tozalandi.</b>", { parse_mode: 'HTML' });
    } catch (err) {
        await logError(ctx, err, "Clear Command");
    }
});

// /send - Asosiy funksiya
bot.command('send', async (ctx) => {
    const loadingMsg = await ctx.reply("🔍 Hisobotlar yuklanmoqda...");

    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) throw error;

        // Agar hisobot bo'lmasa
        if (!data || data.length === 0) {
            return await ctx.telegram.editMessageText(
                ctx.chat.id, 
                loadingMsg.message_id, 
                null, 
                "📭 <b>Sizda hali yuborilmagan hisobotlar yo'q.</b>\nAvval ishlaringizni yozing.", 
                { parse_mode: 'HTML' }
            );
        }

        // Ro'yxatni shakllantirish
        let reportText = `📋 <b>Bugungi ishlaringiz ro'yxati:</b>\n\n`;
        data.forEach((item, index) => {
            reportText += `<b>${index + 1}.</b> ${escapeHTML(item.content)}\n`;
        });

        // WebApp URL ni aniqlash (Vercel URL avtomatik olinadi yoki qo'lda kiritiladi)
        const webAppUrl = process.env.VERCEL_URL 
            ? `${process.env.VERCEL_URL}` 
            : 'https://google.com'; // Fallback

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Guruhga yuborish", "confirm_send")],
            [Markup.button.webApp("✍️ Tahrirlash (Mini App)", webAppUrl)],
            [Markup.button.callback("❌ Bekor qilish", "cancel_preview")],
            [Markup.button.callback("🗑 Tozalash", "clear_reports")]
        ]);

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        await ctx.reply(reportText, { parse_mode: 'HTML', ...keyboard });

    } catch (err) {
        // Xatolik bo'lsa loading xabarni o'chirib xatoni chiqaramiz
        try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch(e){}
        await logError(ctx, err, "Send Command");
    }
});

// --- ACTIONS (TUGMALAR) ---

// Guruhga yuborish tasdig'i
bot.action('confirm_send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error || !data.length) {
            return ctx.answerCbQuery("Yuborish uchun ma'lumot topilmadi (balki o'chirib yuborilgandir?)");
        }

        // --- SANANI ANIQLASH 
        const dateString = new Date().toLocaleDateString('ru-RU', {
            timeZone: 'Asia/Tashkent',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
        // Hisobot matnini shakllantirish
        let finalReport = `📅 <b>#hisobot ${dateString}</b>\n` + 
                          `👤 <b>Xodim:</b> ${escapeHTML(ctx.from.first_name)}\n\n`;
        
        data.forEach((item, index) => {
            finalReport += `${index + 1}. ${escapeHTML(item.content)}\n`;
        });

        // Guruhga yuborish
        await ctx.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'HTML' });
        
        // Bazada statusni o'zgartirish
        await supabase.from('reports').update({ status: 'sent' }).eq('user_id', ctx.from.id).eq('status', 'pending');

        await ctx.editMessageText(`🚀 <b>Hisobot guruhga yuborildi!</b>\nSanasi: ${dateString}`, { parse_mode: 'HTML' });
    } catch (err) {
        await logError(ctx, err, "Confirm Send");
    }
});

bot.action('cancel_preview', async (ctx) => {
    try {
        await ctx.editMessageText("⏸ <b>Yuborish bekor qilindi.</b>", { parse_mode: 'HTML' });
    } catch (err) {
        console.error(err);
    }
});

bot.action('clear_reports', async (ctx) => {
    try {
        await supabase.from('reports').delete().eq('user_id', ctx.from.id).eq('status', 'pending');
        await ctx.editMessageText("🗑 <b>Barcha hisobotlar o'chirildi.</b>", { parse_mode: 'HTML' });
    } catch (err) {
        await logError(ctx, err, "Clear Action");
    }
});

// --- MATN XABARLARINI QABUL QILISH ---

bot.on('text', async (ctx) => {
    // Agar buyruq bo'lsa (masalan /start) ishlamaymiz, chunki ularni tepadagi handlerlar ushlaydi
    if (ctx.message.text.startsWith('/')) return;

    try {
        const { error } = await supabase
            .from('reports')
            .insert([{ user_id: ctx.from.id, content: ctx.message.text }]);

        if (error) throw error;
        
        // Oddiy "Saqlandi" xabari
        await ctx.reply("✅ Saqlandi.", { reply_to_message_id: ctx.message.message_id });
    } catch (err) {
        await logError(ctx, err, "Saving Message");
    }
});

// --- WEBHOOK SERVER ---

module.exports = async (req, res) => {
    // Vercel timeoutni oldini olish uchun
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } catch (err) {
            console.error("Update Error:", err);
            res.status(200).send('Error handled'); // Telegramga 200 qaytarish kerak, aks holda qayta yuboraveradi
        }
    } else {
        res.status(200).send('Bot is running properly!');
    }
};