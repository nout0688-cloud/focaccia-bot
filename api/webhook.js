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

function isAdmin(userId) {
  return ADMIN_ID !== null && userId === ADMIN_ID;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, msg: '🫓 Focaccia bot is alive!' });
  }

  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });

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

      // временная отладка: показываем, что пришла кнопка
      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(cqChat), text: `🐞 debug: кнопка «${dAction}» ${dArg || ''}` }),
        });
      } catch { /* ignore */ }

      try {
        // меню выбора соперника
        if (dAction === 'menu') {
        await sendTg(cqChat, '⚔️ Кого хочешь вызвать на дуэль?\nКто быстрее накликает 100 фокач — тот победил (+5💎)!', {
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
          await sendTg(cqChat, '👥 Пока нет других игроков — позови друга поставить игру!');
          return res.status(200).json({ ok: true });
        }
        const top = list.slice(0, 20);
        const rows = [];
        for (let i = 0; i < top.length; i += 2) {
          rows.push(top.slice(i, i + 2).map((p) => ({ text: p.username ? `@${p.username}` : p.name, callback_data: `duel:chal:${p.id}` })));
        }
        await sendTg(cqChat, '👥 Выбери соперника:', { reply_markup: { inline_keyboard: rows } });
        return res.status(200).json({ ok: true });
      }

      // ввод юзернейма
      if (dAction === 'byname') {
        await redis('SET', `duel_await:${cqChat}`, 'duel', 'EX', 300);
        await sendTg(cqChat, '✍️ Напиши юзернейм соперника (например @spuod):');
        return res.status(200).json({ ok: true });
      }

      // вызов конкретному игроку
      if (dAction === 'chal' && dArg) {
        if (String(dArg) === String(cqChat)) {
          await sendTg(cqChat, '❌ Нельзя вызвать самого себя');
          return res.status(200).json({ ok: true });
        }
        const tData = await redis('HGET', 'users', dArg);
        if (!tData?.result) {
          await sendTg(cqChat, '❌ Игрок не найден');
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
          body: JSON.stringify({ action: 'challenge', from: cqChat, fromName: myName, to: dArg }),
        });
        const data = await apiRes.json();
        if (!data.ok) {
          const why = data.error === 'shadow' ? '🚫 Карма слишком низка — дуэли закрыты (Тінь бабусі)' : '❌ Не удалось создать дуэль';
          await sendTg(cqChat, why);
          return res.status(200).json({ ok: true });
        }
        await sendTg(cqChat, `⚔️ Вызов отправлен ${tName}! У него 5 минут на ответ.`);
        return res.status(200).json({ ok: true });
      }

      // принять вызов
      if (dAction === 'accept' && dArg) {
        const host = req.headers.host || 'focaccia-bot.vercel.app';
        const apiRes = await fetch(`https://${host}/api/duel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accept', duelId: dArg, userId: cqChat }),
        });
        const data = await apiRes.json();
        if (!data.ok) {
          // уведомление вызывающему уже отправляет /api/duel
          await sendTg(cqChat, '⏱ Время вышло — дуэль отменена.');
        }
        // уведомления обоим игрокам с кнопкой мини-аппа отправляет /api/duel
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
        try { await sendTg(cqChat, `🐞 Ошибка дуэли: ${e.message}`); } catch { /* */ }
        return res.status(200).json({ ok: true });
      }
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
      if (text.startsWith('/')) {
        await sendTg(chatId, 'Ввод юзернейма отменён.');
        return res.status(200).json({ ok: true });
      }
      const uname = text.replace(/^@/, '').toLowerCase().trim();
      const tId = await redis('HGET', 'usernames', uname);
      if (!tId?.result) {
        await redis('SET', `duel_await:${chatId}`, 'duel', 'EX', 300);
        await sendTg(chatId, `❌ Игрок @${uname} не найден. Попробуй ещё раз:`);
        return res.status(200).json({ ok: true });
      }
      const host = req.headers.host || 'focaccia-bot.vercel.app';
      let myName = 'Гравець';
      const myRaw = await redis('HGET', 'users', String(chatId));
      if (myRaw?.result) { try { myName = JSON.parse(myRaw.result).name || myName; } catch { /* */ } }
      const apiRes = await fetch(`https://${host}/api/duel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', from: chatId, fromName: myName, to: tId.result }),
      });
      const data = await apiRes.json();
      if (!data.ok) {
        await sendTg(chatId, data.error === 'shadow' ? '🚫 Карма слишком низка — дуэли закрыты' : '❌ Не удалось создать дуэль');
      } else {
        await sendTg(chatId, `⚔️ Вызов отправлен @${uname}! У него 5 минут на ответ.`);
      }
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
        `• Комбо-система до x3\n` +
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
      await sendTg(TOKEN, 'sendMessage', {
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
          `📋 *Команди:*\n` +
          `• \`/users\` — список всіх юзерів\n` +
          `• \`/broadcast <текст>\` — розсилка всім\n` +
          `• \`/give <кількість>\` — видати собі фокачі\n` +
          `• \`/giveto <username> <кількість>\` — видати комусь\n` +
          `• \`/rebirth <кількість>\` — видати собі ребіртхи\n` +
          `• \`/rebirthto <username> <кількість>\` — видати комусь ребіртхи\n` +
          `• \`/check <username>\` — інфо про юзера\n` +
          `• \`/lb_clear\` — очистити лідерборд\n` +
          `• \`/reports\` — звіт античиту (хто детектило)\n` +
          `• \`/warn <username>\` — видати знак ⚠️ вручну\n` +
          `• \`/unflag <username>\` — зняти знак ⚠️ з гравця\n` +
          `• \`/reset <username>\` — скинути акаунт юзера\n` +
          `• \`/reset_all\` — скинути акаунти ВСІХ гравців`,
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

      await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: list, parse_mode: 'Markdown' });
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
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /giveto <username> <кількість>' });
        return res.status(200).json({ ok: true });
      }

      const targetUsername = parts[0].replace('@', '').toLowerCase();
      const amount = parseInt(parts[1]);

      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи правильну кількість' });
        return res.status(200).json({ ok: true });
      }

      // Find user by username
      const targetData = await redis('HGET', 'usernames', targetUsername);
      if (!targetData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Юзер @${targetUsername} не знайдений. Він повинен спершу запустити бота.` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = targetData.result;

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
        text: `✅ Нараховано *${amount.toLocaleString()}* фокач юзеру @${targetUsername}!`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /rebirthto <username> <amount>
    if (cmd.startsWith('/rebirthto ') || cmd.startsWith('rebirthto ')) {
      const raw = text.replace(/^\/?rebirthto\s+/i, '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /rebirthto <username> <кількість>' });
        return res.status(200).json({ ok: true });
      }

      const targetUsername = parts[0].replace('@', '').toLowerCase();
      const amount = parseInt(parts[1]);

      if (!amount || amount <= 0) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Вкажи правильну кількість' });
        return res.status(200).json({ ok: true });
      }

      // Find user by username
      const targetData = await redis('HGET', 'usernames', targetUsername);
      if (!targetData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Юзер @${targetUsername} не знайдений. Він повинен спершу запустити бота.` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = targetData.result;

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
        text: `✅ Нараховано *${amount}* ребіртх(ів) юзеру @${targetUsername}!`,
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

    // /check <username>
    if (cmd.startsWith('/check ') || cmd.startsWith('check ')) {
      const targetUsername = text.replace(/^\/?check\s+/i, '').replace('@', '').toLowerCase().trim();
      const targetData = await redis('HGET', 'usernames', targetUsername);
      if (!targetData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ @${targetUsername} не знайдений` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = targetData.result;
      const userData = await redis('HGET', 'users', targetChatId);
      const pending = await redis('GET', `reward:${targetChatId}`);
      const pendingRb = await redis('GET', `rebirth:${targetChatId}`);

      let info = `👤 *@${targetUsername}*\nID: \`${targetChatId}\`\n`;
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

    // /lb_clear — wipe the leaderboard
    if (cmd === '/lb_clear' || cmd === 'lb_clear') {
      await redis('DEL', 'leaderboard');
      await redis('DEL', 'ac_total');
      await redis('DEL', 'ac_active');
      await redis('DEL', 'ac_karma');
      await redis('DEL', 'ac_strikes');
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

    // /warn <username> — вручну видати знак ⚠️ і знизити карму
    if (cmd.startsWith('/warn ') || cmd.startsWith('warn ')) {
      const targetUsername = text.replace(/^\/?warn\s+/i, '').replace('@', '').toLowerCase().trim();
      if (!targetUsername) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: '❌ Формат: /warn <username>' });
        return res.status(200).json({ ok: true });
      }
      const targetData = await redis('HGET', 'usernames', targetUsername);
      if (!targetData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ Юзер @${targetUsername} не знайдений. Він повинен спершу запустити бота.` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = targetData.result;
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
        text: `⚠️ Знак видано *@${targetUsername}*. Карма: *${karma}/100*.\nЗняти всі обмеження: \`/unflag @${targetUsername}\``,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /unflag <username> — повне відновлення: карма 100, без знаків і детектів
    if (cmd.startsWith('/unflag ') || cmd.startsWith('unflag ')) {
      const targetUsername = text.replace(/^\/?unflag\s+/i, '').replace('@', '').toLowerCase().trim();
      const targetData = await redis('HGET', 'usernames', targetUsername);
      if (!targetData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ @${targetUsername} не знайдений` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = targetData.result;
      await redis('HSET', 'ac_karma', targetChatId, JSON.stringify({ k: 100, on: 0, ts: Date.now() }));
      await redis('HDEL', 'ac_active', targetChatId);
      await redis('HDEL', 'ac_total', targetChatId);
      await redis('HDEL', 'ac_strikes', targetChatId);
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: `✅ *@${targetUsername}* повністю прощений: карма відновлена до *100/100*, знак ⚠️ та всі обмеження знято.`,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /reset <username> — request single user reset
    if ((cmd.startsWith('/reset ') || cmd.startsWith('reset ')) && !cmd.includes('reset_all')) {
      const targetUsername = text.replace(/^\/?reset\s+/i, '').replace('@', '').toLowerCase().trim();
      const targetData = await redis('HGET', 'usernames', targetUsername);
      if (!targetData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ @${targetUsername} не знайдений` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = targetData.result;
      await sendTg(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text:
          `⚠️ *ПІДТВЕРДЖЕННЯ СКИДАННЯ АКАУНТУ*\n\n` +
          `Ви дійсно хочете скинути весь прогрес для @${targetUsername} (ID: \`${targetChatId}\`)?\n\n` +
          `👉 Для підтвердження відправте:\n\`/confirm_reset @${targetUsername}\``,
        parse_mode: 'Markdown',
      });
      return res.status(200).json({ ok: true });
    }

    // /confirm_reset <username> — execute single user reset
    if (cmd.startsWith('/confirm_reset ') || cmd.startsWith('confirm_reset ')) {
      const targetUsername = text.replace(/^\/?confirm_reset\s+/i, '').replace('@', '').toLowerCase().trim();
      const targetData = await redis('HGET', 'usernames', targetUsername);
      if (!targetData?.result) {
        await sendTg(TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ @${targetUsername} не знайдений` });
        return res.status(200).json({ ok: true });
      }

      const targetChatId = targetData.result;
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
        text: `✅ Акаунт @${targetUsername} позначено на скидання! При наступному запуску гри весь його прогрес очиститься.`,
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

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Bot error:', err);
    res.status(200).json({ ok: true, error: err.message });
  }
};
