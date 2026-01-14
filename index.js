const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const moment = require('moment-timezone');

const bot = new Telegraf('8501321491:AAEqW6J7J2QFxYqX9Xz05VxvRAB1RIGbF70');

let db = {
    users: {},
    reports: {},
    reminders: []
};

const UYQUR_GROUP_ID = -1003076536847; 
const TIMEZONE = 'Asia/Tashkent';

// --- XATOLIKLAR ---
bot.catch((err) => console.error(`❌ Xatolik:`, err));

// --- START & HELP ---
bot.start((ctx) => {
    db.users[ctx.from.id] = ctx.from.first_name || "Do'stim";
    ctx.reply(`Assalomu alaykum, <b>${db.users[ctx.from.id]}</b>! Hisobotlarni yozishni boshlashingiz mumkin.`, { parse_mode: 'HTML' });
});

bot.help((ctx) => {
    ctx.reply(`📌 <b>Qo'llanma:</b>\n\n1. Hisobot elementlarini (matn/rasm) botga yozing.\n2. <code>/send</code> buyrug'ini bering.\n3. Bot ko'rsatgan namunani tekshirib, "Tasdiqlash" tugmasini bosing.`, { parse_mode: 'HTML' });
});

// --- HISOBOTNI YIG'ISH ---
bot.on(['text', 'photo'], (ctx, next) => {
    if (ctx.chat.type !== 'private' || (ctx.message.text && ctx.message.text.startsWith('/'))) return next();

    const userId = ctx.from.id;
    if (!db.reports[userId]) db.reports[userId] = [];

    db.reports[userId].push({
        type: ctx.message.photo ? 'photo' : 'text',
        content: ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : ctx.message.text,
        caption: ctx.message.caption || ''
    });
    ctx.reply("📥 Qo'shildi.");
});

// --- SEND BUYRUG'I (PREVIEW BOSQICHI) ---
bot.hears(/^\/send$/i, async (ctx) => {
    const userId = ctx.from.id;
    const reports = db.reports[userId] || [];

    if (reports.length === 0) return ctx.reply("Yuborish uchun ma'lumot yo'q!");

    // Preview tayyorlash
    let previewText = `📝 <b>Hisobotingiz namunasi:</b>\n\n`;
    reports.forEach((item, i) => {
        previewText += `${i + 1}. ${item.type === 'text' ? item.content : '[🖼 Rasm] ' + (item.caption || '')}\n`;
    });

    ctx.reply(previewText + `\n🚀 <b>Guruhga yuborishni tasdiqlaysizmi?</b>`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback("✅ Tasdiqlash va Yuborish", "confirm_send")],
            [Markup.button.callback("❌ Bekor qilish", "cancel_send")]
        ])
    });
});

