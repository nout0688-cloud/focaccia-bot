/**
 * Лідерборд гравців.
 * GET  /api/leaderboard — топ-50 гравців за з'їденими фокачами.
 * POST /api/leaderboard — оновити статистику гравця { userId, name, username, total, prestige }.
 */

const FRESH_MS = 30 * 24 * 60 * 60 * 1000; // гравців, які не заходили 30 днів, не показуємо
const ONLINE_MS = 3 * 60 * 1000; // репорт кожні 60с — онлайн якщо свіжий ≤ 3 хв
const HOUR_MS = 60 * 60 * 1000;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 1975429762;

// Карма 0–100: детект −15, випробування +10 (макс 75), +1 за годину онлайн-гри.
// Карма < 25 → «Тінь бабусі»: лідерборд заморожено.
async function getKarma(userId) {
  const raw = await redis('HGET', 'ac_karma', userId);
  if (!raw?.result) return { k: 100, on: 0 };
  try {
    const d = JSON.parse(raw.result);
    return { k: Math.max(0, Math.min(100, parseInt(d.k) || 0)), on: parseInt(d.on) || 0 };
  } catch { return { k: 100, on: 0 }; }
}

async function setKarma(userId, karma, onlineMs) {
  await redis('HSET', 'ac_karma', userId, JSON.stringify({ k: karma, on: onlineMs, ts: Date.now() }));
}

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

function parsePlayers(data, balanceMap = null, sortBy = 'total') {
  if (!data?.result || data.result.length === 0) return [];
  const players = [];
  const entries = data.result;
  for (let i = 0; i < entries.length; i += 2) {
    try {
      const p = JSON.parse(entries[i + 1]);
      if (p.ts && Date.now() - p.ts > FRESH_MS) continue; // протухлий запис
      if (p.n && p.n.includes('\uFFFD')) continue; // пошкоджене кодування — приховуємо
      const id = String(entries[i]);
      const bal = balanceMap ? balanceMap.get(id) : null;
      const diamonds = p.d !== undefined ? Math.max(0, parseInt(p.d, 10) || 0) : (bal?.d || 0);
      players.push({
        id,
        name: p.n || 'Гравець',
        username: p.u || '',
        total: Number(p.t) || 0,
        prestige: parseInt(p.p, 10) || 0,
        diamonds,
        clicks: Number(p.k) || 0,
        bosses: Number(p.b) || 0,
        achievements: Number(p.ac) || 0,
        showcase: Array.isArray(p.sc) && p.sc.length ? p.sc : ['clicks', 'total', 'diamonds'],
        frame: p.fr || 'frame_default',
        color: p.cl || 'name_default',
        avatar: p.av || '',
        online: !!p.ts && Date.now() - p.ts < ONLINE_MS,
        isDev: String(id) === String(ADMIN_ID),
      });
    } catch { /* skip corrupted */ }
  }

  if (sortBy === 'diamonds') {
    players.sort((a, b) => (b.diamonds - a.diamonds) || (b.total > a.total ? 1 : b.total < a.total ? -1 : 0) || (b.prestige - a.prestige));
  } else if (sortBy === 'rebirth' || sortBy === 'prestige') {
    players.sort((a, b) => (b.prestige - a.prestige) || (b.total > a.total ? 1 : b.total < a.total ? -1 : 0) || (b.diamonds - a.diamonds));
  } else {
    players.sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : (b.prestige - a.prestige) || (b.diamonds - a.diamonds)));
  }
  return players;
}

