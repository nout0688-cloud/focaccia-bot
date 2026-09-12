/**
 * Фокача Клікер — Telegram Bot (Vercel Serverless)
 * Webhook + Admin panel для user ID 1975429762
 */

const WEBAPP_URL = 'https://nout0688-cloud.github.io/focaccia-clicker/?v=1.4.0';
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 1975429762;

async function redis(...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return res.json();
}

async function sendTg(token, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram API error:', data);
      // Auto-fallback if Markdown parse failed
      if (body.parse_mode && data.description && data.description.includes("can't parse entities")) {
        const retryBody = { ...body };
        delete retryBody.parse_mode;
        const retryRes = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(retryBody),
        });
        return retryRes.json();
      }
    }
    return data;
  } catch (err) {
    console.error('sendTg fetch error:', err);
    return null;
  }
}

const DUEL_MSG_CLEANUP_TTL = 15 * 60 * 1000; // 15 хвилин

async function scheduleMessageDeletion(chatId, messageId, delayMs = DUEL_MSG_CLEANUP_TTL) {
  if (!chatId || !messageId) return;
  try {
    const expireAt = Date.now() + delayMs;
    await redis('ZADD', 'duel_msg_cleanup', String(expireAt), `${chatId}:${messageId}`);
  } catch (e) {
    console.error('scheduleMessageDeletion error:', e);
  }
}

async function cleanupExpiredMessages(token) {
  const botToken = token || process.env.BOT_TOKEN;
  if (!botToken) return;
  try {
    const now = Date.now();
    const raw = await redis('ZRANGEBYSCORE', 'duel_msg_cleanup', '0', String(now));
    if (raw?.result && Array.isArray(raw.result) && raw.result.length > 0) {
      const items = raw.result;
      await Promise.allSettled(
        items.map(async (item) => {
          const sep = item.indexOf(':');
          if (sep === -1) return;
          const cId = item.slice(0, sep);
          const mId = item.slice(sep + 1);
          if (cId && mId) {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: Number(cId), message_id: Number(mId) }),
            }).catch(() => {});
          }
        })
      );
      await redis('ZREMRANGEBYSCORE', 'duel_msg_cleanup', '0', String(now));
    }
  } catch (err) {
    console.error('cleanupExpiredMessages error:', err);
  }
}

async function sendDuelTg(token, method, body, delayMs = DUEL_MSG_CLEANUP_TTL) {
  const res = await sendTg(token, method, body);
  if (res?.result?.message_id && body.chat_id) {
    await scheduleMessageDeletion(body.chat_id, res.result.message_id, delayMs);
  }
  return res;
}

function formatNum(n) {
  if (!isFinite(n)) return '∞';
  if (n < 1000) return Math.floor(n).toString();
  const units = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  if (v >= 1000) return n.toExponential(2).replace('e+', 'e');
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}${units[i]}`;
}

async function getUserBalance(userId, cur) {
  const uid = String(userId);
  let bal = null;
  const balData = await redis('HGET', 'user_balance', uid);
  if (balData?.result) {
    try {
      const bObj = JSON.parse(balData.result);
      const val = cur === 'gem' ? Number(bObj.d) : Number(bObj.f);
      if (!isNaN(val) && val > 0) bal = val;
    } catch { /* */ }
  }
  const lbData = await redis('HGET', 'leaderboard', uid);
  if (lbData?.result) {
    try {
      const lbObj = JSON.parse(lbData.result);
      if (cur === 'foc' && typeof lbObj.t === 'number') {
        bal = Math.max(bal || 0, lbObj.t);
      }
    } catch { /* */ }
  }
  return bal;
}

function isAdmin(userId) {
  return ADMIN_ID !== null && userId === ADMIN_ID;
}

async function resolveTargetUser(input) {
  if (!input) return null;
  const raw = String(input).replace(/^@/, '').trim();
  if (!raw) return null;

  // 1. Якщо це числовий ID (наприклад 1975429762)
  if (/^\d{4,25}$/.test(raw)) {
    const id = raw;
    let username = '';
    let name = `ID ${id}`;

    const uData = await redis('HGET', 'users', id);
    if (uData?.result) {
      try {
        const u = JSON.parse(uData.result);
        if (u.username) username = u.username;
        if (u.name) name = u.name;
      } catch { /* */ }
    } else {
      const lbData = await redis('HGET', 'leaderboard', id);
      if (lbData?.result) {
        try {
          const lb = JSON.parse(lbData.result);
          if (lb.u) username = lb.u;
          if (lb.n) name = lb.n;
        } catch { /* */ }
      }
    }

    return {
      id,
      username,
      name,
      display: username ? `@${username} (\`${id}\`)` : `\`${id}\``,
      shortDisplay: username ? `@${username}` : `\`${id}\``,
    };
  }

  // 2. Пошук по таблиці usernames
  const unameKey = raw.toLowerCase();
  const tData = await redis('HGET', 'usernames', unameKey);
  if (tData?.result) {
    const id = String(tData.result);
    let name = raw;
    let username = raw;
    const uData = await redis('HGET', 'users', id);
    if (uData?.result) {
      try {
        const u = JSON.parse(uData.result);
        if (u.name) name = u.name;
        if (u.username) username = u.username;
      } catch { /* */ }
    }
    return {
      id,
      username,
      name,
      display: `@${username} (\`${id}\`)`,
      shortDisplay: `@${username}`,
    };
  }

  // 3. Fallback: пошук у хеші users (якщо маппінг usernames застарів)
  const usersData = await redis('HGETALL', 'users');
  if (usersData?.result) {
    for (let i = 0; i < usersData.result.length; i += 2) {
      const id = String(usersData.result[i]);
      try {
        const u = JSON.parse(usersData.result[i + 1]);
        if (u.username && u.username.toLowerCase() === unameKey) {
          await redis('HSET', 'usernames', unameKey, id);
          return {
            id,
            username: u.username,
            name: u.name || id,
            display: `@${u.username} (\`${id}\`)`,
            shortDisplay: `@${u.username}`,
          };
        }
      } catch { /* */ }
    }
  }

  // 4. Fallback: пошук у leaderboard
  const lbData = await redis('HGETALL', 'leaderboard');
  if (lbData?.result) {
    for (let i = 0; i < lbData.result.length; i += 2) {
      const id = String(lbData.result[i]);
      try {
        const lb = JSON.parse(lbData.result[i + 1]);
        if (lb.u && lb.u.toLowerCase() === unameKey) {
          await redis('HSET', 'usernames', unameKey, id);
          return {
            id,
            username: lb.u,
            name: lb.n || id,
            display: `@${lb.u} (\`${id}\`)`,
            shortDisplay: `@${lb.u}`,
          };
        }
      } catch { /* */ }
    }
  }

  return null;
}

async function deleteTg(token, chatId, messageId) {
  if (!chatId || !messageId) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(chatId), message_id: Number(messageId) }),
    });
    return res.json();
  } catch {
    return null;
  }
}

function formatContestCur(cur, amount) {
  const formatted = (amount || 0).toLocaleString('uk-UA');
  if (cur === 'gem') return `${formatted} 💎 Алмазів`;
  if (cur === 'rebirth') return `${formatted} 🔄 Ребіртхів`;
  return `${formatted} 🫓 Фокач`;
}

function formatDurationHours(h) {
  if (h < 1) return `${Math.round(h * 60)} хв`;
  if (h === 1) return '1 год';
  if (h < 24) return `${h} год`;
  const days = Math.round(h / 24);
  if (days === 1) return '24 год (1 день)';
  if (days <= 4) return `${days * 24} год (${days} дні)`;
  return `${days * 24} год (${days} днів)`;
}

function formatKyivDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function computeKyivScheduledTime(targetHour, targetMinute, dayOffset = 0) {
  const now = new Date();
  const kNowStr = now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hourCycle: 'h23' });
  const kDate = new Date(kNowStr);
  
  const target = new Date(kDate);
  target.setDate(target.getDate() + dayOffset);
  target.setHours(targetHour, targetMinute, 0, 0);

  const diffMs = target.getTime() - kDate.getTime();
  return now.getTime() + diffMs;
}

function parseCustomKyivTime(input) {
  const text = String(input || '').trim();
  const now = new Date();
  const kNowStr = now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hourCycle: 'h23' });
  const kDate = new Date(kNowStr);

  const plusMatch = text.match(/^\+?\s*(\d+(?:\.\d+)?)\s*(?:h|год|годин|ч|час)?$/i);
  if (plusMatch && text.startsWith('+')) {
    const hours = parseFloat(plusMatch[1]);
    if (!isNaN(hours) && hours > 0) {
      return now.getTime() + Math.round(hours * 3600 * 1000);
    }
  }

  const isTomorrow = /завтра|tomorrow/i.test(text);
  const cleanTime = text.replace(/завтра|сьогодні|tomorrow|today/gi, '').trim();

  const timeMatch = cleanTime.match(/^(\d{1,2})[:.\s](\d{2})$/) || cleanTime.match(/^(\d{1,2})$/);
  if (timeMatch) {
    const targetHour = parseInt(timeMatch[1], 10);
    const targetMinute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    if (targetHour >= 0 && targetHour <= 23 && targetMinute >= 0 && targetMinute <= 59) {
      const target = new Date(kDate);
      target.setHours(targetHour, targetMinute, 0, 0);

      if (target.getTime() <= kDate.getTime() && !/сьогодні|today/i.test(text)) {
        target.setDate(target.getDate() + 1);
      } else if (isTomorrow) {
        target.setDate(target.getDate() + 1);
      }

      const diffMs = target.getTime() - kDate.getTime();
      return now.getTime() + diffMs;
    }
  }

  return null;
}

async function getContestDraft(adminId) {
  const dRaw = await redis('GET', `contest_draft:${adminId}`);
  if (dRaw?.result) {
    try {
      const d = JSON.parse(dRaw.result);
      return {
        cur: d.cur || 'foc',
        amount: d.amount || 10000000,
        winners: d.winners || 3,
        durationHours: d.durationHours || 24,
        scheduledStartTime: d.scheduledStartTime || null,
        builderMsgId: d.builderMsgId || null,
      };
    } catch { /* */ }
  }
  return {
    cur: 'foc',
    amount: 10000000,
    winners: 3,
    durationHours: 24,
    scheduledStartTime: null,
    builderMsgId: null,
  };
}

async function setContestDraft(adminId, draft) {
  await redis('SET', `contest_draft:${adminId}`, JSON.stringify(draft), 'EX', 86400);
}

function renderBuilderMessage(draft) {
  const isScheduled = draft.scheduledStartTime && draft.scheduledStartTime > Date.now() + 60000;
  const startTs = isScheduled ? draft.scheduledStartTime : Date.now();
  const endTs = startTs + Math.round((draft.durationHours || 24) * 3600 * 1000);
  const totalPrize = (draft.amount || 10000000) * (draft.winners || 3);
  const totalFormatted = formatContestCur(draft.cur, totalPrize);
  const singleFormatted = formatContestCur(draft.cur, draft.amount || 10000000);
  const startDisplay = isScheduled
    ? `📅 ${formatKyivDate(draft.scheduledStartTime)} (Київ)`
    : '⚡ Зараз (миттєво)';

  const text =
    `🛠 *БІЛДЕР КОНКУРСУ* 🎁\n\n` +
    `Налаштуйте параметри перед запуском розіграшу:\n\n` +
    `🎁 *Приз кожному:* ${singleFormatted}\n` +
    `👥 *Кількість переможців:* ${draft.winners || 3} гравців\n` +
    `⏱ *Тривалість:* ${formatDurationHours(draft.durationHours || 24)}\n` +
    `📅 *Час старту:* ${startDisplay}\n` +
    `🏁 *Підбиття підсумків:* ${formatKyivDate(endTs)} (за Києвом)\n` +
    `💰 *Загальний призовий фонд:* ${totalFormatted}\n\n` +
    (isScheduled
      ? `⏰ *Статус:* Заплановано. Після підтвердження бот автоматично опублікує конкурс у зазначений час без вашої присутності!`
      : `👇 *Оберіть параметр, який бажаєте змінити:*`);

  const reply_markup = {
    inline_keyboard: [
      [{ text: `🎁 Змінити приз (${singleFormatted})`, callback_data: 'concurs:menu:prize' }],
      [{ text: `👥 Змінити переможців (${draft.winners || 3})`, callback_data: 'concurs:menu:winners' }],
      [{ text: `⏱ Змінити тривалість (${formatDurationHours(draft.durationHours || 24)})`, callback_data: 'concurs:menu:duration' }],
      [{ text: `📅 Старт: ${startDisplay}`, callback_data: 'concurs:menu:schedule' }],
      [{
        text: isScheduled ? '⏰ Запланувати розіграш' : '🚀 Опублікувати конкурс усім гравцям',
        callback_data: 'concurs:publish'
      }],
      [
        { text: '⬅️ До адмінки', callback_data: 'admin:back' },
        { text: '❌ Закрити білдер', callback_data: 'concurs:close' },
      ],
    ],
  };

  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderScheduleMenu(draft) {
  const isScheduled = draft.scheduledStartTime && draft.scheduledStartTime > Date.now() + 60000;
  const currentStart = isScheduled
    ? `Заплановано на ${formatKyivDate(draft.scheduledStartTime)} (за Києвом)`
    : '⚡ Зараз (одразу після публікації)';

  const text =
    `📅 *ЧАС ЗАПУСКУ РОЗІГРАШУ*\n\n` +
    `Поточний старт: *${currentStart}*\n\n` +
    `Оберіть, коли конкурс має автоматично розпочатися:\n` +
    `• *Завтра о 15:00* — бот автоматично запустить конкурс завтра о 15:00 за Києвом (навіть якщо ви не за ПК!)\n` +
    `• *Зараз* — конкурс опублікується миттєво після збереження\n` +
    `• Або оберіть інший час чи введіть свій:`;

  const rows = [
    [
      { text: !isScheduled ? '🔘 ⚡ Зараз (миттєво)' : '⚡ Зараз (миттєво)', callback_data: 'concurs:set_sched:now' },
    ],
    [
      { text: '☀️ Завтра о 15:00 (Київ)', callback_data: 'concurs:set_sched:tomorrow_15' },
      { text: '🌅 Завтра о 12:00 (Київ)', callback_data: 'concurs:set_sched:tomorrow_12' },
    ],
    [
      { text: '🌇 Завтра о 18:00 (Київ)', callback_data: 'concurs:set_sched:tomorrow_18' },
      { text: '🌙 Завтра о 21:00 (Київ)', callback_data: 'concurs:set_sched:tomorrow_21' },
    ],
    [
      { text: '⏱ +1 год', callback_data: 'concurs:set_sched:plus_1' },
      { text: '⏱ +3 год', callback_data: 'concurs:set_sched:plus_3' },
      { text: '⏱ +6 год', callback_data: 'concurs:set_sched:plus_6' },
      { text: '⏱ +12 год', callback_data: 'concurs:set_sched:plus_12' },
    ],
    [
      { text: '✍️ Вказати власний час (ГГ:ХХ або +годин)', callback_data: 'concurs:custom_schedule' },
    ],
    [
      { text: '⬅️ Назад до білдера', callback_data: 'concurs:back' },
    ],
  ];

  return {
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function renderPrizeMenu(draft) {
  const cur = draft.cur || 'foc';
  const currentFormatted = formatContestCur(cur, draft.amount || 10000000);

  const text =
    `🎁 *ВИБІР ПРИЗУ ТА СУМИ*\n\n` +
    `Поточний приз: *${currentFormatted}*\n\n` +
    `1️⃣ *Оберіть валюту розіграшу:*\n` +
    `2️⃣ *Оберіть бажану суму зі списку або введіть власну:*`;

  const curRow = [
    { text: `${cur === 'foc' ? '🔘' : '⚪️'} 🫓 Фокачі`, callback_data: 'concurs:set_cur:foc' },
    { text: `${cur === 'gem' ? '🔘' : '⚪️'} 💎 Алмази`, callback_data: 'concurs:set_cur:gem' },
    { text: `${cur === 'rebirth' ? '🔘' : '⚪️'} 🔄 Ребіртхи`, callback_data: 'concurs:set_cur:rebirth' },
  ];

  let amountRows = [];
  if (cur === 'foc') {
    amountRows = [
      [
        { text: '500 тис 🫓', callback_data: 'concurs:set_amount:500000' },
        { text: '1 млн 🫓', callback_data: 'concurs:set_amount:1000000' },
        { text: '5 млн 🫓', callback_data: 'concurs:set_amount:5000000' },
      ],
      [
        { text: '10 млн 🫓', callback_data: 'concurs:set_amount:10000000' },
        { text: '25 млн 🫓', callback_data: 'concurs:set_amount:25000000' },
        { text: '50 млн 🫓', callback_data: 'concurs:set_amount:50000000' },
      ],
      [
        { text: '100 млн 🫓', callback_data: 'concurs:set_amount:100000000' },
        { text: '500 млн 🫓', callback_data: 'concurs:set_amount:500000000' },
        { text: '1 млрд 🫓', callback_data: 'concurs:set_amount:1000000000' },
      ],
    ];
  } else if (cur === 'gem') {
    amountRows = [
      [
        { text: '10 💎', callback_data: 'concurs:set_amount:10' },
        { text: '25 💎', callback_data: 'concurs:set_amount:25' },
        { text: '50 💎', callback_data: 'concurs:set_amount:50' },
      ],
      [
        { text: '100 💎', callback_data: 'concurs:set_amount:100' },
        { text: '250 💎', callback_data: 'concurs:set_amount:250' },
        { text: '500 💎', callback_data: 'concurs:set_amount:500' },
      ],
      [
        { text: '1,000 💎', callback_data: 'concurs:set_amount:1000' },
        { text: '2,500 💎', callback_data: 'concurs:set_amount:2500' },
        { text: '5,000 💎', callback_data: 'concurs:set_amount:5000' },
      ],
    ];
  } else {
    amountRows = [
      [
        { text: '1 🔄', callback_data: 'concurs:set_amount:1' },
        { text: '2 🔄', callback_data: 'concurs:set_amount:2' },
        { text: '3 🔄', callback_data: 'concurs:set_amount:3' },
      ],
      [
        { text: '5 🔄', callback_data: 'concurs:set_amount:5' },
        { text: '10 🔄', callback_data: 'concurs:set_amount:10' },
        { text: '20 🔄', callback_data: 'concurs:set_amount:20' },
      ],
    ];
  }

  const customRow = [
    [{ text: '✍️ Ввести свою суму вручну', callback_data: 'concurs:custom_amount' }],
    [{ text: '⬅️ Назад до білдера', callback_data: 'concurs:back' }],
  ];

  return {
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [curRow, ...amountRows, ...customRow],
    },
  };
}

function renderWinnersMenu(draft) {
  const current = draft.winners || 3;
  const text =
    `👥 *КІЛЬКІСТЬ ПЕРЕМОЖЦІВ*\n\n` +
    `Поточна кількість: *${current}* гравців\n\n` +
    `Скільки випадкових учасників отримають зазначений приз?`;

  const deltaRow = [
    { text: '➖ 1', callback_data: 'concurs:delta_winners:-1' },
    { text: `[ ${current} ]`, callback_data: 'concurs:none' },
    { text: '➕ 1', callback_data: 'concurs:delta_winners:1' },
  ];

  const presetsRow1 = [
    { text: current === 1 ? '🔘 1' : '1', callback_data: 'concurs:set_winners:1' },
    { text: current === 2 ? '🔘 2' : '2', callback_data: 'concurs:set_winners:2' },
    { text: current === 3 ? '🔘 3' : '3', callback_data: 'concurs:set_winners:3' },
  ];

  const presetsRow2 = [
    { text: current === 5 ? '🔘 5' : '5', callback_data: 'concurs:set_winners:5' },
    { text: current === 10 ? '🔘 10' : '10', callback_data: 'concurs:set_winners:10' },
    { text: current === 20 ? '🔘 20' : '20', callback_data: 'concurs:set_winners:20' },
  ];

  const backRow = [
    { text: '⬅️ Назад до білдера', callback_data: 'concurs:back' },
  ];

  return {
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [deltaRow, presetsRow1, presetsRow2, backRow],
    },
  };
}

function renderDurationMenu(draft) {
  const current = draft.durationHours || 24;
  const text =
    `⏱ *ТРИВАЛІСТЬ КОНКУРСУ*\n\n` +
    `Поточний час: *${formatDurationHours(current)}*\n\n` +
    `Оберіть, скільки часу триватиме розіграш до автоматичного визначення переможців:`;

  const rows = [
    [
      { text: current === 0.25 ? '🔘 15 хв' : '15 хв', callback_data: 'concurs:set_duration:0.25' },
      { text: current === 0.5 ? '🔘 30 хв' : '30 хв', callback_data: 'concurs:set_duration:0.5' },
      { text: current === 1 ? '🔘 1 год' : '1 год', callback_data: 'concurs:set_duration:1' },
    ],
    [
      { text: current === 3 ? '🔘 3 год' : '3 год', callback_data: 'concurs:set_duration:3' },
      { text: current === 6 ? '🔘 6 год' : '6 год', callback_data: 'concurs:set_duration:6' },
      { text: current === 12 ? '🔘 12 год' : '12 год', callback_data: 'concurs:set_duration:12' },
    ],
    [
      { text: current === 24 ? '🔘 24 год (1д)' : '24 год (1д)', callback_data: 'concurs:set_duration:24' },
      { text: current === 48 ? '🔘 48 год (2д)' : '48 год (2д)', callback_data: 'concurs:set_duration:48' },
      { text: current === 72 ? '🔘 3 дні' : '3 дні', callback_data: 'concurs:set_duration:72' },
    ],
    [
      { text: current === 168 ? '🔘 1 тиждень' : '1 тиждень', callback_data: 'concurs:set_duration:168' },
    ],
    [
      { text: '⬅️ Назад до білдера', callback_data: 'concurs:back' },
    ],
  ];

  return {
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

async function handleContestJoin(TOKEN, contestId, fromUser) {
  if (!contestId || !fromUser?.id) return { msg: '❌ Помилка запиту' };
  const userId = String(fromUser.id);
  const name = fromUser.first_name || 'Гравець';
  const username = fromUser.username || '';

  const cRaw = await redis('HGET', 'contest:' + contestId, 'data');
  if (!cRaw?.result) {
    return { msg: '❌ Конкурс не знайдено або він застарів', alert: true };
  }

  let contestObj;
  try { contestObj = JSON.parse(cRaw.result); } catch { return { msg: '❌ Помилка даних', alert: true }; }

  if (contestObj.status !== 'active') {
    return { msg: '🏁 Цей конкурс уже завершено!', alert: true };
  }

  if (Date.now() >= contestObj.endTime) {
    finishContest(TOKEN, contestId).catch(() => {});
    return { msg: '⏳ Час вийшов! Зараз підбиваються підсумки...', alert: true };
  }

  const addRes = await redis('SADD', 'contest:' + contestId + ':participants', userId);
  const wasAdded = addRes?.result === 1;

  await redis('HSET', 'contest:' + contestId + ':users', userId, JSON.stringify({ name, username }));

  const cardRes = await redis('SCARD', 'contest:' + contestId + ':participants');
  const count = cardRes?.result || 1;

  if (wasAdded) {
    return {
      msg: '🎉 Вітаємо! Ти береш участь у розіграші! Удачі 🍀',
      alert: false,
      updatedCount: count,
    };
  } else {
    return {
      msg: '✅ Ти вже береш участь у цьому конкурсі! Очікуй результатів.',
      alert: false,
      updatedCount: count,
    };
  }
}

async function publishContest(TOKEN, adminChatId, draft) {
  const contestId = 'c_' + Date.now();
  const durationHours = draft.durationHours || 24;
  const durationMs = Math.round(durationHours * 3600 * 1000);
  const isScheduled = draft.scheduledStartTime && draft.scheduledStartTime > Date.now() + 60000;
  const scheduledStartTime = isScheduled ? draft.scheduledStartTime : null;
  const startTime = isScheduled ? scheduledStartTime : Date.now();
  const endTime = startTime + durationMs;

  const contestObj = {
    id: contestId,
    cur: draft.cur || 'foc',
    amount: draft.amount || 10000000,
    winners: draft.winners || 3,
    durationHours,
    startTime,
    endTime,
    status: isScheduled ? 'scheduled' : 'active',
    scheduledStartTime,
    creatorId: String(adminChatId),
    announced: !isScheduled,
  };

  await redis('HSET', 'contest:' + contestId, 'data', JSON.stringify(contestObj));
  await redis('SADD', 'all_contests', contestId);
  await redis('LPUSH', 'history_contests', contestId);

  const singlePrize = formatContestCur(draft.cur, draft.amount);
  const totalPrize = formatContestCur(draft.cur, draft.amount * draft.winners);
  const endFormatted = formatKyivDate(endTime);

  if (isScheduled) {
    await redis('SADD', 'scheduled_contests', contestId);
    draft.scheduledStartTime = null;
    await setContestDraft(adminChatId, draft);

    const startFormatted = formatKyivDate(scheduledStartTime);
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: adminChatId,
      text:
        `⏰ *РОЗІГРАШ УСПІШНО ЗАПЛАНОВАНО!* 📅\n\n` +
        `🆔 ID: \`${contestId}\`\n` +
        `🎁 Приз: *${singlePrize}* кожному\n` +
        `👥 Переможців: *${draft.winners}*\n` +
        `⏱ Тривалість: *${formatDurationHours(durationHours)}*\n` +
        `📅 *Автоматичний старт:* *${startFormatted}* (за Києвом)\n` +
        `🏁 *Підбиття підсумків:* *${endFormatted}* (за Києвом)\n\n` +
        `🤖 *Бот автоматично розішле конкурс у зазначений час!* Вам не потрібно бути за ПК.\n\n` +
        `📋 *Керування:*\n` +
        `• Запустити негайно: \`/concurs_start ${contestId}\`\n` +
        `• Скасувати розіграш: \`/concurs_cancel ${contestId}\`\n` +
        `• Список розіграшів: \`/concurs_list\``,
      parse_mode: 'Markdown',
    });
    return;
  }

  await redis('SADD', 'active_contests', contestId);

  const announceText =
    `🎉 *РОЗІГРАШ У ФОКАЧА КЛІКЕР!* 🎉\n\n` +
    `Пекарня запускає новий конкурс для всіх пекарів!\n\n` +
    `🎁 *Приз переможцю:* ${singlePrize}\n` +
    `👥 *Кількість переможців:* ${draft.winners} гравців\n` +
    `💰 *Загальний призовий фонд:* ${totalPrize}\n` +
    `⏱ *Підбиття підсумків:* ${endFormatted} (за Києвом)\n\n` +
    `👇 *Тисни кнопку нижче, щоб взяти участь у розіграші:*`;

  const contestMarkup = {
    inline_keyboard: [
      [{ text: '🎉 Взяти участь (0)', callback_data: `concurs:join:${contestId}` }],
      [{ text: '🫓 Відкрити Фокача Клікер', web_app: { url: WEBAPP_URL } }],
    ],
  };

  const usersData = await redis('HGETALL', 'users');
  let sentCount = 0;
  if (usersData?.result && usersData.result.length > 0) {
    const entries = usersData.result;
    for (let i = 0; i < entries.length; i += 2) {
      const uid = entries[i];
      try {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(uid),
          text: announceText,
          parse_mode: 'Markdown',
          reply_markup: contestMarkup,
        });
        sentCount++;
      } catch { /* skip */ }
    }
  } else {
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: adminChatId,
      text: announceText,
      parse_mode: 'Markdown',
      reply_markup: contestMarkup,
    });
    sentCount = 1;
  }

  await sendTg(TOKEN, 'sendMessage', {
    chat_id: adminChatId,
    text:
      `✅ *Конкурс успішно створено та опубліковано!*\n\n` +
      `🆔 ID: \`${contestId}\`\n` +
      `🎁 Приз: *${singlePrize}* кожному\n` +
      `👥 Переможців: *${draft.winners}*\n` +
      `📨 Оповіщено гравців: *${sentCount}*\n` +
      `⏱ Дата завершення: *${endFormatted}*\n\n` +
      `📋 *Керування:*\n` +
      `• Достроково підбити підсумки: \`/concurs_finish ${contestId}\`\n` +
      `• Скасувати розіграш: \`/concurs_cancel ${contestId}\`\n` +
      `• Список активних: \`/concurs_list\``,
    parse_mode: 'Markdown',
  });
}

