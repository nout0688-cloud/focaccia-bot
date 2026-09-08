/**
 * Фокача Клікер — Telegram Bot (Vercel Serverless)
 * Webhook + Admin panel для user ID 1975429762
 */

const WEBAPP_URL = 'https://nout0688-cloud.github.io/focaccia-clicker/?v=1.1.3';
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
        builderMsgId: d.builderMsgId || null,
      };
    } catch { /* */ }
  }
  return {
    cur: 'foc',
    amount: 10000000,
    winners: 3,
    durationHours: 24,
    builderMsgId: null,
  };
}

async function setContestDraft(adminId, draft) {
  await redis('SET', `contest_draft:${adminId}`, JSON.stringify(draft), 'EX', 86400);
}

function renderBuilderMessage(draft) {
  const endTs = Date.now() + Math.round((draft.durationHours || 24) * 3600 * 1000);
  const totalPrize = (draft.amount || 10000000) * (draft.winners || 3);
  const totalFormatted = formatContestCur(draft.cur, totalPrize);
  const singleFormatted = formatContestCur(draft.cur, draft.amount || 10000000);

  const text =
    `🛠 *БІЛДЕР КОНКУРСУ* 🎁\n\n` +
    `Налаштуйте параметри перед запуском розіграшу:\n\n` +
    `🎁 *Приз кожному:* ${singleFormatted}\n` +
    `👥 *Кількість переможців:* ${draft.winners || 3} гравців\n` +
    `⏱ *Тривалість:* ${formatDurationHours(draft.durationHours || 24)}\n` +
    `📅 *Результати орієнтовно:* ${formatKyivDate(endTs)} (за Києвом)\n` +
    `💰 *Загальний призовий фонд:* ${totalFormatted}\n\n` +
    `👇 *Оберіть параметр, який бажаєте змінити:*`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: `🎁 Змінити приз (${singleFormatted})`, callback_data: 'concurs:menu:prize' }],
      [{ text: `👥 Змінити переможців (${draft.winners || 3})`, callback_data: 'concurs:menu:winners' }],
      [{ text: `⏱ Змінити час (${formatDurationHours(draft.durationHours || 24)})`, callback_data: 'concurs:menu:duration' }],
      [{ text: '🚀 Опублікувати конкурс усім гравцям', callback_data: 'concurs:publish' }],
      [{ text: '❌ Закрити білдер', callback_data: 'concurs:close' }],
    ],
  };

  return { text, parse_mode: 'Markdown', reply_markup };
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
  const startTime = Date.now();
  const endTime = startTime + durationMs;

  const contestObj = {
    id: contestId,
    cur: draft.cur || 'foc',
    amount: draft.amount || 10000000,
    winners: draft.winners || 3,
    durationHours,
    startTime,
    endTime,
    status: 'active',
    creatorId: String(adminChatId),
  };

  await redis('HSET', 'contest:' + contestId, 'data', JSON.stringify(contestObj));
  await redis('SADD', 'active_contests', contestId);

  const singlePrize = formatContestCur(draft.cur, draft.amount);
  const totalPrize = formatContestCur(draft.cur, draft.amount * draft.winners);
  const endFormatted = formatKyivDate(endTime);

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, msg: '🫓 Focaccia bot is alive!' });
  }

  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });

  // 🧹 Автоматичне видалення застарілих повідомлень налаштування дуелей (>15 хв)
  await cleanupExpiredMessages(TOKEN);
  // ⏱ Автоматична перевірка та підбиття підсумків активних конкурсів
  await checkExpiredContests(TOKEN);

  try {
    const update = req.body;

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
        // меню выбора соперника
        if (dAction === 'menu') {
        await sendDuelTg(TOKEN, 'sendMessage', { chat_id: Number(cqChat), text: '⚔️ Кого хочешь вызвать на дуэль?\nКто быстрее накликает 100 фокач — тот победил (+5💎)!',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👥 Из списка игроков', callback_data: 'duel:players' }],
              [{ text: '✍️ По юзернейму', callback_data: 'duel:byname' }],
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

      // Кнопка назад: видаляємо поточне підменю, відправляємо білдер
      if (action === 'back') {
        await redis('DEL', `concurs_await_amount:${cqChat}`);
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

    const cmd = text.toLowerCase();

    // ===== /start =====
    if (cmd === '/start' || cmd === 'start' || cmd === 'старт') {
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
            [{ text: '⚔️ Дуэль', callback_data: 'duel:menu' }],
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
      await sendDuelTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: '⚔️ Кого хочешь вызвать на дуэль?\nКто быстрее накликает 100 фокач — тот победил (+5💎)!',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 Из списка игроков', callback_data: 'duel:players' }],
            [{ text: '✍️ По юзернейму', callback_data: 'duel:byname' }],
          ],
        },
      });
      return res.status(200).json({ ok: true });
    }

    // ===== ADMIN COMMANDS =====
    if (!isAdmin(userId)) {
      return res.status(200).json({ ok: true });
    }

    // /admin — show panel
    if (cmd === '/admin' || cmd === 'admin' || cmd === 'адмін' || cmd === 'админ') {
      const usersData = await redis('HGETALL', 'users');
      const userCount = usersData?.result ? Math.floor(usersData.result.length / 2) : 0;

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text:
          `👑 *АДМІН ПАНЕЛЬ*\n\n` +
          `👥 Користувачів: *${userCount}*\n\n` +
          `📋 *Команди (можна вказувати @username або ID):*\n` +
          `• \`/users\` — список всіх юзерів\n` +
          `• \`/update_users [юзер|ID]\` — оновити юзернейми через Telegram API\n` +
          `• \`/broadcast <текст>\` — розсилка всім\n` +
          `• \`/give <кількість>\` — видати собі фокачі\n` +
          `• \`/giveto <юзер|ID> <кількість>\` — видати комусь\n` +
          `• \`/rebirth <кількість>\` — видати собі ребіртхи\n` +
          `• \`/rebirthto <юзер|ID> <кількість>\` — видати комусь ребіртхи\n` +
          `• \`/check <юзер|ID>\` — інфо про юзера\n` +
          `• \`/clearreward <юзер|ID>\` — очистити очікувану нагороду\n` +
          `• \`/takefrom <юзер|ID> <кількість>\` — списати фокачі при вході\n` +
          `• \`/lb_clear\` — очистити лідерборд\n` +
          `• \`/reports\` — звіт античиту (хто детектило)\n` +
          `• \`/aclog <юзер|ID>\` — дебаг-лог детектів (TXT файл)\n` +
          `• \`/warn <юзер|ID>\` — видати знак ⚠️ вручну\n` +
          `• \`/unflag <юзер|ID>\` — зняти знак ⚠️ з гравця\n` +
          `• \`/reset <юзер|ID>\` — скинути акаунт юзера\n` +
          `• \`/reset_all\` — скинути акаунти ВСІХ гравців\n\n` +
          `🎁 *Розіграші та конкурси:*\n` +
          `• \`/concurs\` — інтерактивний білдер конкурсу\n` +
          `• \`/concurs_list\` — список активних розіграшів\n` +
          `• \`/concurs_finish <ID>\` — достроково підбити підсумки\n` +
          `• \`/concurs_cancel <ID>\` — скасувати розіграш`,
        parse_mode: 'Markdown',
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

    // /give <amount> — give focaccia to yourself
    if ((cmd.startsWith('/give ') || cmd.startsWith('give ')) && !cmd.includes('giveto')) {
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
      await redis('DEL', `reward_gem:${targetChatId}`);
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
      let txt = `=== TAPSENTINEL DEBUG LOG ===\n`;
      txt += `Гравець: ${target.name} (${target.display})\n`;
      txt += `ID: ${targetChatId}\n`;
      txt += `Карма: ${karma}/100\n`;
      txt += `Всього детектів: ${totalDetects}\n`;
      txt += `Дата звіту: ${new Date().toISOString()}\n`;
      txt += `\n=== СТРАЙКИ (timestamps) ===\n`;
      if (strikes.length === 0) {
        txt += `(немає)\n`;
      } else {
        strikes.forEach((ts, i) => {
          txt += `  Strike ${i + 1}: ${new Date(ts).toISOString()}\n`;
        });
      }

      txt += `\n=== ДЕБАГ ДЕТЕКТІВ (останні ${logs.length}) ===\n`;
      if (logs.length === 0) {
        txt += `(немає записів — можливо, старі детекти до оновлення)\n`;
      } else {
        logs.forEach((entry, i) => {
          txt += `\n--- Detect ${i + 1} ---\n`;
          txt += `  Час: ${entry.ts ? new Date(entry.ts).toISOString() : 'N/A'}\n`;
          txt += `  R (ритм):     ${entry.R ?? '?'}/100\n`;
          txt += `  C (координати): ${entry.C ?? '?'}/100\n`;
          txt += `  B (поведінка):  ${entry.B ?? '?'}/100\n`;
          txt += `  H (людяність):  ${entry.H ?? '?'}/100\n`;
          txt += `  Evidence:       ${entry.evidence ?? '?'}\n`;
          txt += `  Suspicion:      ${entry.suspicion ?? '?'}\n`;
          txt += `  Indep. signals: ${entry.independentSignals ?? '?'}\n`;
          txt += `  Strong ratio:   ${entry.strongRatio ?? '?'}\n`;
          txt += `  VStrong ratio:  ${entry.veryStrongRatio ?? '?'}\n`;
          txt += `  Metronome:      ${entry.metronome ?? '?'}\n`;
          txt += `  CV40:           ${entry.cv40 ?? '?'}\n`;
          txt += `  ExtremeBoost:   ${entry.extremeSpeedBoost ?? '?'}\n`;
          txt += `  Taps (40):      ${entry.taps40count ?? '?'}\n`;
          txt += `  Taps (300):     ${entry.taps300count ?? '?'}\n`;
          txt += `  Інтервали (мс): ${entry.ivs40 || 'N/A'}\n`;
        });
      }

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

    // ===== /concurs_list — список активних розіграшів =====
    if (
      cmd === '/concurs_list' || cmd === 'concurs_list' ||
      cmd === '/contest_list' || cmd === 'contest_list' ||
      cmd === 'конкурси'
    ) {
      const activeRes = await redis('SMEMBERS', 'active_contests');
      const activeIds = activeRes?.result || [];

      if (activeIds.length === 0) {
        await sendTg(TOKEN, 'sendMessage', {
          chat_id: chatId,
          text: '🎁 Наразі немає активних розіграшів.\n\nСтворити новий: `/concurs`',
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ ok: true });
      }

      let textRes = `📋 *АКТИВНІ РОЗІГРАШІ (${activeIds.length}):*\n\n`;
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
            `⚙️ Завершити: \`/concurs_finish ${cId}\`\n` +
            `❌ Скасувати: \`/concurs_cancel ${cId}\`\n\n`;
        } catch { /* skip */ }
      }

      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: textRes,
        parse_mode: 'Markdown',
      });
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
