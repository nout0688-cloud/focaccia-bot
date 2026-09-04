/**
 * Cron Job — надсилає нагадування юзерам, які давно не грали.
 * Запускається раз на день через Vercel Cron.
 */

const WEBAPP_URL = 'https://nout0688-cloud.github.io/focaccia-clicker/';

const REMINDERS = [
  '👋 Ей, {name}! Твої фокачі черствіють без тебе... 🫓',
  '👵 Бабуся питає де ти! Фокачі самі себе не з\'їдять!',
  '🌟 УВАГА: золота фокача щойно з\'явилась! А може й ні... але краще перевір 😏',
  '🏭 Твої пекарні простоюють, {name}! Фокачі не випікаються!',
  '😢 {name}, ти вже давно не клікав... Фокачі сумують!',
  '🔥 Поки тебе не було, інші клікери обігнали тебе! Поверни лідерство, {name}!',
  '🫓 Псс, {name}... Є свіжа фокача. Гаряча. З розмарином. Ну ти ж не відмовишся?',
  '🚀 Твоя космо-пекарня вийшла на орбіту без тебе! Повертайся, командире {name}!',
];

async function redis(...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });

  try {
    // Отримуємо всіх юзерів
    const data = await redis('HGETALL', 'users');
    if (!data?.result || data.result.length === 0) {
      return res.status(200).json({ ok: true, reminded: 0 });
    }

    // HGETALL повертає [key, value, key, value, ...]
    const entries = data.result;
    let reminded = 0;
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    for (let i = 0; i < entries.length; i += 2) {
      const chatId = entries[i];
      let userData;
      try {
        userData = JSON.parse(entries[i + 1]);
      } catch {
        continue;
      }

      const timeSince = now - (userData.lastActive || 0);

      // Нагадуємо якщо не був активний > 24 годин і ще не нагадували
      if (timeSince > ONE_DAY && !userData.reminded) {
        const msg = REMINDERS[Math.floor(Math.random() * REMINDERS.length)]
          .replace(/\{name\}/g, userData.name || 'друже');

        try {
          await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: Number(chatId),
              text: msg,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🫓 Повернутись до гри!', web_app: { url: WEBAPP_URL } }],
                ],
              },
            }),
          });

          // Позначаємо що нагадали
          userData.reminded = true;
          await redis('HSET', 'users', chatId, JSON.stringify(userData));
          reminded++;
        } catch (err) {
          console.error(`Failed to remind ${chatId}:`, err.message);
        }
      }
    }

    res.status(200).json({ ok: true, reminded });
  } catch (err) {
    console.error('Remind error:', err);
    res.status(200).json({ ok: true, error: err.message });
  }
};
