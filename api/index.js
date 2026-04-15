const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ====== CONFIG ======
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Admin (fallback: old hardcoded id)
const ADMIN_ID = (() => {
  const n = parseInt(process.env.ADMIN_ID || '7894854944', 10);
  return Number.isFinite(n) ? n : 7894854944;
})();

// === /tasks va /report uchun sozlamalar ===
// Mas'ul shaxslar (comma-separated): "789...,123...". Default: ADMIN_ID
const TASK_PLANNERS = (process.env.TASK_PLANNERS || String(ADMIN_ID))
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

// Report qaysi Telegram ID'ga yuboriladi (rahbar). Default: ADMIN_ID (xavfsiz fallback)
const BOSS_ID = (() => {
  const v = process.env.BOSS_ID || process.env.MANAGER_ID;
  const n = v ? parseInt(String(v), 10) : NaN;
  return Number.isFinite(n) ? n : ADMIN_ID;
})();

// WebApp URL (fix: avoid https://https://...)
const WEB_APP_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://uyqur-yordmchi.vercel.app';

// Optional: ClickUp status mapping (some workspaces use custom status names)
const CLICKUP_STATUS_PROCESS = process.env.CLICKUP_STATUS_PROCESS || 'in progress';
const CLICKUP_STATUS_DONE = process.env.CLICKUP_STATUS_DONE || 'closed';

const parseJSONEnv = (raw, fallback) => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('❌ JSON parse error:', err?.message || err);
    return fallback;
  }
};

const TASKMODE_COMPANY_OWNERS = parseJSONEnv(process.env.TASKMODE_COMPANY_OWNERS_JSON, {});
const TASKMODE_ALLOWED_IDS = new Set([ADMIN_ID, ...TASK_PLANNERS]);
const USER_CACHE_TTL_MS = 60 * 1000;
const usersCache = {
  value: null,
  expiresAt: 0,
};

// ====== HELPERS ======
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const escapeHTML = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

const chunkArray = (items, size = 2) => {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
};

const normalizePhone = (value) => String(value || '').replace(/\D+/g, '');
const normalizeHandle = (value) => String(value || '').trim().replace(/^@+/, '').toLowerCase();
const normalizeCompanyKey = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[|]/g, ' | ')
    .trim();

const toMonthShortUz = (value) => {
  const months = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyn', 'Iyul', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];
  return months[value - 1] || String(value || '');
};

const nowTashkent = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));

const getTodayMonthDayLabel = () => {
  const dt = nowTashkent();
  return `${String(dt.getDate()).padStart(2, '0')} ${toMonthShortUz(dt.getMonth() + 1)}`;
};

const buildWelcomeText = (firstName = 'foydalanuvchi') => (
  `Assalomu alaykum, <b>${escapeHTML(firstName)}</b>!

` +
  `Men sizning ish hisobotlaringizni yig'ish va ClickUp vazifalaringizni boshqarishda yordam beraman.

` +
  `📖 Buyruqlar va yordam: /help`
);

const getUpdateMessage = (update) => update?.message || update?.edited_message || null;
const getMessageText = (update) => String(getUpdateMessage(update)?.text || '').trim();
const isPrivateChatUpdate = (update) => getUpdateMessage(update)?.chat?.type === 'private';
const isStartCommand = (update) => /^\/start(?:@\w+)?(?:\s|$)/i.test(getMessageText(update));

const buildWebhookReplySendMessage = (chatId, text, extra = {}) => ({
  method: 'sendMessage',
  chat_id: chatId,
  text,
  ...extra,
});

const getCachedUsers = async ({ force = false } = {}) => {
  const now = Date.now();
  if (!force && usersCache.value && usersCache.expiresAt > now) {
    return usersCache.value;
  }

  const { data, error } = await supabase
    .from('users_mapping')
    .select('*')
    .order('full_name', { ascending: true });

  if (error) {
    throw error;
  }

  usersCache.value = data || [];
  usersCache.expiresAt = now + USER_CACHE_TTL_MS;
  return usersCache.value;
};

const invalidateUsersCache = () => {
  usersCache.value = null;
  usersCache.expiresAt = 0;
};

const resolveCompanyOwnerConfig = (companyName) => {
  const key = normalizeCompanyKey(companyName);
  const entries = Object.entries(TASKMODE_COMPANY_OWNERS || {});
  for (const [rawKey, value] of entries) {
    if (normalizeCompanyKey(rawKey) === key) return value || null;
  }
  return null;
};

const resolveUserRecipient = async ({ companyName, username, phone }) => {
  const cfg = resolveCompanyOwnerConfig(companyName);
  if (cfg?.telegram_id) {
    return {
      telegram_id: Number(cfg.telegram_id),
      username: cfg.username || username || null,
      phone: cfg.phone || phone || null,
      full_name: cfg.full_name || cfg.display_name || companyName,
      source: 'config',
    };
  }

  const users = await getCachedUsers();
  const phoneNorm = normalizePhone(phone);
  const userNorm = normalizeHandle(username);

  for (const row of users) {
    const rowPhone = normalizePhone(row.phone);
    const rowUsername = normalizeHandle(row.username);
    if (phoneNorm && rowPhone && phoneNorm === rowPhone) {
      return { ...row, source: 'users_mapping.phone' };
    }
    if (userNorm && rowUsername && userNorm === rowUsername) {
      return { ...row, source: 'users_mapping.username' };
    }
  }

  return null;
};

const parseTaskmodeCompanies = (input) => {
  const raw = String(input || '').replace(/\r/g, '').trim();
  if (!raw) return [];

  const starts = [...raw.matchAll(/(^|\n)\s*(\d+\.)?\s*🏗/g)].map((m) => (m.index || 0) + (m[1] ? m[1].length : 0));
  const chunks = [];

  if (!starts.length) {
    chunks.push(raw);
  } else {
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1] : raw.length;
      const part = raw.slice(start, end).trim();
      if (part) chunks.push(part);
    }
  }

  return chunks.map((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const header = lines[0] || '';
    const companyMatch = header.match(/🏗\s*(.+?)\s*(?:кунлик ҳисоботи|kunlik hisoboti)\s*:/i);
    const companyName = companyMatch ? companyMatch[1].trim() : header.replace(/^\d+\.\s*/, '').replace(/^🏗\s*/, '').trim();

    const sections = [];
    for (const line of lines) {
      if (!/^[🔴🟢]/u.test(line) || !line.includes(':')) continue;
      const [labelRaw, restRaw] = line.split(/:(.+)/).filter(Boolean);
      const label = String(labelRaw || '').replace(/^[🔴🟢]\s*/u, '').trim();
      const rest = String(restRaw || '').trim();
      const active = /^[🟢]/u.test(line) || /фаол|faol/i.test(rest);
      sections.push({ label, active, raw: line });
    }

    const inactiveSections = sections.filter((x) => !x.active).map((x) => x.label);
    const employeeLine = lines.find((line) => /👤\s*Ходим:|👤\s*Xodim:/i.test(line)) || '';
    const username = (employeeLine.match(/@([A-Za-z0-9_]+)/) || [null, null])[1];
    const phone = (employeeLine.match(/\+?\d[\d\s]{8,}/) || [null])[0];
    const activityLine = lines.find((line) => /📅\s*Фаоллик даври:|📅\s*Faollik davri:/i.test(line)) || '';
    const totalLine = lines.find((line) => /📊\s*Жами амаллар:|📊\s*Jami amallar:/i.test(line)) || '';

    return {
      raw: block,
      companyName,
      sections,
      inactiveSections,
      employeeLine,
      username: username ? `@${username}` : null,
      phone: phone ? phone.replace(/\s+/g, ' ').trim() : null,
      activityLine,
      totalLine,
    };
  }).filter((item) => item.companyName);
};

const buildTaskmodeEmployeeText = ({ companyName, inactiveSections, activityLine }) => {
  const list = inactiveSections.map((item) => `• ${escapeHTML(item)}`).join('\n');
  const activityText = activityLine ? `\n${escapeHTML(activityLine)}` : '';
  return (
    `🏗 <b>${escapeHTML(companyName)}</b> bo‘yicha holat tekshirildi.\n\n` +
    `❗ <b>No-faol bo‘limlar:</b>\n${list}\n\n` +
    `Iltimos, shu bo‘limlar bilan aloqaga chiqib, nofaollik sababini aniqlang va natijani qayta yuboring.` +
    `${activityText}`
  );
};

