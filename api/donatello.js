/**
 * Donatello.to Card Payments & Webhook API
 * GET /api/donatello — повертає налаштований нікнейм Donatello
 * GET /api/donatello?check=1&userId=123&pkgId=gems_150 — перевіряє факт оплати через API Donatello
 * POST /api/donatello — обробляє вебхук від Donatello.to
 */

const PACKAGES = {
  gems_50: {
    title: '50 Діамантів 💎',
    diamonds: 50,
    uah: 20,
  },
  gems_150: {
    title: '150 Діамантів 💎',
    diamonds: 150,
    uah: 50,
  },
  gems_500: {
    title: '500 Діамантів 💎',
    diamonds: 500,
    uah: 150,
  },
  gems_1500: {
    title: '1500 Діамантів 💎',
    diamonds: 1500,
    uah: 400,
  },
  starter_pack: {
    title: '⚡ Стартовий набір',
    diamonds: 100,
    uah: 35,
    weapon: 'vip_hammer',
  },
  tip_dev: {
    title: '☕ Чайові розробнику',
    diamonds: 25,
    uah: 20,
    patron: true,
  },
};

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

async function grantDonationReward(userId, pkgId, txId, amountUah) {
  const pkg = PACKAGES[pkgId];
  if (!pkg) return { ok: false, error: 'Unknown package' };

  // Захист від повторного нарахування (TTL 30 днів = 2592000 сек)
  const setnx = await redis('SET', `donatello_tx:${txId}`, '1', 'EX', '2592000', 'NX');
  if (!setnx?.result && setnx?.result !== 'OK') {
    return { ok: false, alreadyClaimed: true };
  }

  // 1. Нарахування діамантів
  await redis('INCRBY', `reward_gem:${userId}`, String(pkg.diamonds));
  await redis('SET', `reward_gem_source:${userId}`, 'donatello');

  // 2. Спеціальні нагороди
  if (pkg.weapon) {
    await redis('HSET', `user_extra:${userId}`, 'vip_upgrade', pkg.weapon);
  }
  if (pkg.patron) {
    await redis('HSET', `user_extra:${userId}`, 'badge_patron', '1');
  }

  // 3. Повідомлення гравцю в Telegram
  const botToken = process.env.BOT_TOKEN;
  if (botToken) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: Number(userId),
        text: `🎉 *Дякуємо за підтримку гри через Donatello!*\n\n💎 Нараховано: *+${pkg.diamonds} Діамантів*\n💵 Оплачено: *${amountUah} ₴*\n📦 Пакет: *${pkg.title}*${pkg.weapon ? '\n🪵 Отримано зброю: *Бойова скалка*' : ''}${pkg.patron ? '\n💖 Отримано титул: *Меценат*' : ''}\n\n_Нагороду вже доставлено у твою гру!_ ✨`,
        parse_mode: 'Markdown',
      }),
    }).catch(() => {});
  }

  return { ok: true, granted: true, diamonds: pkg.diamonds, title: pkg.title };
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Отримання публічної інформації або перевірка оплати
    if (req.method === 'GET') {
      const isCheck = req.query.check === '1' || req.query.check === 'true';

      // Отримання збереженого нікнейму Donatello
      const nickData = await redis('HGET', 'config', 'donatello_nickname');
      const nickname = nickData?.result || process.env.DONATELLO_NICKNAME || '';

      if (!isCheck) {
        return res.status(200).json({
          ok: true,
          nickname,
          packages: PACKAGES,
        });
      }

      // Перевірка конкретної оплати
      const userId = String(req.query.userId || '').trim();
      const pkgId = String(req.query.pkgId || '').trim();

      if (!userId || !pkgId) {
        return res.status(400).json({ ok: false, error: 'userId and pkgId are required' });
      }

      const pkg = PACKAGES[pkgId];
      if (!pkg) {
        return res.status(400).json({ ok: false, error: 'Invalid packageId' });
      }

      const tokenData = await redis('HGET', 'config', 'donatello_token');
      const donatelloToken = tokenData?.result || process.env.DONATELLO_TOKEN || '';

      if (!donatelloToken) {
        return res.status(200).json({
          ok: false,
          error: 'Donatello token is not configured in admin panel yet (/setdonatello <nick> <token>)',
        });
      }

      // Робимо запит до офіційного API Donatello
      const donRes = await fetch('https://donatello.to/api/v1/donates?size=40', {
        headers: {
          'X-Token': donatelloToken,
        },
      });

      if (!donRes.ok) {
        console.error('Donatello API HTTP error:', donRes.status, await donRes.text());
        return res.status(500).json({ ok: false, error: 'Failed to contact Donatello API' });
      }

      const donData = await donRes.json();
      // donData може бути масивом або об'єктом з полем content/donates
      const donates = Array.isArray(donData)
        ? donData
        : Array.isArray(donData.content)
        ? donData.content
        : Array.isArray(donData.donates)
        ? donData.donates
        : [];

      // Шукаємо транзакцію гравця:
      // Коментар містить FK_{userId}_{pkgId} або FK_{userId}
      // Сума не менша за ціну пакета
      const searchTag = `FK_${userId}_${pkgId}`.toUpperCase();
      const fallbackTag = `FK_${userId}`.toUpperCase();

      for (const item of donates) {
        const msg = String(item.message || item.comment || '').toUpperCase();
        const txId = String(item.pubId || item.id || '');
        const amount = Number(item.amount || 0);

        if (!txId) continue;

        const isExactMatch = msg.includes(searchTag);
        const isFallbackMatch = msg.includes(fallbackTag) && amount >= pkg.uah;

        if (isExactMatch || isFallbackMatch) {
          // Перевіряємо, чи транзакція ще не була використана
          const checkTx = await redis('GET', `donatello_tx:${txId}`);
          if (!checkTx?.result) {
            const grantRes = await grantDonationReward(userId, pkgId, txId, amount);
            if (grantRes.ok) {
              return res.status(200).json({
                ok: true,
                granted: true,
                diamonds: pkg.diamonds,
                title: pkg.title,
                txId,
              });
            }
          }
        }
      }

      return res.status(200).json({
        ok: true,
        granted: false,
        message: 'Оплату ще не знайдено серед останніх донатів Donatello. Перевірте, чи пройшов платіж у банку.',
      });
    }

    // 2. Обробка Webhook POST від Donatello
    if (req.method === 'POST') {
      const body = req.body || {};
      const data = body.data || body;

      const txId = String(data.pubId || data.id || body.pubId || body.id || '');
      const amount = Number(data.amount || body.amount || 0);
      const message = String(data.message || data.comment || body.message || body.comment || '');

      if (!txId) {
        return res.status(400).json({ ok: false, error: 'Missing pubId/id' });
      }

      // Шукаємо патерн FK_{userId}_{pkgId}
      const match = message.match(/FK_(\d+)_([a-zA-Z0-9_]+)/i);
      if (match) {
        const userId = match[1];
        const pkgId = match[2];
        const grantRes = await grantDonationReward(userId, pkgId, txId, amount);
        return res.status(200).json(grantRes);
      }

      // Якщо коментар не містить префіксу FK_ — просто підтверджуємо прийом
      return res.status(200).json({ ok: true, processed: false, reason: 'No FK tag in message' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Donatello handler error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};
