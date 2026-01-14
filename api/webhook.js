const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ================== SOZLAMALAR ==================
const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const GROUP_ID = -1003076536847;

// ================== XATOLARNI USHLASH ==================
bot.catch((err, ctx) => {
    console.error(`❌ Error for update ${ctx.update.update_id}:`, err);
    ctx.reply("Botda ichki xatolik yuz berdi. Iltimos, @uyqur_nurali ga murojaat qiling.");
});

// ================== START ==================
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || "Do'stim";
    const username = ctx.from.username || null;

    try {
        // Supabase — user saqlash
        const { error } = await supabase
            .from('users')
            .upsert(
                { 
                    id: userId, 
                    first_name: firstName,
                    username: username,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'id' }
            );

        if (error) throw error;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.webApp('📊 Hisobotlarim', `${process.env.WEBAPP_URL}`)],
            [Markup.button.callback('📖 Qo\'llanma', 'show_help')]
        ]);

        ctx.reply(
            `Assalomu alaykum, <b>${firstName}</b>! 👋\n\n` +
            `🎯 <b>Uyqu'r Yordamchi</b> botiga xush kelibsiz!\n\n` +
            `Bu bot orqali siz kunlik ishlaringizni kuzatib borishingiz mumkin.\n\n` +
            `<b>Qanday ishlaydi?</b>\n` +
            `• Matn yoki rasm yuboring\n` +
            `• /send buyrug'i bilan tekshiring\n` +
            `• Tasdiqlang va guruhga yuboring\n\n` +
            `📱 Mini App orqali barcha hisobotlaringizni ko'rishingiz mumkin!`,
            { 
                parse_mode: 'HTML',
                ...keyboard
            }
        );
    } catch (err) {
        console.error('Start error:', err);
        ctx.reply('❌ Kutilmagan xatolik yuz berdi. Iltimos, @uyqur_nurali ga murojaat qiling.');
    }
});

// ================== HELP ==================
bot.help(async (ctx) => {
    await sendHelpMessage(ctx);
});

bot.action('show_help', async (ctx) => {
    await ctx.answerCbQuery();
    await sendHelpMessage(ctx);
});

async function sendHelpMessage(ctx) {
    const helpText = 
        `📌 <b>Qo'llanma</b>\n\n` +
        `<b>Hisobot qo'shish:</b>\n` +
        `• Oddiy matn yuboring\n` +
        `• Rasm yuboring (caption bilan yoki bo'lmasdan)\n` +
        `• Bir nechta element qo'shishingiz mumkin\n\n` +
        `<b>Buyruqlar:</b>\n` +
        `/send - Hisobotlarni ko'rish va guruhga yuborish\n` +
        `/stats - Statistikangizni ko'rish\n` +
        `/clear - Yuborilmagan hisobotlarni o'chirish\n` +
        `/help - Bu qo'llanmani ko'rish\n\n` +
        `<b>Mini App:</b>\n` +
        `Barcha hisobotlaringizni ko'rish va boshqarish uchun pastdagi tugmani bosing! 👇`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.webApp('📱 Mini App ochish', `${process.env.WEBAPP_URL}`)]
    ]);

    if (ctx.callbackQuery) {
        await ctx.editMessageText(helpText, { 
            parse_mode: 'HTML',
            ...keyboard
        });
    } else {
        await ctx.reply(helpText, { 
            parse_mode: 'HTML',
            ...keyboard
        });
    }
}

// ================== HISOBOT YIG'ISH ==================
bot.on(['text', 'photo'], async (ctx, next) => {
    // Buyruqlarni o'tkazib yuborish
    if (ctx.chat.type !== 'private' || (ctx.message.text && ctx.message.text.startsWith('/'))) {
        return next();
    }

    const userId = ctx.from.id;
    const type = ctx.message.photo ? 'photo' : 'text';
    const content = ctx.message.photo 
        ? ctx.message.photo[ctx.message.photo.length - 1].file_id 
        : ctx.message.text;
    const caption = ctx.message.caption || '';

    try {
        const { error } = await supabase
            .from('reports')
            .insert([{
                user_id: userId,
                type: type,
                content: content,
                caption: caption,
                created_at: new Date().toISOString()
            }]);

        if (error) throw error;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📤 Yuborish', 'quick_send')],
            [Markup.button.webApp('📱 Mini App', `${process.env.WEBAPP_URL}`)]
        ]);

        await ctx.reply(
            `✅ Saqlandi!\n\n` +
            `${type === 'photo' ? '📸 Rasm' : '📝 Matn'} hisobotga qo'shildi.\n\n` +
            `Guruhga yuborish uchun /send ni bosing.`,
            keyboard
        );
    } catch (err) {
        console.error('Insert error:', err);
        ctx.reply("❌ Saqlashda xatolik. Qaytadan urinib ko'ring.");
    }
});

