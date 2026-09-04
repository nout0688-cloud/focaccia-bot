/**
 * API для отримання/скасування нагород.
 * GET /api/reward?userId=<telegram_user_id> — повертає і видаляє очікувану нагороду.
 */

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

module.exports = async function handler(req, res) {
  // CORS headers for GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

  try {
    // Check if account reset was ordered by admin
    const resetFlag = await redis('GET', `reset:${userId}`);
    if (resetFlag?.result) {
      await redis('DEL', `reset:${userId}`);
      await redis('DEL', `reward:${userId}`);
      return res.status(200).json({ ok: true, reset: true });
    }

    const data = await redis('GET', `reward:${userId}`);
    const amount = data?.result ? parseInt(data.result) : 0;

    if (amount > 0) {
      // Clear the reward after claiming
      await redis('DEL', `reward:${userId}`);
      return res.status(200).json({ ok: true, reward: amount });
    }

    return res.status(200).json({ ok: true, reward: 0 });
  } catch (err) {
    console.error('Reward error:', err);
    return res.status(200).json({ ok: true, reward: 0 });
  }
};