async function finishContest(TOKEN, contestId, force = false) {
  if (!contestId) return null;
  const cRaw = await redis('HGET', 'contest:' + contestId, 'data');
  if (!cRaw?.result) return null;

  let contestObj;
  try { contestObj = JSON.parse(cRaw.result); } catch { return null; }

  if (contestObj.status !== 'active' && !force) return null;

  contestObj.status = 'finished';
  contestObj.finishedAt = Date.now();
  await redis('HSET', 'contest:' + contestId, 'data', JSON.stringify(contestObj));
  await redis('SREM', 'active_contests', contestId);

  const pRes = await redis('SMEMBERS', 'contest:' + contestId + ':participants');
  const participants = pRes?.result || [];

  const curFormatted = formatContestCur(contestObj.cur, contestObj.amount);

  if (participants.length === 0) {
    const noUsersMsg =
      `🏁 *КОНКУРС ЗАВЕРШЕНО*\n\n` +
      `🆔 ID: \`${contestId}\`\n` +
      `🎁 Приз: *${curFormatted}*\n\n` +
      `На жаль, у конкурсі не було жодного учасника 😢`;
    if (contestObj.creatorId) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: Number(contestObj.creatorId),
        text: noUsersMsg,
        parse_mode: 'Markdown',
      });
    }
    return;
  }

  const shuffled = [...participants].sort(() => Math.random() - 0.5);
  const targetWinners = Math.max(1, Math.min(contestObj.winners, shuffled.length));
  const winnersList = shuffled.slice(0, targetWinners);

  const winnersDetails = [];
  for (let i = 0; i < winnersList.length; i++) {
    const wid = String(winnersList[i]);

    if (contestObj.cur === 'gem') {
      const gRaw = await redis('GET', `reward_gem:${wid}`);
      const gCur = gRaw?.result ? parseInt(gRaw.result, 10) : 0;
      await redis('SET', `reward_gem:${wid}`, String(gCur + contestObj.amount));
      await redis('SET', `reward_gem_source:${wid}`, 'contest');
    } else if (contestObj.cur === 'rebirth') {
      const rRaw = await redis('GET', `rebirth:${wid}`);
      const rCur = rRaw?.result ? parseInt(rRaw.result, 10) : 0;
      await redis('SET', `rebirth:${wid}`, String(rCur + contestObj.amount));
    } else {
      const fRaw = await redis('GET', `reward:${wid}`);
      const fCur = fRaw?.result ? parseInt(fRaw.result, 10) : 0;
      await redis('SET', `reward:${wid}`, String(fCur + contestObj.amount));
    }

    let disp = `Гравець \`${wid}\``;
    const uRaw = await redis('HGET', 'contest:' + contestId + ':users', wid);
    if (uRaw?.result) {
      try {
        const u = JSON.parse(uRaw.result);
        disp = u.username ? `@${u.username}` : (u.name || `ID ${wid}`);
      } catch { /* */ }
    } else {
      const uData = await redis('HGET', 'users', wid);
      if (uData?.result) {
        try {
          const u = JSON.parse(uData.result);
          disp = u.username ? `@${u.username}` : (u.name || `ID ${wid}`);
        } catch { /* */ }
      }
    }
    winnersDetails.push({ id: wid, display: disp });

    try {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: Number(wid),
        text:
          `🎉 *ВІТАЄМО! ТИ ПЕРЕМІГ У РОЗІГРАШІ!* 🏆\n\n` +
          `🎁 Твій приз: *${curFormatted}*!\n` +
          `🫓 Нагороду вже нараховано! Відкрий гру щоб забрати її!`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🫓 Забрати приз!', web_app: { url: WEBAPP_URL } }]],
        },
      });
    } catch { /* ignore */ }
  }

  contestObj.winnersDetails = winnersDetails;
  contestObj.winnersList = winnersList;
  await redis('HSET', 'contest:' + contestId, 'data', JSON.stringify(contestObj));

  let resText =
    `🏆 *РЕЗУЛЬТАТИ РОЗІГРАШУ!* 🏆\n\n` +
    `🎁 Приз: *${curFormatted}* кожному переможцю\n` +
    `👥 Всього учасників: *${participants.length}*\n` +
    `👑 Переможців: *${winnersDetails.length}*\n\n` +
    `🎉 *ПЕРЕМОЖЦІ:*\n`;

  winnersDetails.forEach((w, idx) => {
    resText += `${idx + 1}. ${w.display} — *${curFormatted}*\n`;
  });

  resText += `\n✨ Призи автоматично нараховано на акаунти переможців!\nДякуємо всім за участь! 🫓🍀`;

  if (contestObj.creatorId) {
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(contestObj.creatorId),
      text: resText,
      parse_mode: 'Markdown',
    });
  }

  const notifyList = participants.filter((p) => String(p) !== String(contestObj.creatorId)).slice(0, 25);
  for (const pid of notifyList) {
    try {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: Number(pid),
        text: resText,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🫓 Відкрити Фокача Клікер', web_app: { url: WEBAPP_URL } }]],
        },
      });
    } catch { /* skip */ }
  }
}