// ================== SEND (PREVIEW) ==================
bot.command('send', async (ctx) => {
    await showReportPreview(ctx);
});

bot.action('quick_send', async (ctx) => {
    await ctx.answerCbQuery();
    await showReportPreview(ctx);
});

async function showReportPreview(ctx) {
    const userId = ctx.from.id;

    try {
        const { data: reports, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', userId)
            .is('sent_at', null)
            .order('created_at', { ascending: true });

        if (error) throw error;

        if (!reports || reports.length === 0) {
            return ctx.reply(
                '📭 Yuborilmagan hisobotlar topilmadi.\n\n' +
                'Yangi hisobot qo\'shish uchun matn yoki rasm yuboring.'
            );
        }

        let preview = `📋 <b>Yuborilmagan hisobotlar</b>\n`;
        preview += `━━━━━━━━━━━━━━━━━\n`;
        preview += `Jami: <b>${reports.length}</b> ta element\n\n`;

        let textCount = 0;
        let photoCount = 0;

        reports.forEach((r, i) => {
            if (r.type === 'text') {
                textCount++;
                const shortText = r.content.length > 50 
                    ? r.content.substring(0, 50) + '...' 
                    : r.content;
                preview += `${textCount}. 📝 ${shortText}\n`;
            } else {
                photoCount++;
                const caption = r.caption ? r.caption : 'Rasm';
                preview += `${photoCount}. 📸 ${caption}\n`;
            }
        });

        preview += `\n━━━━━━━━━━━━━━━━━\n`;
        preview += `📝 Matnlar: ${textCount} ta\n`;
        preview += `📸 Rasmlar: ${photoCount} ta\n\n`;
        preview += `Guruhga yuborasizmi?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Ha, yuborish', 'confirm_send')],
            [Markup.button.callback('❌ Yo\'q, bekor qilish', 'cancel_send')]
        ]);

        if (ctx.callbackQuery) {
            await ctx.editMessageText(preview, {
                parse_mode: 'HTML',
                ...keyboard
            });
        } else {
            await ctx.reply(preview, {
                parse_mode: 'HTML',
                ...keyboard
            });
        }
    } catch (err) {
        console.error('Preview error:', err);
        ctx.reply('❌ Xatolik yuz berdi. Qaytadan urinib ko\'ring.');
    }
}

// ================== TASDIQLASH ==================
bot.action('confirm_send', async (ctx) => {
    await ctx.answerCbQuery('Yuborilmoqda...');
    
    const userId = ctx.from.id;

    try {
        const { data: reports, error: fetchError } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', userId)
            .is('sent_at', null)
            .order('created_at', { ascending: true });

        if (fetchError || !reports || reports.length === 0) {
            return ctx.editMessageText('❌ Yuborish uchun hisobotlar topilmadi.');
        }

        const userName = ctx.from.first_name || "Do'stim";
        const now = new Date();
        const dateStr = now.toLocaleDateString('uz-UZ', { 
            day: '2-digit', 
            month: '2-digit', 
            year: 'numeric' 
        });
        const timeStr = now.toLocaleTimeString('uz-UZ', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        let reportText =
            `📊 <b>KUNLIK ISH HISOBOTI</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>Xodim:</b> ${userName}\n` +
            `📅 <b>Sana:</b> ${dateStr}\n` +
            `⏰ <b>Vaqt:</b> ${timeStr}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📝 <b>Bajarilgan ishlar:</b>\n\n`;

        let mediaGroup = [];
        let textCount = 0;

        reports.forEach((item, index) => {
            if (item.type === 'text') {
                textCount++;
                reportText += `${textCount}. ${item.content}\n\n`;
            } else if (item.type === 'photo') {
                mediaGroup.push({
                    type: 'photo',
                    media: item.content,
                    caption: item.caption || `📸 Rasm #${mediaGroup.length + 1}`
                });
            }
        });

        if (textCount === 0 && mediaGroup.length > 0) {
            reportText += `<i>(Faqat media hisobotlar)</i>\n\n`;
        }

        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        reportText += `✅ Jami: ${reports.length} ta element`;

        // Guruhga yuborish
        await bot.telegram.sendMessage(GROUP_ID, reportText, { parse_mode: 'HTML' });

        // Rasmlarni yuborish
        if (mediaGroup.length > 0) {
            for (let i = 0; i < mediaGroup.length; i += 10) {
                const chunk = mediaGroup.slice(i, i + 10);
                await bot.telegram.sendMediaGroup(GROUP_ID, chunk);
            }
        }

        // Bazada yangilash
        const { error: updateError } = await supabase
            .from('reports')
            .update({ sent_at: now.toISOString() })
            .eq('user_id', userId)
            .is('sent_at', null);

        if (updateError) throw updateError;

        await ctx.editMessageText(
            `✅ <b>Muvaffaqiyatli yuborildi!</b>\n\n` +
            `📊 Jami ${reports.length} ta element guruhga yuborildi.\n` +
            `⏰ Vaqt: ${timeStr}\n\n` +
            `Yangi hisobot qo'shishingiz mumkin!`,
            { parse_mode: 'HTML' }
        );

    } catch (e) {
        console.error('Send error:', e);
        ctx.editMessageText('❌ Yuborishda xatolik. Qaytadan urinib ko\'ring.');
    }
});