// --- TASDIQLASH VA GURUHGA YUBORISH (YANGILANGAN) ---
bot.action('confirm_send', async (ctx) => {
    const userId = ctx.from.id;
    const reports = db.reports[userId] || [];

    if (reports.length === 0) {
        return ctx.answerCbQuery("Hisobot bo'sh, yuborib bo'lmaydi.");
    }

    try {
        const userName = db.users[userId] || ctx.from.first_name;
        
        // 1. Hisobot matnini tayyorlash (Bitta xabarga yig'ish)
        let reportMessage = `🌟 <b>KUNLIK HISOBOT</b> 🌟\n\n` +
                            `👤 <b>Xodim:</b> ${userName}\n` +
                            `📅 <b>Sana:</b> ${moment().tz(TIMEZONE).format('DD.MM.YYYY')}\n` +
                            `━━━━━━━━━━━━━━━━━━\n\n`;

        // Rasmlarni alohida albom qilish uchun yig'amiz
        let mediaGroup = [];

        reports.forEach((item, index) => {
            if (item.type === 'text') {
                // Matnli vazifalar
                reportMessage += `<b>${index + 1}.</b> ${item.content}\n`;
            } else {
                // Rasmli vazifalar (Matnda ko'rsatib ketamiz)
                reportMessage += `<b>${index + 1}.</b> 📸 <i>Rasm ilova qilindi</i> ${item.caption ? `(${item.caption})` : ''}\n`;
                
                // Rasmni albomga qo'shamiz
                mediaGroup.push({
                    type: 'photo',
                    media: item.content,
                    caption: item.caption ? `🖼 ${index + 1}-vazifa: ${item.caption}` : `🖼 ${index + 1}-vazifa`
                });
            }
        });

        reportMessage += `\n━━━━━━━━━━━━━━━━━━\n✅ <b>Hisobot yakunlandi.</b>`;

        // 2. Katta matnni guruhga yuborish
        await bot.telegram.sendMessage(UYQUR_GROUP_ID, reportMessage, { parse_mode: 'HTML' });

        // 3. Agar rasmlar bo'lsa, ularni albom qilib yuborish
        if (mediaGroup.length > 0) {
            // Telegramda bir vaqtda maksimum 10 ta rasm albom bo'la oladi
            // Agar 10 tadan ko'p bo'lsa bo'lib yuborish kerak (hozircha oddiy holat)
            await bot.telegram.sendMediaGroup(UYQUR_GROUP_ID, mediaGroup);
        }

        // 4. Muvaffaqiyatli yakunlash
        db.reports[userId] = []; // Bazani tozalash
        await ctx.editMessageText("🚀 <b>Hisobot guruhga yaxlit shaklda yuborildi!</b>", { parse_mode: 'HTML' });
        ctx.answerCbQuery("Yuborildi!");

    } catch (e) {
        console.error("Guruhga yuborishda xato:", e);
        ctx.reply(`❌ Xatolik: ${e.message}`);
    }
});

// --- BEKOR QILISH ---
bot.action('cancel_send', (ctx) => {
    ctx.editMessageText("❌ <b>Yuborish bekor qilindi.</b> Ma'lumotlar saqlanib qoldi, tahrirlashingiz mumkin.", { parse_mode: 'HTML' });
});

// --- MY REPORT (KO'RISH VA O'CHIRISH) ---
bot.command('my_report', (ctx) => {
    const reports = db.reports[ctx.from.id] || [];
    if (reports.length === 0) return ctx.reply("Hisobot bo'sh.");
    
    reports.forEach((item, index) => {
        ctx.reply(`${index + 1}. ${item.type === 'text' ? item.content : '[Rasm]'}`, 
        Markup.inlineKeyboard([Markup.button.callback("❌ O'chirish", `del_${index}`)]));
    });
});

bot.action(/del_(\d+)/, (ctx) => {
    const index = parseInt(ctx.match[1]);
    if (db.reports[ctx.from.id]) {
        db.reports[ctx.from.id].splice(index, 1);
        ctx.editMessageText("🗑 O'chirildi.");
    }
});

// --- REMEMBER (ESLATMA) ---
bot.command('remember', (ctx) => {
    const t = ctx.message.text.split(' ');
    if (t.length < 4) return ctx.reply("Format: /remember 15.01.2026 14:00 Vazifa");
    db.reminders.push({ userId: ctx.from.id, time: `${t[1]} ${t[2]}`, task: t.slice(3).join(' '), notified: false });
    ctx.reply("✅ Eslatma saqlandi.");
});

cron.schedule('* * * * *', () => {
    const now = moment().tz(TIMEZONE).format('DD.MM.YYYY HH:mm');
    db.reminders.forEach(rem => {
        if (rem.time === now && !rem.notified) {
            bot.telegram.sendMessage(rem.userId, `🔔 <b>ESLATMA:</b>\n\n📍 ${rem.task}`, { parse_mode: 'HTML' });
            rem.notified = true;
        }
    });
});

bot.launch().then(() => console.log("🚀 Uyqur Yordamchi MVP+ ishga tushdi..."));