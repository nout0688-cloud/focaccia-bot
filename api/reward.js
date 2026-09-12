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

  // ===== 💾 ACTION: SAVE ACCOUNT SNAPSHOT =====
  if (action === 'save_snapshot') {
    const uid = String(body.userId || req.query.userId || '').trim();
    if (!uid || !/^\d+$/.test(uid) || parseInt(uid, 10) <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_user_id' });
    }
    const saveState = body.saveState || body.snapshot;
    if (!saveState || typeof saveState !== 'object') {
      return res.status(400).json({ ok: false, error: 'missing_save_state' });
    }

    try {
      const now = Date.now();
      const total = Number(saveState.total) || 0;
      const prestige = Number(saveState.prestige) || 0;
      const diamonds = Number(saveState.diamonds) || 0;
      const clicks = Number(saveState.clicks) || 0;
      const focaccia = Number(saveState.focaccia) || 0;
      const buildingsCount = Object.values(saveState.buildings || {}).reduce((a, b) => a + (Number(b) || 0), 0);
      const upgradesCount = Array.isArray(saveState.upgrades) ? saveState.upgrades.length : 0;

      const meta = {
        ts: now,
        id: `snap_${now}`,
        total,
        focaccia,
        prestige,
        diamonds,
        clicks,
        buildingsCount,
        upgradesCount,
      };

      const cleanSave = { ...saveState };
      delete cleanSave.photo;
      delete cleanSave.offlineEvents;

      const payload = JSON.stringify(cleanSave);

      // Save latest snapshot
      await redis('SET', `user_latest_snapshot:${uid}`, payload);
      await redis('SET', `user_latest_snapshot_meta:${uid}`, JSON.stringify(meta));

      // Append to history (keep up to 5 snapshots)
      let history = [];
      const histRaw = await redis('GET', `user_snapshot_history:${uid}`);
      if (histRaw?.result) {
        try { history = JSON.parse(histRaw.result); } catch {}
      }
      if (!Array.isArray(history)) history = [];

      const lastHist = history[0];
      const shouldAddToHistory = !lastHist || (now - lastHist.ts >= 120000) || (prestige > (lastHist.prestige || 0));

      if (shouldAddToHistory) {
        history.unshift(meta);
        if (history.length > 5) {
          const removed = history.slice(5);
          history = history.slice(0, 5);
          for (const rem of removed) {
            await redis('DEL', `user_snapshot:${uid}:${rem.id}`);
          }
        }
        await redis('SET', `user_snapshot_history:${uid}`, JSON.stringify(history));
        await redis('SET', `user_snapshot:${uid}:${meta.id}`, payload);
      }

      return res.status(200).json({ ok: true, meta });
    } catch (err) {
      console.error('Error saving snapshot:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ===== 📥 ACTION: GET LATEST SNAPSHOT =====
  if (action === 'get_snapshot') {
    const uid = String(body.userId || req.query.userId || '').trim();
    if (!uid || !/^\d+$/.test(uid)) {
      return res.status(400).json({ ok: false, error: 'invalid_user_id' });
    }
    const snapId = String(body.snapshotId || req.query.snapshotId || '').trim();

    try {
      let snapRaw = null;
      if (snapId && snapId !== 'latest') {
        snapRaw = await redis('GET', `user_snapshot:${uid}:${snapId}`);
      }
      if (!snapRaw?.result) {
        snapRaw = await redis('GET', `user_latest_snapshot:${uid}`);
      }

      const metaRaw = await redis('GET', `user_latest_snapshot_meta:${uid}`);
      let meta = null;
      if (metaRaw?.result) {
        try { meta = JSON.parse(metaRaw.result); } catch {}
      }

      if (snapRaw?.result) {
        try {
          const snapshot = JSON.parse(snapRaw.result);
          return res.status(200).json({ ok: true, snapshot, meta });
        } catch {}
      }

      // Fallback: If no full snapshot exists, check leaderboard for recovery stats
      const lbRaw = await redis('HGET', 'leaderboard', uid);
      if (lbRaw?.result) {
        try {
          const lb = JSON.parse(lbRaw.result);
          if (lb && (Number(lb.t) > 0 || Number(lb.p) > 0 || Number(lb.d) > 0)) {
            return res.status(200).json({
              ok: true,
              snapshot: null,
              leaderboardRecovery: {
                total: Number(lb.t) || 0,
                focaccia: Number(lb.t) || 0,
                prestige: Number(lb.p) || 0,
                diamonds: Number(lb.d) || 0,
                clicks: Number(lb.k) || 0,
                bossesDefeated: Number(lb.b) || 0,
                name: lb.n || '',
              },
            });
          }
        } catch {}
      }

      return res.status(200).json({ ok: false, error: 'no_snapshot' });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ===== 📜 ACTION: LIST SNAPSHOTS =====
  if (action === 'list_snapshots') {
    const uid = String(body.userId || req.query.userId || '').trim();
    if (!uid) return res.status(400).json({ ok: false, error: 'invalid_user_id' });

    try {
      const histRaw = await redis('GET', `user_snapshot_history:${uid}`);
      let history = [];
      if (histRaw?.result) {
        try { history = JSON.parse(histRaw.result); } catch {}
      }
      const latestMetaRaw = await redis('GET', `user_latest_snapshot_meta:${uid}`);
      let latest = null;
      if (latestMetaRaw?.result) {
        try { latest = JSON.parse(latestMetaRaw.result); } catch {}
      }

      return res.status(200).json({ ok: true, latest, history });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
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
    // Оновлюємо статус активності гравця (онлайн протягом останніх 15 секунд)
    await redis('SET', `user_online:${userId}`, '1', 'EX', 15);

    // Перевірка звукового тролінгу (рофл-звук від адміна)
    let roflSound = null;
    const soundRaw = await redis('GET', `rofl_sound:${userId}`);
    if (soundRaw?.result) {
      roflSound = soundRaw.result;
      await redis('DEL', `rofl_sound:${userId}`);
    } else {
      const globalSound = await redis('GET', 'rofl_sound_all');
      if (globalSound?.result) {
        const heard = await redis('GET', `rofl_heard:${userId}:${globalSound.result}`);
        if (!heard?.result) {
          roflSound = globalSound.result;
          await redis('SET', `rofl_heard:${userId}:${globalSound.result}`, '1', 'EX', 60);
        }
      }
    }

    // Карма акаунта (античит)
    let karma = 100;
    const kRaw = await redis('HGET', 'ac_karma', String(userId));
    if (kRaw?.result) {
      try { karma = Math.max(0, Math.min(100, JSON.parse(kRaw.result).k || 0)); } catch { /* */ }
    }

    // Check individual reset flag (set EXCLUSIVELY by admin manually)
    const resetFlag = await redis('GET', `reset:${userId}`);

    if (resetFlag?.result) {
      await redis('DEL', `reset:${userId}`);
      // Safety backup of the latest snapshot before wiping
      const currentSnap = await redis('GET', `user_latest_snapshot:${userId}`);
      if (currentSnap?.result) {
        await redis('SET', `user_snapshot_pre_wipe:${userId}`, currentSnap.result);
      }
      await redis('DEL', `reward:${userId}`);
      await redis('DEL', `rebirth:${userId}`);
      await redis('DEL', `reward_gem:${userId}`);
      await redis('DEL', `reward_gem_source:${userId}`);
      return res.status(200).json({
        ok: true,
        reset: true,
        resetTime: Date.now(),
        karma,
        maintenance: isMaintenance,
      });
    }

    // Check if admin dispatched an account restore
    const restoreRaw = await redis('GET', `reward_restore:${userId}`);
    let pendingRestore = null;
    if (restoreRaw?.result) {
      try {
        pendingRestore = JSON.parse(restoreRaw.result);
        await redis('DEL', `reward_restore:${userId}`);
      } catch {}
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
        restore: pendingRestore,
        roflSound: roflSound || undefined,
        maintenance: isMaintenance,
      });
    }

    return res.status(200).json({ ok: true, reward: 0, trades: [], karma, resetSkins, skinsResetTime, restore: pendingRestore, roflSound: roflSound || undefined, maintenance: isMaintenance });
  } catch (err) {
    console.error('Reward error:', err);
    return res.status(200).json({ ok: true, reward: 0, maintenance: isMaintenance });
  }
};