const buildTaskmodePreview = ({ items, unresolved, sourceCount }) => {
  let text = `🧠 <b>Taskmode tahlili tayyor</b>\n\n`;
  text += `📥 Tahlil qilingan kompaniyalar: <b>${sourceCount}</b>\n`;
  text += `📨 Yuboriladigan topshiriqlar: <b>${items.length}</b>\n`;
  if (unresolved.length) {
    text += `⚠️ Aniqlanmagan mas'ullar: <b>${unresolved.length}</b>\n`;
  }
  text += `\n`;

  items.forEach((item, idx) => {
    text += `<b>${idx + 1}. ${escapeHTML(item.company_name)}</b>\n`;
    text += `Mas'ul: ${escapeHTML(item.owner_label)}\n`;
    text += `Bo‘limlar: ${item.inactive_sections.map((x) => escapeHTML(x)).join(', ')}\n\n`;
  });

  if (unresolved.length) {
    text += `<b>Yuborilmaydigan kompaniyalar</b>\n`;
    unresolved.forEach((item, idx) => {
      text += `${idx + 1}. ${escapeHTML(item.company_name)} — ${escapeHTML(item.reason)}\n`;
    });
  }

  return text.slice(0, 3800);
};

const buildTaskmodeJobPayload = async (input) => {
  const companies = parseTaskmodeCompanies(input);
  const notifications = [];
  const unresolved = [];

  for (const company of companies) {
    if (!company.inactiveSections.length) continue;

    const recipient = await resolveUserRecipient({
      companyName: company.companyName,
      username: company.username,
      phone: company.phone,
    });

    const ownerLabel = recipient?.full_name
      || company.username
      || company.phone
      || company.companyName;

    const notification = {
      company_name: company.companyName,
      inactive_sections: company.inactiveSections,
      owner_label: ownerLabel,
      owner_username: recipient?.username || company.username || null,
      owner_phone: recipient?.phone || company.phone || null,
      telegram_id: recipient?.telegram_id ? Number(recipient.telegram_id) : null,
      message_text: buildTaskmodeEmployeeText({
        companyName: company.companyName,
        inactiveSections: company.inactiveSections,
        activityLine: company.activityLine,
      }),
      source: recipient?.source || null,
    };

    if (notification.telegram_id) {
      notifications.push(notification);
    } else {
      unresolved.push({
        company_name: company.companyName,
        reason: company.username || company.phone || 'telegram_id topilmadi',
      });
    }
  }

  return {
    companies,
    notifications,
    unresolved,
    preview_text: buildTaskmodePreview({
      items: notifications,
      unresolved,
      sourceCount: companies.length,
    }),
  };
};

// ====== CLICKUP TASK STATUS + TG MESSAGE SYNC (FIX) ======
// Status nomlarini normallashtiramiz (ClickUp workspace'da custom bo'lishi mumkin)
const norm = (s) => String(s || '').toLowerCase().trim();

// Bizga 3 ta holat kerak: open | process | done
const statusKeyOf = (statusRaw) => {
  const s = norm(statusRaw);
  if (!s) return 'open';
  if (s === norm(CLICKUP_STATUS_DONE)) return 'done';
  if (s === norm(CLICKUP_STATUS_PROCESS)) return 'process';
  // boshqa custom statuslar bo'lsa ham OPEN deb tutamiz
  return 'open';
};

const buildTaskText = (task) => {
  const st = (task?.status?.status || '').toUpperCase();
  return (
    `📌 <b>Vazifa:</b>\n\n` +
    `<b>Nomi:</b> ${escapeHTML(task?.name || '')}\n` +
    `<b>Status:</b> ${escapeHTML(st)}\n\n` +
    `<a href="${task?.url}">ClickUp'da ochish</a>`
  );
};

const buildTaskKeyboard = (taskId, statusKey) => {
  if (statusKey === 'done') {
    // yakunlanganda tugmalarni olib tashlaymiz
    return Markup.inlineKeyboard([]);
  }
  if (statusKey === 'process') {
    return Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yakunlash', `cu_status_done_${taskId}`)],
    ]);
  }
  // open (default)
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Jarayonda', `cu_status_process_${taskId}`)],
    [Markup.button.callback('✅ Yakunlash', `cu_status_done_${taskId}`)],
  ]);
};

// ====== CLICKUP -> TG MESSAGE MAPPING (idempotency) ======
// clickup_task_messages jadvali: (task_id, assignee_id) unique / primary key
const upsertTaskMessageRow = async ({
  task_id,
  assignee_id,
  telegram_id,
  chat_id,
  message_id,
  last_status,
}) => {
  const { data, error } = await supabase.from('clickup_task_messages').upsert(
    {
      task_id,
      assignee_id,
      telegram_id,
      chat_id,
      message_id,
      last_status,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'task_id,assignee_id' }
  );

  if (error) {
    console.error('❌ Supabase upsert clickup_task_messages error:', error.message);
  }
  return { data, error };
};

const getTaskMessageRow = async (task_id, assignee_id) => {
  const { data, error } = await supabase
    .from('clickup_task_messages')
    .select('task_id, assignee_id, telegram_id, chat_id, message_id, last_status')
    .eq('task_id', task_id)
    .eq('assignee_id', assignee_id)
    .single();

  // .single() "not found" holatda ham error qaytaradi (PGRST116). Bu normal.
  if (error && error.code !== 'PGRST116') {
    console.error('❌ Supabase select clickup_task_messages error:', error.message);
  }
  return data || null;
};

// Concurrency/Retry'larda 1 ta xabar yuborilishi uchun "reserve" qilamiz.
// Birinchi kelgan webhook reserve qiladi, boshqalar esa skip qiladi.
const reserveTaskMessageRow = async ({ task_id, assignee_id, telegram_id, last_status }) => {
  const { data, error } = await supabase
    .from('clickup_task_messages')
    .upsert(
      [
        {
          task_id,
          assignee_id,
          telegram_id,
          chat_id: 0,
          message_id: 0,
          last_status: last_status || 'open',
          updated_at: new Date().toISOString(),
        },
      ],
      { onConflict: 'task_id,assignee_id', ignoreDuplicates: true }
    )
    .select('task_id');

  if (error) {
    console.error('❌ Supabase reserve error:', error.message);
    return { reserved: false, error };
  }

  // ignoreDuplicates bo'lsa: insert bo'lsa data.length > 0, mavjud bo'lsa []
  const reserved = Array.isArray(data) && data.length > 0;
  return { reserved, error: null };
};

const deleteTaskMessageRow = async (task_id, assignee_id) => {
  const { error } = await supabase
    .from('clickup_task_messages')
    .delete()
    .eq('task_id', task_id)
    .eq('assignee_id', assignee_id);
  if (error) console.error('❌ Supabase delete clickup_task_messages error:', error.message);
};


// ClickUp API Helper
const clickupRequest = async (endpoint, method = 'GET', body = null) => {
  const url = `https://api.clickup.com/api/v2/${endpoint}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: process.env.CLICKUP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && (data.err || data.error || data.message)
        ? data.err || data.error || data.message
        : 'Unknown error';
    const err = new Error(`ClickUp API error ${res.status}: ${msg}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return data;
};

// --- Webhook signature helpers (optional, strict mode via env) ---
const getHeader = (req, name) => {
  const key = name.toLowerCase();
  return req?.headers?.[key] || req?.headers?.[name] || null;
};

const verifyClickUpSignature = (req) => {
  const secret = process.env.CLICKUP_WEBHOOK_SECRET;
  const strict = process.env.CLICKUP_WEBHOOK_VERIFY === 'true';
  if (!secret) return true; // backwards-compatible

  const signature = getHeader(req, 'x-signature');
  if (!signature) return !strict;

  // Prefer raw body if your platform provides it
  const raw = req && (req.rawBody || req.bodyRaw)
    ? Buffer.isBuffer(req.rawBody || req.bodyRaw)
      ? (req.rawBody || req.bodyRaw).toString('utf8')
      : String(req.rawBody || req.bodyRaw)
    : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (signature.length !== expected.length) return !strict;

  try {
    const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    // If strict mode is OFF, don't block production traffic on signature mismatches.
    if (!isValid && !strict) return true;
    return isValid;
  } catch {
    return !strict;
  }
};

