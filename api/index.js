const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Markazlashgan xato loger (Telegramga xabar yuboradi)
const logError = async (ctx, err, stage) => {
    console.error(`Error at ${stage}:`, err);
    const msg = `❌ *Xatolik yuz berdi (${stage})*\n\nTexnik xato: \`${err.message}\``;
    try {
        return await ctx.reply(msg);
    } catch (e) {
        console.error("Xabarni yuborib bo'lmadi", e);
    }
};

bot.start((ctx) => {
    ctx.reply(`👋 *Assalomu alaykum, ${ctx.from.first_name}!* \nIshlaringizni ketma-ket yozib qoldiring.`);
});

// Hisobotni saqlash
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    try {
        const { error } = await supabase
            .from('reports')
            .insert([{ user_id: ctx.from.id, content: ctx.message.text }]);
        if (error) throw error;
        ctx.reply("✅ Saqlandi.");
    } catch (err) {
        await logError(ctx, err, "Saving Report");
    }
});

// /send buyrug'i - Hisobotni ko'rib chiqish
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
            return ctx.reply("📭 Yuborish uchun hisobotlar topilmadi.");
        }

        // Chiroyli column formatidagi ro'yxat
        let reportText = `📋 *Bugungi ishlaringiz ro'yxati:*\n\n`;
        data.forEach((item, index) => {
            // Markdown xatoligini oldini olish uchun matnni tozalash oddiyroq usuli
            const cleanContent = item.content.replace(/[*_`]/g, ''); 
            reportText += `*${index + 1}.* ${cleanContent}\n`;
        });

        const webAppUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://google.com';

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Tayyor, guruhga yuborish", "confirm_send")],
            [Markup.button.webApp("✍️ Tahrirlash", webAppUrl)],
            [Markup.button.callback("❌ Bekor qilish", "cancel_preview")],
            [Markup.button.callback("🗑 Hammasini o'chirish", "clear_reports")]
        ]);

        ctx.reply(reportText, keyboard);
    } catch (err) {
        await logError(ctx, err, "Send Command");
    }
});

// Guruhga yuborish tasdig'i
bot.action('confirm_send', async (ctx) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', ctx.from.id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error || !data.length) throw new Error("Hisobotlar topilmadi");

        let finalReport = `📅 *KUNLIK HISOBOT*\n👤 *Xodim:* ${ctx.from.first_name}\n` +
                          `──────────────────\n`;
        data.forEach((item, index) => {
            finalReport += `${index + 1}. ${item.content}\n`;
        });
        finalReport += `──────────────────\n✅ #hisobot`;

        await ctx.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'Markdown' });
        
        // Statusni yuborildi (sent) ga o'zgartirish
        await supabase.from('reports').update({ status: 'sent' }).eq('user_id', ctx.from.id).eq('status', 'pending');

        await ctx.editMessageText("🚀 Hisobot guruhga yuborildi!");
    } catch (err) {
        await logError(ctx, err, "Confirm Send Action");
    }
});

// Bekor qilish (Ma'lumot o'chmaydi, shunchaki preview yopiladi)
bot.action('cancel_preview', async (ctx) => {
    try {
        await ctx.editMessageText("⏸ Yuborish bekor qilindi. Ishlarni yozishda davom etishingiz mumkin.");
    } catch (err) {
        console.error(err);
    }
});

// Tozalash (Hammasini o'chirib tashlash)
bot.action('clear_reports', async (ctx) => {
    try {
        await supabase.from('reports').delete().eq('user_id', ctx.from.id).eq('status', 'pending');
        await ctx.editMessageText("🗑 Barcha hisobotlar o'chirildi.");
    } catch (err) {
        await logError(ctx, err, "Clear Action");
    }
});

// Vercel Webhook handler
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