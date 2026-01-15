/***********************
 *  DEPENDENCIES
 ***********************/
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

/***********************
 *  INIT
 ***********************/
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ADMIN_ID = 7894854944;

/***********************
 *  HELPERS
 ***********************/
const clickupRequest = async (endpoint, method = 'GET', body = null) => {
  const res = await fetch(`https://api.clickup.com/api/v2/${endpoint}`, {
    method,
    headers: {
      Authorization: process.env.CLICKUP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error: ${text}`);
  }

  return res.json();
};

const escapeHTML = (str = '') =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/***********************
 *  CLICKUP WEBHOOK
 ***********************/
const processedWebhooks = new Set();
const ALLOWED_EVENTS = [
  'taskCreated',
  'taskUpdated',
  'taskAssigneeAdded',
];

async function handleClickUpWebhook(req) {
  const { event, task_id, webhook_id } = req.body || {};
  if (!event || !task_id || !webhook_id) return;
  if (!ALLOWED_EVENTS.includes(event)) return;

  const key = `${webhook_id}_${task_id}_${event}`;
  if (processedWebhooks.has(key)) return;
  processedWebhooks.add(key);
  setTimeout(() => processedWebhooks.delete(key), 60_000);

  try {
    // ClickUp bazasi yangilanishi uchun
    await new Promise((r) => setTimeout(r, 1500));

    const task = await clickupRequest(`task/${task_id}`);
    if (!task?.name || !Array.isArray(task.assignees)) return;

    const status =
      task.status?.status?.toUpperCase() || 'NO STATUS';

    for (const assignee of task.assignees) {
      const { data: userMap } = await supabase
        .from('users_mapping')
        .select('telegram_id')
        .eq('clickup_user_id', String(assignee.id))
        .maybeSingle();

      if (!userMap?.telegram_id) continue;

      const text =
        `📌 <b>ClickUp vazifa</b>\n\n` +
        `<b>Nomi:</b> ${escapeHTML(task.name)}\n` +
        `<b>Status:</b> ${status}\n\n` +
        `<a href="${task.url}">🔗 ClickUp'da ochish</a>`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Jarayonda', `cu_process_${task_id}`)],
        [Markup.button.callback('✅ Yakunlash', `cu_done_${task_id}`)],
      ]);

      await bot.telegram.sendMessage(userMap.telegram_id, text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `❌ ClickUp webhook xato:\n${err.message}`
    );
  }
}

/***********************
 *  TELEGRAM COMMANDS
 ***********************/
bot.start(async (ctx) => {
  await ctx.reply(
    `Assalomu alaykum, <b>${escapeHTML(
      ctx.from.first_name
    )}</b>!\n\n📖 Buyruqlar: /help`,
    { parse_mode: 'HTML' }
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `🛠 <b>Bot imkoniyatlari:</b>\n\n` +
      `/bind – ClickUp user bog‘lash (admin)\n` +
      `/send – Hisobot yuborish\n\n` +
      `📌 ClickUp vazifalari avtomatik keladi.`,
    { parse_mode: 'HTML' }
  );
});

/***********************
 *  ADMIN BIND
 ***********************/
bot.command('bind', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID)
    return ctx.reply('❌ Siz admin emassiz');

  const [, tg, cu, ...name] = ctx.message.text.split(' ');
  if (!tg || !cu || !name.length)
    return ctx.reply('Format: /bind TG_ID CLICKUP_ID Ism');

  const { error } = await supabase.from('users_mapping').upsert({
    telegram_id: Number(tg),
    clickup_user_id: String(cu),
    full_name: name.join(' '),
  });

  if (error) ctx.reply(`❌ ${error.message}`);
  else ctx.reply('✅ Muvaffaqiyatli bog‘landi');
});

/***********************
 *  CLICKUP ACTIONS
 ***********************/
bot.action(/cu_(process|done)_(.+)/, async (ctx) => {
  const [, action, taskId] = ctx.match;

  try {
    const status = action === 'process' ? 'in progress' : 'complete';
    await clickupRequest(`task/${taskId}`, 'PUT', { status });

    if (action === 'done') {
      const task = await clickupRequest(`task/${taskId}`);
      await supabase.from('reports').insert({
        user_id: ctx.from.id,
        content: `(ClickUp) ${task.name}`,
        status: 'pending',
      });

      await ctx.editMessageText(
        '✅ Vazifa yakunlandi va hisobotga qo‘shildi',
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.answerCbQuery('🚀 Jarayonda');
    }
  } catch {
    await ctx.answerCbQuery('❌ ClickUp xatosi');
  }
});

/***********************
 *  REPORTS
 ***********************/
bot.command('send', async (ctx) => {
  const { data } = await supabase
    .from('reports')
    .select('*')
    .eq('user_id', ctx.from.id)
    .eq('status', 'pending');

  if (!data?.length)
    return ctx.reply('📭 Yuborish uchun ish yo‘q');

  let text = `📋 <b>Hisobot:</b>\n\n`;
  data.forEach((i, n) => (text += `${n + 1}. ${escapeHTML(i.content)}\n`));

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Guruhga yuborish', 'confirm_send')],
    ]),
  });
});

bot.action('confirm_send', async (ctx) => {
  const { data } = await supabase
    .from('reports')
    .select('*')
    .eq('user_id', ctx.from.id)
    .eq('status', 'pending');

  if (!data?.length) return;

  let msg = `📅 <b>#hisobot</b>\n👤 ${escapeHTML(
    ctx.from.first_name
  )}\n\n`;

  data.forEach((i, n) => (msg += `${n + 1}. ${escapeHTML(i.content)}\n`));

  await ctx.telegram.sendMessage(process.env.GROUP_ID, msg, {
    parse_mode: 'HTML',
  });

  await supabase
    .from('reports')
    .update({ status: 'sent' })
    .eq('user_id', ctx.from.id);

  await ctx.editMessageText('✅ Hisobot yuborildi');
});

/***********************
 *  TEXT HANDLER
 ***********************/
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  await supabase.from('reports').insert({
    user_id: ctx.from.id,
    content: ctx.message.text,
    status: 'pending',
  });
  ctx.reply('✅ Qo‘shildi');
});

/***********************
 *  SERVER EXPORT
 ***********************/
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    if (req.body?.webhook_id) {
      res.status(200).send('OK');
      return handleClickUpWebhook(req);
    }

    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  }

  res.status(200).send('Active');
};