const verifyTelegramSecret = (req) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const strict = process.env.TELEGRAM_WEBHOOK_VERIFY === 'true';
  if (!secret) return true; // backwards-compatible

  const token = getHeader(req, 'x-telegram-bot-api-secret-token');
  if (!token) return !strict;
  return token === secret;
};

// ====== CLICKUP WEBHOOK HANDLER ======
async function handleClickUpWebhook(req) {
  const { event, task_id } = req.body || {};

  // ClickUp'dan ko'p event keladi: taskCreated / taskUpdated / taskAssigneeUpdated
  if (event !== 'taskCreated' && event !== 'taskUpdated' && event !== 'taskAssigneeUpdated') return;
  if (!task_id) return;

  // Task data'ni olib kelamiz (assignee ba'zan kechikib keladi)
  let task;
  for (let i = 0; i < 3; i++) {
    try {
      task = await clickupRequest(`task/${task_id}`);
    } catch (err) {
      console.error(`❌ ClickUp task fetch error (${task_id}):`, err?.message || err);
      return;
    }
    if (task?.assignees?.length) break;
    await delay(800);
  }

  if (!task?.assignees?.length) {
    console.log(`⚠️ Assignee topilmadi (task ${task_id})`);
    return;
  }

  const nowKey = statusKeyOf(task?.status?.status);

  for (const assignee of task.assignees) {
    // mapping: ClickUp user id -> telegram id
    const { data: userMap, error: mapErr } = await supabase
      .from('users_mapping')
      .select('telegram_id')
      .eq('clickup_user_id', assignee.id)
      .single();

    if (mapErr && mapErr.code !== 'PGRST116') {
      console.error('❌ users_mapping select error:', mapErr.message);
    }
    if (!userMap?.telegram_id) continue;

    const telegramId = userMap.telegram_id;

    // 1) Agar oldin yuborilgan bo'lsa — xabarni EDIT qilamiz
    let row = await getTaskMessageRow(task_id, assignee.id);

    // Agar row bor-u, lekin message_id/chat_id 0 bo'lsa — boshqa webhook send qilayotgan bo'lishi mumkin.
    if (row && (!row.chat_id || !row.message_id)) {
      console.log(`⏳ Pending send (skip) task ${task_id} assignee ${assignee.id}`);
      continue;
    }

    if (row && row.chat_id && row.message_id) {
      const prevKey = row.last_status || 'open';
      if (prevKey !== nowKey) {
        const text = buildTaskText(task);
        const keyboard = buildTaskKeyboard(task_id, nowKey);
        try {
          await bot.telegram.editMessageText(row.chat_id, row.message_id, undefined, text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...keyboard,
          });

          await upsertTaskMessageRow({
            task_id,
            assignee_id: assignee.id,
            telegram_id: telegramId,
            chat_id: row.chat_id,
            message_id: row.message_id,
            last_status: nowKey,
          });

          console.log(`♻️ Updated TG msg for task ${task_id} (${prevKey} -> ${nowKey})`);
        } catch (err) {
          const msg = err?.response?.description || err?.message || String(err);
          // "message is not modified" bo'lsa jim o'tamiz
          if (!String(msg).toLowerCase().includes('message is not modified')) {
            console.error(`❌ Telegram edit error (task ${task_id}):`, msg);
          }
        }
      } else {
        console.log(`ℹ️ No status change for task ${task_id} (${nowKey})`);
      }
      continue;
    }

    // 2) Row yo'q bo'lsa — yangi xabar faqat taskCreated / taskAssigneeUpdated event'larda yuboriladi.
    // taskUpdated kelib qolsa (retry/parallel) — dubllar chiqmasin deb SKIP qilamiz.
    if (event === 'taskUpdated') {
      console.log(`⛔ Skip sending on taskUpdated (no row yet): task ${task_id}`);
      continue;
    }

    // 3) Concurrency/Retry'da 1 marta yuborish uchun reserve qilamiz
    const { reserved } = await reserveTaskMessageRow({
      task_id,
      assignee_id: assignee.id,
      telegram_id: telegramId,
      last_status: nowKey,
    });

    if (!reserved) {
      console.log(`⛔ Duplicate notify (reserved already): ${task_id}:${assignee.id}`);
      continue;
    }

    // 4) Birinchi bo'lib reserve qilganimiz uchun endi SEND qilamiz
    const text = buildTaskText(task);
    const keyboard = buildTaskKeyboard(task_id, nowKey);

    try {
      const msg = await bot.telegram.sendMessage(telegramId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...keyboard,
      });

      await upsertTaskMessageRow({
        task_id,
        assignee_id: assignee.id,
        telegram_id: telegramId,
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        last_status: nowKey,
      });

      console.log(`✅ Task ${task_id} → TG ${telegramId} (msg_id=${msg.message_id})`);
    } catch (err) {
      const em = err?.response?.description || err?.message || String(err);
      console.error(`❌ Telegram send error (task ${task_id}):`, em);
      // send fail bo'lsa reserve row'ni o'chirib tashlaymiz (ClickUp retry kelganda qayta yuborishi mumkin)
      await deleteTaskMessageRow(task_id, assignee.id);
    }
  }
}

// ====== TELEGRAM COMMANDS ======
// /bind - faqat admin (TG_ID ClickUp_ID [@username] [+998...] Ism)
bot.command('bind', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Siz admin emassiz!');

  const args = ctx.message.text.split(' ').slice(1).filter(Boolean);
  if (args.length < 3) {
    return ctx.reply("Xato! Format: /bind TG_ID ClickUp_ID [@username] [+998...] Ism");
  }

  const [tg_id, cu_id, ...rest] = args;
  let username = null;
  let phone = null;
  const tail = [...rest];

  if (tail[0] && /^@/.test(tail[0])) {
    username = tail.shift();
  }
  if (tail[0] && /^\+?\d[\d\s-]{8,}$/.test(tail[0])) {
    phone = tail.shift();
  }

  const fullName = tail.join(' ').trim();
  if (!fullName) {
    return ctx.reply("Xato! Ism kiritilishi shart. Format: /bind TG_ID ClickUp_ID [@username] [+998...] Ism");
  }

  const basePayload = {
    telegram_id: parseInt(tg_id, 10),
    clickup_user_id: parseInt(cu_id, 10),
    full_name: fullName,
  };

  const extendedPayload = {
    ...basePayload,
    ...(username ? { username } : {}),
    ...(phone ? { phone } : {}),
  };

  let error = null;
  ({ error } = await supabase.from('users_mapping').upsert(extendedPayload));

  if (error && /column/i.test(error.message || '')) {
    ({ error } = await supabase.from('users_mapping').upsert(basePayload));
  }

  if (error) {
    return ctx.reply(`Xato: ${error.message}`);
  }

  invalidateUsersCache();
  return ctx.reply(`✅ ${fullName} muvaffaqiyatli bog'landi!`);
});

// =========================
// 📣 ADMIN BROADCAST: /message
// =========================
// Ishlatish:
// 1) /message Salom hammaga! Bugun soat 18:00 da yig'ilish bo'ladi.
// 2) Biror xabarga reply qilib, keyin /message yozsangiz — o'sha xabar hamma user'ga nusxa bo'lib ketadi.
// (copyMessage ishlatiladi, forward belgisisiz.)

