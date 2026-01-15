const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Bot buyruqlari tavsifi (Telegram menyusida ko'rinadi)
bot.telegram.setMyCommands([
    { command: 'start', description: 'Botni ishga tushirish' },
    { command: 'send', description: 'Hisobotni ko\'rish va guruhga yuborish' },
    { command: 'clear', description: 'Yozilgan hisobotlarni ochirish' },
    { command: 'help', description: 'Yordam va yo\'riqnoma' }
]);

// Markazlashgan xato loger
const logError = async (ctx, err, stage) => {
    console.error(`Error at ${stage}:`, err);
    const msg = `❌ *Xatolik yuz berdi (${stage})*\n\nTexnik xato: \`${err.message}\` \nIltimos, administratorga murojaat qiling.`;
    if (ctx.callbackQuery) {
        await ctx.answerCbQuery("Xatolik yuz berdi!");
    }
    return ctx.replyWithMarkdown(msg);
};

// --- BUYRUQLAR ---

bot.start((ctx) => {
    const welcomeMsg = `👋 *Assalomu alaykum, ${ctx.from.first_name}!*\n\n` +
        `Men kunlik hisobotlarni yig'uvchi botman.\n\n` +
        `📝 *Qanday foydalanish kerak?*\n` +
        `1. Shunchaki bajargan ishlaringizni xabar sifatida yozing.\n` +
        `2. Bot ularni avtomatik saqlab boradi.\n` +
        `3. Kun oxirida /send buyrug'ini bosing.\n` +
        `4. Hammasi tayyor bo'lsa, tasdiqlang va guruhga yuboring.`;
    ctx.replyWithMarkdown(welcomeMsg);
});

bot.command('help', (ctx) => {
    const helpText = `📖 *Bot buyruqlari bo'yicha qo'llanma:*\n\n` +
        `/send - Hozirgi to'plangan hisobotlarni ko'rish va boshqarish paneli.\n` +
        `/clear - To'plangan (yuborilmagan) barcha ishlarni o'chirib tashlash.\n` +
        `*Mini App* - Tahrirlash tugmasi orqali ishlarni bittalab o'zgartirish mumkin.`;
    ctx.replyWithMarkdown(helpText);
});

// Hisobotni saqlash
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    try {
        const { error } = await supabase
            .from('reports')
            .insert([{ user_id: ctx.from.id, content: ctx.message.text }]);

        if (error) throw error;
        ctx.reply("✅ Saqlandi. Yana yozishingiz mumkin.");
    } catch (err) {
        await logError(ctx, err, "Saving Report");
    }
});

// Hisobotni boshqarish paneli
bot.command('send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) throw error;

        if (!data || data.length === 0) {
            return ctx.reply("📭 Sizda hali yuborilmagan hisobotlar yo'q. Avval bajargan ishlaringizni yozing.");
        }

        let reportText = `📝 *Sizning hisobotingiz:* \n\n`;
        data.forEach((item, index) => {
            reportText += `📍 ${item.content}\n`;
        });

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("🚀 Guruhga yuborish", "confirm_send")],
            [Markup.button.webApp("✍️ Tahrirlash (Mini App)", `https://${process.env.VERCEL_URL}`)],
            [Markup.button.callback("🗑 Tozalash", "clear_reports")]
        ]);

        ctx.replyWithMarkdown(reportText, keyboard);
    } catch (err) {
        await logError(ctx, err, "Generating Preview");
    }
});

// Guruhga yuborish tasdig'i
bot.action('confirm_send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending');

        if (error) throw error;
        if (data.length === 0) return ctx.answerCbQuery("Hisobotlar topilmadi.");

        let finalReport = `📅 *KUNLIK HISOBOT*\n👤 *Xodim:* ${ctx.from.first_name}\n` +
                          `──────────────────\n`;
        data.forEach((item, index) => {
            finalReport += `${index + 1}. ${item.content}\n`;
        });
        finalReport += `──────────────────\n✅ #hisobot`;

        if (!process.env.GROUP_ID) {
            throw new Error("GROUP_ID konfiguratsiyasi topilmadi!");
        }

        await ctx.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'Markdown' });

        // Statusni yangilash
        await supabase.from('reports').update({ status: 'sent' }).eq('user_id', ctx.from.id).eq('status', 'pending');

        await ctx.editMessageText("🚀 Hisobot muvaffaqiyatli yuborildi!");
    } catch (err) {
        await logError(ctx, err, "Sending to Group");
    }
});

// Tozalash buyrug'i (callback va command sifatida)
const clearAction = async (ctx) => {
    try {
        await supabase.from('reports').delete().eq('user_id', ctx.from.id).eq('status', 'pending');
        const msg = "🗑 Barcha yozilgan hisobotlar tozalandi.";
        if (ctx.callbackQuery) {
            ctx.editMessageText(msg);
        } else {
            ctx.reply(msg);
        }
    } catch (err) {
        await logError(ctx, err, "Clearing Reports");
    }
};

bot.command('clear', clearAction);
bot.action('clear_reports', clearAction);

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } catch (err) {
            console.error(err);
            res.status(500).send('Internal Server Error');
        }
    } else {
        res.status(200).send('Bot is running...');
    }
};