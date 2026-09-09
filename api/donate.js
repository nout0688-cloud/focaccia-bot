/**
 * Telegram Stars In-App Purchases (Донат через Зірки)
 * POST /api/donate
 * Body: { userId, packageId }
 */

const PACKAGES = {
  gems_50: {
    title: '50 Діамантів 💎',
    description: 'Жменя сяючих діамантів для прокачок у Фокача Клікер',
    stars: 10,
    diamonds: 50,
  },
  gems_150: {
    title: '150 Діамантів 💎',
    description: 'Мішечок сяючих діамантів (+15 бонус)',
    stars: 25,
    diamonds: 150,
  },
  gems_500: {
    title: '500 Діамантів 💎',
    description: 'Скриня сяючих діамантів (+75 бонус)',
    stars: 75,
    diamonds: 500,
  },
  gems_1500: {
    title: '1500 Діамантів 💎',
    description: 'Скарбниця Фокачі (+300 бонус)',
    stars: 199,
    diamonds: 1500,
  },
  starter_pack: {
    title: '⚡ Стартовий набір',
    description: '100 💎 + зброя «Бойова скалка» 🪵 для боротьби з босами',
    stars: 15,
    diamonds: 100,
  },
  tip_dev: {
    title: '☕ Чайові розробнику',
    description: '25 💎 + особлива позначка 💖 Меценат у профілі',
    stars: 10,
    diamonds: 25,
  },
};

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: return config and packages
  if (req.method === 'GET' && !req.query.packageId) {
    return res.status(200).json({
      ok: true,
      packages: PACKAGES,
    });
  }

  const TOKEN = process.env.BOT_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN not configured' });
  }

  const body = req.body || {};
  const userId = String(body.userId || req.query.userId || '').trim();
  const packageId = String(body.packageId || req.query.packageId || '').trim();

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const pkg = PACKAGES[packageId];
  if (!pkg) {
    return res.status(400).json({ error: 'Invalid packageId' });
  }

  try {
    const payload = `${userId}:${packageId}:${Date.now()}`;
    const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: pkg.title,
        description: pkg.description,
        payload,
        currency: 'XTR',
        prices: [{ label: pkg.title, amount: pkg.stars }],
      }),
    });

    const data = await tgRes.json();
    if (!data.ok) {
      console.error('Telegram createInvoiceLink error:', data);
      return res.status(500).json({ error: data.description || 'Failed to create invoice link' });
    }

    return res.status(200).json({
      ok: true,
      invoiceLink: data.result,
      package: {
        id: packageId,
        title: pkg.title,
        stars: pkg.stars,
        diamonds: pkg.diamonds,
      },
    });
  } catch (err) {
    console.error('Invoice creation exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