// Helper: column bo'yicha barcha satrlarni (pagination bilan) olib kelish
const fetchAllColumn = async (table, column, pageSize = 1000) => {
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(column)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error(`❌ Supabase fetch error (${table}.${column}):`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    rows.push(...data);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
};

const getBroadcastRecipients = async () => {
  const ids = new Set();

  // 1) users_mapping.telegram_id
  try {
    const maps = await fetchAllColumn('users_mapping', 'telegram_id');
    for (const row of maps) {
      const n = parseInt(String(row.telegram_id), 10);
      if (Number.isFinite(n)) ids.add(n);
    }
  } catch (e) {
    console.error('❌ users_mapping fetch failed:', e?.message || e);
  }

  // 2) reports.user_id (botga yozgan userlar ham kirsin)
  try {
    const reps = await fetchAllColumn('reports', 'user_id');
    for (const row of reps) {
      const n = parseInt(String(row.user_id), 10);
      if (Number.isFinite(n)) ids.add(n);
    }
  } catch (e) {
    console.error('❌ reports fetch failed:', e?.message || e);
  }

  return [...ids];
};

// Serverless timeoutga tushmaslik uchun limit (default 500). Kerak bo'lsa env bilan oshirasiz.
const BROADCAST_MAX = (() => {
  const n = parseInt(process.env.BROADCAST_MAX || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
})();

// Telegram rate limit uchun delay (default 40ms ~ 25 msg/sec)
const BROADCAST_DELAY_MS = (() => {
  const n = parseInt(process.env.BROADCAST_DELAY_MS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 40;
})();

bot.command('message', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('Siz admin emassiz!');

    const reply = ctx.message.reply_to_message;
    const text = ctx.message.text.split(' ').slice(1).join(' ').trim();

    if (!reply && !text) {
      return ctx.reply(
        "Xato! Format:\n/message <matn>\n\nYoki biror xabarga reply qilib /message yozing."
      );
    }

    const recipients = await getBroadcastRecipients();
    if (!recipients.length) {
      return ctx.reply(
        "Hozircha foydalanuvchilar topilmadi (users_mapping/reports bo'sh).\n/bind orqali xodimlarni bog'laganingizga ishonch hosil qiling."
      );
    }

    const targets = recipients.slice(0, BROADCAST_MAX);
    if (recipients.length > BROADCAST_MAX) {
      await ctx.reply(
        `⚠️ Juda ko'p user bor: ${recipients.length} ta. Hozir ${BROADCAST_MAX} ta user'ga yuboraman. (BROADCAST_MAX bilan oshirish mumkin)`
      );
    }

    const startMsg = await ctx.reply(`📣 Yuborilyapti... (${targets.length} ta foydalanuvchi)`);

    let ok = 0;
    let fail = 0;

    for (const userId of targets) {
      try {
        if (reply) {
          await ctx.telegram.copyMessage(userId, ctx.chat.id, reply.message_id);
        } else {
          await ctx.telegram.sendMessage(userId, text, { disable_web_page_preview: true });
        }
        ok += 1;
      } catch (e) {
        fail += 1;
        const msg = e?.response?.description || e?.message || String(e);
        console.warn(`⚠️ Broadcast send failed → ${userId}: ${msg}`);
      }

      if (BROADCAST_DELAY_MS) {
        await delay(BROADCAST_DELAY_MS);
      }
    }

    const doneText = `✅ Broadcast tugadi.\n\nYuborildi: ${ok}\nXato: ${fail}`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, startMsg.message_id, undefined, doneText);
    } catch {
      await ctx.reply(doneText);
    }
  } catch (err) {
    console.error('Broadcast command error:', err);
    await ctx.reply("Xatolik: broadcast yuborishda muammo bo'ldi.");
  }
});

bot.start(async (ctx) => {
  await ctx.reply(buildWelcomeText(ctx.from.first_name), { parse_mode: 'HTML' });
});

bot.help(async (ctx) => {
  const helpText =
    `🛠 <b>Bot buyruqlari:</b>\n\n` +
    `/send - Saqlangan barcha ishlarni ko'rish va guruhga yuborish\n` +
    `/tasks - Ertangi vazifalarni tayyorlash (mas'ul shaxs)\n` +
    `/report - Ertangi vazifalarni rahbarga yuborish (tasdiqlash bilan)\n` +
    `/message - (admin) barcha bot foydalanuvchilariga xabar yuborish\n\n` +
    `✍️ <b>Matn yozing</b> - Ishlaringizni botga oddiy xabar sifatida yuborsangiz, ular hisobotga qo'shiladi.\n` +
    `📌 <b>ClickUp</b> - Sizga biriktirilgan tasklar avtomatik keladi.`;
  await ctx.reply(helpText, { parse_mode: 'HTML' });
});

bot.command('send', async (ctx) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('user_id', ctx.from.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error || !data?.length) {
      return ctx.reply("📭 Hozircha yuborish uchun yangi ishlar yo'q.");
    }

    let reportText = `📋 <b>Sizning hisobotingiz (yuborishdan oldin ko'zdan kechiring):</b>\n\n`;
    data.forEach((item, index) => {
      reportText += `<b>${index + 1}.</b> ${escapeHTML(item.content)}\n`;
    });

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Guruhga yuborish', 'confirm_send')],
      [Markup.button.webApp('✍️ Tahrirlash (open)', WEB_APP_URL)],
    ]);

    await ctx.reply(reportText, { parse_mode: 'HTML', ...keyboard });
  } catch (err) {
    console.error('Send command error:', err);
  }
});

// --- ACTIONS ---
bot.action(/cu_status_(process|done)_(.+)/, async (ctx) => {
  const [, action, taskId] = ctx.match;
  const statusName = action === 'process' ? CLICKUP_STATUS_PROCESS : CLICKUP_STATUS_DONE;

  try {
    await clickupRequest(`task/${taskId}`, 'PUT', { status: statusName });

    // Task'ni qayta olib kelib, TG xabarni ham update qilamiz (matn + tugmalar)
    const task = await clickupRequest(`task/${taskId}`);
    const key = statusKeyOf(task?.status?.status);

    // Xabarni yangilash (Jarayonda bo'lsa: faqat Yakunlash; Done bo'lsa: tugmalar yo'q)
    if (action === 'done') {
      // Hisobotga qo'shish (oldingi logikani saqlaymiz)
      await supabase.from('reports').insert([
        {
          user_id: ctx.from.id,
          content: `(ClickUp) ${task.name}`,
          status: 'pending',
        },
      ]);

      await ctx.editMessageText(`✅ <b>Vazifa yakunlandi va hisobotga qo'shildi!</b>`, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...buildTaskKeyboard(taskId, 'done'),
      });
    } else {
      await ctx.answerCbQuery("Status 'Jarayonda'ga o'zgardi");

      await ctx.editMessageText(buildTaskText(task), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...buildTaskKeyboard(taskId, key),
      });
    }

    // Shu xabarni DB'ga bog'lab qo'yamiz (old messages uchun ham foydali)
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (chatId && messageId) {
      const { data: mapRow, error: mapErr } = await supabase
        .from('users_mapping')
        .select('clickup_user_id')
        .eq('telegram_id', ctx.from.id)
        .single();

      if (mapErr && mapErr.code !== 'PGRST116') {
        console.error('❌ users_mapping select error:', mapErr.message);
      }

      const clickupAssigneeId = mapRow?.clickup_user_id || ctx.from.id;

      await upsertTaskMessageRow({
        task_id: taskId,
        assignee_id: clickupAssigneeId,
        telegram_id: ctx.from.id,
        chat_id: chatId,
        message_id: messageId,
        last_status: key,
      });
    }
  } catch (err) {
    console.error('ClickUp status update error:', err?.message || err);
    await ctx.answerCbQuery("Xatolik: ClickUp API bilan bog'lanib bo'lmadi.");
  }
});

