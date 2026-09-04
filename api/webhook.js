/**
 * Фокача Клікер — Telegram Bot (Vercel Serverless)
 * Webhook handler + зберігає юзерів для нагадувань.
 */

const WEBAPP_URL = 'https://nout0688-cloud.github.io/focaccia-clicker/';

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

async function sendMessage(token, chatId, text, keyboard) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, msg: '🫓 Focaccia bot is alive!' });
  }

  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN not set' });
  }

  try {
    const update = req.body;
    const msg = update?.message;

    if (msg?.text === '/start') {
      const chatId = msg.chat.id;
      const name = msg.from?.first_name || 'друже';

      // Зберігаємо юзера для нагадувань
      await redis(
        'HSET',
        'users',
        String(chatId),
        JSON.stringify({ name, lastActive: Date.now(), reminded: false }),
      );

      const text =
        `Привіт, ${name}! 👋\n\n` +
        `🫓 Фокача Клікер — клікай, їж, прокачуйся!\n\n` +
        `🏗️ Будуй пекарні, наймай бабусь, відкривай філії в Італії та навіть запускай космічні пекарні! 🚀\n\n` +
        `⚡ Фішки гри:\n` +
        `• Комбо-система до x3\n` +
        `• 5% шанс криту x10 💥\n` +
        `• Золота фокача з бонусами ✨\n` +
        `• Френзі x7 🔥\n` +
        `• Система престижу ♻️\n` +
        `• 16 досягнень 🏆\n\n` +
        `Натисни кнопку нижче і почни клікати! 👇`;

      await sendMessage(TOKEN, chatId, text, {
        inline_keyboard: [
          [{ text: '🫓 Грати у Фокача Клікер!', web_app: { url: WEBAPP_URL } }],
        ],
      });
    }

    // Будь-яке повідомлення — оновлюємо lastActive
    if (msg?.from?.id) {
      const chatId = msg.chat.id;
      const name = msg.from.first_name || 'друже';
      await redis(
        'HSET',
        'users',
        String(chatId),
        JSON.stringify({ name, lastActive: Date.now(), reminded: false }),
      );
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Bot error:', err);
    res.status(200).json({ ok: true, error: err.message });
  }
};
