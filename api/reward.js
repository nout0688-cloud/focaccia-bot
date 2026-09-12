/**
 * API для отримання/скасування нагород, масової роздачі адміном та режиму технічної перерви.
 * GET /api/reward?userId=<id>&lastReset=<ts>&lastSkinsReset=<ts>
 * POST /api/reward (action: 'distribute' | 'reset_skins_all' | 'set_maintenance' | 'get_maintenance')
 */

const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 1975429762;
const WEBAPP_URL = 'https://nout0688-cloud.github.io/focaccia-clicker/?v=1.4.0';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body if present
  let body = {};
  if (req.body) {
    if (typeof req.body === 'string') {
      try { body = JSON.parse(req.body); } catch {}
    } else if (typeof req.body === 'object') {
      body = req.body;
    }
  }

  const action = body.action || req.query.action;

  // ===== 👑 ADMIN ACTION: SET MAINTENANCE MODE =====
  if (action === 'set_maintenance') {
    const reqAdminId = parseInt(body.adminId || req.query.adminId || '0', 10);
    if (reqAdminId !== ADMIN_ID) {
      return res.status(403).json({ ok: false, error: 'Unauthorized: admin only' });
    }
    const enabled = body.enabled === true || body.enabled === '1' || body.enabled === 1 || req.query.enabled === '1' || req.query.enabled === 'true';
    await redis('SET', 'maintenance_mode', enabled ? '1' : '0');
    return res.status(200).json({ ok: true, maintenance: enabled });
  }

  // ===== 👑 ACTION: GET MAINTENANCE STATUS =====
  if (action === 'get_maintenance') {
    const mRes = await redis('GET', 'maintenance_mode');
    const isM = mRes?.result === '1';
    return res.status(200).json({ ok: true, maintenance: isM });
  }

  // ===== 🤝 ACTION: ACK TRADE (Видалення трейду з pending_trades) =====
  if (action === 'ack_trade') {
    const uid = String(body.userId || req.query.userId || '').trim();
    const tId = String(body.tradeId || req.query.tradeId || '').trim();
    if (uid && tId) {
      await redis('HDEL', `pending_trades:${uid}`, tId);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'missing_params' });
  }

  // ===== 👑 ADMIN ACTION: DISTRIBUTE TO ALL PLAYERS =====
  if (action === 'distribute') {
    const reqAdminId = parseInt(body.adminId || req.query.adminId || '0', 10);
    if (reqAdminId !== ADMIN_ID) {
      return res.status(403).json({ ok: false, error: 'Unauthorized: admin only' });
    }

    const cur = (body.cur || req.query.cur || 'foc').toLowerCase();
    const amount = parseInt(body.amount || req.query.amount || '0', 10);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid amount' });
    }

    try {
      const ids = new Set();
      const usersData = await redis('HGETALL', 'users');
      if (usersData?.result) {
        for (let i = 0; i < usersData.result.length; i += 2) {
          ids.add(String(usersData.result[i]));
        }
      }
      const lbData = await redis('HGETALL', 'leaderboard');
      if (lbData?.result) {
        for (let i = 0; i < lbData.result.length; i += 2) {
          ids.add(String(lbData.result[i]));
        }
      }
      ids.add(String(ADMIN_ID));

      const idList = Array.from(ids);
      const botToken = process.env.BOT_TOKEN;
      const BATCH_SIZE = 10;
      let successCount = 0;

      for (let i = 0; i < idList.length; i += BATCH_SIZE) {
        const batch = idList.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map(async (uid) => {
            if (cur === 'gem' || cur === 'diamonds') {
              const ex = await redis('GET', `reward_gem:${uid}`);
              const c = ex?.result ? parseInt(ex.result, 10) : 0;
              await redis('SET', `reward_gem:${uid}`, String(c + amount));
              await redis('SET', `reward_gem_source:${uid}`, 'admin');
            } else {
              const ex = await redis('GET', `reward:${uid}`);
              const c = ex?.result ? parseInt(ex.result, 10) : 0;
              await redis('SET', `reward:${uid}`, String(c + amount));
              await redis('DEL', `deduct:${uid}`);
            }
            successCount++;

            if (botToken) {
              const textMsg = (cur === 'gem' || cur === 'diamonds')
                ? `💎 *Адміністратор роздав усім гравцям по +${amount} 💎 алмазів!*\nЗайди в гру щоб отримати.`
                : `🎁 *Адміністратор роздав усім гравцям по ${amount.toLocaleString()} фокач!*\n🫓 Зайди в гру щоб отримати.`;
              fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: Number(uid),
                  text: textMsg,
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[{ text: '🫓 Забрати нагороду!', web_app: { url: WEBAPP_URL } }]],
                  },
                }),
              }).catch(() => {});
            }
          })
        );
      }

      return res.status(200).json({ ok: true, count: successCount, amount, cur });
    } catch (err) {
      console.error('Distribute error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

async function resolveUserId(input) {
  if (!input) return null;
  const raw = String(input).replace(/^@/, '').trim();
  if (!raw) return null;
  if (/^\d{4,25}$/.test(raw)) return raw;
  const tData = await redis('HGET', 'usernames', raw.toLowerCase());
  if (tData?.result) return String(tData.result);
  const lbData = await redis('HGETALL', 'leaderboard');
  if (lbData?.result) {
    for (let i = 0; i < lbData.result.length; i += 2) {
      try {
        const lb = JSON.parse(lbData.result[i + 1]);
        if (lb.u && lb.u.toLowerCase() === raw.toLowerCase()) {
          return String(lbData.result[i]);
        }
      } catch {}
    }
  }
  const uData = await redis('HGETALL', 'users');
  if (uData?.result) {
    for (let i = 0; i < uData.result.length; i += 2) {
      try {
        const u = JSON.parse(uData.result[i + 1]);
        if (u.username && u.username.toLowerCase() === raw.toLowerCase()) {
          return String(uData.result[i]);
        }
      } catch {}
    }
  }
  return null;
}

  // ===== 👑 ADMIN ACTION: WIPE ALL SKINS TO CLASSIC =====
  if (action === 'reset_skins_all') {
    const reqAdminId = parseInt(body.adminId || req.query.adminId || '0', 10);
    if (reqAdminId !== ADMIN_ID) {
      return res.status(403).json({ ok: false, error: 'Unauthorized: admin only' });
    }
    const resetTime = Date.now();
    await redis('SET', 'global_skins_reset_time', String(resetTime));
    return res.status(200).json({ ok: true, skinsResetTime: resetTime });
  }

  // ===== 👑 ADMIN ACTION: WIPE SKINS FOR SPECIFIC USER =====
  if (action === 'reset_skins_user') {
    const reqAdminId = parseInt(body.adminId || req.query.adminId || '0', 10);
    if (reqAdminId !== ADMIN_ID) {
      return res.status(403).json({ ok: false, error: 'Unauthorized: admin only' });
    }
    const targetInput = body.target || body.targetUserId || req.query.target;
    const targetId = await resolveUserId(targetInput);
    if (!targetId) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    const resetTime = Date.now();
    await redis('SET', `reset_skins:${targetId}`, String(resetTime));
    return res.status(200).json({ ok: true, targetId, skinsResetTime: resetTime });
  }

  // ===== 👑 ADMIN ACTION: GIVE CURRENCY TO SPECIFIC USER =====
  if (action === 'give_user') {
    const reqAdminId = parseInt(body.adminId || req.query.adminId || '0', 10);
    if (reqAdminId !== ADMIN_ID) {
      return res.status(403).json({ ok: false, error: 'Unauthorized: admin only' });
    }
    const targetInput = body.target || body.targetUserId || req.query.target;
    const targetId = await resolveUserId(targetInput);
    if (!targetId) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    const cur = (body.cur || req.query.cur || 'foc').toLowerCase();
    const amount = parseInt(body.amount || req.query.amount || '0', 10);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid amount' });
    }

    if (cur === 'gem' || cur === 'diamonds') {
      const ex = await redis('GET', `reward_gem:${targetId}`);
      const c = ex?.result ? parseInt(ex.result, 10) : 0;
      await redis('SET', `reward_gem:${targetId}`, String(c + amount));
      await redis('SET', `reward_gem_source:${targetId}`, 'admin');
    } else {
      const ex = await redis('GET', `reward:${targetId}`);
      const c = ex?.result ? parseInt(ex.result, 10) : 0;
      await redis('SET', `reward:${targetId}`, String(c + amount));
      await redis('DEL', `deduct:${targetId}`);
    }

    const botToken = process.env.BOT_TOKEN;
    if (botToken) {
      const textMsg = (cur === 'gem' || cur === 'diamonds')
        ? `💎 *Адміністратор нарахував тобі +${amount} 💎 алмазів!*\nЗайди в гру щоб отримати.`
        : `🎁 *Адміністратор нарахував тобі +${amount.toLocaleString()} 🫓 фокач!*\nЗайди в гру щоб отримати.`;
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(targetId),
          text: textMsg,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🫓 Забрати нагороду!', web_app: { url: WEBAPP_URL } }]],
          },
        }),
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, targetId, amount, cur });
  }

  // ===== Check maintenance mode from Redis =====
  let isMaintenance = false;
  try {
    const mRes = await redis('GET', 'maintenance_mode');
    isMaintenance = mRes?.result === '1';
  } catch {}

  // ===== STANDARD USER REWARD CHECK =====
  const userId = req.query.userId || body.userId;
  const userLastReset = parseInt(req.query.lastReset || body.lastReset || '0');
  const userLastSkinsReset = parseInt(req.query.lastSkinsReset || body.lastSkinsReset || '0');

  // If userId is missing or 0, return current maintenance status
  if (!userId || !/^\d+$/.test(userId) || parseInt(userId, 10) <= 0) {
    return res.status(200).json({ ok: true, maintenance: isMaintenance });
  }

  try {
    // Карма акаунта (античит)
    let karma = 100;
    const kRaw = await redis('HGET', 'ac_karma', String(userId));
    if (kRaw?.result) {
      try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch { /* */ }
    }

    // Check global reset time
    const globalResetData = await redis('GET', 'global_reset_time');
    const globalResetTime = globalResetData?.result ? parseInt(globalResetData.result) : 0;

    // Check individual reset flag
    const resetFlag = await redis('GET', `reset:${userId}`);

    if (resetFlag?.result || (globalResetTime > 0 && userLastReset < globalResetTime)) {
      if (resetFlag?.result) await redis('DEL', `reset:${userId}`);
      await redis('DEL', `reward:${userId}`);
      await redis('DEL', `rebirth:${userId}`);
      await redis('DEL', `reward_gem:${userId}`);
      await redis('DEL', `reward_gem_source:${userId}`);
      return res.status(200).json({
        ok: true,
        reset: true,
        resetTime: Math.max(globalResetTime, Date.now()),
        karma,
        maintenance: isMaintenance,
      });
    }

    // Check skins wipe (individual user flag or global wipe)
    let resetSkins = false;
    let skinsResetTime = 0;
    const indSkinsReset = await redis('GET', `reset_skins:${userId}`);
    if (indSkinsReset?.result) {
      resetSkins = true;
      skinsResetTime = parseInt(indSkinsReset.result, 10) || Date.now();
      await redis('DEL', `reset_skins:${userId}`);
    } else {
      const globalSkinsResetData = await redis('GET', 'global_skins_reset_time');
      if (globalSkinsResetData?.result) {
        skinsResetTime = parseInt(globalSkinsResetData.result, 10);
        if (skinsResetTime > 0 && userLastSkinsReset < skinsResetTime) {
          resetSkins = true;
        }
      }
    }

    // Карма < 25 — «Тінь бабусі»: нагороди від адміна не видаються (тримаються до прощення)
    if (karma < 25) {
      return res.status(200).json({ ok: true, reward: 0, karma, resetSkins, skinsResetTime, maintenance: isMaintenance });
    }

    const data = await redis('GET', `reward:${userId}`);
    const amount = data?.result ? parseInt(data.result) : 0;

    const rbData = await redis('GET', `rebirth:${userId}`);
    const rebirths = rbData?.result ? parseInt(rbData.result) : 0;

    const gemData = await redis('GET', `reward_gem:${userId}`);
    const diamonds = gemData?.result ? parseInt(gemData.result) : 0;
    const gemSourceData = await redis('GET', `reward_gem_source:${userId}`);
    const gemSource = gemSourceData?.result || 'admin';

    const deductData = await redis('GET', `deduct:${userId}`);
    const deduct = deductData?.result ? parseInt(deductData.result) : 0;

    const deductGemData = await redis('GET', `deduct_gem:${userId}`);
    const deductDiamonds = deductGemData?.result ? parseInt(deductGemData.result) : 0;

    const extraUpgradeData = await redis('HGET', `user_extra:${userId}`, 'vip_upgrade');
    const extraUpgrade = extraUpgradeData?.result || null;

    const patronData = await redis('HGET', `user_extra:${userId}`, 'badge_patron');
    const patronBadge = patronData?.result === '1';

    const rewardSkinsRaw = await redis('GET', `reward_skins:${userId}`);
    let grantSkins = [];
    if (rewardSkinsRaw?.result) {
      try { grantSkins = JSON.parse(rewardSkinsRaw.result); } catch {}
    }

    const lostSkinsRaw = await redis('GET', `lost_skins:${userId}`);
    let removeSkins = [];
    if (lostSkinsRaw?.result) {
      try { removeSkins = JSON.parse(lostSkinsRaw.result); } catch {}
    }

    // Трейди, що очікують зарахування гравцю
    const pendingTradesRaw = await redis('HGETALL', `pending_trades:${userId}`);
    let trades = [];
    if (pendingTradesRaw?.result && Array.isArray(pendingTradesRaw.result)) {
      for (let i = 0; i < pendingTradesRaw.result.length; i += 2) {
        try {
          const tObj = JSON.parse(pendingTradesRaw.result[i + 1]);
          trades.push(tObj);
        } catch {}
      }
    }

    if (amount > 0 || rebirths > 0 || diamonds > 0 || deduct > 0 || deductDiamonds > 0 || extraUpgrade || patronBadge || resetSkins || grantSkins.length > 0 || removeSkins.length > 0 || trades.length > 0) {
      // Clear pending grants after claiming
      if (amount > 0) await redis('DEL', `reward:${userId}`);
      if (rebirths > 0) await redis('DEL', `rebirth:${userId}`);
      if (diamonds > 0) {
        await redis('DEL', `reward_gem:${userId}`);
        await redis('DEL', `reward_gem_source:${userId}`);
      }
      if (deduct > 0) await redis('DEL', `deduct:${userId}`);
      if (deductDiamonds > 0) await redis('DEL', `deduct_gem:${userId}`);
      if (extraUpgrade) await redis('HDEL', `user_extra:${userId}`, 'vip_upgrade');
      if (patronBadge) await redis('HDEL', `user_extra:${userId}`, 'badge_patron');
      if (grantSkins.length > 0) await redis('DEL', `reward_skins:${userId}`);
      if (removeSkins.length > 0) await redis('DEL', `lost_skins:${userId}`);

      return res.status(200).json({
        ok: true,
        reward: amount,
        rebirth: rebirths,
        diamonds,
        gemSource,
        deduct,
        deductDiamonds,
        extraUpgrade,
        patronBadge,
        karma,
        resetSkins,
        skinsResetTime,
        grantSkins,
        removeSkins,
        trades,
        maintenance: isMaintenance,
      });
    }

    return res.status(200).json({ ok: true, reward: 0, trades: [], karma, resetSkins, skinsResetTime, maintenance: isMaintenance });
  } catch (err) {
    console.error('Reward error:', err);
    return res.status(200).json({ ok: true, reward: 0, maintenance: isMaintenance });
  }
};