bot.action('confirm_send', async (ctx) => {
  try {
    const { data } = await supabase
      .from('reports')
      .select('*')
      .eq('user_id', ctx.from.id)
      .eq('status', 'pending');

    if (!data?.length) return;

    const dateString = new Date().toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    let finalReport =
      `📅 <b>#hisobot ${dateString}</b>\n👤 <b>Xodim:</b> ${escapeHTML(ctx.from.first_name)}\n\n`;

    data.forEach((item, index) => {
      finalReport += `${index + 1}. ${escapeHTML(item.content)}\n`;
    });

    await ctx.telegram.sendMessage(process.env.GROUP_ID, finalReport, { parse_mode: 'HTML' });
    await supabase
      .from('reports')
      .update({ status: 'sent' })
      .eq('user_id', ctx.from.id)
      .eq('status', 'pending');

    await ctx.editMessageText('🚀 Hisobot guruhga yuborildi!', { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Confirm send error:', err);
  }
});

// ====== /tasks & /report helperlar ======
const isPlanner = (telegramId) => {
  return TASK_PLANNERS.includes(Number(telegramId));
};

const getTashkentISODate = (offsetDays = 0) => {
  const dt = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  // en-CA => YYYY-MM-DD
  return dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
};

const formatUzDate = (isoDate) => {
  try {
    const [y, m, d] = String(isoDate).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent' });
  } catch {
    return String(isoDate);
  }
};

const isTaskmodeAllowed = (telegramId) => TASKMODE_ALLOWED_IDS.has(Number(telegramId));

const isTaskmodeEnabled = async (telegramId) => {
  const { data, error } = await supabase
    .from('taskmode_state')
    .select('enabled')
    .eq('creator_id', telegramId)
    .maybeSingle();

  if (error) {
    if (error.code !== 'PGRST116') {
      console.error('taskmode_state select error:', error.message);
    }
    return false;
  }

  return Boolean(data?.enabled);
};

const sendEmployeePicker = async (ctx, title = "👥 Xodimni tanlang") => {
  let users;
  try {
    users = await getCachedUsers();
  } catch (error) {
    console.error('users_mapping cache fetch error:', error.message || error);
    return ctx.reply("❌ Xodimlar ro'yxati topilmadi. Avval /bind bilan xodimlarni bog'lab chiqing.");
  }

  if (!users?.length) {
    return ctx.reply("❌ Xodimlar ro'yxati topilmadi. Avval /bind bilan xodimlarni bog'lab chiqing.");
  }

  const rows = chunkArray(users, 2).map((group) =>
    group.map((user) => Markup.button.callback(user.full_name, `plan_select_${user.telegram_id}`))
  );
  rows.push([Markup.button.callback('❌ Rejimdan chiqish', 'plan_exit')]);

  return ctx.reply(title, Markup.inlineKeyboard(rows));
};

bot.command('taskmode', async (ctx) => {
  if (!isTaskmodeAllowed(ctx.from.id)) {
    return ctx.reply("Bu buyruq faqat admin yoki mas'ul shaxslar uchun.");
  }

  const { error } = await supabase.from('taskmode_state').upsert({
    creator_id: ctx.from.id,
    enabled: true,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error('taskmode_state upsert error:', error.message || error);
    return ctx.reply("❌ Taskmode yoqilmadi. DB xatolik yuz berdi.");
  }

  return ctx.reply(
    "✅ Taskmode yoqildi. Endi kompaniyalar bo‘yicha kunlik hisobot matnini shu chatga yuboring — bot nofaol bo‘limlarni tahlil qiladi va yuborishdan oldin tasdiq so‘raydi."
  );
});

bot.command('taskmodeoff', async (ctx) => {
  if (!isTaskmodeAllowed(ctx.from.id)) {
    return ctx.reply("Bu buyruq faqat admin yoki mas'ul shaxslar uchun.");
  }

  const { error } = await supabase.from('taskmode_state').upsert({
    creator_id: ctx.from.id,
    enabled: false,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error('taskmode_state disable error:', error.message || error);
    return ctx.reply("❌ Taskmode o‘chmadi. DB xatolik yuz berdi.");
  }

  return ctx.reply("✅ Taskmode o‘chirildi.");
});

bot.action(/taskmode_confirm_(\d+)/, async (ctx) => {
  if (!isTaskmodeAllowed(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo‘q");

  const jobId = Number(ctx.match[1]);
  const { data: job, error } = await supabase
    .from('taskmode_jobs')
    .select('id, creator_id, status, notifications')
    .eq('id', jobId)
    .maybeSingle();

  if (error || !job) {
    return ctx.answerCbQuery('Draft topilmadi');
  }
  if (job.creator_id !== ctx.from.id) {
    return ctx.answerCbQuery('Bu draft sizniki emas');
  }
  if (job.status !== 'draft') {
    return ctx.answerCbQuery('Bu draft allaqachon yakunlangan');
  }

  await ctx.answerCbQuery('Yuborilmoqda...');

  let ok = 0;
  let fail = 0;
  const failed = [];

  for (const item of job.notifications || []) {
    if (!item?.telegram_id) {
      fail += 1;
      failed.push(`${item?.company_name || "Noma'lum kompaniya"} — telegram_id yo‘q`);
      continue;
    }

    try {
      await ctx.telegram.sendMessage(item.telegram_id, item.message_text, { parse_mode: 'HTML' });
      ok += 1;
      await delay(35);
    } catch (err) {
      fail += 1;
      failed.push(`${item.company_name} — ${err?.response?.description || err?.message || 'yuborilmadi'}`);
    }
  }

  await supabase
    .from('taskmode_jobs')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      result_meta: { sent_ok: ok, sent_fail: fail, failed },
    })
    .eq('id', jobId);

  let text = `✅ <b>Taskmode topshiriqlari yuborildi</b>\n\nYuborildi: <b>${ok}</b>\nXato: <b>${fail}</b>`;
  if (failed.length) {
    text += `\n\n<b>Xatolar:</b>\n${failed.map((x, i) => `${i + 1}. ${escapeHTML(x)}`).join('\n')}`;
  }

  return ctx.editMessageText(text.slice(0, 3900), { parse_mode: 'HTML' });
});

bot.action(/taskmode_cancel_(\d+)/, async (ctx) => {
  if (!isTaskmodeAllowed(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo‘q");

  const jobId = Number(ctx.match[1]);
  const { data: job } = await supabase
    .from('taskmode_jobs')
    .select('id, creator_id, status')
    .eq('id', jobId)
    .maybeSingle();

  if (!job || job.creator_id !== ctx.from.id) {
    return ctx.answerCbQuery('Draft topilmadi');
  }
  if (job.status !== 'draft') {
    return ctx.answerCbQuery('Bu draft allaqachon yakunlangan');
  }

  await supabase
    .from('taskmode_jobs')
    .update({ status: 'cancelled' })
    .eq('id', jobId);

  await ctx.answerCbQuery('Bekor qilindi');
  return ctx.editMessageText('❌ Taskmode draft bekor qilindi.');
});

// ====== /tasks komandasi ======
// /tasks -> xodim tanlash
// /tasks list -> ertangi draft tasklarni ko'rish
// /tasks stop -> rejimdan chiqish
bot.command('tasks', async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.reply("Bu buyruq faqat mas'ul shaxs uchun.");

  const args = ctx.message.text.split(' ').slice(1);
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'stop') {
    await supabase.from('planner_state').delete().eq('creator_id', ctx.from.id);
    return ctx.reply("✅ /tasks rejimi o'chirildi.");
  }

  if (sub === 'list') {
    const planDate = getTashkentISODate(1);

    const { data: items } = await supabase
      .from('task_plans')
      .select('id, assignee_tg_id, task_text, created_at')
      .eq('creator_id', ctx.from.id)
      .eq('plan_date', planDate)
      .eq('status', 'draft')
      .order('created_at', { ascending: true });

    if (!items?.length) {
      return ctx.reply("📭 Ertangi vazifalar ro'yxati hozircha bo'sh.");
    }

    const ids = new Set(items.map((i) => Number(i.assignee_tg_id)));
    const users = (await getCachedUsers()).filter((u) => ids.has(Number(u.telegram_id)));

    const nameMap = new Map((users || []).map((u) => [u.telegram_id, u.full_name]));

    let text = `📌 <b>Ertangi draft vazifalar</b> (${formatUzDate(planDate)})\n\n`;
    const grouped = {};
    for (const t of items) {
      const key = t.assignee_tg_id;
      grouped[key] = grouped[key] || [];
      grouped[key].push(t.task_text);
    }

    let idx = 1;
    for (const [assigneeId, tasks] of Object.entries(grouped)) {
      const name = escapeHTML(nameMap.get(Number(assigneeId)) || `ID ${assigneeId}`);
      text += `<b>${idx}. ${name}</b> vazifalar:\n`;
      tasks.forEach((tt) => {
        text += `• ${escapeHTML(tt)}\n`;
      });
      text += `\n`;
      idx++;
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("👥 Yana task qo'shish", 'plan_change')],
      [Markup.button.callback('📝 /report (preview)', 'report_preview')],
    ]);

    return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }

  // default: picker
  const planDate = getTashkentISODate(1);
  await supabase
    .from('planner_state')
    .upsert({ creator_id: ctx.from.id, assignee_tg_id: null, plan_date: planDate, updated_at: new Date().toISOString() });

  return sendEmployeePicker(ctx, `🗓 <b>Ertangi vazifalar</b> (${formatUzDate(planDate)})\n\n👥 Xodimni tanlang:`);
});

// xodim tanlash
bot.action(/plan_select_(\d+)/, async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");

  const assigneeId = parseInt(ctx.match[1], 10);
  const planDate = getTashkentISODate(1);

  await supabase
    .from('planner_state')
    .upsert({ creator_id: ctx.from.id, assignee_tg_id: assigneeId, plan_date: planDate, updated_at: new Date().toISOString() });

  await ctx.answerCbQuery('✅ Tanlandi');

  const users = await getCachedUsers();
  const user = users.find((row) => Number(row.telegram_id) === assigneeId);
  const name = escapeHTML(user?.full_name || String(assigneeId));

  return ctx.editMessageText(
    `✅ <b>${name}</b> tanlandi.\n\nEndi vazifa matnini yozing (har bir xabar = 1 ta task).\n\n<i>Rejimdan chiqish:</i> <b>/tasks stop</b>`,
    { parse_mode: 'HTML' }
  );
});

// rejimdan chiqish
bot.action('plan_exit', async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
  await supabase.from('planner_state').delete().eq('creator_id', ctx.from.id);
  await ctx.answerCbQuery("✅ O'chirildi");
  return ctx.editMessageText('✅ /tasks rejimi yopildi.');
});