async function checkExpiredContests(TOKEN) {
  try {
    const activeRes = await redis('SMEMBERS', 'active_contests');
    if (!activeRes?.result || activeRes.result.length === 0) return;
    const now = Date.now();
    for (const cId of activeRes.result) {
      const cRaw = await redis('HGET', 'contest:' + cId, 'data');
      if (cRaw?.result) {
        try {
          const cObj = JSON.parse(cRaw.result);
          if (cObj.status === 'active' && now >= cObj.endTime) {
            await finishContest(TOKEN, cId);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
}

async function launchScheduledContest(TOKEN, contestId, cObj) {
  if (!contestId) return;
  if (!cObj) {
    const raw = (await redis('HGET', 'contest:' + contestId, 'data'))?.result;
    if (!raw) return;
    try { cObj = JSON.parse(raw); } catch { return; }
  }

  cObj.status = 'active';
  const durationHours = cObj.durationHours || 24;
  cObj.startTime = Date.now();
  cObj.endTime = Date.now() + Math.round(durationHours * 3600 * 1000);
  cObj.announced = true;

  await redis('HSET', 'contest:' + contestId, 'data', JSON.stringify(cObj));
  await redis('SREM', 'scheduled_contests', contestId);
  await redis('SADD', 'active_contests', contestId);

  const singlePrize = formatContestCur(cObj.cur, cObj.amount);
  const totalPrize = formatContestCur(cObj.cur, cObj.amount * cObj.winners);
  const endFormatted = formatKyivDate(cObj.endTime);

  const announceText =
    `🎉 *РОЗІГРАШ У ФОКАЧА КЛІКЕР!* 🎉\n\n` +
    `Пекарня запускає новий конкурс для всіх пекарів!\n\n` +
    `🎁 *Приз переможцю:* ${singlePrize}\n` +
    `👥 *Кількість переможців:* ${cObj.winners} гравців\n` +
    `💰 *Загальний призовий фонд:* ${totalPrize}\n` +
    `⏱ *Підбиття підсумків:* ${endFormatted} (за Києвом)\n\n` +
    `👇 *Тисни кнопку нижче, щоб взяти участь у розіграші:*`;

  const contestMarkup = {
    inline_keyboard: [
      [{ text: '🎉 Взяти участь (0)', callback_data: `concurs:join:${contestId}` }],
      [{ text: '🫓 Відкрити Фокача Клікер', web_app: { url: WEBAPP_URL } }],
    ],
  };

  const usersData = await redis('HGETALL', 'users');
  let sentCount = 0;
  if (usersData?.result && usersData.result.length > 0) {
    const entries = usersData.result;
    for (let i = 0; i < entries.length; i += 2) {
      const uid = entries[i];
      try {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(uid),
          text: announceText,
          parse_mode: 'Markdown',
          reply_markup: contestMarkup,
        });
        sentCount++;
      } catch { /* skip */ }
    }
  }

  if (cObj.creatorId) {
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(cObj.creatorId),
      text:
        `🚀 *ЗАПЛАНОВАНИЙ КОНКУРС АВТОМАТИЧНО РОЗПОЧАТО!* 🎁\n\n` +
        `🆔 ID: \`${contestId}\`\n` +
        `🎁 Приз: *${singlePrize}* кожному (${cObj.winners} перем.)\n` +
        `📨 Оповіщено гравців: *${sentCount}*\n` +
        `⏱ Підсумки: *${endFormatted}* (за Києвом)\n\n` +
        `Керування: \`/concurs_list\``,
      parse_mode: 'Markdown',
    });
  }
}

async function checkScheduledContests(TOKEN) {
  try {
    const schedRes = await redis('SMEMBERS', 'scheduled_contests');
    if (!schedRes?.result || schedRes.result.length === 0) return;
    const now = Date.now();
    for (const cId of schedRes.result) {
      const cRaw = await redis('HGET', 'contest:' + cId, 'data');
      if (!cRaw?.result) {
        await redis('SREM', 'scheduled_contests', cId);
        continue;
      }
      try {
        const cObj = JSON.parse(cRaw.result);
        if (cObj.status === 'scheduled') {
          if (now >= (cObj.scheduledStartTime || cObj.startTime || 0)) {
            await launchScheduledContest(TOKEN, cId, cObj);
          }
        } else {
          await redis('SREM', 'scheduled_contests', cId);
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
}

// ===== 👑 АДМІН-ПАНЕЛЬ: ДОПОМІЖНІ ФУНКЦІЇ ТА РЕНДЕРИ =====

function parseAmountInput(raw) {
  if (!raw) return 0;
  const str = String(raw).trim().toLowerCase().replace(/[\s_,]/g, '');
  if (str.endsWith('k') && !str.endsWith('kk') && !str.endsWith('kkk')) {
    return Math.floor(parseFloat(str.slice(0, -1)) * 1000);
  }
  if (str.endsWith('kk') || str.endsWith('m')) {
    const s = str.endsWith('kk') ? str.slice(0, -2) : str.slice(0, -1);
    return Math.floor(parseFloat(s) * 1000000);
  }
  if (str.endsWith('kkk') || str.endsWith('b')) {
    const s = str.endsWith('kkk') ? str.slice(0, -3) : str.slice(0, -1);
    return Math.floor(parseFloat(s) * 1000000000);
  }
  const n = parseInt(str, 10);
  return isNaN(n) ? 0 : n;
}

async function getAdminPanelMessage() {
  const usersData = await redis('HGETALL', 'users');
  const userCount = usersData?.result ? Math.floor(usersData.result.length / 2) : 0;
  const totals = await redis('HGETALL', 'ac_total');
  let flagCount = 0;
  if (totals?.result) {
    for (let i = 0; i < totals.result.length; i += 2) {
      if (parseInt(totals.result[i + 1]) > 0) flagCount++;
    }
  }
  const activeContestsData = await redis('SMEMBERS', 'active_contests');
  const contestCount = activeContestsData?.result?.length || 0;

  const mRes = await redis('GET', 'maintenance_mode');
  const isMaintenance = mRes?.result === '1';

  const text =
    `👑 *ГОЛОВНА АДМІН ПАНЕЛЬ*\n\n` +
    `👥 Гравців у базі: *${userCount}*\n` +
    `⚠️ Детектів античиту: *${flagCount}*\n` +
    `🎁 Активних конкурсів: *${contestCount}*\n` +
    `🚧 Технічна перерва: *${isMaintenance ? '🔴 УВІМКНЕНО (ГРА ЗАКРИТА)' : '🟢 ВИМКНЕНО (ГРА ВІДКРИТА)'}*\n\n` +
    `👇 *Оберіть дію або розділ керування:*`;

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: isMaintenance ? '🟢 Відкрити гру (Вимкнути техперерву)' : '🔴 Закрити гру (Технічна перерва)',
          callback_data: 'admin:toggle_maintenance',
        },
      ],
      [
        { text: '👥 Список гравців', callback_data: 'admin:users' },
        { text: '🔄 Оновити юзерів', callback_data: 'admin:update_users' },
      ],
      [
        { text: '🎁 Видати фокачі', callback_data: 'admin:menu:give' },
        { text: '💎 Видати алмази', callback_data: 'admin:menu:diamonds' },
      ],
      [
        { text: '🔄 Видати ребіртхи', callback_data: 'admin:menu:rebirth' },
        { text: '⚖️ Списати фокачі', callback_data: 'admin:prompt:take' },
      ],
      [
        { text: '🔍 Пошук гравця', callback_data: 'admin:prompt:check' },
        { text: '📢 Розсилка всім', callback_data: 'admin:prompt:broadcast' },
      ],
      [
        { text: '🛡 Античит', callback_data: 'admin:menu:anticheat' },
        { text: '🎉 Конкурси', callback_data: 'admin:menu:contests' },
      ],
      [
        { text: '🎭 Рофли / Звуки', callback_data: 'admin:menu:rofl' },
        { text: '🧹 Забрати скіни', callback_data: 'admin:menu:takeskins' },
      ],
      [
        { text: '🏆 Очистити топ', callback_data: 'admin:menu:lb_clear' },
        { text: '⚠️ Скинути акаунт', callback_data: 'admin:menu:reset' },
      ],
      [
        { text: '❌ Закрити панель', callback_data: 'admin:close' },
      ],
    ],
  };

  return { text, parse_mode: 'Markdown', reply_markup };
}

async function renderUsersList() {
  const usersData = await redis('HGETALL', 'users');
  if (!usersData?.result || usersData.result.length === 0) {
    return {
      text: '👥 Юзерів у базі поки немає.',
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Оновити юзерів (TG API)', callback_data: 'admin:update_users' }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    };
  }

  const entries = usersData.result;
  const userList = [];
  for (let i = 0; i < entries.length; i += 2) {
    const id = entries[i];
    try {
      const u = JSON.parse(entries[i + 1]);
      userList.push({ id, ...u });
    } catch {
      userList.push({ id, name: id, username: '', lastActive: 0 });
    }
  }

  userList.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));

  let text = `👥 *КОРИСТУВАЧІ БОТА* (Всього: *${userList.length}*)\n\n`;
  const topUsers = userList.slice(0, 20);
  for (const u of topUsers) {
    const ago = Math.floor((Date.now() - (u.lastActive || Date.now())) / 60000);
    const agoText = ago < 60 ? `${ago}хв` : ago < 1440 ? `${Math.floor(ago / 60)}г` : `${Math.floor(ago / 1440)}д`;
    text += `• ${u.name}${u.username ? ` (@${u.username})` : ''} — \`${u.id}\` — ${agoText} тому\n`;
  }
  if (userList.length > 20) {
    text += `\n…і ще ${userList.length - 20} гравців`;
  }

  const userButtons = [];
  for (let i = 0; i < Math.min(topUsers.length, 6); i += 2) {
    const row = [];
    const u1 = topUsers[i];
    row.push({ text: `👤 ${u1.username ? `@${u1.username}` : (u1.name || u1.id).slice(0, 14)}`, callback_data: `admin:check_user:${u1.id}` });
    if (i + 1 < Math.min(topUsers.length, 6)) {
      const u2 = topUsers[i + 1];
      row.push({ text: `👤 ${u2.username ? `@${u2.username}` : (u2.name || u2.id).slice(0, 14)}`, callback_data: `admin:check_user:${u2.id}` });
    }
    userButtons.push(row);
  }

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🔍 Перевірити юзера', callback_data: 'admin:prompt:check' },
        { text: '🔄 Оновити юзернейми', callback_data: 'admin:update_users' },
      ],
      ...userButtons,
      [
        { text: '🔄 Оновити список', callback_data: 'admin:users' },
        { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
      ],
    ],
  };

  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderGiveMenu() {
  const text =
    `🎁 *ВИДАЧА ФОКАЧ*\n\n` +
    `👇 *Швидка видача собі (в один клік):*\n` +
    `Оберіть готову суму або скористайтесь кнопками нижче:`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '+10 млн 🫓', callback_data: 'admin:give_self:10000000' },
        { text: '+50 млн 🫓', callback_data: 'admin:give_self:50000000' },
      ],
      [
        { text: '+100 млн 🫓', callback_data: 'admin:give_self:100000000' },
        { text: '+500 млн 🫓', callback_data: 'admin:give_self:500000000' },
      ],
      [
        { text: '+1 млрд 🫓', callback_data: 'admin:give_self:1000000000' },
        { text: '+5 млрд 🫓', callback_data: 'admin:give_self:5000000000' },
      ],
      [
        { text: '✍️ Своя сума собі', callback_data: 'admin:prompt:give_self' },
      ],
      [
        { text: '👤 Видати гравцю (@ або ID)', callback_data: 'admin:prompt:giveto' },
      ],
      [
        { text: '🌍 Роздати ВСІМ гравцям 🫓', callback_data: 'admin:menu:giveall' },
      ],
      [
        { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderGiveAllMenu() {
  const text =
    `🌍 *РОЗДАЧА ФОКАЧ ВСІМ ГРАВЦЯМ*\n\n` +
    `Виберіть суму фокач, яку отримає *кожен* зареєстрований гравець:\n` +
    `(Усі гравці отримають сповіщення від бота з кнопкою «Забрати нагороду»)`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🌍 Всім по 10 млн 🫓', callback_data: 'admin:giveall_exec:10000000' },
        { text: '🌍 Всім по 50 млн 🫓', callback_data: 'admin:giveall_exec:50000000' },
      ],
      [
        { text: '🌍 Всім по 100 млн 🫓', callback_data: 'admin:giveall_exec:100000000' },
        { text: '🌍 Всім по 500 млн 🫓', callback_data: 'admin:giveall_exec:500000000' },
      ],
      [
        { text: '🌍 Всім по 1 млрд 🫓', callback_data: 'admin:giveall_exec:1000000000' },
        { text: '✍️ Своя сума всім', callback_data: 'admin:prompt:giveall' },
      ],
      [
        { text: '⬅️ Назад до видачі', callback_data: 'admin:menu:give' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderRebirthMenu() {
  const text =
    `🔄 *ВИДАЧА РЕБІРТХІВ*\n\n` +
    `👇 *Швидка видача собі (в один клік):*\n` +
    `Оберіть кількість або скористайтесь кнопками нижче:`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '+1 🔄', callback_data: 'admin:rebirth_self:1' },
        { text: '+2 🔄', callback_data: 'admin:rebirth_self:2' },
        { text: '+5 🔄', callback_data: 'admin:rebirth_self:5' },
      ],
      [
        { text: '+10 🔄', callback_data: 'admin:rebirth_self:10' },
        { text: '+25 🔄', callback_data: 'admin:rebirth_self:25' },
        { text: '+50 🔄', callback_data: 'admin:rebirth_self:50' },
      ],
      [
        { text: '✍️ Своя кількість собі', callback_data: 'admin:prompt:rebirth_self' },
      ],
      [
        { text: '👤 Видати гравцю (@ або ID)', callback_data: 'admin:prompt:rebirthto' },
      ],
      [
        { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderDiamondsMenu() {
  const text =
    `💎 *ВИДАЧА АЛМАЗІВ*\n\n` +
    `👇 *Швидка видача собі (в один клік):*\n` +
    `Оберіть кількість або скористайтесь кнопками нижче:`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '+10 💎', callback_data: 'admin:diamond_self:10' },
        { text: '+25 💎', callback_data: 'admin:diamond_self:25' },
        { text: '+50 💎', callback_data: 'admin:diamond_self:50' },
      ],
      [
        { text: '+100 💎', callback_data: 'admin:diamond_self:100' },
        { text: '+250 💎', callback_data: 'admin:diamond_self:250' },
        { text: '+1,000 💎', callback_data: 'admin:diamond_self:1000' },
      ],
      [
        { text: '✍️ Своя кількість собі', callback_data: 'admin:prompt:diamond_self' },
      ],
      [
        { text: '👤 Видати гравцю (@ або ID)', callback_data: 'admin:prompt:diamondto' },
      ],
      [
        { text: '🌍 Роздати ВСІМ гравцям 💎', callback_data: 'admin:menu:diamondall' },
      ],
      [
        { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderDiamondAllMenu() {
  const text =
    `🌍 *РОЗДАЧА АЛМАЗІВ ВСІМ ГРАВЦЯМ*\n\n` +
    `Виберіть кількість 💎 алмазів, яку отримає *кожен* зареєстрований гравець:\n` +
    `(Усі гравці отримають сповіщення від бота)`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🌍 Всім по 25 💎', callback_data: 'admin:diamondall_exec:25' },
        { text: '🌍 Всім по 50 💎', callback_data: 'admin:diamondall_exec:50' },
      ],
      [
        { text: '🌍 Всім по 100 💎', callback_data: 'admin:diamondall_exec:100' },
        { text: '🌍 Всім по 500 💎', callback_data: 'admin:diamondall_exec:500' },
      ],
      [
        { text: '🌍 Всім по 1,000 💎', callback_data: 'admin:diamondall_exec:1000' },
        { text: '✍️ Своя кількість всім', callback_data: 'admin:prompt:diamondall' },
      ],
      [
        { text: '⬅️ Назад до алмазів', callback_data: 'admin:menu:diamonds' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

async function renderAnticheatMenu() {
  const totals = await redis('HGETALL', 'ac_total');
  const usersData = await redis('HGETALL', 'users');

  const names = {};
  if (usersData?.result) {
    for (let i = 0; i < usersData.result.length; i += 2) {
      try {
        const u = JSON.parse(usersData.result[i + 1]);
        names[usersData.result[i]] = u.username ? `@${u.username}` : u.name;
      } catch {}
    }
  }

  const flagged = [];
  if (totals?.result) {
    for (let i = 0; i < totals.result.length; i += 2) {
      const c = parseInt(totals.result[i + 1]) || 0;
      if (c > 0) flagged.push({ id: totals.result[i], c });
    }
    flagged.sort((a, b) => b.c - a.c);
  }

  let text = `🛡 *АНТИЧИТ TAPSENTINEL v5*\n\n`;
  text += `⚠️ Гравців з детектами: *${flagged.length}*\n\n`;

  if (flagged.length > 0) {
    text += `*Топ підозрілих:*\n`;
    for (const f of flagged.slice(0, 5)) {
      const who = names[f.id] || `\`${f.id}\``;
      text += `• ${who} — *${f.c}* детектів\n`;
    }
    text += '\n';
  } else {
    text += `Чисто! Підозрілих гравців немає ✅\n\n`;
  }

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '📋 Всі звіти', callback_data: 'admin:reports_view' },
        { text: '📄 TXT дебаг-лог', callback_data: 'admin:prompt:aclog' },
      ],
      [
        { text: '⚠️ Видати варн', callback_data: 'admin:prompt:warn' },
        { text: '✅ Зняти варн', callback_data: 'admin:prompt:unflag' },
      ],
      [
        { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

async function renderReportsView() {
  const totals = await redis('HGETALL', 'ac_total');
  const active = await redis('HGETALL', 'ac_active');
  const usersData = await redis('HGETALL', 'users');

  const names = {};
  if (usersData?.result) {
    for (let i = 0; i < usersData.result.length; i += 2) {
      try {
        const u = JSON.parse(usersData.result[i + 1]);
        names[usersData.result[i]] = u.username ? `@${u.username}` : u.name;
      } catch {}
    }
  }

  const activeIds = new Set();
  if (active?.result) {
    for (let i = 0; i < active.result.length; i += 2) activeIds.add(active.result[i]);
  }

  const karmaData = await redis('HGETALL', 'ac_karma');
  const karmaMap = {};
  if (karmaData?.result) {
    for (let i = 0; i < karmaData.result.length; i += 2) {
      try { karmaMap[karmaData.result[i]] = Math.max(0, Math.min(100, JSON.parse(karmaData.result[i + 1]).k || 0)); } catch {}
    }
  }

  const flagged = [];
  if (totals?.result) {
    for (let i = 0; i < totals.result.length; i += 2) {
      const c = parseInt(totals.result[i + 1]) || 0;
      if (c > 0) flagged.push({ id: totals.result[i], c });
    }
    flagged.sort((a, b) => b.c - a.c);
  }

  let msg = '🛡 *TAPSENTINEL v5 — ЗВІТ*\n\n⚠️ *ДЕТЕКТИЛО:*\n';
  if (flagged.length === 0) {
    msg += 'поки нікого — усі чисті 👼\n';
  } else {
    flagged.slice(0, 15).forEach((f, i) => {
      const who = names[f.id] || `\`${f.id}\``;
      const liveMark = activeIds.has(f.id) ? ' 🔴' : '';
      const km = karmaMap[f.id] ?? 100;
      const zone = km < 25 ? '🔴' : km < 50 ? '⚠️' : km < 75 ? '🟡' : '🟢';
      msg += `${i + 1}. ${who} — *${f.c}* раз(ів), карма *${km}/100* ${zone}${liveMark}\n`;
    });
    if (flagged.length > 15) msg += `…і ще ${flagged.length - 15}\n`;
  }

  const flaggedButtons = [];
  for (let i = 0; i < Math.min(flagged.length, 6); i += 2) {
    const row = [];
    const f1 = flagged[i];
    const who1 = (names[f1.id] || f1.id).slice(0, 14);
    row.push({ text: `🔍 ${who1}`, callback_data: `admin:check_user:${f1.id}` });
    if (i + 1 < Math.min(flagged.length, 6)) {
      const f2 = flagged[i + 1];
      const who2 = (names[f2.id] || f2.id).slice(0, 14);
      row.push({ text: `🔍 ${who2}`, callback_data: `admin:check_user:${f2.id}` });
    }
    flaggedButtons.push(row);
  }

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '📄 TXT дебаг-лог', callback_data: 'admin:prompt:aclog' },
        { text: '✅ Зняти варн', callback_data: 'admin:prompt:unflag' },
      ],
      ...flaggedButtons,
      [
        { text: '🛡 Меню античиту', callback_data: 'admin:menu:anticheat' },
        { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
      ],
    ],
  };

  return { text: msg, parse_mode: 'Markdown', reply_markup };
}

function escapeMd(str) {
  if (!str) return '';
  return String(str).replace(/[_*`\[\]]/g, '\\$&');
}

async function renderContestsAdminMenu(page = 0) {
  const token = process.env.BOT_TOKEN;
  if (token) {
    await checkExpiredContests(token).catch(() => {});
  }

  const activeIdsRaw = (await redis('SMEMBERS', 'active_contests'))?.result || [];
  const scheduledIdsRaw = (await redis('SMEMBERS', 'scheduled_contests'))?.result || [];
  const historyIdsRaw = (await redis('LRANGE', 'history_contests', '0', '199'))?.result || [];
  const allContestsRaw = (await redis('SMEMBERS', 'all_contests'))?.result || [];

  const scheduledContests = [];
  const scheduledIds = [];
  for (const sId of scheduledIdsRaw) {
    const raw = (await redis('HGET', 'contest:' + sId, 'data'))?.result;
    if (raw) {
      try {
        const c = JSON.parse(raw);
        if (c.status === 'scheduled') {
          scheduledContests.push(c);
          scheduledIds.push(sId);
        } else {
          await redis('SREM', 'scheduled_contests', sId);
        }
      } catch {
        await redis('SREM', 'scheduled_contests', sId);
      }
    } else {
      await redis('SREM', 'scheduled_contests', sId);
    }
  }

  const activeContests = [];
  const activeIds = [];
  for (const cId of activeIdsRaw) {
    const raw = (await redis('HGET', 'contest:' + cId, 'data'))?.result;
    if (raw) {
      try {
        const c = JSON.parse(raw);
        const isExpired = c.endTime && Date.now() >= c.endTime;
        if (c.status === 'active' && !isExpired) {
          const pCard = await redis('SCARD', 'contest:' + cId + ':participants');
          const pCount = pCard?.result || 0;
          activeContests.push({ cId, c, pCount });
          activeIds.push(cId);
        } else {
          await redis('SREM', 'active_contests', cId);
        }
      } catch {
        await redis('SREM', 'active_contests', cId);
      }
    } else {
      await redis('SREM', 'active_contests', cId);
    }
  }

  // Збираємо всі завершені / скасовані конкурси (зберігаючи порядок від новіших до старіших)
  const candidatePastIds = [...historyIdsRaw, ...allContestsRaw, ...activeIdsRaw];
  const uniquePastCandidates = Array.from(new Set(candidatePastIds));
  const pastContestIds = uniquePastCandidates.filter((id) => !activeIds.includes(id) && !scheduledIds.includes(id));

  let text = `🎁 *РОЗІГРАШІ ТА КОНКУРСИ*\n\n`;
  text += `Активних: *${activeContests.length}* | Запланованих: *${scheduledContests.length}* | Завершених: *${pastContestIds.length}*\n\n`;

  const contestButtons = [];

  if (scheduledContests.length > 0) {
    text += `*📅 Заплановані розіграші:*\n`;
    for (const c of scheduledContests) {
      const cId = c.id;
      const prize = formatContestCur(c.cur, c.amount);
      const startFmt = formatKyivDate(c.scheduledStartTime || c.startTime);
      const msToStart = (c.scheduledStartTime || c.startTime) - Date.now();
      const toStart = msToStart > 0 ? formatDurationHours(Math.max(0.1, msToStart / 3600000)) : 'Запускається...';
      text += `• *#${cId}*: ${prize} для ${c.winners} перем.\n  📅 Старт: *${startFmt}* (до старту: *${toStart}*)\n`;
      contestButtons.push([
        { text: `🚀 Запустити зараз #${cId.slice(-6)}`, callback_data: `admin:concurs_start:${cId}` },
        { text: `❌ Скасувати #${cId.slice(-6)}`, callback_data: `admin:concurs_cancel:${cId}` },
      ]);
    }
    text += '\n';
  }

  if (activeContests.length > 0) {
    text += `*🟢 Активні розіграші:*\n`;
    for (const item of activeContests) {
      const { cId, c, pCount } = item;
      const prize = formatContestCur(c.cur, c.amount);
      const msLeft = c.endTime - Date.now();
      const timeLeft = msLeft > 0 ? formatDurationHours(Math.max(0.1, msLeft / 3600000)) : 'Завершується...';
      text += `• *#${cId}*: ${prize} для ${c.winners} перем.\n  👥 Учасників: *${pCount}* | ⏱ Залишилось: *${timeLeft}*\n`;
      contestButtons.push([
        { text: `👥 Учасники (${pCount}) #${cId.slice(-6)}`, callback_data: `admin:contest_users:${cId}` },
      ]);
      contestButtons.push([
        { text: `⚙️ Завершити #${cId.slice(-6)}`, callback_data: `admin:concurs_finish:${cId}` },
        { text: `❌ Скасувати #${cId.slice(-6)}`, callback_data: `admin:concurs_cancel:${cId}` },
      ]);
    }
    text += '\n';
  } else if (scheduledContests.length === 0 && pastContestIds.length === 0) {
    text += `Наразі немає активних або запланованих розіграшів.\n\n`;
  }

  // Пагінація завершених конкурсів (по 4 на сторінку)
  const PAGE_SIZE = 4;
  const totalPages = Math.max(1, Math.ceil(pastContestIds.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIdx = curPage * PAGE_SIZE;
  const pageItems = pastContestIds.slice(startIdx, startIdx + PAGE_SIZE);

  if (pastContestIds.length > 0) {
    text += `*🏁 Завершені розіграші* (стор. ${curPage + 1} з ${totalPages}):\n`;
    for (const cId of pageItems) {
      const raw = (await redis('HGET', 'contest:' + cId, 'data'))?.result;
      if (raw) {
        try {
          const c = JSON.parse(raw);
          const pCard = await redis('SCARD', 'contest:' + cId + ':participants');
          const pCount = pCard?.result || 0;
          const prize = formatContestCur(c.cur, c.amount);
          const isFin = c.status === 'finished';
          const statusBadge = isFin ? '🏁 Завершено' : '🛑 Скасовано';
          text += `• *#${cId}*: ${prize} (${statusBadge}, учасників: *${pCount}*)\n`;
          contestButtons.push([
            { text: `👥 Учасники (${pCount}) #${cId.slice(-6)} ${isFin ? '🏁' : '🛑'}`, callback_data: `admin:contest_users:${cId}` },
          ]);
        } catch {}
      }
    }
    text += '\n';

    // Рядок пагінації: ⬅️ 1 / N ➡️
    const navRow = [];
    navRow.push({
      text: '⬅️',
      callback_data: curPage > 0 ? `admin:concurs_page:${curPage - 1}` : 'admin:none',
    });
    navRow.push({
      text: totalPages > 1 ? `${curPage + 1} / ${totalPages}` : `${curPage + 1}`,
      callback_data: 'admin:none',
    });
    navRow.push({
      text: '➡️',
      callback_data: curPage < totalPages - 1 ? `admin:concurs_page:${curPage + 1}` : 'admin:none',
    });
    contestButtons.push(navRow);
  }

  const reply_markup = {
    inline_keyboard: [
      [{ text: '➕ Створити новий конкурс (Білдер)', callback_data: 'admin:open_concurs' }],
      ...contestButtons,
      [{ text: '🔍 Перевірити конкурс за ID', callback_data: 'admin:prompt:contest_id' }],
      [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

async function renderContestParticipants(contestId, page = 0) {
  const cRaw = await redis('HGET', 'contest:' + contestId, 'data');
  if (!cRaw?.result) {
    return {
      text: `❌ Конкурс з ID \`${contestId}\` не знайдено в базі даних.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎁 До списку конкурсів', callback_data: 'admin:menu:contests' }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    };
  }

  let cObj = {};
  try { cObj = JSON.parse(cRaw.result); } catch {}

  const pRes = await redis('SMEMBERS', 'contest:' + contestId + ':participants');
  const participantIds = pRes?.result || [];

  const cUsersRaw = await redis('HGETALL', 'contest:' + contestId + ':users');
  const globalUsersRaw = await redis('HGETALL', 'users');

  const userMap = new Map();
  if (globalUsersRaw?.result) {
    for (let i = 0; i < globalUsersRaw.result.length; i += 2) {
      const id = String(globalUsersRaw.result[i]);
      try { userMap.set(id, JSON.parse(globalUsersRaw.result[i + 1])); } catch {}
    }
  }
  if (cUsersRaw?.result) {
    for (let i = 0; i < cUsersRaw.result.length; i += 2) {
      const id = String(cUsersRaw.result[i]);
      try {
        const u = JSON.parse(cUsersRaw.result[i + 1]);
        userMap.set(id, { ...(userMap.get(id) || {}), ...u });
      } catch {}
    }
  }

  const winnersSet = new Set((cObj.winnersList || []).map(String));
  const curFmt = formatContestCur(cObj.cur, cObj.amount);
  const statusStr = cObj.status === 'active' ? '🟢 *АКТИВНИЙ*' : (cObj.status === 'finished' ? '🏁 *ЗАВЕРШЕНИЙ*' : '🛑 *СКАСОВАНИЙ*');

  let text =
    `🎁 *УЧАСНИКИ КОНКУРСУ #${contestId}*\n\n` +
    `📊 Статус: ${statusStr}\n` +
    `💰 Приз: *${curFmt}* кожному\n` +
    `👑 Переможців: *${cObj.winners || 1}*\n` +
    `👥 Всього зареєстровано учасників: *${participantIds.length}*\n`;

  if (cObj.status === 'active') {
    const msLeft = cObj.endTime - Date.now();
    const timeLeft = msLeft > 0 ? formatDurationHours(Math.max(0.1, msLeft / 3600000)) : 'Завершується...';
    const endFmt = formatKyivDate(cObj.endTime);
    text += `⏱ Закінчення: *${timeLeft}* (до ${endFmt})\n`;
  } else if (cObj.finishedAt) {
    text += `🏁 Завершено: *${formatKyivDate(cObj.finishedAt)}*\n`;
  }
  text += `\n`;

  const PAGE_SIZE = 12;
  const totalPages = Math.max(1, Math.ceil(participantIds.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIdx = curPage * PAGE_SIZE;
  const pageItems = participantIds.slice(startIdx, startIdx + PAGE_SIZE);

  const keyboard = [];

  if (participantIds.length === 0) {
    text += `_У цьому конкурсі поки що немає жодного учасника._\n\n`;
  } else {
    text += `📋 *Список учасників (стор. ${curPage + 1} з ${totalPages}):*\n`;
    pageItems.forEach((pid, idx) => {
      const overallIdx = startIdx + idx + 1;
      const u = userMap.get(String(pid)) || {};
      const uname = u.username ? `@${escapeMd(u.username)}` : '';
      const name = escapeMd(u.name || 'Друже');
      const isWinner = winnersSet.has(String(pid)) ? ' 🏆 *[ПЕРЕМОЖЕЦЬ]*' : '';
      text += `${overallIdx}. 👤 *${name}* ${uname ? `(${uname})` : ''} — \`${pid}\`${isWinner}\n`;
    });
    text += `\n`;

    // Кнопки швидкого перегляду карток гравців по 2 в ряд
    for (let i = 0; i < pageItems.length; i += 2) {
      const row = [];
      const pid1 = pageItems[i];
      const u1 = userMap.get(String(pid1)) || {};
      const lbl1 = u1.username ? `@${u1.username}` : (u1.name || String(pid1)).slice(0, 14);
      row.push({ text: `👤 ${lbl1}`, callback_data: `admin:check_user:${pid1}` });

      if (i + 1 < pageItems.length) {
        const pid2 = pageItems[i + 1];
        const u2 = userMap.get(String(pid2)) || {};
        const lbl2 = u2.username ? `@${u2.username}` : (u2.name || String(pid2)).slice(0, 14);
        row.push({ text: `👤 ${lbl2}`, callback_data: `admin:check_user:${pid2}` });
      }
      keyboard.push(row);
    }
  }

  // Пагінація
  if (totalPages > 1) {
    const nav = [];
    if (curPage > 0) {
      nav.push({ text: '⬅️ Назад', callback_data: `admin:contest_users:${contestId}:${curPage - 1}` });
    }
    nav.push({ text: `📄 ${curPage + 1} / ${totalPages}`, callback_data: 'admin:none' });
    if (curPage < totalPages - 1) {
      nav.push({ text: 'Вперед ➡️', callback_data: `admin:contest_users:${contestId}:${curPage + 1}` });
    }
    keyboard.push(nav);
  }

  // Кнопки дій: скачати TXT, оновити
  const actionRow = [];
  if (participantIds.length > 0) {
    actionRow.push({ text: '📥 Скачати TXT', callback_data: `admin:contest_txt:${contestId}` });
  }
  actionRow.push({ text: '🔄 Оновити', callback_data: `admin:contest_users:${contestId}:${curPage}` });
  keyboard.push(actionRow);

  if (cObj.status === 'active') {
    keyboard.push([
      { text: '⚙️ Завершити достроково', callback_data: `admin:concurs_finish:${contestId}` },
      { text: '❌ Скасувати розіграш', callback_data: `admin:concurs_cancel:${contestId}` },
    ]);
  }

  keyboard.push([
    { text: '🎁 До всіх конкурсів', callback_data: 'admin:menu:contests' },
    { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
  ]);

  return { text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
}

async function sendContestParticipantsFile(TOKEN, chatId, contestId) {
  const cRaw = await redis('HGET', 'contest:' + contestId, 'data');
  if (!cRaw?.result) return false;
  let cObj = {};
  try { cObj = JSON.parse(cRaw.result); } catch {}

  const pRes = await redis('SMEMBERS', 'contest:' + contestId + ':participants');
  const participantIds = pRes?.result || [];

  const cUsersRaw = await redis('HGETALL', 'contest:' + contestId + ':users');
  const globalUsersRaw = await redis('HGETALL', 'users');

  const userMap = new Map();
  if (globalUsersRaw?.result) {
    for (let i = 0; i < globalUsersRaw.result.length; i += 2) {
      const id = String(globalUsersRaw.result[i]);
      try { userMap.set(id, JSON.parse(globalUsersRaw.result[i + 1])); } catch {}
    }
  }
  if (cUsersRaw?.result) {
    for (let i = 0; i < cUsersRaw.result.length; i += 2) {
      const id = String(cUsersRaw.result[i]);
      try {
        const u = JSON.parse(cUsersRaw.result[i + 1]);
        userMap.set(id, { ...(userMap.get(id) || {}), ...u });
      } catch {}
    }
  }

  const winnersSet = new Set((cObj.winnersList || []).map(String));
  const curFmt = formatContestCur(cObj.cur, cObj.amount);

  let content = `=== СПИСОК УЧАСНИКІВ КОНКУРСУ #${contestId} ===\r\n\r\n`;
  content += `Статус: ${cObj.status || 'unknown'}\r\n`;
  content += `Приз: ${curFmt} кожному (${cObj.winners || 1} переможців)\r\n`;
  content += `Всього учасників: ${participantIds.length}\r\n`;
  content += `Дата вивантаження: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}\r\n\r\n`;
  content += `№   | Telegram ID    | Username          | Ім'я                  | Статус\r\n`;
  content += `--------------------------------------------------------------------------------\r\n`;

  participantIds.forEach((pid, idx) => {
    const u = userMap.get(String(pid)) || {};
    const uname = u.username ? `@${u.username}` : '—';
    const name = u.name || 'Без імені';
    const isWinner = winnersSet.has(String(pid)) ? ' [🏆 ПЕРЕМОЖЕЦЬ]' : '';
    const num = String(idx + 1).padEnd(4, ' ');
    const idPad = String(pid).padEnd(15, ' ');
    const unPad = uname.padEnd(18, ' ');
    const namePad = name.slice(0, 20).padEnd(22, ' ');
    content += `${num}| ${idPad}| ${unPad}| ${namePad}| ${isWinner}\r\n`;
  });

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const fileName = `contest_${contestId}_participants.txt`;
  const fileBuf = Buffer.from(content, 'utf-8');

  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n🎁 Список учасників конкурсу #${contestId}\nВсього учасників: ${participantIds.length}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`,
  ];
  const beforeFile = Buffer.from(bodyParts.join('\r\n') + '\r\n', 'utf-8');
  const afterFile = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const fullBody = Buffer.concat([beforeFile, fileBuf, afterFile]);

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: fullBody,
  });
  return true;
}

function renderLbClearConfirm() {
  const text =
    `🏆 *ОЧИЩЕННЯ ЛІДЕРБОРДУ*\n\n` +
    `⚠️ Ви дійсно бажаєте повністю очистити таблицю лідерів?\n` +
    `Це видалить записи рейтингу та історію детекцій.`;
  const reply_markup = {
    inline_keyboard: [
      [{ text: '🗑 Так, очистити лідерборд!', callback_data: 'admin:lb_clear_exec' }],
      [{ text: '⬅️ Скасувати / Назад', callback_data: 'admin:back' }],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderResetMenu() {
  const text =
    `⚠️ *СКИДАННЯ АКАУНТІВ*\n\n` +
    `Оберіть дію:\n` +
    `• *Одного гравця* — скидає баланс, будівлі та престиж вказаного юзера\n` +
    `• *ВСІХ гравців* — повне глобальне скидання всієї гри`;
  const reply_markup = {
    inline_keyboard: [
      [{ text: '👤 Скинути одного гравця', callback_data: 'admin:prompt:reset_one' }],
      [{ text: '💣 Скинути ВСІХ гравців (RESET ALL)', callback_data: 'admin:reset_all_confirm' }],
      [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderResetAllConfirm() {
  const text =
    `🚨 *УВАГА: ГЛОБАЛЬНЕ СКИДАННЯ ВСІХ АКАУНТІВ!*\n\n` +
    `Це скине прогрес у ВСІХ зареєстрованих гравців гри!\n` +
    `Цю дію НЕ можна буде скасувати!\n\n` +
    `Ви точно впевнені?`;
  const reply_markup = {
    inline_keyboard: [
      [{ text: '💣 ТАК, ТОЧНО СКИНУТИ ВСІХ ГРАВЦІВ!', callback_data: 'admin:reset_all_exec' }],
      [{ text: '⬅️ Скасувати / Назад', callback_data: 'admin:back' }],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

function renderTakeSkinsMenu() {
  const text =
    `🧹 *КЕРУВАННЯ СКІНАМИ (СКИДАННЯ ДО СТАНДАРТУ)*\n\n` +
    `Тут ви можете забрати всі отримані скіни фокачі та залишити лише базову класичну фокачу:\n\n` +
    `• *У всіх гравців* — глобальне скидання для всієї бази.\n` +
    `• *У конкретного гравця* — скидання по @username або ID.`;
  const reply_markup = {
    inline_keyboard: [
      [{ text: '🧹 Забрати скіни у ВСІХ гравців', callback_data: 'admin:takeskins_all' }],
      [{ text: '👤 Забрати в конкретного гравця', callback_data: 'admin:prompt:takeskins' }],
      [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

async function renderUserCard(target) {
  const uId = target.id;
  const stateRaw = (await redis('GET', `save:${uId}`))?.result;
  let s = null;
  if (stateRaw) {
    try { s = JSON.parse(stateRaw); } catch {}
  }
  const rewardRaw = (await redis('GET', `reward:${uId}`))?.result;
  const pendingReward = rewardRaw ? parseInt(rewardRaw) : 0;
  const rebirthRewardRaw = (await redis('GET', `rebirth:${uId}`))?.result;
  const pendingRebirth = rebirthRewardRaw ? parseInt(rebirthRewardRaw) : 0;
  const diamondRewardRaw = (await redis('GET', `reward_gem:${uId}`))?.result;
  const pendingDiamonds = diamondRewardRaw ? parseInt(diamondRewardRaw) : 0;

  const totalDetectsRaw = (await redis('HGET', 'ac_total', uId))?.result;
  const totalDetects = totalDetectsRaw ? parseInt(totalDetectsRaw) : 0;
  const kRaw = (await redis('HGET', 'ac_karma', uId))?.result;
  let karma = 100;
  if (kRaw) { try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw).k || 0)); } catch {} }
  const isFlagged = totalDetects > 0 || karma < 75;

  const isOnlineRaw = await redis('GET', `user_online:${uId}`);
  const isOnline = isOnlineRaw?.result === '1';

  let text = `👤 *КАРТКА ГРАВЦЯ*\n\n`;
  text += `• Гравець: ${target.display} ${isOnline ? '🟢 *[ЗАРАЗ У ГРІ]*' : '⚪ (офлайн)'}\n`;
  text += `• Ім'я: *${target.name}*\n`;
  text += `• ID: \`${uId}\`\n\n`;

  if (s) {
    text += `🫓 Баланс: *${formatNum(s.focaccia || 0)}*\n`;
    text += `🌟 Загалом з'їдено: *${formatNum(s.total || 0)}*\n`;
    text += `🔄 Престиж: *${s.prestige || 0}*\n`;
    text += `💎 Алмази: *${s.diamonds || 0}*\n`;
    text += `👆 Кліки: *${formatNum(s.clicks || 0)}*\n`;
    text += `🛡 Карма: *${s.karma ?? karma}/100*\n`;
  } else {
    text += `ℹ️ Збереження клієнта поки немає в базі.\n`;
  }

  text += `⚠️ Античит: *${isFlagged ? `🔴 Є ПРАПОРЕЦЬ (детектів: ${totalDetects}, карма: ${karma})` : '🟢 Чистий'}*\n`;
  if (pendingReward > 0) text += `🎁 Очікує нагороду: *${formatNum(pendingReward)}* 🫓\n`;
  if (pendingDiamonds > 0) text += `💎 Очікує алмази: *+${pendingDiamonds}* 💎\n`;
  if (pendingRebirth > 0) text += `🔄 Очікує ребіртхи: *+${pendingRebirth}*\n`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: `🔊 Увімкнути звук (${isOnline ? '🟢 У грі' : '⚪ Офлайн'})`, callback_data: `admin:user_sounds_menu:${uId}` },
      ],
      [
        { text: '+🫓 Фокачі', callback_data: `admin:prompt:giveto_target:${uId}` },
        { text: '+💎 Алмази', callback_data: `admin:prompt:diamondto_target:${uId}` },
      ],
      [
        { text: '+🔄 Ребіртхи', callback_data: `admin:prompt:rebirthto_target:${uId}` },
        { text: '-🫓 Списати', callback_data: `admin:prompt:take_target:${uId}` },
      ],
      [
        { text: isFlagged ? '✅ Зняти варн' : '⚠️ Видати варн', callback_data: `admin:user_toggle_warn:${uId}` },
        { text: '📄 Дебаг-лог TXT', callback_data: `admin:user_aclog:${uId}` },
      ],
      [
        { text: '🧹 Забрати скіни', callback_data: `admin:takeskins_target:${uId}` },
        { text: '🗑 Скинути акаунт', callback_data: `admin:user_reset_confirm:${uId}` },
      ],
      [
        { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

const ROFL_SOUND_NAMES = {
  vine_boom: '💥 Vine Boom',
  fart: '💨 Пердьож',
  screamer: '😱 Скрімер',
  bruh: '🗿 Bruh',
  doorbell: '🚪 Дзвінок у двері',
  knocking: '✊ Стук у двері',
  sad_trombone: '🎺 Сумна труба',
  alarm: '⏰ Будильник',
  airhorn: '📢 Airhorn',
  oof: '💀 OOF',
};

async function renderUserSoundsMenu(targetId) {
  const target = await resolveTargetUser(targetId);
  const uId = target ? target.id : targetId;
  const isOnlineRaw = await redis('GET', `user_online:${uId}`);
  const isOnline = isOnlineRaw?.result === '1';

  let text = `🎭 *ЗВУКОВИЙ ТРОЛІНГ (РОФЛ)*\n\n`;
  text += `👤 Гравець: *${target?.display || uId}*\n`;
  text += `📡 Статус: *${isOnline ? '🟢 Зараз грає у Фокача Клікер!' : '⚪ Зараз офлайн'}*\n\n`;
  if (isOnline) {
    text += `⚡ _Гравець зараз у грі! Звук увімкнеться миттєво (за 1-3 сек) прямо під час тапання, а телефон завібрує!_ 🔊💥\n\n`;
  } else {
    text += `💤 _Гравець зараз не в грі. Звук увімкнеться, щойно він запустить клікер!_\n\n`;
  }
  text += `👇 *Оберіть звук для відтворення:*`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '💥 Vine Boom', callback_data: `admin:send_sound:${uId}:vine_boom` },
        { text: '💨 Пердьож', callback_data: `admin:send_sound:${uId}:fart` },
      ],
      [
        { text: '😱 Скрімер', callback_data: `admin:send_sound:${uId}:screamer` },
        { text: '🗿 Bruh', callback_data: `admin:send_sound:${uId}:bruh` },
      ],
      [
        { text: '🚪 Дзвінок у двері', callback_data: `admin:send_sound:${uId}:doorbell` },
        { text: '✊ Стук у двері', callback_data: `admin:send_sound:${uId}:knocking` },
      ],
      [
        { text: '🎺 Сумна труба', callback_data: `admin:send_sound:${uId}:sad_trombone` },
        { text: '⏰ Будильник', callback_data: `admin:send_sound:${uId}:alarm` },
      ],
      [
        { text: '📢 Airhorn', callback_data: `admin:send_sound:${uId}:airhorn` },
        { text: '💀 OOF', callback_data: `admin:send_sound:${uId}:oof` },
      ],
      [
        { text: '👤 До картки гравця', callback_data: `admin:check_user:${uId}` },
        { text: '⬅️ Головне меню', callback_data: 'admin:back' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

async function renderAllSoundsMenu() {
  const text =
    `📢 *МАСОВИЙ ЗВУКОВИЙ ТРОЛІНГ (ВСІМ ОНЛАЙН)*\n\n` +
    `⚠️ *Увага!* Обраний звук увімкнеться у **ВСІХ гравців**, які зараз грають або зайдуть у гру протягом 45 секунд! 🔊💥\n\n` +
    `👇 *Оберіть звук:*`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '💥 Vine Boom усім', callback_data: 'admin:send_sound_all:vine_boom' },
        { text: '💨 Пердьож усім', callback_data: 'admin:send_sound_all:fart' },
      ],
      [
        { text: '😱 Скрімер усім', callback_data: 'admin:send_sound_all:screamer' },
        { text: '🗿 Bruh усім', callback_data: 'admin:send_sound_all:bruh' },
      ],
      [
        { text: '🚪 Дзвінок у двері', callback_data: 'admin:send_sound_all:doorbell' },
        { text: '✊ Стук у двері', callback_data: 'admin:send_sound_all:knocking' },
      ],
      [
        { text: '🎺 Сумна труба', callback_data: 'admin:send_sound_all:sad_trombone' },
        { text: '⏰ Будильник', callback_data: 'admin:send_sound_all:alarm' },
      ],
      [
        { text: '📢 Airhorn усім', callback_data: 'admin:send_sound_all:airhorn' },
        { text: '💀 OOF усім', callback_data: 'admin:send_sound_all:oof' },
      ],
      [
        { text: '🎭 До рофл-меню', callback_data: 'admin:menu:rofl' },
        { text: '⬅️ Головне меню', callback_data: 'admin:back' },
      ],
    ],
  };
  return { text, parse_mode: 'Markdown', reply_markup };
}

async function renderRoflMenu() {
  const usersData = await redis('HGETALL', 'users');
  const onlineUsers = [];
  if (usersData?.result) {
    for (let i = 0; i < usersData.result.length; i += 2) {
      const uId = usersData.result[i];
      const isOnline = (await redis('GET', `user_online:${uId}`))?.result === '1';
      if (isOnline) {
        try {
          const u = JSON.parse(usersData.result[i + 1]);
          onlineUsers.push({ id: uId, name: u.name || uId, username: u.username || '' });
        } catch {
          onlineUsers.push({ id: uId, name: uId, username: '' });
        }
      }
    }
  }

  let text = `🎭 *РОФЛ ТА ЗВУКОВИЙ ТРОЛІНГ ГРАВЦІВ*\n\n`;
  text += `Тут ви можете обрати мемний звук. Якщо людина прямо зараз грає в клікер — у неї несподівано увімкнеться цей звук на повну гучність прямо під час тапання фокачі! 😂🔊\n\n`;
  text += `🟢 *Зараз онлайн у грі: ${onlineUsers.length}*\n`;
  if (onlineUsers.length > 0) {
    onlineUsers.forEach((u, i) => {
      text += `${i + 1}. ${u.username ? '@' + u.username : u.name} (\`${u.id}\`)\n`;
    });
  } else {
    text += `_Наразі ніхто не тапає. Але ви можете надіслати звук будь-якому гравцю — він спрацює як тільки гравець зайде в гру!_\n`;
  }
  text += `\n👇 *Оберіть дію:*`;

  const rows = [];
  if (onlineUsers.length > 0) {
    for (const u of onlineUsers.slice(0, 4)) {
      rows.push([{ text: `🔊 ${u.username ? '@' + u.username : u.name.slice(0, 14)} 🟢`, callback_data: `admin:user_sounds_menu:${u.id}` }]);
    }
  }
  rows.push([
    { text: '🎯 Обрати гравця за @username / ID', callback_data: 'admin:prompt:rofl_target' },
  ]);
  rows.push([
    { text: '📢 Увімкнути звук ВСІМ онлайн!', callback_data: 'admin:all_sounds_menu' },
  ]);
  rows.push([
    { text: '⬅️ Назад до адмінки', callback_data: 'admin:back' },
  ]);

  return { text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
}

function formatAcLogTxt(target, targetChatId, karma, totalDetects, strikes, logs) {
  let txt = `=== TAPSENTINEL DEBUG LOG ===\n`;
  txt += `Гравець: ${target.name} (${target.display})\n`;
  txt += `ID: ${targetChatId}\n`;
  txt += `Карма: ${karma}/100\n`;
  txt += `Всього детектів: ${totalDetects}\n`;
  txt += `Дата звіту: ${new Date().toISOString()}\n`;
  txt += `\n=== СТРАЙКИ (timestamps) ===\n`;
  if (!strikes || strikes.length === 0) {
    txt += `(немає)\n`;
  } else {
    strikes.forEach((ts, i) => {
      txt += `  Strike ${i + 1}: ${new Date(ts).toISOString()}\n`;
    });
  }

  txt += `\n=== ДЕБАГ ДЕТЕКТІВ (останні ${logs ? logs.length : 0}) ===\n`;
  if (!logs || logs.length === 0) {
    txt += `(немає записів)\n`;
  } else {
    logs.forEach((entry, i) => {
      txt += `\n--- Detect ${i + 1}${entry.type ? ` [${entry.type}]` : ''} ---\n`;
      txt += `  Час: ${entry.ts ? new Date(entry.ts).toISOString() : 'N/A'}\n`;
      if (entry.reason) txt += `  Причина:        ${entry.reason}\n`;
      if (entry.ratePerSec) txt += `  Швидкість:      ${entry.ratePerSec} кл/с (${entry.dClicks} кл за ${entry.dSec}с)\n`;
      if (entry.karmaAfter !== undefined) txt += `  Карма після:    ${entry.karmaAfter}/100\n`;
      if (entry.R !== undefined) txt += `  R (ритм):       ${entry.R}/100\n`;
      if (entry.C !== undefined) txt += `  C (координати): ${entry.C}/100\n`;
      if (entry.B !== undefined) txt += `  B (поведінка):  ${entry.B}/100\n`;
      if (entry.H !== undefined) txt += `  H (людяність):  ${entry.H}/100\n`;
      if (entry.evidence !== undefined) txt += `  Evidence:       ${entry.evidence}\n`;
      if (entry.suspicion !== undefined) txt += `  Suspicion:      ${entry.suspicion}\n`;
      if (entry.independentSignals !== undefined) txt += `  Indep. signals: ${entry.independentSignals}\n`;
      if (entry.strongRatio !== undefined) txt += `  Strong ratio:   ${entry.strongRatio}\n`;
      if (entry.veryStrongRatio !== undefined) txt += `  VStrong ratio:  ${entry.veryStrongRatio}\n`;
      if (entry.metronome !== undefined) txt += `  Metronome:      ${entry.metronome}\n`;
      if (entry.cv40 !== undefined) txt += `  CV40:           ${entry.cv40}\n`;
      if (entry.extremeSpeedBoost !== undefined) txt += `  ExtremeBoost:   ${entry.extremeSpeedBoost}\n`;
      if (entry.taps40count !== undefined) txt += `  Taps (40):      ${entry.taps40count}\n`;
      if (entry.taps300count !== undefined) txt += `  Taps (300):     ${entry.taps300count}\n`;
      if (entry.ivs40) txt += `  Інтервали (мс): ${entry.ivs40}\n`;
    });
  }
  return txt;
}

async function sendAcLogDocument(TOKEN, chatId, target) {
  const targetChatId = target.id;
  const targetUsername = target.username || targetChatId;

  let karma = 100;
  const kRaw = await redis('HGET', 'ac_karma', targetChatId);
  if (kRaw?.result) { try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch {} }

  const totalRaw = await redis('HGET', 'ac_total', targetChatId);
  const totalDetects = totalRaw?.result ? (parseInt(totalRaw.result) || 0) : 0;

  let logs = [];
  const logsRaw = await redis('HGET', 'ac_debug_log', targetChatId);
  if (logsRaw?.result) { try { logs = JSON.parse(logsRaw.result); } catch { logs = []; } }

  let strikes = [];
  const sRaw = await redis('HGET', 'ac_strikes', targetChatId);
  if (sRaw?.result) { try { strikes = JSON.parse(sRaw.result); } catch { strikes = []; } }

  const txt = formatAcLogTxt(target, targetChatId, karma, totalDetects, strikes, logs);

  const boundary = '----FormBoundary' + Date.now();
  const fileName = `aclog_${targetUsername}_${Date.now()}.txt`;
  const fileContent = Buffer.from(txt, 'utf-8');

  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n🛡 Debug log для ${target.display}\nДетектів: ${totalDetects} | Карма: ${karma}/100`,
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: text/plain\r\n\r\n`,
  ];

  const beforeFile = Buffer.from(bodyParts.join('\r\n') + '\r\n', 'utf-8');
  const afterFile = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const fullBody = Buffer.concat([beforeFile, fileContent, afterFile]);

  return fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: fullBody,
  });
}

async function executeUpdateUsers(TOKEN, targetArg = '') {
  const arg = (targetArg || '').replace('@', '').trim();

  const usersData = await redis('HGETALL', 'users');
  const lbData = await redis('HGETALL', 'leaderboard');

  const userMap = new Map();
  if (usersData?.result) {
    for (let i = 0; i < usersData.result.length; i += 2) {
      const id = String(usersData.result[i]);
      let obj = {};
      try { obj = JSON.parse(usersData.result[i + 1]); } catch { /* */ }
      userMap.set(id, obj);
    }
  }

  const lbMap = new Map();
  if (lbData?.result) {
    for (let i = 0; i < lbData.result.length; i += 2) {
      const id = String(lbData.result[i]);
      let obj = {};
      try { obj = JSON.parse(lbData.result[i + 1]); } catch { /* */ }
      lbMap.set(id, obj);
      if (!userMap.has(id)) {
        userMap.set(id, { name: obj.n || 'Гравець', username: obj.u || '', lastActive: obj.ts || Date.now() });
      }
    }
  }

  let targetIds = [];
  if (arg) {
    if (/^\d+$/.test(arg)) {
      targetIds = [arg];
    } else {
      const tData = await redis('HGET', 'usernames', arg.toLowerCase());
      if (tData?.result) {
        targetIds = [String(tData.result)];
      } else {
        for (const [uid, uObj] of userMap.entries()) {
          if (uObj.username && uObj.username.toLowerCase() === arg.toLowerCase()) {
            targetIds = [uid];
            break;
          }
        }
      }
      if (targetIds.length === 0) {
        return `❌ Юзер @${arg} не знайдений у базі.`;
      }
    }
  } else {
    targetIds = Array.from(userMap.keys());
  }

  if (targetIds.length === 0) {
    return '👥 Користувачів для оновлення не знайдено.';
  }

  let updatedCount = 0;
  let unchangedCount = 0;
  let inaccessibleCount = 0;
  const changes = [];

  const batchSize = 8;
  for (let i = 0; i < targetIds.length; i += batchSize) {
    const batch = targetIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async (id) => {
      const current = userMap.get(id) || {};
      const oldUsername = current.username || '';
      const oldName = current.name || '';
      const lbEntry = lbMap.get(id);

      let freshName = null;
      let freshUsername = null;
      let tgOk = false;

      try {
        const chatRes = await sendTg(TOKEN, 'getChat', { chat_id: Number(id) });
        if (chatRes?.ok && chatRes.result) {
          tgOk = true;
          freshName = chatRes.result.first_name || '';
          freshUsername = chatRes.result.username || '';
        }
      } catch { /* network error */ }

      if (!tgOk && lbEntry && lbEntry.u) {
        freshUsername = lbEntry.u;
        freshName = lbEntry.n || oldName;
      }

      if (freshName === null && freshUsername === null) {
        inaccessibleCount++;
        return;
      }

      const hasUsernameChanged = freshUsername !== null && freshUsername !== oldUsername;
      const hasNameChanged = freshName !== null && freshName !== oldName;

      if (hasUsernameChanged || hasNameChanged) {
        updatedCount++;
        const finalUsername = freshUsername !== null ? freshUsername : oldUsername;
        const finalName = freshName !== null ? freshName : oldName;

        if (oldUsername && oldUsername.toLowerCase() !== finalUsername.toLowerCase()) {
          await redis('HDEL', 'usernames', oldUsername.toLowerCase());
        }
        if (finalUsername) {
          await redis('HSET', 'usernames', finalUsername.toLowerCase(), String(id));
        }

        const updatedUser = {
          ...current,
          name: finalName,
          username: finalUsername,
          lastActive: current.lastActive || Date.now(),
        };
        await redis('HSET', 'users', String(id), JSON.stringify(updatedUser));

        if (lbEntry) {
          lbEntry.n = finalName;
          lbEntry.u = finalUsername;
          if (!lbEntry.av && finalUsername) {
            lbEntry.av = `https://t.me/i/userpic/320/${finalUsername}.jpg`;
          }
          await redis('HSET', 'leaderboard', String(id), JSON.stringify(lbEntry));
        }

        changes.push(`• ID \`${id}\`: ${oldName}${oldUsername ? ` (@${oldUsername})` : ''} ➔ *${finalName}*${finalUsername ? ` (@${finalUsername})` : ' (без юзернейму)'}`);
      } else {
        unchangedCount++;
        if (lbEntry && !lbEntry.av && (finalUsername || oldUsername)) {
          lbEntry.av = `https://t.me/i/userpic/320/${finalUsername || oldUsername}.jpg`;
          await redis('HSET', 'leaderboard', String(id), JSON.stringify(lbEntry));
        }
        if (oldUsername) {
          await redis('HSET', 'usernames', oldUsername.toLowerCase(), String(id));
        }
      }
    }));
  }

  let report = `✅ *Оновлення юзернеймів завершено!*\n\n` +
    `👥 Перевірено: *${targetIds.length}*\n` +
    `🔄 Оновлено: *${updatedCount}*\n` +
    `⏺ Без змін: *${unchangedCount}*\n`;
  if (inaccessibleCount > 0) {
    report += `⚠️ Недоступно через API: *${inaccessibleCount}*\n`;
  }

  if (changes.length > 0) {
    report += `\n📋 *Зміни:*\n` + changes.slice(0, 30).join('\n');
    if (changes.length > 30) {
      report += `\n…і ще ${changes.length - 30} юзерів`;
    }
  } else {
    report += `\nУсі юзернейми в базі вже актуальні!`;
  }

  return report;
}

async function getAllPlayerIds() {
  const ids = new Set();
  const usersData = await redis('HGETALL', 'users');
  if (usersData?.result) {
    for (let i = 0; i < usersData.result.length; i += 2) {
      ids.add(String(usersData.result[i]));
    }
  }
  const lbData = await redis('HGETALL', 'leaderboard');
  if (lbData?.result) {
    for (let i = 0; i < lbData.result.length; i += 2) {
      ids.add(String(lbData.result[i]));
    }
  }
  if (ADMIN_ID) ids.add(String(ADMIN_ID));
  return Array.from(ids);
}

async function executeGiveAll(TOKEN, adminChatId, amount) {
  const targetIds = await getAllPlayerIds();
  if (targetIds.length === 0) {
    await sendTg(TOKEN, 'sendMessage', { chat_id: adminChatId, text: '❌ Гравців у базі не знайдено.' });
    return;
  }
  await sendTg(TOKEN, 'sendMessage', {
    chat_id: adminChatId,
    text: `⏳ Роздаю по *${amount.toLocaleString()}* фокач для *${targetIds.length}* гравців...`,
    parse_mode: 'Markdown',
  });

  const BATCH_SIZE = 10;
  let sent = 0;
  for (let i = 0; i < targetIds.length; i += BATCH_SIZE) {
    const batch = targetIds.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (uid) => {
        const ex = await redis('GET', `reward:${uid}`);
        const curR = ex?.result ? parseInt(ex.result, 10) : 0;
        await redis('SET', `reward:${uid}`, String(curR + amount));
        await redis('DEL', `deduct:${uid}`);
        sent++;
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(uid),
          text: `🎁 *Тобі нараховано ${amount.toLocaleString()} фокач від адміна!*\n🫓 Зайди в гру щоб отримати.`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🫓 Забрати нагороду!', web_app: { url: WEBAPP_URL } }]],
          },
        }).catch(() => {});
      })
    );
  }

  await sendTg(TOKEN, 'sendMessage', {
    chat_id: adminChatId,
    text: `✅ Успішно нараховано по *${amount.toLocaleString()}* фокач для *${sent}* гравців!`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎁 Меню видачі', callback_data: 'admin:menu:give' }],
        [{ text: '⬅️ Головне меню', callback_data: 'admin:back' }],
      ],
    },
  });
}

async function executeDiamondAll(TOKEN, adminChatId, amount) {
  const targetIds = await getAllPlayerIds();
  if (targetIds.length === 0) {
    await sendTg(TOKEN, 'sendMessage', { chat_id: adminChatId, text: '❌ Гравців у базі не знайдено.' });
    return;
  }
  await sendTg(TOKEN, 'sendMessage', {
    chat_id: adminChatId,
    text: `⏳ Роздаю по *+${amount}* 💎 алмазів для *${targetIds.length}* гравців...`,
    parse_mode: 'Markdown',
  });

  const BATCH_SIZE = 10;
  let sent = 0;
  for (let i = 0; i < targetIds.length; i += BATCH_SIZE) {
    const batch = targetIds.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (uid) => {
        const ex = await redis('GET', `reward_gem:${uid}`);
        const curR = ex?.result ? parseInt(ex.result, 10) : 0;
        await redis('SET', `reward_gem:${uid}`, String(curR + amount));
        await redis('SET', `reward_gem_source:${uid}`, 'admin');
        sent++;
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(uid),
          text: `💎 *Тобі нараховано +${amount} 💎 алмазів від адміна!*\nЗайди в гру щоб отримати.`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🫓 Забрати алмази!', web_app: { url: WEBAPP_URL } }]],
          },
        }).catch(() => {});
      })
    );
  }

  await sendTg(TOKEN, 'sendMessage', {
    chat_id: adminChatId,
    text: `✅ Успішно нараховано по *+${amount}* 💎 алмазів для *${sent}* гравців!`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💎 Меню алмазів', callback_data: 'admin:menu:diamonds' }],
        [{ text: '⬅️ Головне меню', callback_data: 'admin:back' }],
      ],
    },
  });
}

async function handleAdminAwaitInput(TOKEN, chatId, text, awaitData) {
  const action = awaitData?.action;
  const targetId = awaitData?.targetId;

  if (text.startsWith('/') && text !== '/cancel') {
    // allow slash commands
  }

  if (action === 'takeskins') {
    const raw = text.trim();
    if (raw.toLowerCase() === 'all' || raw.toLowerCase() === 'всім' || raw.toLowerCase() === 'все' || raw.toLowerCase() === 'всем') {
      const resetTime = Date.now();
      await redis('SET', 'global_skins_reset_time', String(resetTime));
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `🧹 *Скидання скінів для ВСІХ гравців успішно активовано!*\n\nУ всіх гравців при вході або оновленні гри залишиться виключно стандартна класична фокача.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👑 До адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const target = await resolveTargetUser(raw);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача "${raw}" не знайдено в базі. Спробуйте інший @username або числовий Telegram ID.`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Спробувати ще раз', callback_data: 'admin:prompt:takeskins' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const resetTime = Date.now();
    await redis('SET', `reset_skins:${target.id}`, String(resetTime));
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `🧹 *Скіни успішно забрано!*\n\nГравець: ${target.display}\nПри наступному вході або синхронізації всі додаткові скіни фокачі будуть очищені до стандарту.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Профіль гравця', callback_data: `admin:check_id:${target.id}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'rofl_target') {
    const raw = text.trim();
    const target = await resolveTargetUser(raw);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача "${raw}" не знайдено в базі.`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Спробувати ще раз', callback_data: 'admin:prompt:rofl_target' }],
            [{ text: '🎭 До рофл-меню', callback_data: 'admin:menu:rofl' }],
          ],
        },
      });
      return;
    }
    const menu = await renderUserSoundsMenu(target.id);
    await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...menu });
    return;
  }

  if (action === 'give_self') {
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна сума. Вкажіть число (наприклад: 50000000 або 50m):',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:give_self' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const existing = await redis('GET', `reward:${chatId}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `reward:${chatId}`, String(current + amt));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Нараховано *${amt.toLocaleString()}* фокач тобі!\n🫓 Зайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎁 Видати ще', callback_data: 'admin:menu:give' }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'giveto') {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Формат: `@username 50000000` або `1975429762 50m`',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:giveto' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const target = await resolveTargetUser(parts[0]);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача ${parts[0]} не знайдено (вкажи @username або ID).`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:giveto' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const amt = parseAmountInput(parts[1]);
    if (!amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість фокач.',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:giveto' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const targetChatId = target.id;
    const existing = await redis('GET', `reward:${targetChatId}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `reward:${targetChatId}`, String(current + amt));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(targetChatId),
      text: `🎁 Тобі нараховано *${amt.toLocaleString()}* фокач від адміна!\n🫓 Зайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🫓 Забрати нагороду!', web_app: { url: WEBAPP_URL } }]],
      },
    });

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Нараховано *${amt.toLocaleString()}* фокач для ${target.display}!`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Відкрити картку гравця', callback_data: `admin:check_user:${targetChatId}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'giveto_target') {
    const target = await resolveTargetUser(targetId);
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0 || !target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна сума.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const existing = await redis('GET', `reward:${target.id}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `reward:${target.id}`, String(current + amt));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(target.id),
      text: `🎁 Тобі нараховано *${amt.toLocaleString()}* фокач від адміна!\n🫓 Зайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🫓 Забрати нагороду!', web_app: { url: WEBAPP_URL } }]],
      },
    });

    const card = await renderUserCard(target);
    await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...card });
    return;
  }

  if (action === 'rebirth_self') {
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість ребіртхів.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const existing = await redis('GET', `rebirth:${chatId}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `rebirth:${chatId}`, String(current + amt));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Нараховано *+${amt}* ребіртх(ів) тобі!\n🔄 Зайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Видати ще', callback_data: 'admin:menu:rebirth' }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'rebirthto') {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Формат: `@username 5` або `1975429762 10`',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const target = await resolveTargetUser(parts[0]);
    const amt = parseAmountInput(parts[1]);
    if (!target || !amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Користувача або кількість не розпізнано.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const existing = await redis('GET', `rebirth:${target.id}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `rebirth:${target.id}`, String(current + amt));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(target.id),
      text: `🔄 Тобі нараховано *+${amt}* ребіртх(ів) від адміна!\nЗайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🫓 Забрати ребіртхи!', web_app: { url: WEBAPP_URL } }]],
      },
    });

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Нараховано *+${amt}* ребіртх(ів) для ${target.display}!`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Відкрити картку гравця', callback_data: `admin:check_user:${target.id}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'rebirthto_target') {
    const target = await resolveTargetUser(targetId);
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0 || !target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const existing = await redis('GET', `rebirth:${target.id}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `rebirth:${target.id}`, String(current + amt));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(target.id),
      text: `🔄 Тобі нараховано *+${amt}* ребіртх(ів) від адміна!\nЗайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🫓 Забрати ребіртхи!', web_app: { url: WEBAPP_URL } }]],
      },
    });

    const card = await renderUserCard(target);
    await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...card });
    return;
  }

  if (action === 'diamond_self') {
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість алмазів. Вкажіть число (наприклад: 50 або 500):',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:diamond_self' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const existing = await redis('GET', `reward_gem:${chatId}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `reward_gem:${chatId}`, String(current + amt));
    await redis('SET', `reward_gem_source:${chatId}`, 'admin');

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Нараховано *+${amt}* 💎 алмазів тобі!\n💎 Зайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💎 Видати ще', callback_data: 'admin:menu:diamonds' }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'diamondto') {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Формат: `@username 100` або `1975429762 50`',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:diamondto' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const target = await resolveTargetUser(parts[0]);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача ${parts[0]} не знайдено (вкажи @username або ID).`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:diamondto' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const amt = parseAmountInput(parts[1]);
    if (!amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість алмазів.',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:diamondto' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const targetChatId = target.id;
    const existing = await redis('GET', `reward_gem:${targetChatId}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `reward_gem:${targetChatId}`, String(current + amt));
    await redis('SET', `reward_gem_source:${targetChatId}`, 'admin');

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(targetChatId),
      text: `💎 Тобі нараховано *+${amt}* алмазів від адміна!\nЗайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🫓 Забрати алмази!', web_app: { url: WEBAPP_URL } }]],
      },
    });

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Нараховано *+${amt}* 💎 алмазів для ${target.display}!`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Відкрити картку гравця', callback_data: `admin:check_user:${targetChatId}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'diamondto_target') {
    const target = await resolveTargetUser(targetId);
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0 || !target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість алмазів.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const existing = await redis('GET', `reward_gem:${target.id}`);
    const current = existing?.result ? parseInt(existing.result) : 0;
    await redis('SET', `reward_gem:${target.id}`, String(current + amt));
    await redis('SET', `reward_gem_source:${target.id}`, 'admin');

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: Number(target.id),
      text: `💎 Тобі нараховано *+${amt}* алмазів від адміна!\nЗайди в гру щоб отримати.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🫓 Забрати алмази!', web_app: { url: WEBAPP_URL } }]],
      },
    });

    const card = await renderUserCard(target);
    await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...card });
    return;
  }

  if (action === 'giveall') {
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна сума фокач. Вкажіть число (наприклад: 50m або 100000000):',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:giveall' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    await executeGiveAll(TOKEN, chatId, amt);
    return;
  }

  if (action === 'diamondall') {
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість алмазів. Вкажіть число (наприклад: 50 або 500):',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати ще раз', callback_data: 'admin:prompt:diamondall' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    await executeDiamondAll(TOKEN, chatId, amt);
    return;
  }

  if (action === 'check') {
    const target = await resolveTargetUser(text);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача \`${text}\` не знайдено в базі.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✍️ Спробувати іншого', callback_data: 'admin:prompt:check' }],
            [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
          ],
        },
      });
      return;
    }
    const card = await renderUserCard(target);
    await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...card });
    return;
  }

  if (action === 'take') {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Формат: `@username 5000000` або `1975429762 5m`',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const target = await resolveTargetUser(parts[0]);
    const amt = parseAmountInput(parts[1]);
    if (!target || !amt || amt <= 0) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Користувача або кількість не розпізнано.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    await redis('DEL', `reward:${target.id}`);
    const exDeduct = await redis('GET', `deduct:${target.id}`);
    const curD = exDeduct?.result ? parseInt(exDeduct.result) : 0;
    await redis('SET', `deduct:${target.id}`, String(curD + amt));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Встановлено списання *${amt.toLocaleString()}* фокач для ${target.display} при наступному вході!`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Відкрити картку гравця', callback_data: `admin:check_user:${target.id}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'take_target') {
    const target = await resolveTargetUser(targetId);
    const amt = parseAmountInput(text);
    if (!amt || amt <= 0 || !target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Некоректна кількість.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    await redis('DEL', `reward:${target.id}`);
    const exDeduct = await redis('GET', `deduct:${target.id}`);
    const curD = exDeduct?.result ? parseInt(exDeduct.result) : 0;
    await redis('SET', `deduct:${target.id}`, String(curD + amt));

    const card = await renderUserCard(target);
    await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...card });
    return;
  }

  if (action === 'broadcast') {
    const broadcastText = text.trim();
    const usersData = await redis('HGETALL', 'users');
    if (!usersData?.result) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Немає юзерів у базі.',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const entries = usersData.result;
    let sent = 0, failed = 0;
    for (let i = 0; i < entries.length; i += 2) {
      const uid = entries[i];
      try {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(uid),
          text: `📢 *Оголошення:*\n\n${broadcastText}`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🫓 Грати!', web_app: { url: WEBAPP_URL } }]],
          },
        });
        sent++;
      } catch {
        failed++;
      }
    }
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Розсилка завершена!\n📨 Відправлено: *${sent}*\n❌ Помилок: *${failed}*`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
      },
    });
    return;
  }

  if (action === 'aclog') {
    const target = await resolveTargetUser(text);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача ${text} не знайдено.`,
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    await sendAcLogDocument(TOKEN, chatId, target);
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `📄 Дебаг-лог для ${target.display} сформовано та надіслано!`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Картка гравця', callback_data: `admin:check_user:${target.id}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'warn') {
    const target = await resolveTargetUser(text);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача ${text} не знайдено.`,
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const targetChatId = target.id;
    let karma = 100;
    const kRaw = await redis('HGET', 'ac_karma', targetChatId);
    if (kRaw?.result) { try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch {} }
    karma = Math.max(0, karma - 15);
    await redis('HSET', 'ac_karma', targetChatId, JSON.stringify({ k: karma, on: 0, ts: Date.now() }));
    await redis('HINCRBY', 'ac_total', targetChatId, '1');
    await redis('SADD', 'flagged_users', targetChatId);
    if (karma < 50) await redis('HSET', 'ac_active', targetChatId, '1');

    let wStrikes = [];
    const wsRaw = await redis('HGET', 'ac_strikes', targetChatId);
    if (wsRaw?.result) { try { wStrikes = JSON.parse(wsRaw.result); } catch {} }
    wStrikes.push(Date.now());
    if (wStrikes.length > 50) wStrikes = wStrikes.slice(-50);
    await redis('HSET', 'ac_strikes', targetChatId, JSON.stringify(wStrikes));

    let wLogs = [];
    const wlRaw = await redis('HGET', 'ac_debug_log', targetChatId);
    if (wlRaw?.result) { try { wLogs = JSON.parse(wlRaw.result); } catch {} }
    wLogs.push({
      type: 'admin_warn',
      reason: 'Ручне попередження від адміністратора',
      karmaAfter: karma,
      ts: Date.now(),
    });
    if (wLogs.length > 50) wLogs = wLogs.slice(-50);
    await redis('HSET', 'ac_debug_log', targetChatId, JSON.stringify(wLogs));

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `⚠️ Знак видано для ${target.display}. Карма: *${karma}/100*.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Відкрити картку', callback_data: `admin:check_user:${targetChatId}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'unflag') {
    const target = await resolveTargetUser(text);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача ${text} не знайдено.`,
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    const targetChatId = target.id;
    await redis('HSET', 'ac_karma', targetChatId, JSON.stringify({ k: 100, on: 0, ts: Date.now() }));
    await redis('HDEL', 'ac_active', targetChatId);
    await redis('HDEL', 'ac_total', targetChatId);
    await redis('HDEL', 'ac_strikes', targetChatId);
    await redis('HDEL', 'ac_debug_log', targetChatId);
    await redis('SREM', 'flagged_users', targetChatId);

    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ ${target.display} повністю прощений: карма відновлена до *100/100*, знак ⚠️ та всі обмеження знято!`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Відкрити картку', callback_data: `admin:check_user:${targetChatId}` }],
          [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'reset_one') {
    const target = await resolveTargetUser(text);
    if (!target) {
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Користувача ${text} не знайдено.`,
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
        },
      });
      return;
    }
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `⚠️ *ПІДТВЕРДЖЕННЯ СКИДАННЯ АКАУНТУ*\n\nВи дійсно хочете скинути весь прогрес для ${target.display}?`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑 Так, скинути!', callback_data: `admin:user_reset_exec:${target.id}` }],
          [{ text: '⬅️ Скасувати / Назад', callback_data: 'admin:back' }],
        ],
      },
    });
    return;
  }

  if (action === 'update_user') {
    const report = await executeUpdateUsers(TOKEN, text);
    await sendTg(TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: report,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
      },
    });
    return;
  }

  if (action === 'contest_id') {
    const cId = text.trim();
    const pView = await renderContestParticipants(cId, 0);
    await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...pView });
    return;
  }
}

module.exports = async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;

  if (req.method !== 'POST') {
    if (TOKEN) {
      await checkScheduledContests(TOKEN).catch(() => {});
      await checkExpiredContests(TOKEN).catch(() => {});
    }
    return res.status(200).json({ ok: true, msg: '🫓 Focaccia bot is alive!' });
  }

  if (!TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });

  // 🧹 Автоматичне видалення застарілих повідомлень налаштування дуелей (>15 хв)
  await cleanupExpiredMessages(TOKEN);
  // ⏱ Автоматичний запуск запланованих конкурсів
  await checkScheduledContests(TOKEN);
  // ⏱ Автоматична перевірка та підбиття підсумків активних конкурсів
  await checkExpiredContests(TOKEN);

  try {
    const update = req.body;

    // ===== 🌟 TELEGRAM STARS PAYMENTS =====
    if (update.pre_checkout_query) {
      const pcq = update.pre_checkout_query;
      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/answerPreCheckoutQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pre_checkout_query_id: pcq.id,
            ok: true,
          }),
        });
      } catch (err) {
        console.error('answerPreCheckoutQuery error:', err);
      }
      return res.status(200).json({ ok: true });
    }

    if (update.message?.successful_payment) {
      const msg = update.message;
      const sp = msg.successful_payment;
      const payload = String(sp.invoice_payload || '');
      const parts = payload.split(':');
      const targetUserId = parts[0] || String(msg.from.id);
      const packageId = parts[1] || '';
      const chatId = msg.chat?.id || targetUserId;

      let diamonds = 0;
      let title = 'Діаманти';
      let extraNote = '';

      if (packageId === 'gems_50') {
        diamonds = 50;
        title = '50 Діамантів 💎';
      } else if (packageId === 'gems_150') {
        diamonds = 150;
        title = '150 Діамантів 💎';
      } else if (packageId === 'gems_500') {
        diamonds = 500;
        title = '500 Діамантів 💎';
      } else if (packageId === 'gems_1500') {
        diamonds = 1500;
        title = '1500 Діамантів 💎';
      } else if (packageId === 'starter_pack') {
        diamonds = 100;
        title = '⚡ Стартовий набір';
        extraNote = '\n🪵 Вам також надано зброю проти босів «Бойова скалка»!';
        await redis('HSET', `user_extra:${targetUserId}`, 'vip_upgrade', 'vip_hammer');
      } else if (packageId === 'tip_dev') {
        diamonds = 25;
        title = '☕ Чайові розробнику';
        extraNote = '\n💖 Вам присвоєно особливий титул «Меценат»!';
        await redis('HSET', `user_extra:${targetUserId}`, 'badge_patron', '1');
      } else {
        diamonds = Math.max(10, (sp.total_amount || 10) * 3);
      }

      if (diamonds > 0) {
        const existing = await redis('GET', `reward_gem:${targetUserId}`);
        const prevGems = existing?.result ? parseInt(existing.result, 10) : 0;
        await redis('SET', `reward_gem:${targetUserId}`, String(prevGems + diamonds));
        await redis('SET', `reward_gem_source:${targetUserId}`, 'donate');
      }

      await redis('HINCRBY', 'donations_total_stars', targetUserId, String(sp.total_amount || 0));
      await redis('HINCRBY', 'donations_count', targetUserId, '1');
      await redis('INCRBY', 'global_donations_stars', String(sp.total_amount || 0));

      try {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(chatId),
          text: `🎉 *Оплата успішна!*\n\nЩиро дякуємо за придбання *${title}* за ${sp.total_amount} ⭐!\n\n💎 Вам нараховано: *+${diamonds} 💎*${extraNote}\n\nВідкрийте гру, щоб отримати нагороду!`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🫓 Відкрити гру', web_app: { url: WEBAPP_URL } }]],
          },
        });
      } catch (err) {
        console.error('Error sending purchase confirmation:', err);
      }

      return res.status(200).json({ ok: true });
    }

    // ===== ⚔️ ДУЭЛИ: inline-кнопки =====
    const cq = update.callback_query;
    if (cq && typeof cq.data === 'string' && cq.data.startsWith('duel:')) {
      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      } catch { /* ignore */ }

      const cqChat = cq.message?.chat?.id ?? cq.from.id;
      const parts = cq.data.split(':');
      const dAction = parts[1];
      const dArg = parts[2];

      // Видаляємо попереднє повідомлення налаштування дуелі через 15 хв (якщо це не стартове меню)
      if (cq.message?.message_id && cqChat && dAction !== 'menu') {
        scheduleMessageDeletion(cqChat, cq.message.message_id, DUEL_MSG_CLEANUP_TTL).catch(() => {});
      }

      try {
        // меню відкриття дуелей у міні-аппі
        if (dAction === 'menu') {
          const duelLobbyUrl = 'https://nout0688-cloud.github.io/focaccia-clicker/?v=1.4.0&duel=lobby';
          await sendDuelTg(TOKEN, 'sendMessage', {
            chat_id: Number(cqChat),
            text: '⚔️ *Дуелі Фокача Клікер (Mini App)*\n\nБийся 1 на 1 у реальному часі на фокачі 🫓 або алмази 💎!\nОбирай суперника, валюту, ставку, ціль та тривалість бою прямо в окремому міні-аппі.',
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⚔️ Відкрити Дуелі (Mini App)', web_app: { url: duelLobbyUrl } }],
              ],
            },
          });
          return res.status(200).json({ ok: true });
        }

      // список игроков (последние активные, без себя)
      if (dAction === 'players') {
        const usersData = await redis('HGETALL', 'users');
        const list = [];
        if (usersData?.result) {
          for (let i = 0; i < usersData.result.length; i += 2) {
            if (String(usersData.result[i]) === String(cqChat)) continue;
            try {
              const u = JSON.parse(usersData.result[i + 1]);
              list.push({ id: usersData.result[i], name: u.name, username: u.username, last: u.lastActive || 0 });
            } catch { /* skip */ }
          }
          list.sort((a, b) => b.last - a.last);
        }
        if (list.length === 0) {
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '👥 Пока нет других игроков — позови друга поставить игру!' });
          return res.status(200).json({ ok: true });
        }
        const top = list.slice(0, 20);
        const rows = [];
        for (let i = 0; i < top.length; i += 2) {
          rows.push(top.slice(i, i + 2).map((p) => ({ text: p.username ? `@${p.username}` : p.name, callback_data: `duel:chal:${p.id}` })));
        }
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '👥 Выбери соперника:', reply_markup: { inline_keyboard: rows } });
        return res.status(200).json({ ok: true });
      }

      // ввод юзернейма
      if (dAction === 'byname') {
        await redis('SET', `duel_await:${cqChat}`, 'duel', 'EX', 300);
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '✍️ Напиши юзернейм соперника (например @spuod):' });
        return res.status(200).json({ ok: true });
      }

      // шаг 1: валюта ставки
      if (dAction === 'chal' && dArg) {
        if (String(dArg) === String(cqChat)) {
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Нельзя вызвать самого себя' });
          return res.status(200).json({ ok: true });
        }
        await sendDuelTg(TOKEN, 'sendMessage', {
          chat_id: Number(cqChat),
          text: '💰 На что играем? Ставку списывает у обоих при старте — победитель забирает банк!',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🫓 Фокачі', callback_data: `duel:cur:${dArg}:foc` },
                { text: '💎 Алмази', callback_data: `duel:cur:${dArg}:gem` },
              ],
              [{ text: '❌ Отмена', callback_data: 'duel:cancel' }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // шаг 2: сумма ставки
      if (dAction === 'cur' && dArg && parts[3]) {
        const cur = parts[3];
        const bets = cur === 'gem'
          ? [1, 5, 10, 25, 50, 100]
          : [10000, 100000, 1000000, 10000000, 100000000, 1000000000, 1000000000000, 100000000000000, 1000000000000000, 10000000000000000, 1000000000000000000];
        const sym = cur === 'gem' ? '💎' : '🫓';
        const rows = [];
        for (let i = 0; i < bets.length; i += 2) {
          rows.push(bets.slice(i, i + 2).map((b) => ({ text: `${formatNum(b)} ${sym}`, callback_data: `duel:stake:${dArg}:${cur}:${b}` })));
        }
        rows.push([{ text: '❌ Отмена', callback_data: 'duel:cancel' }]);
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: `💰 Розмір ставки (${sym}):`, reply_markup: { inline_keyboard: rows } });
        return res.status(200).json({ ok: true });
      }

      // шаг 3: цель (сколько тапнуть)
      if (dAction === 'stake' && parts[2] && parts[3] && parts[4]) {
        const targetId = parts[2];
        const cur = parts[3];
        const stake = Number(parts[4]) || 0;
        const sym = cur === 'gem' ? '💎' : '🫓';

        // Перевірка балансу творця дуелі
        const userBal = await getUserBalance(cqChat, cur);
        if (userBal !== null && userBal < stake) {
          await sendDuelTg(TOKEN, 'sendMessage', {
            chat_id: Number(cqChat),
            text: `❌ У тебе недостатньо коштів для цієї ставки!\n💰 Твій баланс: ${formatNum(userBal)} ${sym}\n⚔️ Потрібно: ${formatNum(stake)} ${sym}\n\n💡 Зайди в гру, щоб оновити баланс, або вибери меншу ставку!`,
          });
          return res.status(200).json({ ok: true });
        }

        // Перевірка балансу обраного суперника
        const oppBal = await getUserBalance(targetId, cur);
        // Блокуємо тільки якщо баланс суперника ТОЧНО зафіксований і строго менший за ставку
        if (oppBal !== null && oppBal < stake) {
          await sendDuelTg(TOKEN, 'sendMessage', {
            chat_id: Number(cqChat),
            text: `❌ У суперника недостатньо коштів для такої ставки!\n💰 Його баланс: ${formatNum(oppBal)} ${sym}\n⚔️ Обери меншу ставку для дуелі з цим гравцем!`,
          });
          return res.status(200).json({ ok: true });
        }

        const goals = [100, 250, 500, 1000];
        const rows = goals.map((g) => [{ text: `🎯 ${g} тапов`, callback_data: `duel:goal:${targetId}:${cur}:${stake}:${g}` }]);
        rows.push([{ text: '❌ Отмена', callback_data: 'duel:cancel' }]);
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '🎯 Цель — кто быстрее наберёт тапы:', reply_markup: { inline_keyboard: rows } });
        return res.status(200).json({ ok: true });
      }

      // шаг 4: длительность раунда → создание дуэли
      if (dAction === 'goal' && parts[2] && parts[3] && parts[4] && parts[5]) {
        const targetId = parts[2];
        const cur = parts[3];
        const stake = parts[4];
        const goal = parts[5];
        const times = [[120000, '2 мин'], [180000, '3 мин'], [300000, '5 мин'], [600000, '10 мин']];
        const rows = times.map(([ms, label]) => [{ text: `⏱ ${label}`, callback_data: `duel:time:${targetId}:${cur}:${stake}:${goal}:${ms}` }]);
        rows.push([{ text: '❌ Отмена', callback_data: 'duel:cancel' }]);
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '⏱ Длительность раунда:', reply_markup: { inline_keyboard: rows } });
        return res.status(200).json({ ok: true });
      }

      // шаг 5: создание дуэли со всеми параметрами
      if (dAction === 'time' && parts[2] && parts[3] && parts[4] && parts[5] && parts[6]) {
        const targetId = parts[2];
        const stakeCur = parts[3] === 'gem' ? 'gem' : 'foc';
        const stake = Number(parts[4]) || 0;
        const goal = parseInt(parts[5]) || 100;
        const timeMs = parseInt(parts[6]) || 180000;
        if (String(targetId) === String(cqChat)) {
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Нельзя вызвать самого себя' });
          return res.status(200).json({ ok: true });
        }
        const tData = await redis('HGET', 'users', targetId);
        if (!tData?.result) {
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Игрок не найден' });
          return res.status(200).json({ ok: true });
        }
        let tName = 'Гравець';
        let myName = 'Гравець';
        try { const u = JSON.parse(tData.result); tName = u.username ? `@${u.username}` : u.name; } catch { /* */ }
        const myData = await redis('HGET', 'users', String(cqChat));
        if (myData?.result) { try { myName = JSON.parse(myData.result).name || myName; } catch { /* */ } }

        const host = req.headers.host || 'focaccia-bot.vercel.app';
        const apiRes = await fetch(`https://${host}/api/duel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'challenge', from: cqChat, fromName: myName, to: targetId, stakeCur, stake, goal, timeMs }),
        });
        const data = await apiRes.json();
        if (!data.ok) {
          let why = '❌ Не вдалося створити дуель';
          if (data.error === 'shadow') why = '🚫 Карма занадто низька — дуелі закрито (Тінь бабусі)';
          else if (data.error === 'no_funds_creator') why = '❌ У тебе недостатньо коштів на балансі для цієї ставки! Зайди в гру, щоб оновити баланс.';
          else if (data.error === 'no_funds_opponent') why = '❌ У суперника недостатньо коштів для такої ставки!';
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: why });
          return res.status(200).json({ ok: true });
        }
        const sym = stakeCur === 'gem' ? '💎' : '🫓';
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: `⚔️ Вызов отправлен ${tName}!\n💰 Ставка: ${formatNum(stake)} ${sym} • 🎯 ${goal} тапов • ⏱ ${Math.round(timeMs / 60000)} мин\nУ него 5 минут на ответ.` });
        return res.status(200).json({ ok: true });
      }

      // отмена настройки
      if (dAction === 'cancel') {
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Создание дуэли отменено' });
        return res.status(200).json({ ok: true });
      }

      // принять вызов
      if (dAction === 'accept' && dArg) {
        const host = req.headers.host || 'focaccia-bot.vercel.app';
        const apiRes = await fetch(`https://${host}/api/duel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accept', duelId: dArg, userId: cqChat, name: cq.from?.first_name || '', u: cq.from?.username || '' }),
        });
        const data = await apiRes.json();
        if (!data.ok) {
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '⏱ Время вышло — дуэль отменена.' });
        }
        return res.status(200).json({ ok: true });
      }

      // отклонить вызов
      if (dAction === 'decline' && dArg) {
        const host = req.headers.host || 'focaccia-bot.vercel.app';
        await fetch(`https://${host}/api/duel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'decline', duelId: dArg, userId: cqChat }),
        });
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
      } catch (e) {
        console.error('Duel callback error:', dAction, e.message);
        return res.status(200).json({ ok: true });
      }
    }

    // ===== 🤝 ТРЕЙДИ: callback-кнопки =====
    if (cq && typeof cq.data === 'string' && cq.data.startsWith('trade:')) {
      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      } catch { /* ignore */ }

      const cqChat = cq.message?.chat?.id ?? cq.from.id;
      const parts = cq.data.split(':');
      const tAction = parts[1];
      const tArg = parts[2];

      if (cq.message?.message_id && cqChat && tAction !== 'menu') {
        scheduleMessageDeletion(cqChat, cq.message.message_id, DUEL_MSG_CLEANUP_TTL).catch(() => {});
      }

      try {
        // Меню вибору партнерів
        if (tAction === 'menu') {
          await sendDuelTg(TOKEN, 'sendMessage', {
            chat_id: Number(cqChat),
            text: '🤝 *Меню безпечних Трейдів*\nОбмінюйся фокачами 🫓, алмазами 💎 та скінами 🎨 в окремому міні-аппі!',
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '👥 Зі списку гравців', callback_data: 'trade:players' }],
                [{ text: '🔍 За юзернеймом', callback_data: 'trade:byname' }],
                [{ text: '🔗 Створити відкритий трейд', callback_data: 'trade:open' }],
              ],
            },
          });
          return res.status(200).json({ ok: true });
        }

        // Список останніх активних гравців
        if (tAction === 'players') {
          const usersData = await redis('HGETALL', 'users');
          const list = [];
          if (usersData?.result) {
            for (let i = 0; i < usersData.result.length; i += 2) {
              if (String(usersData.result[i]) === String(cqChat)) continue;
              try {
                const u = JSON.parse(usersData.result[i + 1]);
                list.push({ id: usersData.result[i], name: u.name, username: u.username, last: u.lastActive || 0 });
              } catch { /* skip */ }
            }
            list.sort((a, b) => b.last - a.last);
          }
          if (list.length === 0) {
            await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '👥 Поки немає інших гравців онлайн. Створи відкритий трейд і надішли другові!' });
            return res.status(200).json({ ok: true });
          }
          const top = list.slice(0, 20);
          const rows = [];
          for (let i = 0; i < top.length; i += 2) {
            rows.push(top.slice(i, i + 2).map((p) => ({ text: p.username ? `@${p.username}` : p.name, callback_data: `trade:chal:${p.id}` })));
          }
          rows.push([{ text: '❌ Скасувати', callback_data: 'trade:cancel' }]);
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '👥 Обери гравця для обміну:', reply_markup: { inline_keyboard: rows } });
          return res.status(200).json({ ok: true });
        }

        // Очікування юзернейму
        if (tAction === 'byname') {
          await redis('SET', `trade_await:${cqChat}`, 'trade', 'EX', 300);
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '✍️ Введи @username або числовий ID партнера для обміну:' });
          return res.status(200).json({ ok: true });
        }

        // Прямий виклик на трейд
        if (tAction === 'chal' && tArg) {
          if (String(tArg) === String(cqChat)) {
            await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Не можна трейдитися із самим собою' });
            return res.status(200).json({ ok: true });
          }
          const host = req.headers.host || 'focaccia-bot.vercel.app';
          const myName = (cq.from?.first_name || 'Гравець').slice(0, 24);
          const myU = (cq.from?.username || '').slice(0, 32);

          const apiRes = await fetch(`https://${host}/api/trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create', from: cqChat, to: tArg, fromName: myName, fromU: myU }),
          });
          const data = await apiRes.json();
          if (data?.ok) {
            const kb = {
              inline_keyboard: [
                [{ text: '🤝 Увійти в трейд', web_app: { url: data.url } }],
              ],
            };
            await sendDuelTg(TOKEN, 'sendMessage', {
              chat_id: Number(cqChat),
              text: `🤝 Запрошення до трейду надіслано гравцю!\nНатисни кнопку нижче, щоб відкрити кімнату обміну:`,
              reply_markup: kb,
            });
          } else if (data?.error === 'rebirth_locked') {
            const rem = data.remainingMs || 0;
            const days = Math.floor(rem / (24 * 3600 * 1000));
            const hours = Math.floor((rem % (24 * 3600 * 1000)) / (3600 * 1000));
            await sendDuelTg(TOKEN, 'sendMessage', {
              chat_id: Number(cqChat),
              text: `⏳ *Трейди заблоковано після ребіртху!*\n\nПісля останнього переродження має пройти 5 днів для запобігання нечесному переливу ресурсів.\nЗалишилося: *${days} дн. ${hours} год.*`,
              parse_mode: 'Markdown',
            });
          } else if (data?.error === 'recipient_rebirth_locked') {
            await sendDuelTg(TOKEN, 'sendMessage', {
              chat_id: Number(cqChat),
              text: `⏳ *Партнер не може торгувати!*\n\nЦей гравець нещодавно зробив ребіртх. Трейди для нього заблоковані на 5 днів.`,
            });
          } else {
            await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Не вдалося створити трейд. Спробуй пізніше.' });
          }
          return res.status(200).json({ ok: true });
        }

        // Створення відкритого трейду
        if (tAction === 'open') {
          const host = req.headers.host || 'focaccia-bot.vercel.app';
          const myName = (cq.from?.first_name || 'Гравець').slice(0, 24);
          const myU = (cq.from?.username || '').slice(0, 32);

          const apiRes = await fetch(`https://${host}/api/trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create', from: cqChat, to: null, fromName: myName, fromU: myU }),
          });
          const data = await apiRes.json();
          if (data?.ok) {
            const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(data.url)}&text=${encodeURIComponent('🤝 Заходь у мій трейд у Фокача Клікері! Обміняємося фокачами, алмазами чи скінами.')}`;
            const kb = {
              inline_keyboard: [
                [{ text: '🤝 Увійти в свій трейд', web_app: { url: data.url } }],
                [{ text: '📤 Поділитися посиланням', url: shareUrl }],
              ],
            };
            await sendDuelTg(TOKEN, 'sendMessage', {
              chat_id: Number(cqChat),
              text: `🔗 *Відкритий трейд створено!*\n\nБудь-який гравець, який перейде за цим посиланням, стане твоїм партнером по обміну:\n\`${data.url}\``,
              parse_mode: 'Markdown',
              reply_markup: kb,
            });
          } else if (data?.error === 'rebirth_locked') {
            const rem = data.remainingMs || 0;
            const days = Math.floor(rem / (24 * 3600 * 1000));
            const hours = Math.floor((rem % (24 * 3600 * 1000)) / (3600 * 1000));
            await sendDuelTg(TOKEN, 'sendMessage', {
              chat_id: Number(cqChat),
              text: `⏳ *Трейди заблоковано після ребіртху!*\n\nПісля останнього переродження має пройти 5 днів для запобігання нечесному переливу ресурсів.\nЗалишилося: *${days} дн. ${hours} год.*`,
              parse_mode: 'Markdown',
            });
          } else {
            await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Не вдалося створити відкритий трейд.' });
          }
          return res.status(200).json({ ok: true });
        }

        // Відхилити трейд
        if (tAction === 'decline' && tArg) {
          const host = req.headers.host || 'focaccia-bot.vercel.app';
          await fetch(`https://${host}/api/trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cancel', tradeId: tArg, userId: cqChat, reason: 'Відхилено користувачем' }),
          });
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Трейд відхилено.' });
          return res.status(200).json({ ok: true });
        }

        // Скасувати вибір
        if (tAction === 'cancel') {
          await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '❌ Створення трейду скасовано.' });
          return res.status(200).json({ ok: true });
        }

        return res.status(200).json({ ok: true });
      } catch (e) {
        console.error('Trade callback error:', tAction, e.message);
        return res.status(200).json({ ok: true });
      }
    }

    // ===== 🎁 КОНКУРСИ: callback-кнопки =====
    if (cq && typeof cq.data === 'string' && (cq.data.startsWith('concurs:') || cq.data.startsWith('contest:'))) {
      const cqChat = cq.message?.chat?.id ?? cq.from.id;
      const cqMsgId = cq.message?.message_id;
      const parts = cq.data.split(':');
      const action = parts[1];

      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      } catch { /* ignore */ }

      // 1. Участь у конкурсі (доступно будь-якому гравцю)
      if (action === 'join') {
        const contestId = parts[2];
        const joinRes = await handleContestJoin(TOKEN, contestId, cq.from);
        try {
          await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callback_query_id: cq.id,
              text: joinRes.msg,
              show_alert: joinRes.alert || false,
            }),
          });
        } catch { /* ignore */ }

        if (joinRes.updatedCount !== undefined && cqMsgId) {
          try {
            await sendTg(TOKEN, 'editMessageReplyMarkup', {
              chat_id: cqChat,
              message_id: cqMsgId,
              reply_markup: {
                inline_keyboard: [
                  [{ text: `🎉 Взяти участь (${joinRes.updatedCount})`, callback_data: `concurs:join:${contestId}` }],
                  [{ text: '🫓 Відкрити Фокача Клікер', web_app: { url: WEBAPP_URL } }],
                ],
              },
            });
          } catch { /* ignore */ }
        }
        return res.status(200).json({ ok: true });
      }

      // Решта дій — ТІЛЬКИ ДЛЯ АДМІНА
      if (!isAdmin(cq.from.id)) {
        return res.status(200).json({ ok: true });
      }

      const draft = await getContestDraft(cqChat);

      if (action === 'none') {
        return res.status(200).json({ ok: true });
      }

      if (action === 'close') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        return res.status(200).json({ ok: true });
      }

      // Перехід у підменю (видаляємо старе повідомлення, відправляємо нове)
      if (action === 'menu') {
        const sub = parts[2];
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);

        let menuData;
        if (sub === 'prize') menuData = renderPrizeMenu(draft);
        else if (sub === 'winners') menuData = renderWinnersMenu(draft);
        else if (sub === 'duration') menuData = renderDurationMenu(draft);
        else if (sub === 'schedule') menuData = renderScheduleMenu(draft);
        else menuData = renderBuilderMessage(draft);

        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menuData });
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_cur') {
        const cur = parts[2];
        draft.cur = cur;
        if (cur === 'foc' && draft.amount < 100000) draft.amount = 10000000;
        if (cur === 'gem' && draft.amount > 10000) draft.amount = 100;
        if (cur === 'rebirth' && draft.amount > 50) draft.amount = 5;
        await setContestDraft(cqChat, draft);

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderPrizeMenu(draft) });
        return res.status(200).json({ ok: true });
      }

      // Вибір готової суми: видаляємо меню з сумами, відправляємо головний білдер
      if (action === 'set_amount') {
        const amt = parseInt(parts[2], 10);
        if (amt && amt > 0) draft.amount = amt;
        await setContestDraft(cqChat, draft);

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderBuilderMessage(draft) });
        return res.status(200).json({ ok: true });
      }

      // Кастомна сума: видаляємо меню, запитуємо число
      if (action === 'custom_amount') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const promptSent = await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: `✍️ *Введіть суму виграшу числами* (наприклад: 50000000):\n\nПоточна валюта: *${draft.cur === 'gem' ? 'Алмази 💎' : draft.cur === 'rebirth' ? 'Ребіртхи 🔄' : 'Фокачі 🫓'}*`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Назад до білдера', callback_data: 'concurs:back' }]],
          },
        });
        const promptMsgId = promptSent?.result?.message_id || '1';
        await redis('SET', `concurs_await_amount:${cqChat}`, String(promptMsgId), 'EX', 300);
        return res.status(200).json({ ok: true });
      }

      // Кількість переможців: вибір числа або дельта
      if (action === 'set_winners') {
        const w = parseInt(parts[2], 10);
        if (w && w > 0) draft.winners = w;
        await setContestDraft(cqChat, draft);

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderBuilderMessage(draft) });
        return res.status(200).json({ ok: true });
      }

      if (action === 'delta_winners') {
        const delta = parseInt(parts[2], 10);
        const next = Math.max(1, Math.min(100, (draft.winners || 3) + delta));
        draft.winners = next;
        await setContestDraft(cqChat, draft);

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderWinnersMenu(draft) });
        return res.status(200).json({ ok: true });
      }

      // Тривалість конкурсу
      if (action === 'set_duration') {
        const dur = parseFloat(parts[2]);
        if (dur && dur > 0) draft.durationHours = dur;
        await setContestDraft(cqChat, draft);

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderBuilderMessage(draft) });
        return res.status(200).json({ ok: true });
      }

      // Час старту конкурсу
      if (action === 'set_sched') {
        const type = parts[2];
        if (type === 'now') {
          draft.scheduledStartTime = null;
        } else if (type === 'tomorrow_15') {
          draft.scheduledStartTime = computeKyivScheduledTime(15, 0, 1);
        } else if (type === 'tomorrow_12') {
          draft.scheduledStartTime = computeKyivScheduledTime(12, 0, 1);
        } else if (type === 'tomorrow_18') {
          draft.scheduledStartTime = computeKyivScheduledTime(18, 0, 1);
        } else if (type === 'tomorrow_21') {
          draft.scheduledStartTime = computeKyivScheduledTime(21, 0, 1);
        } else if (type === 'plus_1') {
          draft.scheduledStartTime = Date.now() + 1 * 3600 * 1000;
        } else if (type === 'plus_3') {
          draft.scheduledStartTime = Date.now() + 3 * 3600 * 1000;
        } else if (type === 'plus_6') {
          draft.scheduledStartTime = Date.now() + 6 * 3600 * 1000;
        } else if (type === 'plus_12') {
          draft.scheduledStartTime = Date.now() + 12 * 3600 * 1000;
        }
        await setContestDraft(cqChat, draft);

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderBuilderMessage(draft) });
        return res.status(200).json({ ok: true });
      }

      if (action === 'custom_schedule') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const promptSent = await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text:
            `✍️ *Введіть бажаний час старту конкурсу:*\n\n` +
            `Приклади:\n` +
            `• \`15:00\` (або \`завтра 15:00\`)\n` +
            `• \`19:30\`\n` +
            `• \`+4\` (через 4 години)\n\n` +
            `🇺🇦 Розрахунок за Київським часом (${formatKyivDate(Date.now())})`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Назад до білдера', callback_data: 'concurs:back' }]],
          },
        });
        const promptMsgId = promptSent?.result?.message_id || '1';
        await redis('SET', `concurs_await_sched:${cqChat}`, String(promptMsgId), 'EX', 300);
        return res.status(200).json({ ok: true });
      }

      // Кнопка назад: видаляємо поточне підменю, відправляємо білдер
      if (action === 'back') {
        await redis('DEL', `concurs_await_amount:${cqChat}`);
        await redis('DEL', `concurs_await_sched:${cqChat}`);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderBuilderMessage(draft) });
        return res.status(200).json({ ok: true });
      }

      // Публікація конкурсу
      if (action === 'publish') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await publishContest(TOKEN, cqChat, draft);
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    // ===== 👑 АДМІНКА: callback-кнопки =====
    if (cq && typeof cq.data === 'string' && cq.data.startsWith('admin:')) {
      const cqChat = cq.message?.chat?.id ?? cq.from.id;
      const cqMsgId = cq.message?.message_id;
      const parts = cq.data.split(':');
      const action = parts[1];
      const targetId = parts[2];

      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      } catch { /* ignore */ }

      if (!isAdmin(cq.from.id)) {
        return res.status(200).json({ ok: true });
      }

      // ===== 🏦 ПІДТВЕРДЖЕННЯ / ВІДХИЛЕННЯ ОПЛАТИ НА БАНКУ =====
      if (action === 'order_ok' || action === 'order_no') {
        const orderId = targetId;
        const oRaw = await redis('GET', `order:${orderId}`);
        if (!oRaw?.result) {
          await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id, text: '⚠️ Замовлення не знайдено або застаріло', show_alert: true }),
          });
          return res.status(200).json({ ok: true });
        }

        let order = {};
        try { order = JSON.parse(oRaw.result); } catch {}

        if (order.status !== 'pending') {
          await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id, text: `⚠️ Це замовлення вже ${order.status === 'completed' ? 'підтверджено' : 'відхилено'}!`, show_alert: true }),
          });
          return res.status(200).json({ ok: true });
        }

        if (action === 'order_ok') {
          order.status = 'completed';
          order.completedAt = Date.now();
          await redis('SET', `order:${orderId}`, JSON.stringify(order), 'EX', 172800);

          // Credit diamonds
          if (order.diamonds > 0) {
            const existing = await redis('GET', `reward_gem:${order.userId}`);
            const prevGems = existing?.result ? parseInt(existing.result, 10) : 0;
            await redis('SET', `reward_gem:${order.userId}`, String(prevGems + order.diamonds));
            await redis('SET', `reward_gem_source:${order.userId}`, 'donate_jar');
          }

          // Starter pack weapon
          if (order.isStarter) {
            await redis('HSET', `user_extra:${order.userId}`, 'vip_upgrade', 'vip_hammer');
          }

          // Patron badge
          if (order.isTip) {
            await redis('HSET', `user_extra:${order.userId}`, 'badge_patron', '1');
          }

          // Stats
          await redis('HINCRBY', 'donations_total_uah', String(order.userId), String(order.amountUah || 0));
          await redis('HINCRBY', 'donations_count', String(order.userId), '1');
          await redis('INCRBY', 'global_donations_uah', String(order.amountUah || 0));

          // Edit admin message
          const nowKyiv = new Date().toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
          const userDisplay = order.username ? `@${order.username}` : `(без @username)`;
          const editedAdminText =
`✅ <b>ЗАМОВЛЕННЯ #${order.id} ПІДТВЕРДЖЕНО!</b>

👤 Гравець: ${userDisplay} (ID: <code>${order.userId}</code>)
📦 Товар: <b>${order.title}</b>
💵 Оплачено: <b>${order.amountUah} ₴</b>
💎 Нараховано: <b>+${order.diamonds} 💎</b>${order.isStarter ? ' + Бойова скалка 🪵' : ''}${order.isTip ? ' + титул Меценат 💖' : ''}
⏱ Підтверджено о: ${nowKyiv}`;

          if (cqMsgId) {
            await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: cqChat,
                message_id: cqMsgId,
                text: editedAdminText,
                parse_mode: 'HTML',
              }),
            }).catch(() => null);
          }

          // Notify player
          try {
            const playerText =
`🎉 <b>Вашу оплату замовлення #${order.id} підтверджено!</b>

Дякуємо за підтримку розробника! 💖
💎 Вам нараховано: <b>+${order.diamonds} 💎</b>${order.isStarter ? '\n🪵 Отримано зброю «Бойова скалка» проти босів!' : ''}${order.isTip ? '\n💖 Присвоєно особливий титул «Меценат» у профілі!' : ''}

Відкрийте гру, щоб отримати нагороду!`;

            await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: Number(order.userId),
                text: playerText,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[{ text: '🫓 Відкрити Фокача Клікер', web_app: { url: WEBAPP_URL } }]],
                },
              }),
            });
          } catch (e) {
            console.error('Notify player error:', e);
          }

          await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id, text: `✅ Замовлення #${order.id} успішно підтверджено! +${order.diamonds} 💎` }),
          });

          return res.status(200).json({ ok: true });
        }

        if (action === 'order_no') {
          order.status = 'rejected';
          order.rejectedAt = Date.now();
          await redis('SET', `order:${orderId}`, JSON.stringify(order), 'EX', 172800);

          const editedAdminText =
`❌ <b>ЗАМОВЛЕННЯ #${order.id} ВІДХИЛЕНО</b>

👤 Гравець: ${order.username ? '@' + order.username : order.userId} (ID: <code>${order.userId}</code>)
📦 Товар: <b>${order.title}</b>
💵 Сума: <b>${order.amountUah} ₴</b>
<i>Нагороду не нараховано.</i>`;

          if (cqMsgId) {
            await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: cqChat,
                message_id: cqMsgId,
                text: editedAdminText,
                parse_mode: 'HTML',
              }),
            }).catch(() => null);
          }

          try {
            await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: Number(order.userId),
                text: `⚠️ <b>Замовлення #${order.id} відхилено</b>\n\nКошти не надійшли на Банку або не було вказано коментар із номером замовлення.\nЯкщо ви оплатили, зв'яжіться з автором гри через підтримку!`,
                parse_mode: 'HTML',
              }),
            });
          } catch (e) {}

          await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id, text: `❌ Замовлення #${order.id} відхилено.` }),
          });

          return res.status(200).json({ ok: true });
        }
      }

      // Закрити панель — просто видалити повідомлення
      if (action === 'close') {
        await redis('DEL', `admin_await:${cqChat}`);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        return res.status(200).json({ ok: true });
      }

      // Повернутися до головного меню адмінки
      if (action === 'back') {
        await redis('DEL', `admin_await:${cqChat}`);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const panel = await getAdminPanelMessage();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...panel });
        return res.status(200).json({ ok: true });
      }

      // Розділи головного меню (видаляємо попереднє повідомлення, шлемо вибране меню)
      if (action === 'menu') {
        const sub = parts[2];
        await redis('DEL', `admin_await:${cqChat}`);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);

        let menuData;
        if (sub === 'give') menuData = renderGiveMenu();
        else if (sub === 'giveall') menuData = renderGiveAllMenu();
        else if (sub === 'diamonds') menuData = renderDiamondsMenu();
        else if (sub === 'diamondall') menuData = renderDiamondAllMenu();
        else if (sub === 'rebirth') menuData = renderRebirthMenu();
        else if (sub === 'anticheat') menuData = await renderAnticheatMenu();
        else if (sub === 'contests') menuData = await renderContestsAdminMenu();
        else if (sub === 'reset') menuData = renderResetMenu();
        else if (sub === 'lb_clear') menuData = renderLbClearConfirm();
        else if (sub === 'takeskins') menuData = renderTakeSkinsMenu();
        else if (sub === 'rofl') menuData = await renderRoflMenu();
        else menuData = await getAdminPanelMessage();

        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menuData });
        return res.status(200).json({ ok: true });
      }

      // Перемикання режиму технічної перерви
      if (action === 'toggle_maintenance') {
        const mRes = await redis('GET', 'maintenance_mode');
        const currentM = mRes?.result === '1';
        const newM = !currentM;
        await redis('SET', 'maintenance_mode', newM ? '1' : '0');
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const panel = await getAdminPanelMessage();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...panel });
        return res.status(200).json({ ok: true });
      }

      // Забрати скіни у ВСІХ гравців
      if (action === 'takeskins_all') {
        const resetTime = Date.now();
        await redis('SET', 'global_skins_reset_time', String(resetTime));
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: `🧹 *Скидання скінів активовано для ВСІХ гравців!*\n\nУ всіх гравців при вході/синхронізації залишиться лише стандартна класична фокача.`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👑 До адмін-панелі', callback_data: 'admin:back' }],
              [{ text: '🫓 Відкрити гру', web_app: { url: WEBAPP_URL } }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Забрати скіни у конкретного гравця по ID з картки
      if (action === 'takeskins_target') {
        const targetId = parts[2];
        const resetTime = Date.now();
        await redis('SET', `reset_skins:${targetId}`, String(resetTime));
        const targetUser = await resolveTargetUser(targetId);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: `🧹 *Скіни забрано у ${targetUser?.display || targetId}!*\n\nВсі скіни очищено до базової класичної фокачі.`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👤 Профіль гравця', callback_data: `admin:check_id:${targetId}` }],
              [{ text: '👑 Адмінка', callback_data: 'admin:back' }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Список юзерів
      if (action === 'users') {
        await redis('DEL', `admin_await:${cqChat}`);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const usersView = await renderUsersList();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...usersView });
        return res.status(200).json({ ok: true });
      }

      // Оновлення юзернеймів через TG API
      if (action === 'update_users') {
        await redis('DEL', `admin_await:${cqChat}`);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const report = await executeUpdateUsers(TOKEN, '');
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: report,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👥 До списку гравців', callback_data: 'admin:users' }],
              [{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Роздача фокач ВСІМ (готові пресети)
      if (action === 'giveall_exec') {
        const amt = parseInt(parts[2], 10);
        if (amt && amt > 0) {
          if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
          await executeGiveAll(TOKEN, cqChat, amt);
        }
        return res.status(200).json({ ok: true });
      }

      // Роздача алмазів ВСІМ (готові пресети)
      if (action === 'diamondall_exec') {
        const amt = parseInt(parts[2], 10);
        if (amt && amt > 0) {
          if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
          await executeDiamondAll(TOKEN, cqChat, amt);
        }
        return res.status(200).json({ ok: true });
      }

      // Видача фокач собі (готові пресети)
      if (action === 'give_self') {
        const amt = parseInt(parts[2], 10);
        if (amt && amt > 0) {
          const ex = await redis('GET', `reward:${cqChat}`);
          const curR = ex?.result ? parseInt(ex.result) : 0;
          await redis('SET', `reward:${cqChat}`, String(curR + amt));
          await redis('DEL', `deduct:${cqChat}`);
          if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: cqChat,
            text: `✅ Видано *${amt.toLocaleString()}* фокач! Зайдіть у гру, щоб забрати.`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🫓 Відкрити гру', web_app: { url: WEBAPP_URL } }],
                [{ text: '🎁 Видати ще', callback_data: 'admin:menu:give' }],
                [{ text: '⬅️ Головне меню', callback_data: 'admin:back' }],
              ],
            },
          });
        }
        return res.status(200).json({ ok: true });
      }

      // Видача ребіртхів собі (готові пресети)
      if (action === 'rebirth_self') {
        const amt = parseInt(parts[2], 10);
        if (amt && amt > 0) {
          const ex = await redis('GET', `rebirth:${cqChat}`);
          const curR = ex?.result ? parseInt(ex.result) : 0;
          await redis('SET', `rebirth:${cqChat}`, String(curR + amt));
          if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: cqChat,
            text: `✅ Видано *+${amt}* ребіртх(ів)! Зайдіть у гру, щоб отримати.`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🫓 Відкрити гру', web_app: { url: WEBAPP_URL } }],
                [{ text: '🔄 Видати ще', callback_data: 'admin:menu:rebirth' }],
                [{ text: '⬅️ Головне меню', callback_data: 'admin:back' }],
              ],
            },
          });
        }
        return res.status(200).json({ ok: true });
      }

      // Видача алмазів собі (готові пресети)
      if (action === 'diamond_self') {
        const amt = parseInt(parts[2], 10);
        if (amt && amt > 0) {
          const ex = await redis('GET', `reward_gem:${cqChat}`);
          const curR = ex?.result ? parseInt(ex.result) : 0;
          await redis('SET', `reward_gem:${cqChat}`, String(curR + amt));
          await redis('SET', `reward_gem_source:${cqChat}`, 'admin');
          if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: cqChat,
            text: `✅ Видано *+${amt}* 💎 алмазів! Зайдіть у гру, щоб отримати.`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🫓 Відкрити гру', web_app: { url: WEBAPP_URL } }],
                [{ text: '💎 Видати ще', callback_data: 'admin:menu:diamonds' }],
                [{ text: '⬅️ Головне меню', callback_data: 'admin:back' }],
              ],
            },
          });
        }
        return res.status(200).json({ ok: true });
      }

      // Запит текстового введення від адміна (prompts)
      if (action === 'prompt') {
        const promptType = parts[2];
        const arg1 = parts[3];
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);

        let promptText = '';
        let targetUser = null;
        if (arg1) {
          targetUser = await resolveTargetUser(arg1);
        }

        if (promptType === 'give_self') {
          promptText = '✍️ *Введіть суму фокач для видачі собі:*\n(Можна вказувати `10m`, `500k`, `1b`, `50 000 000`)';
        } else if (promptType === 'diamond_self') {
          promptText = '✍️ *Введіть кількість алмазів для видачі собі:*\n(Наприклад: `25`, `100`, `1000`)';
        } else if (promptType === 'giveall') {
          promptText = '✍️ *Роздача фокач ВСІМ зареєстрованим гравцям:*\nВведіть суму, яку отримає кожен (наприклад: `10m`, `50m`, `100 000 000`):';
        } else if (promptType === 'diamondall') {
          promptText = '✍️ *Роздача алмазів ВСІМ зареєстрованим гравцям:*\nВведіть кількість 💎, яку отримає кожен (наприклад: `25`, `50`, `100`, `500`):';
        } else if (promptType === 'rebirth_self') {
          promptText = '✍️ *Введіть кількість ребіртхів для видачі собі:*\n(Наприклад: `5`, `10`, `25`)';
        } else if (promptType === 'giveto') {
          promptText = '✍️ *Видача фокач іншому гравцю*\nВведіть у форматі: `@username сума` або `ID сума`\nПриклад: `@durov 50m` або `1975429762 100000000`';
        } else if (promptType === 'diamondto') {
          promptText = '✍️ *Видача алмазів іншому гравцю*\nВведіть у форматі: `@username кількість` або `ID кількість`\nПриклад: `@durov 50` або `1975429762 100`';
        } else if (promptType === 'rebirthto') {
          promptText = '✍️ *Видача ребіртхів іншому гравцю*\nВведіть у форматі: `@username кількість` або `ID кількість`\nПриклад: `@durov 10` або `1975429762 5`';
        } else if (promptType === 'giveto_target') {
          promptText = `✍️ *Видача фокач для ${targetUser?.display || arg1}:*\nВведіть кількість (наприклад: \`50m\`, \`100000000\`)`;
        } else if (promptType === 'diamondto_target') {
          promptText = `✍️ *Видача алмазів для ${targetUser?.display || arg1}:*\nВведіть кількість (наприклад: \`50\`, \`250\`)`;
        } else if (promptType === 'rebirthto_target') {
          promptText = `✍️ *Видача ребіртхів для ${targetUser?.display || arg1}:*\nВведіть кількість (наприклад: \`5\`, \`20\`)`;
        } else if (promptType === 'take_target') {
          promptText = `✍️ *Списання фокач для ${targetUser?.display || arg1}:*\nВведіть кількість (наприклад: \`10000000\`)`;
        } else if (promptType === 'take') {
          promptText = '✍️ *Списання фокач у гравця*\nВведіть у форматі: `@username сума` або `ID сума`\nПриклад: `@durov 50000000`';
        } else if (promptType === 'check') {
          promptText = '✍️ *Введіть @username або числовий ID гравця для перегляду картки:*';
        } else if (promptType === 'broadcast') {
          promptText = '✍️ *Введіть текст розсилки всім зареєстрованим гравцям:*\n(Підтримується розмітка Markdown)';
        } else if (promptType === 'aclog') {
          promptText = '✍️ *Дебаг-лог античиту*\nВведіть @username або ID гравця для отримання TXT файлу:';
        } else if (promptType === 'warn') {
          promptText = '✍️ *Видача попередження ⚠️*\nВведіть @username або ID гравця:';
        } else if (promptType === 'unflag') {
          promptText = '✍️ *Зняття варну та очищення підозр*\nВведіть @username або ID гравця:';
        } else if (promptType === 'reset_one') {
          promptText = '✍️ *Скидання акаунту гравця*\nВведіть @username або ID гравця, якого потрібно скинути:';
        } else if (promptType === 'contest_id') {
          promptText = '✍️ *Перегляд учасників конкурсу*\nВведіть ID конкурсу (наприклад: `c_1712345678901`):';
        } else if (promptType === 'takeskins') {
          promptText = '✍️ *Забрати скіни у гравця*\nВведіть `@username`, числовий `ID` або слово `all` для скидання скінів усім:';
        } else if (promptType === 'rofl_target') {
          promptText = '✍️ *Введіть @username або числовий ID гравця, якому хочете увімкнути звук:*';
        }

        const pSent = await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: promptText || '✍️ Введіть дані:',
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
          },
        });
        const promptMsgId = pSent?.result?.message_id || '1';
        await redis('SET', `admin_await:${cqChat}`, JSON.stringify({
          action: promptType,
          targetId: arg1 || null,
          promptMsgId,
        }), 'EX', 300);
        return res.status(200).json({ ok: true });
      }

      // Картка гравця
      if (action === 'check_user') {
        const target = await resolveTargetUser(targetId);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        if (!target) {
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: cqChat,
            text: `❌ Гравця \`${targetId}\` не знайдено.`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '⬅️ Назад до списку', callback_data: 'admin:users' }]],
            },
          });
          return res.status(200).json({ ok: true });
        }
        const card = await renderUserCard(target);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...card });
        return res.status(200).json({ ok: true });
      }

      // Зняти / видати варн з картки
      if (action === 'user_toggle_warn') {
        const targetChatId = targetId;
        const totalRaw = await redis('HGET', 'ac_total', targetChatId);
        const totalDetects = totalRaw?.result ? (parseInt(totalRaw.result) || 0) : 0;
        const kRaw = await redis('HGET', 'ac_karma', targetChatId);
        let karma = 100;
        if (kRaw?.result) { try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch {} }
        const isFlagged = totalDetects > 0 || karma < 75;

        if (isFlagged) {
          await redis('HSET', 'ac_karma', targetChatId, JSON.stringify({ k: 100, on: 0, ts: Date.now() }));
          await redis('HDEL', 'ac_active', targetChatId);
          await redis('HDEL', 'ac_total', targetChatId);
          await redis('HDEL', 'ac_strikes', targetChatId);
          await redis('HDEL', 'ac_debug_log', targetChatId);
          await redis('SREM', 'flagged_users', targetChatId);
        } else {
          karma = Math.max(0, karma - 15);
          await redis('HSET', 'ac_karma', targetChatId, JSON.stringify({ k: karma, on: 0, ts: Date.now() }));
          await redis('HINCRBY', 'ac_total', targetChatId, '1');
          await redis('SADD', 'flagged_users', targetChatId);
          if (karma < 50) await redis('HSET', 'ac_active', targetChatId, '1');

          let wStrikes = [];
          const wsRaw = await redis('HGET', 'ac_strikes', targetChatId);
          if (wsRaw?.result) { try { wStrikes = JSON.parse(wsRaw.result); } catch {} }
          wStrikes.push(Date.now());
          if (wStrikes.length > 50) wStrikes = wStrikes.slice(-50);
          await redis('HSET', 'ac_strikes', targetChatId, JSON.stringify(wStrikes));

          let wLogs = [];
          const wlRaw = await redis('HGET', 'ac_debug_log', targetChatId);
          if (wlRaw?.result) { try { wLogs = JSON.parse(wlRaw.result); } catch {} }
          wLogs.push({
            type: 'admin_warn',
            reason: 'Ручне попередження (перемикання мітки) від адміністратора',
            karmaAfter: karma,
            ts: Date.now(),
          });
          if (wLogs.length > 50) wLogs = wLogs.slice(-50);
          await redis('HSET', 'ac_debug_log', targetChatId, JSON.stringify(wLogs));
        }

        const target = await resolveTargetUser(targetId);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        if (target) {
          const card = await renderUserCard(target);
          await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...card });
        }
        return res.status(200).json({ ok: true });
      }

      // Дебаг-лог TXT файл
      if (action === 'user_aclog') {
        const target = await resolveTargetUser(targetId);
        if (target) {
          await sendAcLogDocument(TOKEN, cqChat, target);
        }
        return res.status(200).json({ ok: true });
      }

      // Очистити очікувані нагороди
      if (action === 'user_clearreward') {
        await redis('DEL', `reward:${targetId}`);
        await redis('DEL', `rebirth:${targetId}`);
        await redis('DEL', `reward_gem:${targetId}`);
        await redis('DEL', `reward_gem_source:${targetId}`);
        await redis('DEL', `deduct:${targetId}`);
        const target = await resolveTargetUser(targetId);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        if (target) {
          const card = await renderUserCard(target);
          await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...card });
        }
        return res.status(200).json({ ok: true });
      }

      // Скидання одного акаунту
      if (action === 'user_reset_confirm') {
        const target = await resolveTargetUser(targetId);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: `⚠️ *ПІДТВЕРДЖЕННЯ СКИДАННЯ АКАУНТУ*\n\nВи дійсно хочете скинути весь прогрес для ${target?.display || targetId}?`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑 Так, скинути!', callback_data: `admin:user_reset_exec:${targetId}` }],
              [{ text: '⬅️ Скасувати', callback_data: `admin:check_user:${targetId}` }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      if (action === 'user_reset_exec') {
        await redis('HDEL', 'leaderboard', targetId);
        await redis('DEL', `save:${targetId}`);
        await redis('DEL', `reward:${targetId}`);
        await redis('DEL', `rebirth:${targetId}`);
        await redis('DEL', `reward_gem:${targetId}`);
        await redis('DEL', `reward_gem_source:${targetId}`);
        await redis('DEL', `deduct:${targetId}`);
        await redis('HDEL', 'ac_karma', targetId);
        await redis('HDEL', 'ac_active', targetId);
        await redis('HDEL', 'ac_total', targetId);
        await redis('HDEL', 'ac_strikes', targetId);
        await redis('HDEL', 'ac_debug_log', targetId);
        await redis('SREM', 'flagged_users', targetId);
        await redis('SET', `reset_request:${targetId}`, '1');
        await redis('SET', `reset:${targetId}`, '1');

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: `✅ Акаунт \`${targetId}\` повністю скинуто! При наступному вході гра почнеться з нуля.`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Звіт античиту
      if (action === 'reports_view') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const rep = await renderReportsView();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...rep });
        return res.status(200).json({ ok: true });
      }

      // Очищення лідерборду
      if (action === 'lb_clear_confirm') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderLbClearConfirm() });
        return res.status(200).json({ ok: true });
      }

      if (action === 'lb_clear_exec') {
        await redis('DEL', 'leaderboard');
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: '🏆 Лідерборд успішно очищено!',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Скидання ВСІХ акаунтів
      if (action === 'reset_all_confirm') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderResetAllConfirm() });
        return res.status(200).json({ ok: true });
      }

      if (action === 'reset_all_exec') {
        await redis('DEL', 'leaderboard');
        await redis('DEL', 'ac_karma');
        await redis('DEL', 'ac_active');
        await redis('DEL', 'ac_total');
        await redis('DEL', 'ac_strikes');
        await redis('DEL', 'ac_debug_log');
        await redis('DEL', 'flagged_users');
        await redis('SET', 'reset_all_request', '1');
        await redis('SET', 'global_reset_time', String(Date.now()));

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: '💣 *ВСІ АКАУНТИ СКИНУТО!*\nЛідерборд і дані античиту також очищено.',
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Назад до адмінки', callback_data: 'admin:back' }]],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Відкрити білдер конкурсу з адмінки
      if (action === 'open_concurs') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const draft = await getContestDraft(cqChat);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...renderBuilderMessage(draft) });
        return res.status(200).json({ ok: true });
      }

      // Достроковий запуск запланованого конкурсу
      if (action === 'concurs_start') {
        const contestId = targetId;
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await launchScheduledContest(TOKEN, contestId);
        const menu = await renderContestsAdminMenu();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menu });
        return res.status(200).json({ ok: true });
      }

      // Дострокове завершення конкурсу
      if (action === 'concurs_finish') {
        const contestId = targetId;
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await finishContest(TOKEN, contestId, true);
        const menu = await renderContestsAdminMenu();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menu });
        return res.status(200).json({ ok: true });
      }

      // Скасування конкурсу
      if (action === 'concurs_cancel') {
        const contestId = targetId;
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const cRaw = await redis('HGET', 'contest:' + contestId, 'data');
        if (cRaw?.result) {
          let cObj = {};
          try { cObj = JSON.parse(cRaw.result); } catch {}
          cObj.status = 'cancelled';
          cObj.cancelledAt = Date.now();
          await redis('HSET', 'contest:' + contestId, 'data', JSON.stringify(cObj));
          await redis('SREM', 'active_contests', contestId);
          await redis('SREM', 'scheduled_contests', contestId);
        }
        const menu = await renderContestsAdminMenu();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menu });
        return res.status(200).json({ ok: true });
      }

      // Перегляд списку учасників конкурсу
      if (action === 'contest_users' || action === 'concurs_parts') {
        const contestId = targetId;
        const page = parseInt(parts[3] || '0', 10);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const view = await renderContestParticipants(contestId, page);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...view });
        return res.status(200).json({ ok: true });
      }

      // Скачування списку учасників у TXT
      if (action === 'contest_txt') {
        const contestId = targetId;
        await sendContestParticipantsFile(TOKEN, cqChat, contestId);
        return res.status(200).json({ ok: true });
      }

      // Пагінація завершених конкурсів в адмінці
      if (action === 'concurs_page') {
        const page = parseInt(targetId || '0', 10);
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const menu = await renderContestsAdminMenu(page);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menu });
        return res.status(200).json({ ok: true });
      }

      // Меню звукового тролінгу конкретного гравця
      if (action === 'user_sounds_menu') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const menu = await renderUserSoundsMenu(targetId);
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menu });
        return res.status(200).json({ ok: true });
      }

      // Меню звукового тролінгу всіх онлайн
      if (action === 'all_sounds_menu') {
        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        const menu = await renderAllSoundsMenu();
        await sendTg(TOKEN, 'sendMessage', { chat_id: cqChat, ...menu });
        return res.status(200).json({ ok: true });
      }

      // Відправка звуку конкретному гравцю
      if (action === 'send_sound') {
        const tId = targetId;
        const soundKey = parts[3];
        await redis('SET', `rofl_sound:${tId}`, soundKey, 'EX', 180);
        const target = await resolveTargetUser(tId);
        const isOnlineRaw = await redis('GET', `user_online:${tId}`);
        const isOnline = isOnlineRaw?.result === '1';
        const sName = ROFL_SOUND_NAMES[soundKey] || soundKey;
        const msg =
          `🔊 *ЗВУК ВІДПРАВЛЕНО!* 😂\n\n` +
          `👤 Гравець: *${target?.display || tId}*\n` +
          `🎵 Звук: *${sName}*\n` +
          `📡 Статус: *${isOnline ? '🟢 Зараз у грі — увімкнеться за 1-3 секунди!' : '⚪ Зараз офлайн — увімкнеться при запуску гри'}*\n\n` +
          `Телефон жертви також завібрує від несподіванки 📳`;

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: msg,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Увімкнути ще звук', callback_data: `admin:user_sounds_menu:${tId}` }],
              [{ text: '👤 До картки гравця', callback_data: `admin:check_user:${tId}` }],
              [{ text: '⬅️ Головне меню', callback_data: 'admin:back' }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Відправка звуку всім онлайн гравцям
      if (action === 'send_sound_all') {
        const soundKey = targetId;
        await redis('SET', 'rofl_sound_all', soundKey, 'EX', 45);
        const sName = ROFL_SOUND_NAMES[soundKey] || soundKey;
        const msg =
          `📢 *МАСОВИЙ ЗВУК АКТИВОВАНО!* 🔊💥\n\n` +
          `🎵 Звук: *${sName}*\n\n` +
          `🌐 Всі гравці, які зараз у грі або зайдуть протягом 45 секунд, почують цей звук на повну гучність прямо під час тапання! 😂`;

        if (cqMsgId) await deleteTg(TOKEN, cqChat, cqMsgId);
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: cqChat,
          text: msg,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Інший звук усім', callback_data: 'admin:all_sounds_menu' }],
              [{ text: '🎭 До рофл-меню', callback_data: 'admin:menu:rofl' }],
              [{ text: '⬅️ Головне меню', callback_data: 'admin:back' }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const name = msg.from?.first_name || 'друже';
    const username = msg.from?.username;
    const text = msg.text.trim();

    // Save user info for reminders + admin
    const userData = JSON.stringify({
      name,
      username: username || '',
      lastActive: Date.now(),
      reminded: false,
    });
    await redis('HSET', 'users', String(chatId), userData);

    // Save username → chatId mapping
    if (username) {
      await redis('HSET', 'usernames', username.toLowerCase(), String(chatId));
    }

    // ⚔️ ожидание ввода юзернейма для дуэли
    const duelAwait = await redis('GET', `duel_await:${chatId}`);
    if (duelAwait?.result === 'duel') {
      await redis('DEL', `duel_await:${chatId}`);
      if (msg.message_id) {
        scheduleMessageDeletion(chatId, msg.message_id, DUEL_MSG_CLEANUP_TTL).catch(() => {});
      }
      if (text.startsWith('/')) {
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(chatId), text: 'Ввід відмінено.' });
        return res.status(200).json({ ok: true });
      }
      const target = await resolveTargetUser(text);
      if (!target) {
        await redis('SET', `duel_await:${chatId}`, 'duel', 'EX', 300);
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(chatId), text: `❌ Гравця ${text} не знайдено (вкажи @username або числовий ID). Спробуй ще раз:` });
        return res.status(200).json({ ok: true });
      }
      const targetId = target.id;
      if (String(targetId) === String(chatId)) {
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(chatId), text: '❌ Не можна викликати самого себе' });
        return res.status(200).json({ ok: true });
      }
      await sendDuelTg(TOKEN, 'sendMessage', {
        chat_id: Number(chatId),
        text: `💰 На що граємо проти ${target.shortDisplay}? Ставку списує в обох при старті — переможець забирає банк!`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🫓 Фокачі', callback_data: `duel:cur:${targetId}:foc` },
              { text: '💎 Алмази', callback_data: `duel:cur:${targetId}:gem` },
            ],
            [{ text: '❌ Відміна', callback_data: 'duel:cancel' }],
          ],
        },
      });
      return res.status(200).json({ ok: true });
    }

    // 🤝 очікування вводу юзернейма для трейду
    const tradeAwait = await redis('GET', `trade_await:${chatId}`);
    if (tradeAwait?.result === 'trade') {
      await redis('DEL', `trade_await:${chatId}`);
      if (msg.message_id) {
        scheduleMessageDeletion(chatId, msg.message_id, DUEL_MSG_CLEANUP_TTL).catch(() => {});
      }
      if (text.startsWith('/')) {
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(chatId), text: 'Ввід відмінено.' });
        return res.status(200).json({ ok: true });
      }
      const target = await resolveTargetUser(text);
      if (!target) {
        await redis('SET', `trade_await:${chatId}`, 'trade', 'EX', 300);
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(chatId), text: `❌ Гравця ${text} не знайдено (вкажи @username або числовий ID). Спробуй ще раз:` });
        return res.status(200).json({ ok: true });
      }
      const targetId = target.id;
      if (String(targetId) === String(chatId)) {
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(chatId), text: '❌ Не можна трейдитися із самим собою' });
        return res.status(200).json({ ok: true });
      }

      // Створюємо трейд
      const host = req.headers.host || 'focaccia-bot.vercel.app';
      const myName = (msg.from?.first_name || 'Гравець').slice(0, 24);
      const myU = (msg.from?.username || '').slice(0, 32);

      const tradeRes = await fetch(`https://${host}/api/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', from: chatId, to: targetId, fromName: myName, fromU: myU }),
      });
      const tData = await tradeRes.json();
      if (tData?.ok) {
        const kb = {
          inline_keyboard: [
            [{ text: '🤝 Увійти в трейд', web_app: { url: tData.url } }],
          ],
        };
        await sendDuelTg(TOKEN, 'sendMessage', {
          chat_id: Number(chatId),
          text: `🤝 Запрошення до трейду надіслано ${target.shortDisplay}!\nНатисни кнопку нижче, щоб відкрити кімнату обміну:`,
          reply_markup: kb,
        });
      } else if (tData?.error === 'rebirth_locked') {
        const rem = tData.remainingMs || 0;
        const days = Math.floor(rem / (24 * 3600 * 1000));
        const hours = Math.floor((rem % (24 * 3600 * 1000)) / (3600 * 1000));
        await sendDuelTg(TOKEN, 'sendMessage', {
          chat_id: Number(chatId),
          text: `⏳ *Трейди заблоковано після ребіртху!*\n\nПісля останнього переродження має пройти 5 днів для запобігання нечесному переливу ресурсів.\nЗалишилося: *${days} дн. ${hours} год.*`,
          parse_mode: 'Markdown',
        });
      } else if (tData?.error === 'recipient_rebirth_locked') {
        await sendDuelTg(TOKEN, 'sendMessage', {
          chat_id: Number(chatId),
          text: `⏳ *Партнер не може торгувати!*\n\nГравець ${target.shortDisplay} нещодавно зробив ребіртх. Трейди для нього заблоковані на 5 днів.`,
        });
      } else {
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(chatId), text: '❌ Не вдалося створити трейд. Спробуй пізніше.' });
      }
      return res.status(200).json({ ok: true });
    }

    // 🎁 Очікування введення суми для конкурсу
    const contestAmtAwait = await redis('GET', `concurs_await_amount:${chatId}`);
    if (contestAmtAwait?.result && isAdmin(userId)) {
      await redis('DEL', `concurs_await_amount:${chatId}`);
      const promptId = Number(contestAmtAwait.result);
      if (promptId) await deleteTg(TOKEN, chatId, promptId);
      if (msg.message_id) await deleteTg(TOKEN, chatId, msg.message_id);

      const draft = await getContestDraft(chatId);
      const cleaned = text.replace(/[\s_,]/g, '');
      const num = parseInt(cleaned, 10);
      if (!isNaN(num) && num > 0) {
        draft.amount = num;
        await setContestDraft(chatId, draft);
      }
      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...renderBuilderMessage(draft) });
      return res.status(200).json({ ok: true });
    }

    // 🎁 Очікування введення власного часу для конкурсу
    const contestSchedAwait = await redis('GET', `concurs_await_sched:${chatId}`);
    if (contestSchedAwait?.result && isAdmin(userId)) {
      await redis('DEL', `concurs_await_sched:${chatId}`);
      const promptId = Number(contestSchedAwait.result);
      if (promptId) await deleteTg(TOKEN, chatId, promptId);
      if (msg.message_id) await deleteTg(TOKEN, chatId, msg.message_id);

      const draft = await getContestDraft(chatId);
      const parsedTs = parseCustomKyivTime(text);
      if (parsedTs && parsedTs > Date.now() + 60000) {
        draft.scheduledStartTime = parsedTs;
        await setContestDraft(chatId, draft);
      } else {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `⚠️ Не вдалося розпізнати час або вказаний час уже минув. Спробуйте формат \`15:00\` або \`+3\`.`,
        });
      }
      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...renderBuilderMessage(draft) });
      return res.status(200).json({ ok: true });
    }

    // 👑 Очікування введення для адмінки
    const adminAwaitRaw = await redis('GET', `admin_await:${chatId}`);
    if (adminAwaitRaw?.result && isAdmin(userId)) {
      let awaitData = null;
      try { awaitData = JSON.parse(adminAwaitRaw.result); } catch {}
      if (awaitData) {
        await redis('DEL', `admin_await:${chatId}`);
        const promptId = Number(awaitData.promptMsgId);

        if (text === '/cancel' || text === 'скасувати' || text === 'отмена') {
          if (promptId) await deleteTg(TOKEN, chatId, promptId);
          if (msg.message_id) await deleteTg(TOKEN, chatId, msg.message_id);
          const panel = await getAdminPanelMessage();
          await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...panel });
          return res.status(200).json({ ok: true });
        }

        if (text.startsWith('/')) {
          if (promptId) await deleteTg(TOKEN, chatId, promptId);
        } else {
          if (promptId) await deleteTg(TOKEN, chatId, promptId);
          if (msg.message_id) await deleteTg(TOKEN, chatId, msg.message_id);
          await handleAdminAwaitInput(TOKEN, chatId, text, awaitData);
          return res.status(200).json({ ok: true });
        }
      }
    }

    const cmd = text.toLowerCase();

    // ===== /start =====
    if (cmd.startsWith('/start') || cmd === 'start' || cmd === 'старт') {
      const parts = text.trim().split(/\s+/);
      const startParam = parts[1] || '';

      // Deep link to Trade: /start trade_tr_... or /start tr_... or /start trade
      if (startParam.startsWith('trade_') || startParam.startsWith('tr_') || startParam === 'trade' || startParam === 'trade_lobby') {
        const tradeId = (startParam === 'trade' || startParam === 'trade_lobby') ? 'lobby' : (startParam.startsWith('trade_') ? startParam.replace('trade_', '') : startParam);
        const tradeUrl = `https://nout0688-cloud.github.io/focaccia-clicker/?v=${Date.now()}&trade=${tradeId}`;
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `🤝 *Запрошення до безпечного обміну (Трейд)*\n\nТебе запросили у кімнату обміну! Обмінюйся фокачами 🫓, алмазами 💎 та рідкісними скінами.\n\nНатисни кнопку нижче, щоб відкрити кімнату:`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🤝 Увійти в трейд', web_app: { url: tradeUrl } }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      // Deep link to Duel: /start duel_... or /start d_...
      if (startParam.startsWith('duel_') || startParam.startsWith('d_') || startParam === 'duel') {
        const duelId = (startParam === 'duel' || startParam === 'duel_lobby') ? 'lobby' : startParam.replace(/^duel_/, '');
        const duelUrl = `https://nout0688-cloud.github.io/focaccia-clicker/?v=${Date.now()}&duel=${duelId}`;
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `⚔️ *Виклик на дуель 1 на 1!*\n\nТебе викликали на бій у Фокача Клікері!\nНатисни кнопку нижче, щоб прийняти виклик:`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚔️ Відкрити дуель', web_app: { url: duelUrl } }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      const welcome =
        `Привіт, ${name}! 👋\n\n` +
        `🫓 Фокача Клікер — клікай, їж, прокачуйся!\n\n` +
        `🏗️ Будуй пекарні, наймай бабусь, відкривай філії в Італії та навіть запускай космічні пекарні! 🚀\n\n` +
        `⚡ Фішки гри:\n` +
        `• Комбо-система до x100\n` +
        `• 5% шанс криту x10 💥\n` +
        `• Золота фокача з бонусами ✨\n` +
        `• Френзі x7 🔥\n` +
        `• Система престижу ♻️\n` +
        `• Дуэли с другими игроками ⚔️\n\n` +
        `Натисни кнопку нижче і почни клікати! 👇`;

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: welcome,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🫓 Грати у Фокача Клікер!', web_app: { url: WEBAPP_URL } }],
            [{ text: '⚔️ Дуель', callback_data: 'duel:menu' }],
          ],
        },
      });
      return res.status(200).json({ ok: true });
    }

    // ===== /duel — меню дуэлей =====
    if (cmd === '/duel' || cmd === 'дуель' || cmd === 'duel') {
      if (msg.message_id) {
        scheduleMessageDeletion(chatId, msg.message_id, DUEL_MSG_CLEANUP_TTL).catch(() => {});
      }
      const duelLobbyUrl = `https://nout0688-cloud.github.io/focaccia-clicker/?v=${Date.now()}&duel=lobby`;
      await sendDuelTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '⚔️ *Дуелі Фокача Клікер (Mini App)*\n\nБийся 1 на 1 у реальному часі на фокачі 🫓 або алмази 💎!\nОбирай суперника, валюту, ставку, ціль та час раунду прямо в окремому міні-аппі.',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚔️ Відкрити Дуелі (Mini App)', web_app: { url: duelLobbyUrl } }],
          ],
        },
      });
      return res.status(200).json({ ok: true });
    }

    // ===== /trade — меню трейдів =====
    if (cmd === '/trade' || cmd === 'трейд' || cmd === 'трейди' || cmd === 'trade') {
      if (msg.message_id) {
        scheduleMessageDeletion(chatId, msg.message_id, DUEL_MSG_CLEANUP_TTL).catch(() => {});
      }

      // Перевірка 5-денного кулдауну після ребіртху
      const rbtRaw = await redis('GET', `user_rebirth_time:${chatId}`);
      const rbt = rbtRaw?.result ? Number(rbtRaw.result) : 0;
      if (rbt > 0 && Date.now() - rbt < 5 * 24 * 60 * 60 * 1000) {
        const rem = 5 * 24 * 60 * 60 * 1000 - (Date.now() - rbt);
        const days = Math.floor(rem / (24 * 3600 * 1000));
        const hours = Math.floor((rem % (24 * 3600 * 1000)) / (3600 * 1000));
        await sendDuelTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `⏳ *Трейди заблоковано після ребіртху!*\n\nПісля останнього переродження має пройти 5 днів для запобігання нечесному переливу ресурсів.\nЗалишилося: *${days} дн. ${hours} год.*`,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      const tradeLobbyUrl = `https://nout0688-cloud.github.io/focaccia-clicker/?v=${Date.now()}&trade=lobby`;
      await sendDuelTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '🤝 *Меню безпечних Трейдів*\nОбмінюйся фокачами 🫓, алмазами 💎 та скінами 🎨 в окремому міні-аппі!',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🤝 Відкрити Трейди (Mini App)', web_app: { url: tradeLobbyUrl } }],
            [{ text: '👥 Зі списку гравців', callback_data: 'trade:players' }],
            [{ text: '🔍 За юзернеймом', callback_data: 'trade:byname' }],
            [{ text: '🔗 Створити відкритий трейд', callback_data: 'trade:open' }],
          ],
        },
      });
      return res.status(200).json({ ok: true });
    }

    // ===== ADMIN COMMANDS =====
    if (!isAdmin(userId)) {
      return res.status(200).json({ ok: true });
    }

    // /admin — show interactive button panel with message cleanup
    if (cmd === '/admin' || cmd === 'admin' || cmd === 'адмін' || cmd === 'админ') {
      if (msg.message_id) {
        await deleteTg(TOKEN, chatId, msg.message_id);
      }
      const panel = await getAdminPanelMessage();
      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...panel });
      return res.status(200).json({ ok: true });
    }

    // /maintenance [on|off] or /tech [on|off] — toggle game access
    if (
      cmd.startsWith('/maintenance') || cmd.startsWith('/tech') ||
      cmd.startsWith('maintenance') || cmd.startsWith('tech') ||
      cmd.startsWith('/тех') || cmd.startsWith('тех')
    ) {
      const arg = text.replace(/^\/?(maintenance|tech|тех)\s*/i, '').trim().toLowerCase();
      let newM;
      if (arg === 'on' || arg === '1' || arg === 'enable' || arg === 'закрити' || arg === 'вкл' || arg === 'вруби' || arg === 'включить') {
        newM = true;
      } else if (arg === 'off' || arg === '0' || arg === 'disable' || arg === 'відкрити' || arg === 'выкл' || arg === 'вируби' || arg === 'выключить') {
        newM = false;
      } else {
        const mRes = await redis('GET', 'maintenance_mode');
        newM = !(mRes?.result === '1');
      }
      await redis('SET', 'maintenance_mode', newM ? '1' : '0');
      const statusText = newM
        ? '🔴 *Технічну перерву УВІМКНЕНО!*\n\n🚫 Звичайні гравці бачать екран перерви та контакти підтримки (@hhimd).\n👑 Ви, як творець, маєте повний доступ до гри.'
        : '🟢 *Технічну перерву ВИМКНЕНО!*\n\n✨ Доступ до гри повністю відкрито для всіх гравців.';
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: statusText,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👑 Адмін-панель', callback_data: 'admin:back' }],
            [{ text: '🫓 Відкрити гру', web_app: { url: WEBAPP_URL } }],
          ],
        },
      });
      return res.status(200).json({ ok: true });
    }

    // /take_skins [all | @username | ID] or /resetskins /clearskins
    if (
      cmd.startsWith('/take_skins') || cmd.startsWith('take_skins') ||
      cmd.startsWith('/takeskins') || cmd.startsWith('takeskins') ||
      cmd.startsWith('/resetskins') || cmd.startsWith('resetskins') ||
      cmd.startsWith('/clearskins') || cmd.startsWith('clearskins') ||
      cmd.startsWith('/забрать_скины') || cmd.startsWith('забрать_скины') ||
      cmd.startsWith('/скины_сброс') || cmd.startsWith('скины_сброс')
    ) {
      const arg = text.replace(/^\/?(take_skins|takeskins|resetskins|clearskins|забрать_скины|скины_сброс)\s*/i, '').trim();
      if (!arg) {
        const menu = renderTakeSkinsMenu();
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...menu });
        return res.status(200).json({ ok: true });
      }
      if (arg.toLowerCase() === 'all' || arg.toLowerCase() === 'всім' || arg.toLowerCase() === 'все' || arg.toLowerCase() === 'всем') {
        const resetTime = Date.now();
        await redis('SET', 'global_skins_reset_time', String(resetTime));
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `🧹 *Скидання скінів активовано для ВСІХ гравців!*\n\nУ всіх гравців при вході/синхронізації залишиться лише стандартна класична фокача.`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👑 До адмінки', callback_data: 'admin:back' }],
              [{ text: '🫓 Відкрити гру', web_app: { url: WEBAPP_URL } }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }
      const target = await resolveTargetUser(arg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `❌ Гравця "${arg}" не знайдено. Вкажіть @username, числовий ID або "all" для всіх.`,
        });
        return res.status(200).json({ ok: true });
      }
      const resetTime = Date.now();
      await redis('SET', `reset_skins:${target.id}`, String(resetTime));
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `🧹 *Скіни забрано у гравця ${target.display}!*\n\nВсі його скіни очищено до базової класичної фокачі.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👤 Профіль гравця', callback_data: `admin:check_id:${target.id}` }],
            [{ text: '👑 Адмінка', callback_data: 'admin:back' }],
          ],
        },
      });
      return res.status(200).json({ ok: true });
    }

    // /users — list all users
    if (cmd === '/users' || cmd === 'users' || cmd === 'юзерс') {
      const usersData = await redis('HGETALL', 'users');
      if (!usersData?.result || usersData.result.length === 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '👥 Юзерів поки нема' });
        return res.status(200).json({ ok: true });
      }

      const entries = usersData.result;
      let list = '👥 *Користувачі:*\n\n';
      for (let i = 0; i < entries.length; i += 2) {
        const id = entries[i];
        try {
          const u = JSON.parse(entries[i + 1]);
          const ago = Math.floor((Date.now() - u.lastActive) / 60000);
          const agoText = ago < 60 ? `${ago}хв` : ago < 1440 ? `${Math.floor(ago / 60)}г` : `${Math.floor(ago / 1440)}д`;
          list += `• ${u.name}${u.username ? ` (@${u.username})` : ''} — ID: \`${id}\` — ${agoText} тому\n`;
        } catch { /* skip */ }
      }

      if (list.length <= 3800) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: list, parse_mode: 'Markdown' });
      } else {
        const lines = list.split('\n');
        let currentChunk = '';
        for (const line of lines) {
          if (currentChunk.length + line.length + 1 > 3500) {
            await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: currentChunk, parse_mode: 'Markdown' });
            currentChunk = line + '\n';
          } else {
            currentChunk += line + '\n';
          }
        }
        if (currentChunk.trim()) {
          await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: currentChunk, parse_mode: 'Markdown' });
        }
      }
      return res.status(200).json({ ok: true });
    }

    // /update_users [username/id] — refresh usernames & names from Telegram API or leaderboard
    if (
      cmd.startsWith('/update_users') || cmd.startsWith('update_users') ||
      cmd.startsWith('/update_user') || cmd.startsWith('update_user') ||
      cmd.startsWith('/refresh_users') || cmd.startsWith('refresh_users') ||
      cmd.startsWith('/sync_users') || cmd.startsWith('sync_users')
    ) {
      const arg = text.replace(/^\/?(update_users|update_user|refresh_users|sync_users)\s*/i, '').replace('@', '').trim();

      const usersData = await redis('HGETALL', 'users');
      const lbData = await redis('HGETALL', 'leaderboard');

      const userMap = new Map();
      if (usersData?.result) {
        for (let i = 0; i < usersData.result.length; i += 2) {
          const id = String(usersData.result[i]);
          let obj = {};
          try { obj = JSON.parse(usersData.result[i + 1]); } catch { /* */ }
          userMap.set(id, obj);
        }
      }

      const lbMap = new Map();
      if (lbData?.result) {
        for (let i = 0; i < lbData.result.length; i += 2) {
          const id = String(lbData.result[i]);
          let obj = {};
          try { obj = JSON.parse(lbData.result[i + 1]); } catch { /* */ }
          lbMap.set(id, obj);
          if (!userMap.has(id)) {
            userMap.set(id, { name: obj.n || 'Гравець', username: obj.u || '', lastActive: obj.ts || Date.now() });
          }
        }
      }

      // If specific user requested
      let targetIds = [];
      if (arg) {
        if (/^\d+$/.test(arg)) {
          targetIds = [arg];
        } else {
          const tData = await redis('HGET', 'usernames', arg.toLowerCase());
          if (tData?.result) {
            targetIds = [String(tData.result)];
          } else {
            for (const [uid, uObj] of userMap.entries()) {
              if (uObj.username && uObj.username.toLowerCase() === arg.toLowerCase()) {
                targetIds = [uid];
                break;
              }
            }
          }
          if (targetIds.length === 0) {
            await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Юзер @${arg} не знайдений у базі.` });
            return res.status(200).json({ ok: true });
          }
        }
      } else {
        targetIds = Array.from(userMap.keys());
      }

      if (targetIds.length === 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '👥 Користувачів для оновлення не знайдено.' });
        return res.status(200).json({ ok: true });
      }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `⏳ Оновлюю дані для *${targetIds.length}* користувачів через Telegram API...`,
        parse_mode: 'Markdown',
      });

      let updatedCount = 0;
      let unchangedCount = 0;
      let inaccessibleCount = 0;
      const changes = [];

      const batchSize = 8;
      for (let i = 0; i < targetIds.length; i += batchSize) {
        const batch = targetIds.slice(i, i + batchSize);
        await Promise.all(batch.map(async (id) => {
          const current = userMap.get(id) || {};
          const oldUsername = current.username || '';
          const oldName = current.name || '';
          const lbEntry = lbMap.get(id);

          let freshName = null;
          let freshUsername = null;
          let tgOk = false;

          try {
            const chatRes = await sendTg(TOKEN, 'getChat', { chat_id: Number(id) });
            if (chatRes?.ok && chatRes.result) {
              tgOk = true;
              freshName = chatRes.result.first_name || '';
              freshUsername = chatRes.result.username || '';
            }
          } catch { /* network error */ }

          // Fallback if getChat failed, but leaderboard has fresh username
          if (!tgOk && lbEntry && lbEntry.u) {
            freshUsername = lbEntry.u;
            freshName = lbEntry.n || oldName;
          }

          if (freshName === null && freshUsername === null) {
            inaccessibleCount++;
            return;
          }

          const hasUsernameChanged = freshUsername !== null && freshUsername !== oldUsername;
          const hasNameChanged = freshName !== null && freshName !== oldName;

          if (hasUsernameChanged || hasNameChanged) {
            updatedCount++;
            const finalUsername = freshUsername !== null ? freshUsername : oldUsername;
            const finalName = freshName !== null ? freshName : oldName;

            if (oldUsername && oldUsername.toLowerCase() !== finalUsername.toLowerCase()) {
              await redis('HDEL', 'usernames', oldUsername.toLowerCase());
            }
            if (finalUsername) {
              await redis('HSET', 'usernames', finalUsername.toLowerCase(), String(id));
            }

            const updatedUser = {
              ...current,
              name: finalName,
              username: finalUsername,
              lastActive: current.lastActive || Date.now(),
            };
            await redis('HSET', 'users', String(id), JSON.stringify(updatedUser));

            if (lbEntry) {
              lbEntry.n = finalName;
              lbEntry.u = finalUsername;
              await redis('HSET', 'leaderboard', String(id), JSON.stringify(lbEntry));
            }

            changes.push(`• ID \`${id}\`: ${oldName}${oldUsername ? ` (@${oldUsername})` : ''} ➔ *${finalName}*${finalUsername ? ` (@${finalUsername})` : ' (без юзернейму)'}`);
          } else {
            unchangedCount++;
            if (oldUsername) {
              await redis('HSET', 'usernames', oldUsername.toLowerCase(), String(id));
            }
          }
        }));
      }

      let report = `✅ *Оновлення юзернеймів завершено!*\n\n` +
        `👥 Перевірено: *${targetIds.length}*\n` +
        `🔄 Оновлено: *${updatedCount}*\n` +
        `⏺ Без змін: *${unchangedCount}*\n`;
      if (inaccessibleCount > 0) {
        report += `⚠️ Недоступно через API: *${inaccessibleCount}*\n`;
      }

      if (changes.length > 0) {
        report += `\n📋 *Зміни:*\n` + changes.slice(0, 30).join('\n');
        if (changes.length > 30) {
          report += `\n…і ще ${changes.length - 30} юзерів`;
        }
      } else {
        report += `\nУсі юзернейми в базі вже актуальні!`;
      }

      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: report, parse_mode: 'Markdown' });
      return res.status(200).json({ ok: true });
    }

    // /broadcast <text>
    if (cmd.startsWith('/broadcast ') || cmd.startsWith('broadcast ')) {
      const broadcastText = text.replace(/^\/?broadcast\s+/i, '').trim();
      if (!broadcastText) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи текст: /broadcast <текст>' });
        return res.status(200).json({ ok: true });
      }

      const usersData = await redis('HGETALL', 'users');
      if (!usersData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Немає юзерів' });
        return res.status(200).json({ ok: true });
      }

      const entries = usersData.result;
      let sent = 0, failed = 0;

      for (let i = 0; i < entries.length; i += 2) {
        const uid = entries[i];
        try {
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: Number(uid),
            text: `📢 *Оголошення:*\n\n${broadcastText}`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🫓 Грати!', web_app: { url: WEBAPP_URL } }]],
            },
          });
          sent++;
        } catch { failed++; }
      }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Розсилка завершена!\n📨 Відправлено: ${sent}\n❌ Помилок: ${failed}`,
      });
      return res.status(200).json({ ok: true });
    }

    // /giveall <amount> — give focaccia to all players
    if (
      cmd.startsWith('/giveall ') || cmd.startsWith('giveall ') ||
      cmd.startsWith('/give_all ') || cmd.startsWith('give_all ') ||
      cmd.startsWith('/роздати ') || cmd.startsWith('роздати ')
    ) {
      const rawAmt = text.replace(/^\/?(giveall|give_all|роздати)\s+/i, '').trim();
      const amount = parseAmountInput(rawAmt);
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи суму фокач: `/giveall 50m` або `/giveall 100000000`', parse_mode: 'Markdown' });
        return res.status(200).json({ ok: true });
      }
      await executeGiveAll(TOKEN, chatId, amount);
      return res.status(200).json({ ok: true });
    }

    // /diamondall <amount> — give diamonds to all players
    if (
      cmd.startsWith('/diamondall ') || cmd.startsWith('diamondall ') ||
      cmd.startsWith('/diamond_all ') || cmd.startsWith('diamond_all ') ||
      cmd.startsWith('/gemall ') || cmd.startsWith('gemall ') ||
      cmd.startsWith('/gemsall ') || cmd.startsWith('gemsall ') ||
      cmd.startsWith('/роздати_алмази ') || cmd.startsWith('роздати_алмази ')
    ) {
      const rawAmt = text.replace(/^\/?(diamondall|diamond_all|gemall|gemsall|роздати_алмази)\s+/i, '').trim();
      const amount = parseAmountInput(rawAmt);
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи кількість алмазів: `/diamondall 50` або `/diamondall 500`', parse_mode: 'Markdown' });
        return res.status(200).json({ ok: true });
      }
      await executeDiamondAll(TOKEN, chatId, amount);
      return res.status(200).json({ ok: true });
    }

    // /reset_skins_all — wipe skins for all players to classic
    if (cmd === '/reset_skins_all' || cmd === 'reset_skins_all' || cmd === '/скинути_скіни' || cmd === 'скинути_скіни') {
      await redis('SET', 'global_skins_reset_time', String(Date.now()));
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '✅ *Глобальне скидання скінів активовано!*\nУсі скіни у всіх гравців скинуто до стандартної класичної фокачі.',
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /give <amount> — give focaccia to yourself
    if ((cmd.startsWith('/give ') || cmd.startsWith('give ')) && !cmd.includes('giveto') && !cmd.includes('giveall')) {
      const amount = parseInt(text.replace(/^\/?give\s+/i, '').trim());
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи кількість: /give <число>' });
        return res.status(200).json({ ok: true });
      }

      // Get existing reward and add
      const existing = await redis('GET', `reward:${chatId}`);
      const currentReward = existing?.result ? parseInt(existing.result) : 0;
      await redis('SET', `reward:${chatId}`, String(currentReward + amount));

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Нараховано *${amount.toLocaleString()}* фокач тобі!\n🫓 Зайди в гру щоб отримати.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /giveto <username> <amount>
    if (cmd.startsWith('/giveto ') || cmd.startsWith('giveto ')) {
      const raw = text.replace(/^\/?giveto\s+/i, '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /giveto <username|ID> <кількість>' });
        return res.status(200).json({ ok: true });
      }

      const amount = parseInt(parts[1]);
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи правильну кількість' });
        return res.status(200).json({ ok: true });
      }

      const target = await resolveTargetUser(parts[0]);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${parts[0]} не знайдено (вкажи @username або числовий ID).` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;

      // Add reward
      const existing = await redis('GET', `reward:${targetChatId}`);
      const currentReward = existing?.result ? parseInt(existing.result) : 0;
      await redis('SET', `reward:${targetChatId}`, String(currentReward + amount));

      // Notify the user
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: Number(targetChatId),
        text: `🎁 Тобі нараховано *${amount.toLocaleString()}* фокач від адміна!\n🫓 Зайди в гру щоб отримати.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🫓 Забрати нагороду!', web_app: { url: WEBAPP_URL } }]],
        },
      });

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Нараховано *${amount.toLocaleString()}* фокач для ${target.display}!`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /rebirthto <username> <amount>
    if (cmd.startsWith('/rebirthto ') || cmd.startsWith('rebirthto ')) {
      const raw = text.replace(/^\/?rebirthto\s+/i, '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /rebirthto <username|ID> <кількість>' });
        return res.status(200).json({ ok: true });
      }

      const amount = parseInt(parts[1]);
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи правильну кількість' });
        return res.status(200).json({ ok: true });
      }

      const target = await resolveTargetUser(parts[0]);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${parts[0]} не знайдено (вкажи @username або числовий ID).` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;

      // Add pending rebirths
      const existingRb = await redis('GET', `rebirth:${targetChatId}`);
      const currentRb = existingRb?.result ? parseInt(existingRb.result) : 0;
      await redis('SET', `rebirth:${targetChatId}`, String(currentRb + amount));

      // Notify the user
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: Number(targetChatId),
        text: `🔄 Тобі нараховано *${amount}* ребіртх(ів) від адміна!\nЗайди в гру щоб отримати.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🫓 Забрати ребіртхи!', web_app: { url: WEBAPP_URL } }]],
        },
      });

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Нараховано *${amount}* ребіртх(ів) для ${target.display}!`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /rebirth <amount> — give rebirths to yourself
    if ((cmd.startsWith('/rebirth ') || cmd.startsWith('rebirth ')) && !cmd.includes('rebirthto')) {
      const amount = parseInt(text.replace(/^\/?rebirth\s+/i, '').trim());
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи кількість: /rebirth <число>' });
        return res.status(200).json({ ok: true });
      }

      // Get existing pending rebirths and add
      const existing = await redis('GET', `rebirth:${chatId}`);
      const currentRb = existing?.result ? parseInt(existing.result) : 0;
      await redis('SET', `rebirth:${chatId}`, String(currentRb + amount));

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Нараховано *${amount}* ребіртх(ів) тобі!\n🔄 Зайди в гру щоб отримати.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /diamondto <username|ID> <amount>
    if (cmd.startsWith('/diamondto ') || cmd.startsWith('diamondto ') || cmd.startsWith('/gemto ') || cmd.startsWith('gemto ')) {
      const raw = text.replace(/^\/?(diamondto|gemto)\s+/i, '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /diamondto <username|ID> <кількість>' });
        return res.status(200).json({ ok: true });
      }

      const amount = parseInt(parts[1]);
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи правильну кількість' });
        return res.status(200).json({ ok: true });
      }

      const target = await resolveTargetUser(parts[0]);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${parts[0]} не знайдено (вкажи @username або числовий ID).` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;

      // Add pending diamonds
      const existingGem = await redis('GET', `reward_gem:${targetChatId}`);
      const currentGem = existingGem?.result ? parseInt(existingGem.result) : 0;
      await redis('SET', `reward_gem:${targetChatId}`, String(currentGem + amount));
      await redis('SET', `reward_gem_source:${targetChatId}`, 'admin');

      // Notify the user
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: Number(targetChatId),
        text: `💎 Тобі нараховано *+${amount}* алмазів від адміна!\nЗайди в гру щоб отримати.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🫓 Забрати алмази!', web_app: { url: WEBAPP_URL } }]],
        },
      });

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Нараховано *+${amount}* 💎 алмазів для ${target.display}!`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /diamond <amount> — give diamonds to yourself
    if (
      (cmd.startsWith('/diamond ') || cmd.startsWith('diamond ') ||
       cmd.startsWith('/diamonds ') || cmd.startsWith('diamonds ') ||
       cmd.startsWith('/gem ') || cmd.startsWith('gem ') ||
       cmd.startsWith('/gems ') || cmd.startsWith('gems ')) &&
      !cmd.includes('to') && !cmd.includes('all')
    ) {
      const amount = parseInt(text.replace(/^\/?(diamonds?|gems?)\s+/i, '').trim());
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи кількість: /diamond <число>' });
        return res.status(200).json({ ok: true });
      }

      // Get existing pending diamonds and add
      const existing = await redis('GET', `reward_gem:${chatId}`);
      const currentGem = existing?.result ? parseInt(existing.result) : 0;
      await redis('SET', `reward_gem:${chatId}`, String(currentGem + amount));
      await redis('SET', `reward_gem_source:${chatId}`, 'admin');

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Нараховано *+${amount}* 💎 алмазів тобі!\n💎 Зайди в гру щоб отримати.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /check <username|ID>
    if (cmd.startsWith('/check ') || cmd.startsWith('check ')) {
      const targetArg = text.replace(/^\/?check\s+/i, '').trim();
      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;
      const userData = await redis('HGET', 'users', targetChatId);
      const pending = await redis('GET', `reward:${targetChatId}`);
      const pendingRb = await redis('GET', `rebirth:${targetChatId}`);
      const pendingGem = await redis('GET', `reward_gem:${targetChatId}`);

      let info = `👤 *${target.display}*\nID: \`${targetChatId}\`\n`;
      if (userData?.result) {
        try {
          const u = JSON.parse(userData.result);
          const ago = Math.floor((Date.now() - u.lastActive) / 60000);
          info += `Ім'я: ${u.name}\nОстання активність: ${ago < 60 ? `${ago} хв` : `${Math.floor(ago / 60)} год`} тому\n`;
        } catch { /* skip */ }
      }
      if (pending?.result && parseInt(pending.result) > 0) {
        info += `🎁 Очікує нагорода: ${parseInt(pending.result).toLocaleString()} фокач\n`;
      }
      if (pendingGem?.result && parseInt(pendingGem.result) > 0) {
        info += `💎 Очікується алмазів: +${parseInt(pendingGem.result)} 💎\n`;
      }
      if (pendingRb?.result && parseInt(pendingRb.result) > 0) {
        info += `🔄 Очікується ребіртхів: ${parseInt(pendingRb.result)}\n`;
      }
      const kRaw = await redis('HGET', 'ac_karma', targetChatId);
      let karma = 100;
      if (kRaw?.result) { try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch { /* */ } }
      if (karma < 25) info += `🔴 Карма: ${karma}/100 — *Тінь бабусі* (топ заморожено)\n`;
      else if (karma < 50) info += `⚠️ Карма: ${karma}/100 — казино закрите, ⚠️ у топі\n`;
      else if (karma < 75) info += `🟡 Карма: ${karma}/100 — ставки в казино до 1K\n`;
      else info += `🛡 Карма: ${karma}/100 — Clear\n`;

      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: info, parse_mode: 'Markdown' });
      return res.status(200).json({ ok: true });
    }

    // /clearreward <username|ID> — clear pending rewards
    if (cmd.startsWith('/clearreward ') || cmd.startsWith('clearreward ')) {
      const targetArg = text.replace(/^\/?clearreward\s+/i, '').trim();
      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено` });
        return res.status(200).json({ ok: true });
      }
      const targetChatId = target.id;
      await redis('DEL', `reward:${targetChatId}`);
      await redis('DEL', `rebirth:${targetChatId}`);
      await redis('DEL', `reward_gem:${targetChatId}`);
      await redis('DEL', `reward_gem_source:${targetChatId}`);
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Очікувані нагороди для ${target.display} повністю очищено!`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /takefrom <username|ID> <amount> — deduct focaccia on next game entry
    if (cmd.startsWith('/takefrom ') || cmd.startsWith('takefrom ')) {
      const raw = text.replace(/^\/?takefrom\s+/i, '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /takefrom <username|ID> <кількість>' });
        return res.status(200).json({ ok: true });
      }
      const amount = parseInt(parts[1]);
      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи правильну кількість' });
        return res.status(200).json({ ok: true });
      }
      const target = await resolveTargetUser(parts[0]);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${parts[0]} не знайдено` });
        return res.status(200).json({ ok: true });
      }
      const targetChatId = target.id;
      await redis('DEL', `reward:${targetChatId}`);
      const exDeduct = await redis('GET', `deduct:${targetChatId}`);
      const curD = exDeduct?.result ? parseInt(exDeduct.result) : 0;
      await redis('SET', `deduct:${targetChatId}`, String(curD + amount));
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Встановлено списання *${amount.toLocaleString()}* фокач для ${target.display} при наступному вході в гру (та очищено очікувані нагороди).`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /lb_clear — wipe the leaderboard
    if (cmd === '/lb_clear' || cmd === 'lb_clear') {
      await redis('DEL', 'leaderboard');
      await redis('DEL', 'ac_total');
      await redis('DEL', 'ac_active');
      await redis('DEL', 'ac_karma');
      await redis('DEL', 'ac_strikes');
      await redis('DEL', 'ac_debug_log');
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '✅ Лідерборд, карма та лічильники античиту очищено! Гравці повернуться туди протягом хвилини гри.',
      });
      return res.status(200).json({ ok: true });
    }

    // /reports — античит: хто детектило, хто чистий
    if (cmd === '/reports' || cmd === 'reports' || cmd === 'репортс') {
      const totals = await redis('HGETALL', 'ac_total');
      const active = await redis('HGETALL', 'ac_active');
      const usersData = await redis('HGETALL', 'users');

      // id → як показувати (username або ім'я)
      const names = {};
      if (usersData?.result) {
        for (let i = 0; i < usersData.result.length; i += 2) {
          try {
            const u = JSON.parse(usersData.result[i + 1]);
            names[usersData.result[i]] = u.username ? `@${u.username}` : u.name;
          } catch { /* skip */ }
        }
      }

      const activeIds = new Set();
      if (active?.result) {
        for (let i = 0; i < active.result.length; i += 2) activeIds.add(active.result[i]);
      }

      const karmaData = await redis('HGETALL', 'ac_karma');
      const karmaMap = {};
      if (karmaData?.result) {
        for (let i = 0; i < karmaData.result.length; i += 2) {
          try { karmaMap[karmaData.result[i]] = Math.max(0, Math.min(100, JSON.parse(karmaData.result[i + 1]).k || 0)); } catch { /* */ }
        }
      }

      const flagged = [];
      if (totals?.result) {
        for (let i = 0; i < totals.result.length; i += 2) {
          const c = parseInt(totals.result[i + 1]) || 0;
          if (c > 0) flagged.push({ id: totals.result[i], c });
        }
        flagged.sort((a, b) => b.c - a.c);
      }

      let msg = '🛡 *TAPSENTINEL v5 — ЗВІТ*\n\n⚠️ *ДЕТЕКТИЛО:*\n';
      if (flagged.length === 0) {
        msg += 'поки нікого — усі чисті 👼\n';
      } else {
        flagged.slice(0, 20).forEach((f, i) => {
          const who = names[f.id] || `\`${f.id}\``;
          const liveMark = activeIds.has(f.id) ? ' 🔴' : '';
          const km = karmaMap[f.id] ?? 100;
          const zone = km < 25 ? '🔴' : km < 50 ? '⚠️' : km < 75 ? '🟡' : '🟢';
          msg += `${i + 1}. ${who} — *${f.c}* раз(ів), карма *${km}/100* ${zone}${liveMark}\n`;
        });
        if (flagged.length > 20) msg += `…і ще ${flagged.length - 20}\n`;
      }

      const flaggedIds = new Set(flagged.map((f) => f.id));
      const clearIds = Object.keys(names).filter((id) => !flaggedIds.has(id));
      msg += '\n✅ *CLEAR:*\n';
      if (clearIds.length === 0) {
        msg += 'поки нікого не зареєстровано чистим';
      } else {
        const lines = clearIds.map((id) => `• ${names[id]} — Clear`);
        const budget = Math.max(0, Math.floor((3600 - msg.length) / 40));
        if (lines.length <= budget) {
          msg += lines.join('\n');
        } else {
          msg += lines.slice(0, budget).join('\n') + `\n…і ще ${lines.length - budget} гравців`;
        }
      }

      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
      return res.status(200).json({ ok: true });
    }

    // /aclog <username|ID> — дебаг-лог детектів гравця (TXT файл)
    if (cmd.startsWith('/aclog ') || cmd.startsWith('aclog ')) {
      const targetArg = text.replace(/^\/?aclog\s+/i, '').trim();
      if (!targetArg) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /aclog <username|ID>' });
        return res.status(200).json({ ok: true });
      }
      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено.` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;
      const targetUsername = target.username || targetChatId;

      // Karma
      let karma = 100;
      const kRaw = await redis('HGET', 'ac_karma', targetChatId);
      if (kRaw?.result) { try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch { /* */ } }

      // Total detects
      const totalRaw = await redis('HGET', 'ac_total', targetChatId);
      const totalDetects = totalRaw?.result ? (parseInt(totalRaw.result) || 0) : 0;

      // Debug logs
      let logs = [];
      const logsRaw = await redis('HGET', 'ac_debug_log', targetChatId);
      if (logsRaw?.result) { try { logs = JSON.parse(logsRaw.result); } catch { logs = []; } }

      // Strikes (timestamps)
      let strikes = [];
      const sRaw = await redis('HGET', 'ac_strikes', targetChatId);
      if (sRaw?.result) { try { strikes = JSON.parse(sRaw.result); } catch { strikes = []; } }

      // Формуємо TXT
      const txt = formatAcLogTxt(target, targetChatId, karma, totalDetects, strikes, logs);

      // Відправляємо як документ
      const boundary = '----FormBoundary' + Date.now();
      const fileName = `aclog_${targetUsername}_${Date.now()}.txt`;
      const fileContent = Buffer.from(txt, 'utf-8');

      const bodyParts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`,
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n🛡 Debug log для ${target.display}\nДетектів: ${totalDetects} | Карма: ${karma}/100`,
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: text/plain\r\n\r\n`,
      ];

      const beforeFile = Buffer.from(bodyParts.join('\r\n') + '\r\n', 'utf-8');
      const afterFile = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
      const fullBody = Buffer.concat([beforeFile, fileContent, afterFile]);

      await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: fullBody,
      });

      return res.status(200).json({ ok: true });
    }

    // /warn <username|ID> — вручну видати знак ⚠️ і знизити карму
    if (cmd.startsWith('/warn ') || cmd.startsWith('warn ')) {
      const targetArg = text.replace(/^\/?warn\s+/i, '').trim();
      if (!targetArg) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /warn <username|ID>' });
        return res.status(200).json({ ok: true });
      }
      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено.` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;
      // карма −15
      let karma = 100;
      const kRaw = await redis('HGET', 'ac_karma', targetChatId);
      if (kRaw?.result) { try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch { /* */ } }
      karma = Math.max(0, karma - 15);
      await redis('HSET', 'ac_karma', targetChatId, JSON.stringify({ k: karma, on: 0, ts: Date.now() }));
      await redis('HINCRBY', 'ac_total', targetChatId, '1');
      if (karma < 50) await redis('HSET', 'ac_active', targetChatId, '1');

      let wStrikes = [];
      const wsRaw = await redis('HGET', 'ac_strikes', targetChatId);
      if (wsRaw?.result) { try { wStrikes = JSON.parse(wsRaw.result); } catch {} }
      wStrikes.push(Date.now());
      if (wStrikes.length > 50) wStrikes = wStrikes.slice(-50);
      await redis('HSET', 'ac_strikes', targetChatId, JSON.stringify(wStrikes));

      let wLogs = [];
      const wlRaw = await redis('HGET', 'ac_debug_log', targetChatId);
      if (wlRaw?.result) { try { wLogs = JSON.parse(wlRaw.result); } catch {} }
      wLogs.push({
        type: 'admin_warn',
        reason: 'Команда /warn від адміністратора',
        karmaAfter: karma,
        ts: Date.now(),
      });
      if (wLogs.length > 50) wLogs = wLogs.slice(-50);
      await redis('HSET', 'ac_debug_log', targetChatId, JSON.stringify(wLogs));
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `⚠️ Знак видано для ${target.display}. Карма: *${karma}/100*.\nЗняти всі обмеження: \`/unflag ${target.shortDisplay}\``,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /unflag <username|ID> — повне відновлення: карма 100, без знаків і детектів
    if (cmd.startsWith('/unflag ') || cmd.startsWith('unflag ')) {
      const targetArg = text.replace(/^\/?unflag\s+/i, '').trim();
      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;
      await redis('HSET', 'ac_karma', targetChatId, JSON.stringify({ k: 100, on: 0, ts: Date.now() }));
      await redis('HDEL', 'ac_active', targetChatId);
      await redis('HDEL', 'ac_total', targetChatId);
      await redis('HDEL', 'ac_strikes', targetChatId);
      await redis('HDEL', 'ac_debug_log', targetChatId);
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ ${target.display} повністю прощений: карма відновлена до *100/100*, знак ⚠️ та всі обмеження знято.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /reset <username|ID> — request single user reset
    if ((cmd.startsWith('/reset ') || cmd.startsWith('reset ')) && !cmd.includes('reset_all')) {
      const targetArg = text.replace(/^\/?reset\s+/i, '').trim();
      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text:
          `⚠️ *ПІДТВЕРДЖЕННЯ СКИДАННЯ АКАУНТУ*\n\n` +
          `Ви дійсно хочете скинути весь прогрес для ${target.display}?\n\n` +
          `👉 Для підтвердження відправте:\n\`/confirm_reset ${target.shortDisplay}\``,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /confirm_reset <username|ID> — execute single user reset
    if (cmd.startsWith('/confirm_reset ') || cmd.startsWith('confirm_reset ')) {
      const targetArg = text.replace(/^\/?confirm_reset\s+/i, '').trim();
      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = target.id;
      // Mark user for client reset and clear pending rewards
      await redis('SET', `reset:${targetChatId}`, '1');
      await redis('DEL', `reward:${targetChatId}`);
      await redis('DEL', `rebirth:${targetChatId}`);

      // Notify target user
      try {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(targetChatId),
          text: `⚠️ *Твій ігровий прогрес було скинуто адміністратором.*\nПри наступному відкритті гра розпочнеться з нуля.`,
          parse_mode: 'Markdown',
        });
      } catch { /* user may have blocked bot */ }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Акаунт ${target.display} позначено на скидання! При наступному запуску гри весь його прогрес очиститься.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /snapshots <username|ID> — view account backup snapshots
    if (cmd.startsWith('/snapshots') || cmd.startsWith('snapshots') || cmd.startsWith('/snaps') || cmd.startsWith('snaps')) {
      const targetArg = text.replace(/^\/?(snapshots|snaps)\s*/i, '').trim();
      if (!targetArg) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `ℹ️ Вкажіть користувача:\n\`/snapshots @username\` або \`/snapshots ID\``,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено` });
        return res.status(200).json({ ok: true });
      }

      const targetId = target.id;
      const latestMetaRaw = await redis('GET', `user_latest_snapshot_meta:${targetId}`);
      let latest = null;
      if (latestMetaRaw?.result) {
        try { latest = JSON.parse(latestMetaRaw.result); } catch {}
      }

      const histRaw = await redis('GET', `user_snapshot_history:${targetId}`);
      let history = [];
      if (histRaw?.result) {
        try { history = JSON.parse(histRaw.result); } catch {}
      }

      const lbRaw = await redis('HGET', 'leaderboard', targetId);
      let lb = null;
      if (lbRaw?.result) {
        try { lb = JSON.parse(lbRaw.result); } catch {}
      }

      let textMsg = `📸 *СНАПШОТИ ТА БЕКАПИ: ${target.display}*\n\n`;

      if (lb) {
        textMsg += `🏆 *Пікові рекорди в лідерборді:*\n` +
          `• Фокач (total): \`${Number(lb.t || 0).toLocaleString()}\`\n` +
          `• Ребіртхи: \`${lb.p || 0}\` | Алмази: \`${lb.d || 0} 💎\` | Кліки: \`${lb.k || 0}\`\n\n`;
      }

      if (!latest && history.length === 0) {
        textMsg += `⚠️ Повних серверних снапшотів ще немає (вони зберігаються автоматично під час активної гри).\n\n` +
          `👉 Але ви можете відновити пікові рекорди командою:\n\`/restore ${target.shortDisplay} peak\``;
      } else {
        if (latest) {
          const dt = new Date(latest.ts).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
          textMsg += `🔹 *Останній автоснапшот [latest]:*\n` +
            `• Час: ${dt}\n` +
            `• Фокач: \`${Number(latest.focaccia || 0).toLocaleString()}\` (всього: \`${Number(latest.total || 0).toLocaleString()}\`)\n` +
            `• Ребіртхи: \`${latest.prestige || 0}\` | Алмази: \`${latest.diamonds || 0} 💎\`\n` +
            `• Будівель: \`${latest.buildingsCount || 0}\` | Апгрейдів: \`${latest.upgradesCount || 0}\`\n\n`;
        }

        if (history.length > 0) {
          textMsg += `📜 *Історія снапшотів (останні ${history.length}):*\n`;
          history.forEach((h, idx) => {
            const hDt = new Date(h.ts).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
            textMsg += `\`[${idx + 1}]\` ${hDt} — 🔄 ${h.prestige || 0} | 💎 ${h.diamonds || 0} | 🫓 ${Number(h.total || 0).toLocaleString()}\n`;
          });
          textMsg += `\n`;
        }

        textMsg += `👉 *Щоб відновити акаунт з потрібного снапшота, відправте:*\n` +
          `\`/restore ${target.shortDisplay} latest\` — з найновішого\n` +
          `\`/restore ${target.shortDisplay} 1\` — за номером з історії\n` +
          `\`/restore ${target.shortDisplay} peak\` — за рекордом лідерборду`;
      }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: textMsg,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /restore <username|ID> [latest|1..5|peak] — restore account from snapshot
    if (cmd.startsWith('/restore') || cmd.startsWith('restore')) {
      const parts = text.trim().split(/\s+/);
      const targetArg = parts[1] || '';
      const snapArg = parts[2] || 'latest';

      if (!targetArg) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `ℹ️ Формат команди:\n\`/restore @username [latest|номер|peak]\`\n\nПриклад: \`/restore @player latest\``,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      const target = await resolveTargetUser(targetArg);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Користувача ${targetArg} не знайдено` });
        return res.status(200).json({ ok: true });
      }

      const targetId = target.id;
      let restoreData = null;
      let restoreTypeDesc = '';

      if (snapArg.toLowerCase() === 'peak') {
        const lbRaw = await redis('HGET', 'leaderboard', targetId);
        if (lbRaw?.result) {
          try {
            const lb = JSON.parse(lbRaw.result);
            restoreData = {
              type: 'leaderboard',
              total: Number(lb.t) || 0,
              focaccia: Number(lb.t) || 0,
              prestige: Number(lb.p) || 0,
              diamonds: Number(lb.d) || 0,
              clicks: Number(lb.k) || 0,
              bossesDefeated: Number(lb.b) || 0,
              ts: Date.now(),
            };
            restoreTypeDesc = `пікові рекорди з лідерборду (🫓 ${restoreData.total.toLocaleString()}, 🔄 ${restoreData.prestige}, 💎 ${restoreData.diamonds})`;
          } catch {}
        }
      } else {
        let snapPayload = null;
        if (/^\d+$/.test(snapArg)) {
          const idx = parseInt(snapArg, 10) - 1;
          const histRaw = await redis('GET', `user_snapshot_history:${targetId}`);
          if (histRaw?.result) {
            try {
              const hist = JSON.parse(histRaw.result);
              if (Array.isArray(hist) && hist[idx]) {
                const sId = hist[idx].id;
                const snapRes = await redis('GET', `user_snapshot:${targetId}:${sId}`);
                if (snapRes?.result) snapPayload = snapRes.result;
              }
            } catch {}
          }
        }
        if (!snapPayload) {
          const latestSnap = await redis('GET', `user_latest_snapshot:${targetId}`);
          if (latestSnap?.result) snapPayload = latestSnap.result;
        }

        if (snapPayload) {
          try {
            const parsed = JSON.parse(snapPayload);
            restoreData = {
              type: 'full_save',
              save: parsed,
              ts: Date.now(),
            };
            restoreTypeDesc = `повний снапшот (🫓 ${Number(parsed.total || 0).toLocaleString()}, 🔄 ${parsed.prestige || 0}, 💎 ${parsed.diamonds || 0})`;
          } catch {}
        }
      }

      if (!restoreData) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `❌ Не вдалося знайти снапшот або запис у лідерборді для відновлення користувача ${target.display}. Спочатку перевірте: \`/snapshots ${target.shortDisplay}\``,
        });
        return res.status(200).json({ ok: true });
      }

      // Remove any lingering reset flags and set restore payload
      await redis('DEL', `reset:${targetId}`);
      await redis('SET', `reward_restore:${targetId}`, JSON.stringify(restoreData));

      // Notify target user
      try {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: Number(targetId),
          text: `🎉 *Твій акаунт відновлено адміністратором!*\n\nВідновлено: ${restoreTypeDesc}.\nПри наступному відкритті гри весь твій прогрес буде автоматично синхронізовано!`,
          parse_mode: 'Markdown',
        });
      } catch {}

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ *АКАУНТ ${target.display} ВІДНОВЛЕНО!*\n\nДані: ${restoreTypeDesc}.\nГравцю відправлено сповіщення. При наступному вході гра підтягне ці дані.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /sound або /rofl <@username|ID|all> [sound_key]
    if (cmd.startsWith('/sound') || cmd.startsWith('sound') || cmd.startsWith('/rofl') || cmd.startsWith('rofl')) {
      if (!isAdmin(userId)) return res.status(200).json({ ok: true });
      const parts = text.trim().split(/\s+/);
      const targetInput = parts[1];
      const soundInput = parts[2]?.toLowerCase();

      if (!targetInput) {
        const menu = await renderRoflMenu();
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...menu });
        return res.status(200).json({ ok: true });
      }

      if (targetInput.toLowerCase() === 'all' || targetInput.toLowerCase() === 'всім') {
        if (soundInput && ROFL_SOUND_NAMES[soundInput]) {
          await redis('SET', 'rofl_sound_all', soundInput, 'EX', 45);
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: chatId,
            text: `📢 *Звук ${ROFL_SOUND_NAMES[soundInput]} активовано для ВСІХ онлайн гравців!* 🔊💥`,
            parse_mode: 'Markdown',
          });
          return res.status(200).json({ ok: true });
        }
        const menu = await renderAllSoundsMenu();
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...menu });
        return res.status(200).json({ ok: true });
      }

      const target = await resolveTargetUser(targetInput);
      if (!target) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `❌ Користувача "${targetInput}" не знайдено в базі.`,
        });
        return res.status(200).json({ ok: true });
      }

      if (soundInput && ROFL_SOUND_NAMES[soundInput]) {
        await redis('SET', `rofl_sound:${target.id}`, soundInput, 'EX', 180);
        const isOnlineRaw = await redis('GET', `user_online:${target.id}`);
        const isOnline = isOnlineRaw?.result === '1';
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `🔊 *Звук ${ROFL_SOUND_NAMES[soundInput]} відправлено для ${target.display}!* ${isOnline ? '🟢 Зараз у грі — увімкнеться за 1-3 сек!' : '⚪ Офлайн — увімкнеться при запуску.'}`,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      const menu = await renderUserSoundsMenu(target.id);
      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...menu });
      return res.status(200).json({ ok: true });
    }

    // /reset_all — request all users reset
    if (cmd === '/reset_all' || cmd === 'reset_all') {
      const usersData = await redis('HGETALL', 'users');
      const userCount = usersData?.result ? Math.floor(usersData.result.length / 2) : 0;

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text:
          `🚨 *УВАГА: СКИДАННЯ ВСІХ АКАУНТІВ!*\n\n` +
          `Це скине прогрес у ВСІХ зареєстрованих гравців (всього: ${userCount})!\n\n` +
          `👉 Для підтвердження відправте ТОЧНО таку команду:\n\`/confirm_reset_all YES\``,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /confirm_reset_all YES — execute all users reset
    if (cmd === '/confirm_reset_all yes' || cmd === 'confirm_reset_all yes') {
      const resetTime = Date.now();
      await redis('SET', 'global_reset_time', String(resetTime));

      const usersData = await redis('HGETALL', 'users');
      if (!usersData?.result || usersData.result.length === 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '✅ Глобальне скидання встановлено! Юзерів у базі поки нема.' });
        return res.status(200).json({ ok: true });
      }

      const entries = usersData.result;
      let count = 0;
      for (let i = 0; i < entries.length; i += 2) {
        const uid = entries[i];
        await redis('SET', `reset:${uid}`, '1');
        await redis('DEL', `reward:${uid}`);
        await redis('DEL', `rebirth:${uid}`);
        count++;

        // Notify user
        try {
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: Number(uid),
            text: `⚠️ *Глобальне скидання:*\nТвій ігровий прогрес було скинуто адміністратором. Гра розпочнеться з нуля!`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🫓 Почати з нуля!', web_app: { url: WEBAPP_URL } }]],
            },
          });
        } catch { /* ignore */ }
      }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Успішно активовано скидання для ВСІХ гравців (${count} акаунтів)!`,
      });
      return res.status(200).json({ ok: true });
    }

    // ===== /concurs /contest /giveaway — білдер розіграшу =====
    if (
      cmd === '/concurs' || cmd === 'concurs' ||
      cmd === '/contest' || cmd === 'contest' ||
      cmd === '/giveaway' || cmd === 'giveaway' ||
      cmd === 'конкурс' || cmd === 'розіграш'
    ) {
      if (msg.message_id) {
        await deleteTg(TOKEN, chatId, msg.message_id);
      }
      const draft = await getContestDraft(chatId);
      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...renderBuilderMessage(draft) });
      return res.status(200).json({ ok: true });
    }

    // ===== /concurs_list — список активних та запланованих розіграшів =====
    if (
      cmd === '/concurs_list' || cmd === 'concurs_list' ||
      cmd === '/contest_list' || cmd === 'contest_list' ||
      cmd === 'конкурси'
    ) {
      await checkScheduledContests(TOKEN);
      await checkExpiredContests(TOKEN);

      const activeRes = await redis('SMEMBERS', 'active_contests');
      const activeIds = activeRes?.result || [];

      const schedRes = await redis('SMEMBERS', 'scheduled_contests');
      const schedIds = schedRes?.result || [];

      if (activeIds.length === 0 && schedIds.length === 0) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: '🎁 Наразі немає активних або запланованих розіграшів.\n\nСтворити новий: `/concurs`',
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      let textRes = `📋 *РОЗІГРАШІ ТА КОНКУРСИ:*\n\n`;

      if (schedIds.length > 0) {
        textRes += `📅 *ЗАПЛАНОВАНІ РОЗІГРАШІ (${schedIds.length}):*\n`;
        for (const cId of schedIds) {
          const cRaw = await redis('HGET', 'contest:' + cId, 'data');
          if (!cRaw?.result) continue;
          try {
            const cObj = JSON.parse(cRaw.result);
            const curFmt = formatContestCur(cObj.cur, cObj.amount);
            const startFmt = formatKyivDate(cObj.scheduledStartTime || cObj.startTime);
            const msToStart = (cObj.scheduledStartTime || cObj.startTime) - Date.now();
            const toStart = msToStart > 0 ? formatDurationHours(Math.max(0.1, msToStart / 3600000)) : 'Запускається...';

            textRes +=
              `🔹 ID: \`${cId}\`\n` +
              `🎁 Приз: *${curFmt}* для ${cObj.winners} перем.\n` +
              `📅 Старт: *${startFmt}* (за Києвом)\n` +
              `⏱ До старту: *${toStart}*\n` +
              `🚀 Запустити зараз: \`/concurs_start ${cId}\`\n` +
              `❌ Скасувати: \`/concurs_cancel ${cId}\`\n\n`;
          } catch {}
        }
      }

      if (activeIds.length > 0) {
        textRes += `🚀 *АКТИВНІ РОЗІГРАШІ (${activeIds.length}):*\n`;
        for (const cId of activeIds) {
          const cRaw = await redis('HGET', 'contest:' + cId, 'data');
          if (!cRaw?.result) continue;
          try {
            const cObj = JSON.parse(cRaw.result);
            const pCard = await redis('SCARD', 'contest:' + cId + ':participants');
            const pCount = pCard?.result || 0;
            const curFmt = formatContestCur(cObj.cur, cObj.amount);
            const endFmt = formatKyivDate(cObj.endTime);
            const msLeft = cObj.endTime - Date.now();
            const timeLeft = msLeft > 0 ? formatDurationHours(Math.max(0.1, msLeft / 3600000)) : 'Завершується...';

            textRes +=
              `🔹 ID: \`${cId}\`\n` +
              `🎁 Приз: *${curFmt}* кожному\n` +
              `👥 Переможців: *${cObj.winners}* | Учасників: *${pCount}*\n` +
              `⏱ Залишилось: *${timeLeft}* (до ${endFmt})\n` +
              `👥 Учасники: \`/concurs_users ${cId}\`\n` +
              `⚙️ Завершити: \`/concurs_finish ${cId}\`\n` +
              `❌ Скасувати: \`/concurs_cancel ${cId}\`\n\n`;
          } catch { /* skip */ }
        }
      }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: textRes,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // ===== /concurs_start <id> — запустити запланований розіграш достроково =====
    if (
      cmd.startsWith('/concurs_start') || cmd.startsWith('concurs_start') ||
      cmd.startsWith('/contest_start') || cmd.startsWith('contest_start')
    ) {
      const parts = text.split(/\s+/);
      const targetId = parts[1]?.trim();

      if (!targetId) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: '❌ Вкажіть ID конкурсу для запуску:\nПриклад: `/concurs_start c_1712345678901`\n\nСписок: `/concurs_list`',
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      const cRaw = await redis('HGET', 'contest:' + targetId, 'data');
      if (!cRaw?.result) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `❌ Конкурс з ID \`${targetId}\` не знайдено.`,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      let cObj = {};
      try { cObj = JSON.parse(cRaw.result); } catch {}

      if (cObj.status === 'active') {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `ℹ️ Цей конкурс уже активний!`,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      await launchScheduledContest(TOKEN, targetId, cObj);
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `🚀 Конкурс \`${targetId}\` успішно запущено прямо зараз!`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // ===== /concurs_users <id> — перегляд учасників розіграшу =====
    if (
      cmd.startsWith('/concurs_users') || cmd.startsWith('concurs_users') ||
      cmd.startsWith('/contest_users') || cmd.startsWith('contest_users') ||
      cmd.startsWith('/concurs_parts') || cmd.startsWith('concurs_parts')
    ) {
      const parts = text.split(/\s+/);
      let targetId = parts[1]?.trim();

      if (!targetId) {
        const activeRes = await redis('SMEMBERS', 'active_contests');
        const activeIds = activeRes?.result || [];
        if (activeIds.length === 1) {
          targetId = activeIds[0];
        } else {
          await sendTg(TOKEN, 'sendMessage', {
            chat_id: chatId,
            text: '❌ Вкажіть ID конкурсу:\nПриклад: `/concurs_users c_1712345678901`\n\nСписок активних: `/concurs_list`',
            parse_mode: 'Markdown',
          });
          return res.status(200).json({ ok: true });
        }
      }

      const pView = await renderContestParticipants(targetId, 0);
      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, ...pView });
      return res.status(200).json({ ok: true });
    }

    // ===== /concurs_finish <id> — достроково підбити підсумки =====
    if (
      cmd.startsWith('/concurs_finish') || cmd.startsWith('concurs_finish') ||
      cmd.startsWith('/contest_finish') || cmd.startsWith('contest_finish')
    ) {
      const parts = text.split(/\s+/);
      const targetId = parts[1]?.trim();

      if (!targetId) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: '❌ Вкажіть ID конкурсу:\nПриклад: `/concurs_finish c_1712345678901`\n\nСписок активних: `/concurs_list`',
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      const cRaw = await redis('HGET', 'contest:' + targetId, 'data');
      if (!cRaw?.result) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `❌ Конкурс з ID \`${targetId}\` не знайдено.`,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `⏳ Підбиваю підсумки розіграшу \`${targetId}\`...`,
        parse_mode: 'Markdown',
      });

      await finishContest(TOKEN, targetId, true);
      return res.status(200).json({ ok: true });
    }

    // ===== /concurs_cancel <id> — скасувати конкурс без видачі призів =====
    if (
      cmd.startsWith('/concurs_cancel') || cmd.startsWith('concurs_cancel') ||
      cmd.startsWith('/contest_cancel') || cmd.startsWith('contest_cancel')
    ) {
      const parts = text.split(/\s+/);
      const targetId = parts[1]?.trim();

      if (!targetId) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: '❌ Вкажіть ID конкурсу для скасування:\nПриклад: `/concurs_cancel c_1712345678901`',
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      const cRaw = await redis('HGET', 'contest:' + targetId, 'data');
      if (!cRaw?.result) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: `❌ Конкурс з ID \`${targetId}\` не знайдено.`,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      let cObj = {};
      try { cObj = JSON.parse(cRaw.result); } catch { /* */ }
      cObj.status = 'cancelled';
      cObj.cancelledAt = Date.now();
      await redis('HSET', 'contest:' + targetId, 'data', JSON.stringify(cObj));
      await redis('SREM', 'active_contests', targetId);
      await redis('SREM', 'scheduled_contests', targetId);

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `🛑 Конкурс \`${targetId}\` скасовано! Нагороди не нараховувались.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Bot error:', err);
    res.status(200).json({ ok: true, error: err.message });
  }
};
