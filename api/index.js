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
        `Assalomu alaykum, <b>${firstName}</b>!\n\nKunlik qilgan ishlaringizni yozib borsangiz kun oxirida /send buyrug'i bilan kunlik natijangizni guruhga yuborishingiz mumkin.`,
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
    // Buyruqlarni o'tkazib yuborish
    if (ctx.chat.type !== 'private' || (ctx.message.text && ctx.message.text.startsWith('/'))) return next();

    const userId = ctx.from.id;
    const type = ctx.message.photo ? 'photo' : 'text';
    const content = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : ctx.message.text;
    const caption = ctx.message.caption || '';

    try {
        // Supabase-ga to'g'ridan-to'g'ri yozish
        const { error } = await supabase
            .from('reports')
            .insert([{
                user_id: userId,
                type: type,
                content: content,
                caption: caption
            }]);

        if (error) throw error; // Agar Supabase xato qaytarsa catch blokiga o'tadi

        ctx.reply("📥 Saqlandi. Mini App orqali ko'rishingiz mumkin.");
    } catch (err) {
        console.error('Supabase Error:', err);
        ctx.reply("❌ Hisobotni saqlashda bazada xatolik yuz berdi.");
    }
});

// ================== SEND (PREVIEW) ==================
bot.command('send', async (ctx) => {
    const userId = ctx.from.id;

    // Supabase-dan ushbu userning oxirgi hisobotlarini olamiz
    const { data: reports, error } = await supabase
        .from('reports')
        .select('*')
        .eq('user_id', userId)
        .is('sent_at', null); // Faqat hali guruhga yuborilmaganlarini olamiz

    if (error || !reports || reports.length === 0) {
        return ctx.reply('❗️ Hisobot bo‘sh. Avval ma\'lumot yuboring.');
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

    // 1. Bazadan hali yuborilmagan (sent_at IS NULL) hisobotlarni olish
    const { data: reports, error: fetchError } = await supabase
        .from('reports')
        .select('*')
        .eq('user_id', userId)
        .is('sent_at', null)
        .order('created_at', { ascending: true });

    if (fetchError || !reports || reports.length === 0) {
        return ctx.answerCbQuery('Yuborish uchun yangi hisobotlar topilmadi!', { show_alert: true });
    }

    try {
        const userName = ctx.from.first_name || "Xodim";
        const now = moment().tz(TIMEZONE);
        
        // Chiroyli sarlavha
        let reportText = 
            `📊 <b>KUNLIK ISH HISOBOTI</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>Xodim:</b> ${userName}\n` +
            `📅 <b>Sana:</b> ${now.format('DD.MM.YYYY')}\n` +
            `⏰ <b>Vaqt:</b> ${now.format('HH:mm')}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📝 <b>Bajarilgan ishlar:</b>\n`;

        let mediaGroup = [];
        let textCount = 0;

        // Hisobotlarni tartiblash
        reports.forEach((item, index) => {
            if (item.type === 'text') {
                textCount++;
                reportText += `<b>${textCount}.</b> ${item.content}\n`;
            } else if (item.type === 'photo') {
                mediaGroup.push({
                    type: 'photo',
                    media: item.content,
                    caption: item.caption ? `📸 ${item.caption}` : `📸 Rasm #${index + 1}`
                });
            }
        });

        if (textCount === 0 && mediaGroup.length > 0) {
            reportText += `<i>(Faqat media hisobotlar yuborildi)</i>\n`;
        }

        // 2. Guruhga matnli hisobotni yuborish
        await bot.telegram.sendMessage(GROUP_ID, reportText, { parse_mode: 'HTML' });

        // 3. Agar rasmlar bo'lsa, ularni alohida Albom ko'rinishida yuborish
        if (mediaGroup.length > 0) {
            // Telegram bitta xabarda max 10 ta rasm yubora oladi
            const chunks = [];
            for (let i = 0; i < mediaGroup.length; i += 10) {
                chunks.push(mediaGroup.slice(i, i + 10));
            }
            
            for (const chunk of chunks) {
                await bot.telegram.sendMediaGroup(GROUP_ID, chunk);
            }
        }

        // 4. Bazada ushbu hisobotlarni "yuborildi" deb belgilash
        const { error: updateError } = await supabase
            .from('reports')
            .update({ sent_at: now.toISOString() })
            .eq('user_id', userId)
            .is('sent_at', null);

        if (updateError) throw updateError;

        // Foydalanuvchiga tasdiq xabari
        await ctx.editMessageText(
            `✅ <b>Hisobot guruhga muvaffaqiyatli yuborildi!</b>\n\n` +
            `Barcha elementlar arxivlandi.`,
            { parse_mode: 'HTML' }
        );

        ctx.answerCbQuery('Muvaffaqiyatli yuborildi');

    } catch (e) {
        console.error('Yuborishda xatolik:', e);
        ctx.reply('❌ Hisobotni guruhga yuborishda texnik xatolik yuz berdi.');
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