// xodimni almashtirish (picker)
bot.action('plan_change', async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
  await ctx.answerCbQuery();
  return sendEmployeePicker(ctx, "👥 Xodimni tanlang (task qo'shishda davom etamiz):");
});

// /report preview tugmasi
bot.action('report_preview', async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
  await ctx.answerCbQuery();
  return bot.telegram.sendMessage(ctx.from.id, "📝 Preview va yuborish uchun: /report");
});

// ====== /report komandasi ======
// /report -> preview (faqat yaratgan odam ko'radi) + Tasdiqlash/Bekor qilish
bot.command('report', async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.reply("Bu buyruq faqat mas'ul shaxs uchun.");

  const planDate = getTashkentISODate(1);

  const { data: tasks, error } = await supabase
    .from('task_plans')
    .select('id, assignee_tg_id, task_text, created_at')
    .eq('creator_id', ctx.from.id)
    .eq('plan_date', planDate)
    .eq('status', 'draft')
    .order('created_at', { ascending: true });

  if (error || !tasks?.length) {
    return ctx.reply("📭 Ertangi vazifalar yo'q. Avval /tasks bilan vazifalarni kiriting.");
  }

  const assigneeIds = [...new Set(tasks.map((t) => t.assignee_tg_id))];

  const assigneeSet = new Set(assigneeIds.map((x) => Number(x)));
  const users = (await getCachedUsers()).filter((u) => assigneeSet.has(Number(u.telegram_id)));

  const nameMap = new Map((users || []).map((u) => [u.telegram_id, u.full_name]));

  let message = `📌 <b>Ertangi vazifalar</b> (${formatUzDate(planDate)})\n\n`;

  const grouped = {};
  for (const t of tasks) {
    const key = t.assignee_tg_id;
    grouped[key] = grouped[key] || [];
    grouped[key].push(t.task_text);
  }

  let i = 1;
  for (const [assigneeId, items] of Object.entries(grouped)) {
    const name = escapeHTML(nameMap.get(Number(assigneeId)) || `ID ${assigneeId}`);
    message += `<b>${i}. ${name}</b> vazifalar:\n`;
    for (const it of items) {
      message += `• ${escapeHTML(it)}\n`;
    }
    message += `\n`;
    i++;
  }

  const { data: draft, error: draftErr } = await supabase
    .from('task_reports')
    .insert([
      {
        creator_id: ctx.from.id,
        plan_date: planDate,
        message,
        task_ids: tasks.map((t) => t.id),
        status: 'draft',
      },
    ])
    .select('id')
    .single();

  if (draftErr || !draft?.id) {
    console.error('task_reports insert error:', draftErr);
    return ctx.reply("❌ Report draft yaratishda xatolik bo'ldi.");
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Tasdiqlash va yuborish', `report_confirm_${draft.id}`)],
    [Markup.button.callback('❌ Bekor qilish', `report_cancel_${draft.id}`)],
  ]);

  return ctx.reply(`🧾 <b>Rahbarga yuborishdan oldin tekshirib oling:</b>\n\n${message}`, {
    parse_mode: 'HTML',
    ...keyboard,
  });
});

bot.action(/report_confirm_(.+)/, async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");

  const reportId = ctx.match[1];

  const { data: draft } = await supabase
    .from('task_reports')
    .select('id, creator_id, plan_date, message, task_ids, status')
    .eq('id', reportId)
    .single();

  if (!draft || draft.creator_id !== ctx.from.id) {
    return ctx.answerCbQuery('Draft topilmadi');
  }

  if (draft.status !== 'draft') {
    return ctx.answerCbQuery("Bu report allaqachon yakunlangan");
  }

  try {
    await ctx.telegram.sendMessage(BOSS_ID, draft.message, { parse_mode: 'HTML' });

    if (Array.isArray(draft.task_ids) && draft.task_ids.length) {
      await supabase.from('task_plans').update({ status: 'sent' }).in('id', draft.task_ids);
    }

    await supabase.from('task_reports').update({ status: 'sent' }).eq('id', reportId);

    await ctx.answerCbQuery('✅ Yuborildi');
    return ctx.editMessageText('✅ Report rahbarga yuborildi!', { parse_mode: 'HTML' });
  } catch (err) {
    console.error('report_confirm error:', err);
    return ctx.answerCbQuery("Xatolik: yuborib bo'lmadi");
  }
});

bot.action(/report_cancel_(.+)/, async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");

  const reportId = ctx.match[1];

  const { data: draft } = await supabase
    .from('task_reports')
    .select('id, creator_id, status')
    .eq('id', reportId)
    .single();

  if (!draft || draft.creator_id !== ctx.from.id) {
    return ctx.answerCbQuery('Draft topilmadi');
  }

  if (draft.status !== 'draft') {
    return ctx.answerCbQuery("Bu report allaqachon yakunlangan");
  }

  await supabase.from('task_reports').update({ status: 'cancelled' }).eq('id', reportId);

  await ctx.answerCbQuery('❌ Bekor qilindi');
  return ctx.editMessageText('❌ Report bekor qilindi. (Vazifalar draft holatda qoldi)');
});

// ====== WEBAPP: planner dispatch (mini app sendData) ======
const dispatchPlansToOwners = async (ctx, planDate, creatorId) => {
  // draftlarni olamiz
  let q = supabase
    .from('task_plans')
    .select('id, assignee_tg_id, task_text, creator_id, created_at')
    .eq('plan_date', planDate)
    .eq('status', 'draft')
    .order('created_at', { ascending: true });

  // Admin bo'lmasa faqat o'z yaratganlari
  if (ctx.from.id !== ADMIN_ID) {
    q = q.eq('creator_id', creatorId);
  }

  const { data: plans, error } = await q;

  if (error) {
    console.error('task_plans fetch error:', error);
    return { ok: false, message: "❌ Reja vazifalarini olishda xatolik bo'ldi." };
  }

  if (!plans?.length) {
    return { ok: false, message: "📭 Bu sana uchun yuboriladigan draft reja topilmadi." };
  }

  // group by assignee
  const grouped = {};
  for (const p of plans) {
    grouped[p.assignee_tg_id] = grouped[p.assignee_tg_id] || [];
    grouped[p.assignee_tg_id].push(p);
  }

  let sentOk = 0;
  let sentFail = 0;

  for (const [assigneeIdStr, items] of Object.entries(grouped)) {
    const assigneeId = Number(assigneeIdStr);

    const text =
      `🗓️ <b>Reja (${formatUzDate(planDate)})</b>\n\n` +
      items.map((x, i) => `${i + 1}. ${escapeHTML(x.task_text)}`).join('\n');

    try {
      await ctx.telegram.sendMessage(assigneeId, text, { parse_mode: 'HTML' });
      sentOk += 1;
    } catch (e) {
      sentFail += 1;
      const msg = e?.response?.description || e?.message || String(e);
      console.warn(`⚠️ Plan send failed → ${assigneeId}: ${msg}`);
    }

    await delay(35);
  }

  // mark sent
  try {
    await supabase
      .from('task_plans')
      .update({ status: 'sent' })
      .in('id', plans.map((p) => p.id));
  } catch (e) {
    console.warn('⚠️ task_plans mark sent failed:', e?.message || e);
  }

  return {
    ok: true,
    message: `✅ Reja yuborildi.\n\nXodimlar: ${Object.keys(grouped).length}\nYuborildi: ${sentOk}\nXato: ${sentFail}`,
  };
};

