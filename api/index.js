const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const moment = require('moment-timezone');
const cron = require('node-cron');

// ================== SOZLAMALAR ==================
const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const GROUP_ID = -1003076536847;
const TIMEZONE = 'Asia/Tashkent';

// ================== XOTIRA (TEMP) ==================
let db = {
    users: {},       // { userId: first_name }
    reports: {},     // { userId: [] }
    reminders: []
};

// ================== XATOLARNI USHLASH ==================
bot.catch(err => {
    console.error('❌ BOT ERROR:', err);
});

// ================== START ==================
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || "Do'stim";

    db.users[userId] = firstName;

    // Supabase — user saqlash
    await supabase
        .from('users')
        .upsert(
            { id: userId, first_name: firstName },
            { onConflict: 'id' }
        );

    ctx.reply(
        `Assalomu alaykum, <b>${firstName}</b>!\n\nKunlik qilgan ishlaringizni yozib borsangiz kun oxirida /start buyrug'i bilan kunlik natijangizni guruhga yuborishingiz mumkin.`,
        { parse_mode: 'HTML' }
    );
});

// ================== HELP ==================
bot.help((ctx) => {
    ctx.reply(
        `📌 <b>Qo‘llanma</b>\n
1️⃣ Matn yoki rasm yuboring  
2️⃣ /send → tekshirish  
3️⃣ Tasdiqlang va yuboring`,
        { parse_mode: 'HTML' }
    );
});

// ================== HISOBOT YIG‘ISH ==================
bot.on(['text', 'photo'], async (ctx, next) => {
    if (ctx.chat.type !== 'private' || (ctx.message.text && ctx.message.text.startsWith('/'))) return next();
    
    const userId = ctx.from.id;
    const type = ctx.message.photo ? 'photo' : 'text';
    const content = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : ctx.message.text;
    const caption = ctx.message.caption || '';

    // Supabase-ga yozish
    const { error } = await supabase
        .from('reports')
        .insert([{ 
            user_id: userId, 
            type: type, 
            content: content, 
            caption: caption 
        }]);
    
    if (error) {
        console.error("Supabase Error:", error);
        return ctx.reply("❌ Hisobotni saqlashda bazada xatolik yuz berdi.");
    }

    ctx.reply("📥 Muvaffaqqiyatli saqlandi.");
});

// ================== SEND (PREVIEW) ==================
bot.command('send', async (ctx) => {
    const userId = ctx.from.id;
    const reports = db.reports[userId] || [];

    if (!reports.length) {
        return ctx.reply('❗️Hisobot bo‘sh');
    }

    let preview = `📝 <b>Hisobot namunasi</b>\n\n`;
    reports.forEach((r, i) => {
        preview += `${i + 1}. ${r.type === 'text' ? r.content : '📸 Rasm'}\n`;
    });

    ctx.reply(preview + `\nTasdiqlaysizmi?`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yuborish', 'confirm_send')],
            [Markup.button.callback('❌ Bekor qilish', 'cancel_send')]
        ])
    });
});

// ================== TASDIQLASH ==================
bot.action('confirm_send', async (ctx) => {
    const userId = ctx.from.id;
    const reports = db.reports[userId] || [];
    if (!reports.length) return ctx.answerCbQuery('Bo‘sh');

    try {
        const userName = db.users[userId] || ctx.from.first_name;

        let text =
            `🌟 <b>KUNLIK HISOBOT</b>\n\n` +
            `👤 <b>Xodim:</b> ${userName}\n` +
            `📅 <b>Sana:</b> ${moment().tz(TIMEZONE).format('DD.MM.YYYY')}\n\n`;

        let media = [];

        reports.forEach((r, i) => {
            if (r.type === 'text') {
                text += `<b>${i + 1}.</b> ${r.content}\n`;
            } else {
                text += `<b>${i + 1}.</b> 📸 Rasm\n`;
                media.push({
                    type: 'photo',
                    media: r.content,
                    caption: r.caption || ''
                });
            }
        });

        // 1️⃣ Matn
        await bot.telegram.sendMessage(GROUP_ID, text, { parse_mode: 'HTML' });

        // 2️⃣ Rasmlar
        if (media.length) {
            await bot.telegram.sendMediaGroup(GROUP_ID, media);
        }

        // 3️⃣ Supabase — hisobot saqlash
        await supabase.from('reports').insert({
            user_id: userId,
            content: reports,
            sent_at: moment().tz(TIMEZONE).toISOString()
        });

        db.reports[userId] = [];

        await ctx.editMessageText(
            '✅ <b>Hisobot muvaffaqiyatli yuborildi</b>',
            { parse_mode: 'HTML' }
        );
        ctx.answerCbQuery('Yuborildi');

    } catch (e) {
        console.error(e);
        ctx.reply('❌ Xatolik yuz berdi');
    }
});

// ================== BEKOR QILISH ==================
bot.action('cancel_send', (ctx) => {
    ctx.editMessageText(
        '❌ Yuborish bekor qilindi',
        { parse_mode: 'HTML' }
    );
});

// ================== ESLATMA ==================
bot.command('remember', (ctx) => {
    const t = ctx.message.text.split(' ');
    if (t.length < 4)
        return ctx.reply('Format: /remember [DD.MM.YYYY] [HH:MM] Vazifa');

    db.reminders.push({
        userId: ctx.from.id,
        time: `${t[1]} ${t[2]}`,
        task: t.slice(3).join(' '),
        notified: false
    });

    ctx.reply('⏰ Eslatma saqlandi');
});

cron.schedule('* * * * *', () => {
    const now = moment().tz(TIMEZONE).format('DD.MM.YYYY HH:mm');
    db.reminders.forEach(r => {
        if (r.time === now && !r.notified) {
            bot.telegram.sendMessage(
                r.userId,
                `🔔 <b>Eslatma</b>\n${r.task}`,
                { parse_mode: 'HTML' }
            );
            r.notified = true;
        }
    });
});

// bot.launch() 
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body); // Telegramdan kelgan xabarni qayta ishlash
            return res.status(200).send('OK');
        } catch (err) {
            console.error(err);
            return res.status(500).send('Xato');
        }
    }
    res.status(200).send("Bot serveri ishlamoqda..."); // Brauzerda ochganda ko'rinadi
};
console.log('🚀 Bot ishga tushdi');