// ================== BEKOR QILISH ==================
bot.action('cancel_send', async (ctx) => {
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.editMessageText(
        '❌ Yuborish bekor qilindi.\n\n' +
        'Hisobotlaringiz saqlanib qoldi.',
        { parse_mode: 'HTML' }
    );
});

// ================== STATISTIKA ==================
bot.command('stats', async (ctx) => {
    const userId = ctx.from.id;

    try {
        const { count: totalCount } = await supabase
            .from('reports')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);

        const { count: sentCount } = await supabase
            .from('reports')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .not('sent_at', 'is', null);

        const { count: pendingCount } = await supabase
            .from('reports')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .is('sent_at', null);

        ctx.reply(
            `📊 <b>Sizning statistikangiz</b>\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `📝 Jami hisobotlar: <b>${totalCount || 0}</b>\n` +
            `✅ Yuborilgan: <b>${sentCount || 0}</b>\n` +
            `⏳ Kutilmoqda: <b>${pendingCount || 0}</b>\n\n` +
            `Davom eting! 💪`,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('Stats error:', err);
        ctx.reply('❌ Statistikani olishda xatolik.');
    }
});

// ================== TOZALASH ==================
bot.command('clear', async (ctx) => {
    const userId = ctx.from.id;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha, o\'chirish', 'confirm_clear')],
        [Markup.button.callback('❌ Yo\'q', 'cancel_clear')]
    ]);

    ctx.reply(
        '⚠️ Yuborilmagan barcha hisobotlarni o\'chirmoqchimisiz?\n\n' +
        'Bu amalni ortga qaytarib bo\'lmaydi!',
        keyboard
    );
});

bot.action('confirm_clear', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;

    try {
        const { error } = await supabase
            .from('reports')
            .delete()
            .eq('user_id', userId)
            .is('sent_at', null);

        if (error) throw error;

        await ctx.editMessageText(
            '✅ Barcha yuborilmagan hisobotlar o\'chirildi.\n\n' +
            'Yangi hisobotlar qo\'shishingiz mumkin!'
        );
    } catch (err) {
        console.error('Clear error:', err);
        ctx.editMessageText('❌ O\'chirishda xatolik.');
    }
});

bot.action('cancel_clear', async (ctx) => {
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.editMessageText('❌ O\'chirish bekor qilindi.');
});

// ================== WEBHOOK HANDLER ==================
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('Uyqur Yordamchi bot is active.');
        }
    } catch (err) {
        console.error('❌ Webhook error:', err);
        res.status(200).send('Error handled');
    }
};