// ====== TEXT HANDLER ======
bot.on('text', async (ctx) => {
  // 1) Buyruqlar (/) ni o'tkazib yuborish
  if (ctx.message.text.startsWith('/')) return;

  // 2) Faqat shaxsiy chat
  if (ctx.chat.type !== 'private') return;

  // 3) WebApp sendData kelgan bo'lsa (mini app)
  // Telegram WebApp message odatda text + web_app_data bilan keladi,
  // shuning uchun albatta 1-o'rinda tutib qolamiz.
  if (ctx.message.web_app_data && ctx.message.web_app_data.data) {
    let payload;
    try {
      payload = JSON.parse(ctx.message.web_app_data.data);
    } catch {
      // agar json bo'lmasa, shunchaki e'tiborsiz
      return;
    }

    if (payload?.type === 'dispatch_plans') {
      if (!isPlanner(ctx.from.id) && ctx.from.id !== ADMIN_ID) {
        return ctx.reply("Bu amal faqat mas'ul shaxs uchun.");
      }

      const planDate = payload?.date || getTashkentISODate(1);
      const result = await dispatchPlansToOwners(ctx, planDate, ctx.from.id);
      return ctx.reply(result.message);
    }

    // boshqa webapp eventlar bo'lsa kelajakda shu yerda tutib olamiz
    return;
  }

  // 4) Taskmode yoqilgan bo'lsa - kompaniya hisobotini tahlil qilamiz
  const textValue = (ctx.message.text || '').trim();
  const looksLikeTaskmodeInput = /🏗|кунлик ҳисоботи|kunlik hisoboti/i.test(textValue);

  if (looksLikeTaskmodeInput && isTaskmodeAllowed(ctx.from.id) && await isTaskmodeEnabled(ctx.from.id)) {
    const progress = await ctx.reply('⏳ Tahlil qilinmoqda...');

    try {
      const payload = await buildTaskmodeJobPayload(textValue);

      if (!payload.companies.length) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          progress.message_id,
          undefined,
          "⚠️ Taskmode uchun kompaniya hisobotlari topilmadi. Matn formatini tekshiring.",
        );
      }

      if (!payload.notifications.length && !payload.unresolved.length) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          progress.message_id,
          undefined,
          "✅ Tahlil tugadi. Hozircha no-faol bo‘lim topilmadi.",
        );
      }

      const { data: job, error } = await supabase
        .from('taskmode_jobs')
        .insert([
          {
            creator_id: ctx.from.id,
            raw_text: textValue,
            preview_text: payload.preview_text,
            notifications: payload.notifications,
            unresolved: payload.unresolved,
            source_count: payload.companies.length,
            status: 'draft',
          },
        ])
        .select('id')
        .single();

      if (error || !job?.id) {
        console.error('taskmode_jobs insert error:', error?.message || error);
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          progress.message_id,
          undefined,
          "❌ Taskmode draft saqlanmadi. DB xatolik yuz berdi.",
        );
      }

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tayyor, yuborishni tasdiqlang', `taskmode_confirm_${job.id}`)],
        [Markup.button.callback('❌ Bekor qilish', `taskmode_cancel_${job.id}`)],
      ]);

      return ctx.telegram.editMessageText(
        ctx.chat.id,
        progress.message_id,
        undefined,
        `${payload.preview_text}

✅ <b>Tayyor.</b> Yuborishni tasdiqlang.`,
        { parse_mode: 'HTML', ...keyboard },
      );
    } catch (err) {
      console.error('taskmode parse error:', err?.message || err);
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        progress.message_id,
        undefined,
        "❌ Taskmode tahlilida xatolik yuz berdi.",
      );
    }
  }

  // 5) Agar mas'ul shaxs /tasks rejimida bo'lsa - task_plans ga yozamiz
  if (isPlanner(ctx.from.id)) {
    const { data: state } = await supabase
      .from('planner_state')
      .select('assignee_tg_id, plan_date')
      .eq('creator_id', ctx.from.id)
      .single();

    if (state?.assignee_tg_id) {
      const content = (ctx.message.text || '').trim();
      if (!content) return;

      const planDate = state.plan_date || getTashkentISODate(1);

      const { error } = await supabase.from('task_plans').insert([
        {
          creator_id: ctx.from.id,
          assignee_tg_id: state.assignee_tg_id,
          task_text: content,
          plan_date: planDate,
          status: 'draft',
        },
      ]);

      if (error) {
        console.error('task_plans insert error:', error);
        return ctx.reply("❌ Task saqlanmadi (DB xatolik)");
      }

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("👥 Xodimni almashtirish", 'plan_change')],
        [Markup.button.callback("📋 Ro'yxat", 'plan_show_list')],
        [Markup.button.callback('✅ Tayyor /report', 'plan_report_hint')],
      ]);

      return ctx.reply(
        `✅ Task qo'shildi (${formatUzDate(planDate)}):\n<b>${escapeHTML(content)}</b>`,
        { parse_mode: 'HTML', ...keyboard }
      );
    }
  }

  // 5) Default: oddiy hisobot (reports)
  try {
    await supabase.from('reports').insert([
      {
        user_id: ctx.from.id,
        content: ctx.message.text,
        status: 'pending',
      },
    ]);
    await ctx.reply("✅ Hisobotga qo'shildi.", { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    console.error('Text save error:', err);
  }
});

bot.action('plan_show_list', async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
  await ctx.answerCbQuery();
  return bot.telegram.sendMessage(ctx.from.id, "📋 Ko'rish uchun yozing: /tasks list");
});

bot.action('plan_report_hint', async (ctx) => {
  if (!isPlanner(ctx.from.id)) return ctx.answerCbQuery("Ruxsat yo'q");
  await ctx.answerCbQuery();
  return bot.telegram.sendMessage(ctx.from.id, '✅ Preview va yuborish uchun: /report');
});

// ====== LEADERBOARD / MONTH-END SUMMARY (BOSS) ======

// Pad helper
const pad2 = (n) => String(n).padStart(2, '0');
const daysInMonth = (year, month1to12) => new Date(Date.UTC(year, month1to12, 0)).getUTCDate();

const getTashkentYMD = () => {
  const iso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }); // YYYY-MM-DD
  const [y, m, d] = String(iso).split('-').map((x) => parseInt(x, 10));
  return { y, m, d, iso };
};

const getPrevMonthRangeISO = () => {
  const { y, m } = getTashkentYMD();
  let year = y;
  let month = m - 1;
  if (month <= 0) {
    month = 12;
    year -= 1;
  }
  const startISO = `${year}-${pad2(month)}-01`;
  const endISO = `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`;
  return { year, month, startISO, endISO };
};

