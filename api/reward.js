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
  const userLastReset = parseInt(req.query.lastReset || '0');

  // Validate: userId must be a positive integer (Telegram user IDs are numeric)
  if (!userId || !/^\d+$/.test(userId) || parseInt(userId, 10) <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid userId' });
  }

  try {
    // Check global reset time
    const globalResetData = await redis('GET', 'global_reset_time');
    const globalResetTime = globalResetData?.result ? parseInt(globalResetData.result) : 0;

    // Check individual reset flag
    const resetFlag = await redis('GET', `reset:${userId}`);

    if (resetFlag?.result || (globalResetTime > 0 && userLastReset < globalResetTime)) {
      if (resetFlag?.result) await redis('DEL', `reset:${userId}`);
      await redis('DEL', `reward:${userId}`);
      await redis('DEL', `rebirth:${userId}`);
      return res.status(200).json({
        ok: true,
        reset: true,
        resetTime: Math.max(globalResetTime, Date.now()),
      });
    }

    const data = await redis('GET', `reward:${userId}`);
    const amount = data?.result ? parseInt(data.result) : 0;

    const rbData = await redis('GET', `rebirth:${userId}`);
    const rebirths = rbData?.result ? parseInt(rbData.result) : 0;

    if (amount > 0 || rebirths > 0) {
      // Clear pending grants after claiming
      if (amount > 0) await redis('DEL', `reward:${userId}`);
      if (rebirths > 0) await redis('DEL', `rebirth:${userId}`);
      return res.status(200).json({ ok: true, reward: amount, rebirth: rebirths });
    }

    return res.status(200).json({ ok: true, reward: 0 });
  } catch (err) {
    console.error('Reward error:', err);
    return res.status(200).json({ ok: true, reward: 0 });
  }
};
