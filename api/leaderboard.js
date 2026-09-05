/**
 * Лідерборд гравців.
 * GET  /api/leaderboard — топ-50 гравців за з'їденими фокачами.
 * POST /api/leaderboard — оновити статистику гравця { userId, name, username, total, prestige }.
 */

const FRESH_MS = 30 * 24 * 60 * 60 * 1000; // гравців, які не заходили 30 днів, не показуємо

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

function parsePlayers(data) {
  if (!data?.result || data.result.length === 0) return [];
  const players = [];
  const entries = data.result;
  for (let i = 0; i < entries.length; i += 2) {
    try {
      const p = JSON.parse(entries[i + 1]);
      if (p.ts && Date.now() - p.ts > FRESH_MS) continue; // протухлий запис
      if (p.n && p.n.includes('\uFFFD')) continue; // пошкоджене кодування — приховуємо
      players.push({ id: entries[i], name: p.n || 'Гравець', username: p.u || '', total: p.t || 0, prestige: p.p || 0 });
    } catch { /* skip corrupted */ }
  }
  players.sort((a, b) => b.total - a.total);
  return players;
}

module.exports = async function handler(req, res) {
  // CORS headers for GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ===== POST — оновити статистику гравця =====
    if (req.method === 'POST') {
      const body = req.body || {};
      const userId = String(body.userId || '');
      if (!/^\d{1,20}$/.test(userId)) {
        return res.status(400).json({ ok: false, error: 'invalid userId' });
      }

      const total = Math.max(0, Math.min(Number(body.total) || 0, 1e15));
      const prestige = Math.max(0, Math.min(parseInt(body.prestige, 10) || 0, 1e6));
      const name = String(body.name || 'Гравець')
        .replace(/\uFFFD/g, '') // вирізаємо пошкоджені символи кодування
        .trim()
        .slice(0, 24) || 'Гравець';
      const username = String(body.username || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);

      await redis('HSET', 'leaderboard', userId, JSON.stringify({ n: name, u: username, t: total, p: prestige, ts: Date.now() }));

      // Рахуємо місце гравця одразу після оновлення
      const rank = parsePlayers(await redis('HGETALL', 'leaderboard')).findIndex((p) => p.id === userId) + 1;

      return res.status(200).json({ ok: true, rank: rank > 0 ? rank : null });
    }

    // ===== GET — топ гравців =====
    const players = parsePlayers(await redis('HGETALL', 'leaderboard'));
    return res.status(200).json({ ok: true, players: players.slice(0, 50) });
  } catch (err) {
    console.error('Leaderboard error:', err);
    if (req.method === 'POST') return res.status(200).json({ ok: false });
    return res.status(200).json({ ok: true, players: [] });
  }
};
