/**
 * Фокача Клікер — Telegram Bot (Vercel Serverless)
 * Webhook handler: Telegram надсилає сюди кожне повідомлення.
 */

const WEBAPP_URL = 'https://nout0688-cloud.github.io/focaccia-clicker/';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, msg: '🫓 Focaccia bot is alive!' });
  }

  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN not set' });
  }

  const update = req.body;
  const msg = update?.message;

  if (msg?.text === '/start') {
    const chatId = msg.chat.id;
    const name = msg.from?.first_name || 'друже';

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          `Привіт, ${name}! 👋\n\n` +
          `🫓 *Фокача Клікер* — клікай, їж, прокачуйся\\!\n\n` +
          `🏗️ Будуй пекарні, наймай бабусь, відкривай філії в Італії та навіть запускай космічні пекарні\\! 🚀\n\n` +
          `⚡ *Фішки гри:*\n` +
          `• Комбо\\-система до x3\n` +
          `• 5% шанс криту x10 💥\n` +
          `• Золота фокача з бонусами ✨\n` +
          `• Френзі x7 🔥\n` +
          `• Система престижу ♻️\n` +
          `• 16 досягнень 🏆\n\n` +
          `Натисни кнопку нижче і почни клікати\\! 👇`,
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🫓 Грати у Фокача Клікер!',
                web_app: { url: WEBAPP_URL },
              },
            ],
          ],
        },
      }),
    });
  }

  res.status(200).json({ ok: true });
}