module.exports = async function handler(req, res) {
  // CORS headers for GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ===== POST — оновити статистику гравця / подія античиту =====
    if (req.method === 'POST') {
      const body = req.body || {};
      const userId = String(body.userId || '');
      if (!/^\d{1,20}$/.test(userId)) {
        return res.status(400).json({ ok: false, error: 'invalid userId' });
      }

      // Події античиту — мʼяка лестниця карми:
      // challenge запущено: 0 (перший), −10 якщо підтвердження ≤ 30 хв, −15 якщо ≥ 6 страйків/24ч
      // challenge провалено: −5. challenge пройдено: 0.
      if (body.event === 'flag') {
        const now = Date.now();
        let strikes = [];
        const sRaw = await redis('HGET', 'ac_strikes', userId);
        if (sRaw?.result) {
          try { strikes = JSON.parse(sRaw.result); } catch { strikes = []; }
        }
        const prevStrike = strikes.length ? strikes[strikes.length - 1] : 0;
        strikes.push(now);
        if (strikes.length > 20) strikes = strikes.slice(-20);
        await redis('HSET', 'ac_strikes', userId, JSON.stringify(strikes));
        await redis('HINCRBY', 'ac_total', userId, '1');

        // Зберігаємо дебаг-лог детекту (останні 20 записів)
        if (body.debug && typeof body.debug === 'object') {
          let logs = [];
          const logsRaw = await redis('HGET', 'ac_debug_log', userId);
          if (logsRaw?.result) { try { logs = JSON.parse(logsRaw.result); } catch { logs = []; } }
          logs.push(body.debug);
          if (logs.length > 20) logs = logs.slice(-20);
          await redis('HSET', 'ac_debug_log', userId, JSON.stringify(logs));
        }

        const recent24 = strikes.filter((ts) => now - ts < 24 * 3600000).length;
        const { k } = await getKarma(userId);
        let karma = k;
        if (recent24 >= 6) karma = Math.max(0, karma - 15);       // стійкий порушник
        else if (prevStrike && now - prevStrike < 30 * 60000) karma = Math.max(0, karma - 10); // повторне підтвердження
        await setKarma(userId, karma, 0);
        if (karma < 50) await redis('HSET', 'ac_active', userId, '1');
        else await redis('HDEL', 'ac_active', userId);
        return res.status(200).json({ ok: true, karma });
      }
      if (body.event === 'fail') {
        const { k } = await getKarma(userId);
        const karma = Math.max(0, k - 5); // не прошів challenge
        await setKarma(userId, karma, 0);
        return res.status(200).json({ ok: true, karma });
      }
      if (body.event === 'clear') {
        const { k } = await getKarma(userId);
        await redis('HDEL', 'ac_active', userId); // підозру знято, карма не міняється
        return res.status(200).json({ ok: true, karma: k });
      }

      const total = Math.max(0, Math.min(Number(body.total) || 0, 1e24));
      const prestige = Math.max(0, Math.min(parseInt(body.prestige, 10) || 0, 1e6));
      const diamonds = Math.max(0, Math.min(parseInt(body.diamonds, 10) || 0, 1e9));
      const clicks = Math.max(0, Math.min(Math.floor(Number(body.clicks)) || 0, 1e9));
      const name = String(body.name || 'Гравець')
        .replace(/\uFFFD/g, '') // вирізаємо пошкоджені символи кодування
        .trim()
        .slice(0, 24) || 'Гравець';
      const username = String(body.username || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);

      const now = Date.now();
      const prevRaw = await redis('HGET', 'leaderboard', userId);
      let prev = null;
      if (prevRaw?.result) {
        try { prev = JSON.parse(prevRaw.result); } catch { /* skip corrupted */ }
      }

      // Карма: +1 за годину онлайн-гри (рахуємо час між репортами, максимум 2 хв за раз)
      const cur = await getKarma(userId);
      let karma = cur.k;
      let onlineMs = cur.on + Math.min(now - (prev?.ts || now), 120000);
      while (onlineMs >= HOUR_MS && karma < 100) { karma = Math.min(100, karma + 1); onlineMs -= HOUR_MS; }

      // Античит: порівнюємо дельту кліків з попереднього репорту.
      // Рука людини не дає стабільно > 400 кл/мин (6.7/с) цілодобово.
      if (prev && typeof prev.k === 'number' && prev.ts) {
        const dClicks = clicks - prev.k;
        const dMin = (now - prev.ts) / 60000;
        if (dClicks > 0 && dMin > 0 && dClicks / dMin > 400) {
          karma = Math.max(0, karma - 15);
          await redis('HINCRBY', 'ac_total', userId, '1');
          await redis('HSET', 'ac_active', userId, '1');
        }
      }
      await setKarma(userId, karma, onlineMs);

      // Карма < 25 — «Тінь бабусі»: прогрес у лідерборді заморожено
      const frozen = karma < 25 && prev && typeof prev.t === 'number';
      const storedTotal = frozen ? prev.t : total;
      const bosses = Math.max(0, Math.min(parseInt(body.bosses, 10) || 0, 1e6));
      const achievements = Math.max(0, Math.min(parseInt(body.achievements, 10) || 0, 100));
      const showcase = Array.isArray(body.showcase) ? body.showcase.slice(0, 3) : (prev?.sc || ['clicks', 'total', 'diamonds']);
      const frame = String(body.frame || prev?.fr || 'frame_default').slice(0, 32);
      const color = String(body.color || prev?.cl || 'name_default').slice(0, 32);
      const avatar = String(body.avatar || prev?.av || '').slice(0, 256);
      await redis('HSET', 'leaderboard', userId, JSON.stringify({
        n: name,
        u: username,
        t: storedTotal,
        p: prestige,
        d: diamonds,
        k: clicks,
        b: bosses,
        ac: achievements,
        sc: showcase,
        fr: frame,
        cl: color,
        av: avatar,
        ts: now
      }));

      // Автоматичне оновлення users та usernames при звіті клієнта
      try {
        const uRaw = await redis('HGET', 'users', userId);
        let uData = {};
        if (uRaw?.result) {
          try { uData = JSON.parse(uRaw.result); } catch { /* */ }
        }
        const oldUname = uData.username || '';
        if (oldUname && oldUname.toLowerCase() !== username.toLowerCase()) {
          await redis('HDEL', 'usernames', oldUname.toLowerCase());
        }
        if (username) {
          await redis('HSET', 'usernames', username.toLowerCase(), userId);
        }
        uData.name = name;
        uData.username = username;
        uData.lastActive = now;
        await redis('HSET', 'users', userId, JSON.stringify(uData));
      } catch { /* skip */ }

      const rawFoc = body.focaccia !== undefined && body.focaccia !== null ? Math.max(0, Math.min(Number(body.focaccia) || 0, 1e24)) : null;
      const rawDia = body.diamonds !== undefined && body.diamonds !== null ? Math.max(0, Math.min(Number(body.diamonds) || 0, 1e9)) : null;

      // Оновлюємо user_balance тільки якщо поля передані
      if (rawFoc !== null || rawDia !== null) {
        let prevFoc = 0;
        let prevDia = 0;
        const prevBal = await redis('HGET', 'user_balance', userId);
        if (prevBal?.result) {
          try {
            const pb = JSON.parse(prevBal.result);
            prevFoc = Number(pb.f) || 0;
            prevDia = Number(pb.d) || 0;
          } catch { /* */ }
        }
        const finalFoc = rawFoc !== null ? rawFoc : prevFoc;
        const finalDia = rawDia !== null ? rawDia : prevDia;
        await redis('HSET', 'user_balance', userId, JSON.stringify({ f: finalFoc, d: finalDia, ts: now }));
      }

      // Рахуємо місце гравця одразу після оновлення для всіх 3 категорій
      const allPlayers = parsePlayers(await redis('HGETALL', 'leaderboard'), null, 'total');
      const rankTotal = allPlayers.findIndex((p) => p.id === userId) + 1;
      const rankDiamonds = [...allPlayers].sort((a, b) => (b.diamonds - a.diamonds) || (b.total - a.total)).findIndex((p) => p.id === userId) + 1;
      const rankRebirth = [...allPlayers].sort((a, b) => (b.prestige - a.prestige) || (b.total - a.total)).findIndex((p) => p.id === userId) + 1;

      return res.status(200).json({
        ok: true,
        rank: rankTotal > 0 ? rankTotal : null,
        ranks: {
          total: rankTotal > 0 ? rankTotal : null,
          diamonds: rankDiamonds > 0 ? rankDiamonds : null,
          rebirth: rankRebirth > 0 ? rankRebirth : null,
        },
        karma,
        frozen,
      });
    }

    // ===== GET — топ гравців (з позначками ⚠️) =====
    let sortBy = 'total';
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      sortBy = req.query?.sort || req.query?.category || urlObj.searchParams.get('sort') || urlObj.searchParams.get('category') || 'total';
    } catch { /* ignore */ }

    const [activeData, lbData, balancesData] = await Promise.all([
      redis('HGETALL', 'ac_karma'),
      redis('HGETALL', 'leaderboard'),
      redis('HGETALL', 'user_balance'),
    ]);

    const karmaMap = new Map();
    if (activeData?.result) {
      for (let i = 0; i < activeData.result.length; i += 2) {
        try { karmaMap.set(activeData.result[i], JSON.parse(activeData.result[i + 1]).k || 0); } catch { /* */ }
      }
    }

    const balanceMap = new Map();
    if (balancesData?.result) {
      for (let i = 0; i < balancesData.result.length; i += 2) {
        try {
          const b = JSON.parse(balancesData.result[i + 1]);
          balanceMap.set(String(balancesData.result[i]), { d: Number(b.d) || 0, f: Number(b.f) || 0 });
        } catch { /* */ }
      }
    }

    const players = parsePlayers(lbData, balanceMap, sortBy)
      .slice(0, 50)
      .map((p) => ({ ...p, flag: (karmaMap.get(p.id) ?? 100) < 50 }));
    return res.status(200).json({ ok: true, players, sortBy });
  } catch (err) {
    console.error('Leaderboard error:', err);
    if (req.method === 'POST') return res.status(200).json({ ok: false });
    return res.status(200).json({ ok: true, players: [] });
  }
};
