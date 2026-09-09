/**
 * Telegram Stars & Monobank Jar In-App Purchases (Донат через Зірки та Банку Монобанк)
 * POST /api/donate
 */

const JAR_URL = 'https://send.monobank.ua/jar/9jugPBu9om';
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

const PACKAGES = {
  gems_50: {
    title: '50 Діамантів 💎',
    description: 'Жменя сяючих діамантів для прокачок у Фокача Клікер',
    stars: 10,
    priceUah: 10,
    diamonds: 50,
  },
  gems_150: {
    title: '150 Діамантів 💎',
    description: 'Мішечок сяючих діамантів (+15 бонус)',
    stars: 25,
    priceUah: 25,
    diamonds: 150,
  },
  gems_500: {
    title: '500 Діамантів 💎',
    description: 'Скриня сяючих діамантів (+75 бонус)',
    stars: 75,
    priceUah: 60,
    diamonds: 500,
  },
  gems_1500: {
    title: '1500 Діамантів 💎',
    description: 'Скарбниця Фокачі (+300 бонус)',
    stars: 199,
    priceUah: 150,
    diamonds: 1500,
  },
  starter_pack: {
    title: '⚡ Стартовий набір',
    description: '100 💎 + зброя «Бойова скалка» 🪵 для боротьби з босами',
    stars: 15,
    priceUah: 15,
    diamonds: 100,
    isStarter: true,
  },
  tip_dev: {
    title: '☕ Чайові розробнику',
    description: '25 💎 + особлива позначка 💖 Меценат у профілі',
    stars: 10,
    priceUah: 10,
    diamonds: 25,
    isTip: true,
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

  // GET / POST: Перевірка статусу замовлення на Банку
  if (req.query.action === 'check_order' || req.query.type === 'check_order' || req.body?.type === 'check_order') {
    const orderId = String(req.query.orderId || req.body?.orderId || '').trim().toUpperCase();
    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'orderId is required' });
    }
    const raw = await redis('GET', `order:${orderId}`);
    if (!raw?.result) {
      return res.status(404).json({ ok: false, error: 'Замовлення не знайдено' });
    }
    let order = {};
    try { order = JSON.parse(raw.result); } catch {}
    return res.status(200).json({
      ok: true,
      orderId,
      status: order.status || 'pending',
      diamonds: order.diamonds || 0,
      isStarter: !!order.isStarter,
      isTip: !!order.isTip,
    });
  }

  // GET: return config, jarUrl and packages
  if (req.method === 'GET' && !req.query.packageId) {
    return res.status(200).json({
      ok: true,
      jarUrl: JAR_URL,
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
  const reqType = String(body.type || req.query.type || '').trim();

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  // ===== 🏦 MONOBANK JAR ORDER =====
  if (reqType === 'jar_order') {
    const customAmount = parseInt(body.customAmount || req.query.customAmount || '0', 10);
    const username = String(body.username || req.query.username || '').replace(/^@/, '').trim();

    let orderPackageTitle = '';
    let amountUah = 0;
    let diamonds = 0;
    let isStarter = false;
    let isTip = false;

    if (packageId === 'custom_tip') {
      if (isNaN(customAmount) || customAmount < 1 || customAmount > 9999) {
        return res.status(400).json({ error: 'Сума чайових має бути від 1 до 9999 ₴' });
      }
      amountUah = customAmount;
      diamonds = Math.max(1, Math.round(customAmount * 2.5));
      orderPackageTitle = `💖 Чайові автору (${amountUah} ₴)`;
      isTip = true;
    } else {
      const pkg = PACKAGES[packageId];
      if (!pkg) {
        return res.status(400).json({ error: 'Недійсний ідентифікатор товару' });
      }
      orderPackageTitle = pkg.title;
      amountUah = pkg.priceUah;
      diamonds = pkg.diamonds;
      isStarter = !!pkg.isStarter;
      isTip = !!pkg.isTip;
    }

    // Генерація 4-значного коду (напр. FC-4821)
    const randNum = Math.floor(1000 + Math.random() * 9000);
    const orderId = `FC-${randNum}`;

    const orderData = {
      id: orderId,
      userId,
      username,
      packageId,
      title: orderPackageTitle,
      amountUah,
      diamonds,
      isStarter,
      isTip,
      status: 'pending',
      createdAt: Date.now(),
    };

    // Зберігаємо замовлення в Redis на 48 годин
    await redis('SET', `order:${orderId}`, JSON.stringify(orderData), 'EX', 172800);

    // Сповіщення розробнику (ADMIN_ID) у Telegram з інлайн-кнопками підтвердження
    const userTag = username ? `@${username}` : `(без @username)`;
    const adminMsgText =
`📥 <b>НОВЕ ЗАМОВЛЕННЯ НА БАНКУ!</b>

🧾 Замовлення: <code>#${orderId}</code>
👤 Гравець: ${userTag} (ID: <code>${userId}</code>)
📦 Товар: <b>${orderPackageTitle}</b>
💎 Нагорода: <b>+${diamonds} 💎</b>${isStarter ? ' + Бойова скалка 🪵' : ''}${isTip ? ' + титул Меценат 💖' : ''}
💵 До сплати: <b>${amountUah} ₴</b>
💬 <b>Коментар у банці має бути:</b> <code>${orderId}</code>

<i>Перевірте надходження у додатку Monobank і підтвердіть:</i>`;

    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_ID,
          text: adminMsgText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Підтвердити оплату', callback_data: `admin:order_ok:${orderId}` },
                { text: '❌ Відхилити', callback_data: `admin:order_no:${orderId}` },
              ],
            ],
          },
        }),
      });
    } catch (e) {
      console.error('Failed to notify admin about jar order:', e);
    }

    return res.status(200).json({
      ok: true,
      orderId,
      amountUah,
      diamonds,
      isStarter,
      isTip,
      comment: orderId,
      jarUrl: JAR_URL,
      title: orderPackageTitle,
    });
  }

  return res.status(400).json({ error: 'Невідомий тип запиту' });
};