const buildLeaderboardForRange = async ({ startISO, endISO }) => {
  // Tashkent timezone'da to'liq oy/kun diapazoni
  const startTS = `${startISO}T00:00:00+05:00`;
  const endTS = `${endISO}T23:59:59.999+05:00`;

  const [{ data: employees, error: empErr }, { data: plans, error: planErr }, { data: reps, error: repErr }] =
    await Promise.all([
      supabase.from('users_mapping').select('telegram_id, full_name').order('full_name', { ascending: true }),
      supabase.from('task_plans').select('assignee_tg_id, status').gte('plan_date', startISO).lte('plan_date', endISO),
      supabase.from('reports').select('user_id, status').gte('created_at', startTS).lte('created_at', endTS),
    ]);

  if (empErr) throw new Error(`users_mapping error: ${empErr.message}`);
  if (planErr) throw new Error(`task_plans error: ${planErr.message}`);
  if (repErr) throw new Error(`reports error: ${repErr.message}`);

  const planBy = {};
  (plans || []).forEach((p) => {
    const k = String(p.assignee_tg_id || '');
    if (!planBy[k]) planBy[k] = { total: 0, sent: 0, queued: 0, draft: 0 };
    planBy[k].total += 1;
    if (p.status === 'sent') planBy[k].sent += 1;
    else if (p.status === 'queued') planBy[k].queued += 1;
    else planBy[k].draft += 1;
  });

  const repBy = {};
  (reps || []).forEach((r) => {
    const k = String(r.user_id || '');
    if (!repBy[k]) repBy[k] = { total: 0, sent: 0, pending: 0 };
    repBy[k].total += 1;
    if (r.status === 'sent') repBy[k].sent += 1;
    else repBy[k].pending += 1;
  });

  const rows = (employees || []).map((u) => {
    const id = String(u.telegram_id);
    const name = u.full_name || `TG ${id}`;
    const p = planBy[id] || { total: 0, sent: 0, queued: 0, draft: 0 };
    const r = repBy[id] || { total: 0, sent: 0, pending: 0 };
    return { id, name, p, r, score: r.total };
  });

  rows.sort((a, b) => (b.score - a.score) || (b.r.sent - a.r.sent) || a.name.localeCompare(b.name));
  return rows;
};

// Idempotency: oy oxirida 2 marta ketib qolmasligi uchun (ixtiyoriy)
// Supabase'da jadval kerak: cron_runs(job text, run_key text, ran_at timestamptz default now(), primary key(job, run_key))
const reserveCronRun = async (job, runKey) => {
  try {
    const { data, error } = await supabase
      .from('cron_runs')
      .upsert([{ job, run_key: runKey }], { onConflict: 'job,run_key', ignoreDuplicates: true })
      .select('job');

    if (error) {
      // Jadval yo'q bo'lsa ham ishlayversin (faqat dublikatga kafolat yo'q)
      console.warn('⚠️ cron_runs upsert warning:', error.message);
      return { reserved: true, via: 'no-table-or-error' };
    }

    // ignoreDuplicates bo'lsa: insert bo'lsa data.length > 0, mavjud bo'lsa []
    const reserved = Array.isArray(data) && data.length > 0;
    return { reserved, via: 'db' };
  } catch (e) {
    console.warn('⚠️ cron_runs reserve error:', e?.message || e);
    return { reserved: true, via: 'exception' };
  }
};

const sendMonthlyLeaderboardToBoss = async () => {
  const { year, month, startISO, endISO } = getPrevMonthRangeISO();
  const runKey = `${year}-${pad2(month)}`;

  const resv = await reserveCronRun('monthly_leaderboard', runKey);
  if (!resv.reserved) {
    console.log(`ℹ️ monthly_leaderboard already sent for ${runKey}`);
    return { ok: true, skipped: true, runKey };
  }

  const rows = await buildLeaderboardForRange({ startISO, endISO });
  const top = rows.filter((x) => x.r.total > 0).slice(0, 10);

  const title = new Intl.DateTimeFormat('uz-UZ', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Tashkent',
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  let text = `🏆 <b>Eng faol ishchilar — ${escapeHTML(title)}</b>\n`;
  text += `<i>Davr:</i> ${escapeHTML(startISO)} — ${escapeHTML(endISO)}\n\n`;

  if (!top.length) {
    text += 'Hali bu oy bo‘yicha ishlar topilmadi.';
  } else {
    top.forEach((x, i) => {
      text += `${i + 1}-o‘rin — <b>${escapeHTML(x.name)}</b>: ${x.r.total} ish (🟢 ${x.r.sent} yuborilgan)\n`;
    });
  }

  await bot.telegram.sendMessage(BOSS_ID, text, { parse_mode: 'HTML' });
  return { ok: true, skipped: false, runKey };
};

// Optional: qo'lda tekshirish uchun (rahbar)
bot.command('top', async (ctx) => {
  if (ctx.from.id !== BOSS_ID && ctx.from.id !== ADMIN_ID) return;

  const arg = (ctx.message.text.split(' ')[1] || '').trim().toLowerCase();
  const today = getTashkentISODate(0);

  // default: month (current month-to-date)
  let startISO = today;
  let endISO = today;

  if (arg === 'today' || arg === 'bugun') {
    startISO = today;
    endISO = today;
  } else if (arg === 'week' || arg === 'hafta') {
    // last 7 days (including today)
    const dt = new Date(`${today}T00:00:00Z`);
    const dtStart = new Date(dt.getTime() - 6 * 24 * 60 * 60 * 1000);
    startISO = dtStart.toISOString().slice(0, 10);
    endISO = today;
  } else {
    // month-to-date
    const [y, m] = today.split('-').map(Number);
    startISO = `${y}-${pad2(m)}-01`;
    endISO = today;
  }

  const rows = await buildLeaderboardForRange({ startISO, endISO });
  const top = rows.filter((x) => x.r.total > 0).slice(0, 10);

  let text = `🏅 <b>TOP ishchilar</b>\n<i>Davr:</i> ${escapeHTML(startISO)} — ${escapeHTML(endISO)}\n\n`;
  if (!top.length) {
    text += 'Bu davrda ishlar topilmadi.';
  } else {
    top.forEach((x, i) => {
      text += `${i + 1}-o‘rin — <b>${escapeHTML(x.name)}</b>: ${x.r.total} ish (🟢 ${x.r.sent})\n`;
    });
  }

  return ctx.reply(text, { parse_mode: 'HTML' });
});

// ====== SERVER LOGIC ======
module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const job = url.searchParams.get('job');

  // ====== CRON / JOBS (GET) ======
  if (req.method === 'GET' && job) {
    try {
      if (job === 'monthly_leaderboard') {
        const expected = process.env.CRON_SECRET;
        if (expected) {
          const got = url.searchParams.get('secret') || getHeader(req, 'x-cron-secret');
          if (got !== expected) return res.status(401).send('Invalid cron secret');
        }

        const result = await sendMonthlyLeaderboardToBoss();
        if (typeof res.json === 'function') return res.status(200).json(result);
        return res.status(200).send(JSON.stringify(result));
      }

      return res.status(404).send('Unknown job');
    } catch (err) {
      console.error('Cron/job handler error:', err?.message || err);
      return res.status(500).send('Cron error');
    }
  }

  // ====== WEBHOOKS (POST) ======
  if (req.method === 'POST') {
    try {
      // ⚠️ AGAR BU CLICKUP WEBHOOK BO'LSA
      if (req.body && req.body.webhook_id) {
        // Optional signature verification (strict mode via env)
        const ok = verifyClickUpSignature(req);
        if (!ok) {
          console.warn('⚠️ ClickUp signature verification failed');
          return res.status(401).send('Invalid signature');
        }
        await handleClickUpWebhook(req);
        return res.status(200).send('OK');
      }

      // ⚠️ AGAR BU TELEGRAM XABARI BO'LSA
      const tgOk = verifyTelegramSecret(req);
      if (!tgOk) {
        console.warn('⚠️ Telegram secret token verification failed');
        return res.status(401).send('Invalid telegram secret');
      }

      if (isPrivateChatUpdate(req.body) && isStartCommand(req.body)) {
        const msg = getUpdateMessage(req.body);
        const payload = buildWebhookReplySendMessage(
          msg.chat.id,
          buildWelcomeText(msg?.from?.first_name || 'foydalanuvchi'),
          { parse_mode: 'HTML' },
        );
        if (typeof res.json === 'function') return res.status(200).json(payload);
        return res.status(200).send(JSON.stringify(payload));
      }

      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Main Handler Error:', err);
      return res.status(200).send('OK');
    }
  }

  res.status(200).send('Bot is active!');
};