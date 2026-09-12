/**
 * TapSentinel Trade System v1.0 — Безпечні трейди (фокачі, алмази, скіни)
 *
 * Флоу: створення трейду (прямий виклик або відкрите посилання) →
 * обидва гравці входять у Trade Mini App (?trade=<id>) →
 * вибір фокач, алмазів та скінів → обопільна фіксація (Lock) →
 * двохетапне підтвердження (Confirm) → атомарний трансфер предметів у Redis.
 *
 * Ключі Redis:
 *   trade:{id}           — стан трейду (учасники, пропозиції, стадії, локи)
 *   trade_lock:{id}      — захист від race condition при фіналізації
 *   user_balance         — hash: userId → { f: focaccia, d: diamonds, ts }
 *   reward_skins:{userId}— скіни для видачі клієнту в грі
 *   lost_skins:{userId}  — скіни для списання в грі
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const TRADE_SITE = 'https://nout0688-cloud.github.io/focaccia-clicker/?v=';
const TRADE_TTL = 30 * 60; // 30 хвилин у Redis

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

async function sendTg(chatId, text, extra = {}) {
  if (!BOT_TOKEN || !chatId) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(chatId), text, ...extra }),
    });
    return res.json();
  } catch {
    return null;
  }
}

async function getUserBalance(userId) {
  const uid = String(userId);
  let f = 0, d = 0;
  const balData = await redis('HGET', 'user_balance', uid);
  if (balData?.result) {
    try {
      const bObj = JSON.parse(balData.result);
      if (typeof bObj.f === 'number') f = bObj.f;
      if (typeof bObj.d === 'number') d = bObj.d;
    } catch { /* fallback */ }
  }
  const lbData = await redis('HGET', 'leaderboard', uid);
  if (lbData?.result) {
    try {
      const lbObj = JSON.parse(lbData.result);
      if (typeof lbObj.t === 'number' && f === 0) f = lbObj.t;
      if (typeof lbObj.d === 'number' && d === 0) d = lbObj.d;
    } catch { /* fallback */ }
  }
  return { f, d };
}

async function setUserBalance(userId, f, d) {
  const uid = String(userId);
  await redis('HSET', 'user_balance', uid, JSON.stringify({ f, d, ts: Date.now() }));
}

const REBIRTH_TRADE_LOCK_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

async function getUserRebirthTime(userId) {
  if (!userId) return 0;
  const uid = String(userId);
  const raw = await redis('GET', `user_rebirth_time:${uid}`);
  if (raw?.result) {
    const t = Number(raw.result) || 0;
    if (t > 0) return t;
  }
  const lbData = await redis('HGET', 'leaderboard', uid);
  if (lbData?.result) {
    try {
      const lbObj = JSON.parse(lbData.result);
      if (typeof lbObj.rbt === 'number' && lbObj.rbt > 0) return lbObj.rbt;
    } catch {}
  }
  return 0;
}

async function setUserRebirthTime(userId, timestamp) {
  if (!userId || !timestamp) return;
  const uid = String(userId);
  const t = Number(timestamp) || 0;
  if (t > 0) {
    await redis('SET', `user_rebirth_time:${uid}`, String(t));
  }
}

async function checkUserRebirthLock(userId, clientTimestamp = 0) {
  const serverTime = await getUserRebirthTime(userId);
  const effectiveTime = Math.max(serverTime, Number(clientTimestamp) || 0);
  if (effectiveTime > 0) {
    const elapsed = Date.now() - effectiveTime;
    if (elapsed < REBIRTH_TRADE_LOCK_MS) {
      return { locked: true, remainingMs: REBIRTH_TRADE_LOCK_MS - elapsed };
    }
  }
  return { locked: false, remainingMs: 0 };
}

async function getTrade(tradeId) {
  const raw = await redis('GET', `trade:${tradeId}`);
  if (!raw?.result) return null;
  try { return JSON.parse(raw.result); } catch { return null; }
}

async function saveTrade(trade) {
  await redis('SET', `trade:${trade.id}`, JSON.stringify(trade), 'EX', TRADE_TTL);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  if (req.body) {
    if (typeof req.body === 'string') {
      try { body = JSON.parse(req.body); } catch {}
    } else if (typeof req.body === 'object') {
      body = req.body;
    }
  }

  const action = body.action || req.query.action;
  const now = Date.now();

  try {
    // 0.1 Отримати список активних гравців для лобі трейдів
    if (action === 'get_active_players') {
      const myId = String(req.query.userId || body.userId || '');
      const players = [];
      const seenIds = new Set();
      if (myId) seenIds.add(myId);

      const lbRaw = await redis('HGETALL', 'leaderboard');
      if (lbRaw?.result && Array.isArray(lbRaw.result)) {
        for (let i = 0; i < lbRaw.result.length; i += 2) {
          const id = String(lbRaw.result[i]);
          if (seenIds.has(id)) continue;
          try {
            const d = JSON.parse(lbRaw.result[i + 1]);
            seenIds.add(id);
            players.push({
              id,
              name: d.n || d.name || 'Гравець',
              username: d.u || d.username || '',
              score: Number(d.t) || 0,
            });
          } catch {}
        }
      }

      if (players.length < 20) {
        const usersRaw = await redis('HGETALL', 'users');
        if (usersRaw?.result && Array.isArray(usersRaw.result)) {
          for (let i = 0; i < usersRaw.result.length; i += 2) {
            const id = String(usersRaw.result[i]);
            if (seenIds.has(id)) continue;
            try {
              const u = JSON.parse(usersRaw.result[i + 1]);
              seenIds.add(id);
              players.push({
                id,
                name: u.name || u.first_name || 'Гравець',
                username: u.username || '',
                score: 0,
              });
              if (players.length >= 25) break;
            } catch {}
          }
        }
      }

      return res.status(200).json({ ok: true, players: players.slice(0, 25) });
    }

    // 0.2 Пошук гравця за @username або ID
    if (action === 'find_player') {
      const q = String(req.query.q || body.q || '').trim();
      if (!q) return res.status(400).json({ ok: false, error: 'empty_query' });
      const cleanQ = q.replace(/^@/, '').toLowerCase();

      // Шукаємо за точним ID
      if (/^\d{4,25}$/.test(cleanQ)) {
        const uRaw = await redis('HGET', 'users', cleanQ);
        if (uRaw?.result) {
          try {
            const u = JSON.parse(uRaw.result);
            return res.status(200).json({
              ok: true,
              player: {
                id: cleanQ,
                name: u.name || u.first_name || 'Гравець',
                username: u.username || '',
              },
            });
          } catch {}
        }
      }

      // Шукаємо за юзернеймом у leaderboard
      const lbRaw = await redis('HGETALL', 'leaderboard');
      if (lbRaw?.result && Array.isArray(lbRaw.result)) {
        for (let i = 0; i < lbRaw.result.length; i += 2) {
          const id = String(lbRaw.result[i]);
          try {
            const d = JSON.parse(lbRaw.result[i + 1]);
            const u = String(d.u || d.username || '').toLowerCase();
            if (u === cleanQ) {
              return res.status(200).json({
                ok: true,
                player: {
                  id,
                  name: d.n || d.name || 'Гравець',
                  username: d.u || d.username || '',
                  score: Number(d.t) || 0,
                },
              });
            }
          } catch {}
        }
      }

      // Шукаємо за юзернеймом у users
      const usersRaw = await redis('HGETALL', 'users');
      if (usersRaw?.result && Array.isArray(usersRaw.result)) {
        for (let i = 0; i < usersRaw.result.length; i += 2) {
          const id = String(usersRaw.result[i]);
          try {
            const u = JSON.parse(usersRaw.result[i + 1]);
            const un = String(u.username || '').toLowerCase();
            if (un === cleanQ) {
              return res.status(200).json({
                ok: true,
                player: {
                  id,
                  name: u.name || u.first_name || 'Гравець',
                  username: u.username || '',
                  score: 0,
                },
              });
            }
          } catch {}
        }
      }

      return res.status(200).json({ ok: false, error: 'not_found' });
    }

    // 0.3 Підтвердження отримання трейду (видалення з pending_trades)
    if (action === 'ack_trade') {
      const uid = String(body.userId || req.query.userId || '').trim();
      const tId = String(body.tradeId || req.query.tradeId || '').trim();
      if (uid && tId) {
        await redis('HDEL', `pending_trades:${uid}`, tId);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    // 1. Отримати актуальний баланс користувача
    if (action === 'get_balance') {
      const userId = String(body.userId || req.query.userId || '');
      if (!userId) return res.status(400).json({ ok: false, error: 'no_userId' });
      const bal = await getUserBalance(userId);
      const rbt = await getUserRebirthTime(userId);
      return res.status(200).json({ ok: true, focaccia: bal.f, diamonds: bal.d, lastRebirthTime: rbt });
    }

    // 2. Створити сесію трейду
    if (action === 'create') {
      const from = String(body.from || '').trim();
      const rawTo = body.to !== undefined && body.to !== null ? String(body.to).trim() : '';
      const to = (rawTo && rawTo !== 'null' && rawTo !== 'undefined' && rawTo !== '0') ? rawTo : null;
      const fromName = String(body.fromName || 'Гравець').slice(0, 24);
      const fromU = String(body.fromU || '').slice(0, 32);

      if (!from || !/^[a-zA-Z0-9_-]{1,40}$/.test(from)) {
        return res.status(400).json({ ok: false, error: 'invalid_from' });
      }
      if (to && String(from) === String(to)) {
        return res.status(400).json({ ok: false, error: 'self_trade_not_allowed' });
      }

      // Перевірка 5-денного кулдауну після ребіртху для ініціатора трейду
      const clientRbt = Number(body.clientLastRebirthTime) || 0;
      if (clientRbt > 0) await setUserRebirthTime(from, clientRbt);
      const fromLock = await checkUserRebirthLock(from, clientRbt);
      if (fromLock.locked) {
        return res.status(200).json({ ok: false, error: 'rebirth_locked', remainingMs: fromLock.remainingMs });
      }

      // Перевірка кулдауну для запрошеного партнера (якщо вказано ID)
      if (to) {
        const toLock = await checkUserRebirthLock(to);
        if (toLock.locked) {
          return res.status(200).json({ ok: false, error: 'recipient_rebirth_locked', remainingMs: toLock.remainingMs });
        }
      }

      const tradeId = `tr_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const trade = {
        id: tradeId,
        stage: 'active', // active | completed | cancelled
        p1: { id: String(from), name: fromName, u: fromU },
        p2: to ? { id: String(to), name: '', u: '' } : null,
        p1Offer: { focaccia: 0, diamonds: 0, skins: [] },
        p2Offer: { focaccia: 0, diamonds: 0, skins: [] },
        p1Locked: false,
        p2Locked: false,
        p1Confirmed: false,
        p2Confirmed: false,
        p1Seen: now,
        p2Seen: 0,
        createdAt: now,
        completedAt: null,
        cancelledReason: null,
      };

      await saveTrade(trade);
      const url = `${TRADE_SITE}${Date.now()}&trade=${tradeId}`;

      // Якщо вказано конкретного отримувача — надсилаємо інвайт у Telegram
      if (to) {
        const kb = {
          inline_keyboard: [
            [{ text: '🤝 Відкрити трейд', web_app: { url } }],
            [{ text: '❌ Відхилити', callback_data: `trade:decline:${tradeId}` }],
          ],
        };
        await sendTg(to, `🤝 Гравець ${fromName} пропонує тобі безпечний обмін (фокачі, алмази, скіни)!\n\nНатисни кнопку нижче, щоб увійти в кімнату обміну:`, { reply_markup: kb });
      }

      return res.status(200).json({ ok: true, tradeId, url });
    }

    // Параметри для наступних дій:
    const tradeId = String(body.tradeId || req.query.tradeId || '').trim();
    const userId = String(body.userId || req.query.userId || '').trim();

    if (!tradeId) {
      return res.status(400).json({ ok: false, error: 'missing_tradeId' });
    }

    // 2.1 Попередній перегляд трейду (без вимоги бути учасником)
    if (action === 'preview') {
      const trade = await getTrade(tradeId);
      if (!trade) return res.status(200).json({ ok: false, error: 'not_found' });
      const hasP2 = Boolean(trade.p2 && trade.p2.id && String(trade.p2.id) !== 'null' && String(trade.p2.id) !== 'undefined');
      return res.status(200).json({
        ok: true,
        trade: {
          id: trade.id,
          stage: trade.stage,
          p1: { name: trade.p1.name, u: trade.p1.u },
          p2: hasP2 ? { name: trade.p2.name, u: trade.p2.u } : null,
          hasP2,
          isP1: String(trade.p1?.id) === String(userId),
          isP2: hasP2 && String(trade.p2?.id) === String(userId),
        },
      });
    }

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'missing_userId' });
    }

    const trade = await getTrade(tradeId);
    if (!trade) {
      return res.status(200).json({ ok: false, error: 'not_found' });
    }

    let isP1 = String(trade.p1?.id) === String(userId);
    let isP2 = Boolean(trade.p2 && String(trade.p2.id) === String(userId));
    const isP2Empty = !trade.p2 || !trade.p2.id || String(trade.p2.id) === 'null' || String(trade.p2.id) === 'undefined' || String(trade.p2.id) === '0';
    // Дозволяємо приєднання, якщо слот p2 порожній або партнер ще нічого не пропонував/не зафіксував (захист від Telegram prefetch / guest ID race)
    const isP2Clean = !trade.p2Locked && !trade.p2Confirmed && (!trade.p2Offer || (trade.p2Offer.focaccia === 0 && trade.p2Offer.diamonds === 0 && (!trade.p2Offer.skins || trade.p2Offer.skins.length === 0)));
    const isP2SlotAvailable = isP2Empty || (!trade.p2Seen) || (isP2Clean && (!trade.p2.name || trade.p2.name === 'Гравець' || trade.p2.name === ''));

    // Приєднання до відкритого посилання (open trade), якщо p2 ще немає або слот вільний і гравець не p1
    if (!isP1 && !isP2 && isP2SlotAvailable) {
      const clientRbt = Number(body.clientLastRebirthTime) || 0;
      if (clientRbt > 0) await setUserRebirthTime(userId, clientRbt);
      const lockCheck = await checkUserRebirthLock(userId, clientRbt);
      if (lockCheck.locked) {
        return res.status(200).json({ ok: false, error: 'rebirth_locked', remainingMs: lockCheck.remainingMs });
      }

      trade.p2 = {
        id: String(userId),
        name: String(body.name || 'Гравець').slice(0, 24),
        u: String(body.u || '').slice(0, 32),
      };
      trade.p2Seen = now;
      await saveTrade(trade);
      isP2 = true;
    }

    if (!isP1 && !isP2) {
      return res.status(200).json({ ok: false, error: 'not_a_participant' });
    }

    // Оновлюємо статус активності (last seen)
    if (isP1) {
      trade.p1Seen = now;
      if (body.name) trade.p1.name = String(body.name).slice(0, 24);
      if (body.u) trade.p1.u = String(body.u).slice(0, 32);
    } else if (isP2) {
      trade.p2Seen = now;
      if (body.name) trade.p2.name = String(body.name).slice(0, 24);
      if (body.u) trade.p2.u = String(body.u).slice(0, 32);
    }

    // 2.2 Явне приєднання або отримання поточного стану
    if (action === 'join' || action === 'get_trade') {
      await saveTrade(trade);
      const me = isP1 ? trade.p1 : trade.p2;
      const opp = isP1 ? trade.p2 : trade.p1;
      const meOffer = isP1 ? trade.p1Offer : trade.p2Offer;
      const oppOffer = isP1 ? trade.p2Offer : trade.p1Offer;
      const meLocked = isP1 ? trade.p1Locked : trade.p2Locked;
      const oppLocked = isP1 ? trade.p2Locked : trade.p1Locked;
      const meConfirmed = isP1 ? trade.p1Confirmed : trade.p2Confirmed;
      const oppConfirmed = isP1 ? trade.p2Confirmed : trade.p1Confirmed;
      const oppSeen = isP1 ? trade.p2Seen : trade.p1Seen;

      let oppRebirthLocked = false;
      let oppRebirthRemainingMs = 0;
      if (opp?.id) {
        const oppLock = await checkUserRebirthLock(opp.id);
        oppRebirthLocked = oppLock.locked;
        oppRebirthRemainingMs = oppLock.remainingMs;
      }

      return res.status(200).json({
        ok: true,
        stage: trade.stage,
        completedAt: trade.completedAt,
        cancelledReason: trade.cancelledReason,
        serverNow: now,
        me: {
          id: me?.id,
          name: me?.name,
          u: me?.u,
          offer: meOffer,
          locked: meLocked,
          confirmed: meConfirmed,
        },
        opp: (opp && opp.id && opp.id !== 'null' && opp.id !== 'undefined') ? {
          id: opp.id,
          name: opp.name || 'Партнер',
          u: opp.u || '',
          offer: oppOffer,
          locked: oppLocked,
          confirmed: oppConfirmed,
          online: (now - oppSeen) < 10000,
          rebirthLocked: oppRebirthLocked,
          rebirthRemainingMs: oppRebirthRemainingMs,
        } : null,
      });
    }

    // 3. Синхронізація пропозицій (Sync)
    if (action === 'sync') {
      // Оновлюємо кеш балансу користувача, якщо передано перевірений клієнтський баланс
      if (body.clientBalance && typeof body.clientBalance === 'object') {
        const cF = Math.max(0, Math.min(Number(body.clientBalance.f) || 0, 1e24));
        const cD = Math.max(0, Math.min(Number(body.clientBalance.d) || 0, 1e9));
        const curBal = await getUserBalance(userId);
        if (cF > curBal.f || cD > curBal.d) {
          await setUserBalance(userId, Math.max(curBal.f, cF), Math.max(curBal.d, cD));
        }
      }

      if (trade.stage === 'active' && body.offer && typeof body.offer === 'object') {
        const myLock = isP1 ? trade.p1Locked : trade.p2Locked;
        // Якщо гравець ще не зафіксував пропозицію або явно її редагує:
        if (!myLock) {
          const rawFoc = Math.max(0, Math.min(Number(body.offer.focaccia) || 0, 1e24));
          const rawDia = Math.max(0, Math.min(Number(body.offer.diamonds) || 0, 1e9));
          const rawSkins = Array.isArray(body.offer.skins)
            ? body.offer.skins.map((s) => String(s).slice(0, 40)).filter((s) => s && s !== 'skin_classic')
            : [];

          const targetOffer = isP1 ? trade.p1Offer : trade.p2Offer;
          const focChanged = targetOffer.focaccia !== rawFoc;
          const diaChanged = targetOffer.diamonds !== rawDia;
          const skinsChanged = JSON.stringify(targetOffer.skins.slice().sort()) !== JSON.stringify(rawSkins.slice().sort());

          if (focChanged || diaChanged || skinsChanged) {
            if (isP1) {
              trade.p1Offer = { focaccia: rawFoc, diamonds: rawDia, skins: rawSkins };
            } else {
              trade.p2Offer = { focaccia: rawFoc, diamonds: rawDia, skins: rawSkins };
            }
            // АНТИ-СКАМ ЗАХИСТ: якщо хтось змінив пропозицію — ВСІ локи та підтвердження скидаються!
            trade.p1Locked = false;
            trade.p2Locked = false;
            trade.p1Confirmed = false;
            trade.p2Confirmed = false;
          }
        }
      }

      await saveTrade(trade);

      const me = isP1 ? trade.p1 : trade.p2;
      const opp = isP1 ? trade.p2 : trade.p1;
      const meOffer = isP1 ? trade.p1Offer : trade.p2Offer;
      const oppOffer = isP1 ? trade.p2Offer : trade.p1Offer;
      const meLocked = isP1 ? trade.p1Locked : trade.p2Locked;
      const oppLocked = isP1 ? trade.p2Locked : trade.p1Locked;
      const meConfirmed = isP1 ? trade.p1Confirmed : trade.p2Confirmed;
      const oppConfirmed = isP1 ? trade.p2Confirmed : trade.p1Confirmed;
      const oppSeen = isP1 ? trade.p2Seen : trade.p1Seen;

      let oppRebirthLocked = false;
      let oppRebirthRemainingMs = 0;
      if (opp?.id) {
        const oppLock = await checkUserRebirthLock(opp.id);
        oppRebirthLocked = oppLock.locked;
        oppRebirthRemainingMs = oppLock.remainingMs;
      }

      return res.status(200).json({
        ok: true,
        stage: trade.stage,
        completedAt: trade.completedAt,
        cancelledReason: trade.cancelledReason,
        serverNow: now,
        me: {
          id: me?.id,
          name: me?.name,
          u: me?.u,
          offer: meOffer,
          locked: meLocked,
          confirmed: meConfirmed,
        },
        opp: (opp && opp.id && String(opp.id) !== 'null' && String(opp.id) !== 'undefined') ? {
          id: opp.id,
          name: opp.name || 'Партнер',
          u: opp.u || '',
          offer: oppOffer,
          locked: oppLocked,
          confirmed: oppConfirmed,
          online: (now - oppSeen) < 10000,
          rebirthLocked: oppRebirthLocked,
          rebirthRemainingMs: oppRebirthRemainingMs,
        } : null,
      });
    }

    // 4. Зафіксувати або розблокувати пропозицію (Lock)
    if (action === 'lock') {
      if (trade.stage !== 'active') return res.status(200).json({ ok: false, error: 'trade_not_active' });
      const clientRbt = Number(body.clientLastRebirthTime) || 0;
      if (clientRbt > 0) await setUserRebirthTime(userId, clientRbt);
      const lockCheck = await checkUserRebirthLock(userId, clientRbt);
      if (lockCheck.locked) {
        return res.status(200).json({ ok: false, error: 'rebirth_locked', remainingMs: lockCheck.remainingMs });
      }

      const wantLock = body.locked === true;
      if (isP1) trade.p1Locked = wantLock;
      else trade.p2Locked = wantLock;

      // Якщо зняли замок — скидаємо підтвердження обох
      if (!wantLock) {
        trade.p1Confirmed = false;
        trade.p2Confirmed = false;
      }

      await saveTrade(trade);
      return res.status(200).json({ ok: true, p1Locked: trade.p1Locked, p2Locked: trade.p2Locked });
    }

    // 5. Фінальне підтвердження обміну (Confirm)
    if (action === 'confirm') {
      if (trade.stage !== 'active') return res.status(200).json({ ok: false, error: 'trade_not_active' });
      if (!trade.p1Locked || !trade.p2Locked) {
        return res.status(200).json({ ok: false, error: 'both_must_lock_first' });
      }

      const clientRbt = Number(body.clientLastRebirthTime) || 0;
      if (clientRbt > 0) await setUserRebirthTime(userId, clientRbt);

      // Перевірка 5-денного кулдауну після ребіртху для обох учасників
      const p1Lock = await checkUserRebirthLock(trade.p1.id, isP1 ? clientRbt : 0);
      if (p1Lock.locked) {
        return res.status(200).json({ ok: false, error: 'rebirth_locked', remainingMs: p1Lock.remainingMs });
      }
      if (trade.p2?.id) {
        const p2Lock = await checkUserRebirthLock(trade.p2.id, isP2 ? clientRbt : 0);
        if (p2Lock.locked) {
          return res.status(200).json({ ok: false, error: 'rebirth_locked', remainingMs: p2Lock.remainingMs });
        }
      }

      if (isP1) trade.p1Confirmed = true;
      else trade.p2Confirmed = true;

      // Якщо обидва гравці підтвердили — АТОМАРНЕ ВИКОНАННЯ ТРЕЙДУ
      if (trade.p1Confirmed && trade.p2Confirmed && trade.p2) {
        const lockKey = `trade_lock:${trade.id}`;
        const lockRes = await redis('SET', lockKey, '1', 'NX', 'EX', 10);
        if (!lockRes?.result) {
          // Вже обробляється паралельним запитом
          return res.status(200).json({ ok: true, stage: trade.stage });
        }

        // Оновлюємо баланси з клієнтських даних, якщо передано
        if (body.clientBalance && typeof body.clientBalance === 'object') {
          const cF = Math.max(0, Math.min(Number(body.clientBalance.f) || 0, 1e24));
          const cD = Math.max(0, Math.min(Number(body.clientBalance.d) || 0, 1e9));
          const curBal = await getUserBalance(userId);
          if (cF > curBal.f || cD > curBal.d) {
            await setUserBalance(userId, Math.max(curBal.f, cF), Math.max(curBal.d, cD));
          }
        }

        // Перевіряємо актуальні баланси обох гравців
        const balP1 = await getUserBalance(trade.p1.id);
        const balP2 = await getUserBalance(trade.p2.id);

        if (balP1.f < trade.p1Offer.focaccia || balP1.d < trade.p1Offer.diamonds) {
          trade.stage = 'cancelled';
          trade.cancelledReason = `У гравця ${trade.p1.name} недостатньо коштів`;
          await saveTrade(trade);
          return res.status(200).json({ ok: false, error: 'insufficient_funds_p1' });
        }
        if (balP2.f < trade.p2Offer.focaccia || balP2.d < trade.p2Offer.diamonds) {
          trade.stage = 'cancelled';
          trade.cancelledReason = `У гравця ${trade.p2.name} недостатньо коштів`;
          await saveTrade(trade);
          return res.status(200).json({ ok: false, error: 'insufficient_funds_p2' });
        }

        const p1Offer = trade.p1Offer || { focaccia: 0, diamonds: 0, skins: [] };
        const p2Offer = trade.p2Offer || { focaccia: 0, diamonds: 0, skins: [] };

        const p1GainFoc = p2Offer.focaccia || 0;
        const p1LossFoc = p1Offer.focaccia || 0;
        const p1GainDia = p2Offer.diamonds || 0;
        const p1LossDia = p1Offer.diamonds || 0;
        const p1GrantSkins = p2Offer.skins || [];
        const p1RemoveSkins = p1Offer.skins || [];

        const p2GainFoc = p1Offer.focaccia || 0;
        const p2LossFoc = p2Offer.focaccia || 0;
        const p2GainDia = p1Offer.diamonds || 0;
        const p2LossDia = p2Offer.diamonds || 0;
        const p2GrantSkins = p1Offer.skins || [];
        const p2RemoveSkins = p2Offer.skins || [];

        // 1. Атомарне оновлення user_balance у Redis:
        const nextP1F = Math.max(0, balP1.f - p1LossFoc + p1GainFoc);
        const nextP1D = Math.max(0, balP1.d - p1LossDia + p1GainDia);
        const nextP2F = Math.max(0, balP2.f - p2LossFoc + p2GainFoc);
        const nextP2D = Math.max(0, balP2.d - p2LossDia + p2GainDia);

        await setUserBalance(trade.p1.id, nextP1F, nextP1D);
        await setUserBalance(trade.p2.id, nextP2F, nextP2D);

        // 2. Гарантована доставка винагород через чергу pending_trades для App.tsx:
        const p1TradeData = {
          tradeId: trade.id,
          focacciaGain: p1GainFoc,
          focacciaLoss: p1LossFoc,
          diamondGain: p1GainDia,
          diamondLoss: p1LossDia,
          grantSkins: p1GrantSkins,
          removeSkins: p1RemoveSkins,
          partnerName: trade.p2.name || 'Партнер',
          partnerId: String(trade.p2.id),
          completedAt: now,
        };

        const p2TradeData = {
          tradeId: trade.id,
          focacciaGain: p2GainFoc,
          focacciaLoss: p2LossFoc,
          diamondGain: p2GainDia,
          diamondLoss: p2LossDia,
          grantSkins: p2GrantSkins,
          removeSkins: p2RemoveSkins,
          partnerName: trade.p1.name || 'Партнер',
          partnerId: String(trade.p1.id),
          completedAt: now,
        };

        await redis('HSET', `pending_trades:${trade.p1.id}`, trade.id, JSON.stringify(p1TradeData));
        await redis('HSET', `pending_trades:${trade.p2.id}`, trade.id, JSON.stringify(p2TradeData));

        trade.stage = 'completed';
        trade.completedAt = now;
        await saveTrade(trade);

        // Надсилаємо привітальні сповіщення у Telegram
        const p1Got = [];
        if (p1GainFoc > 0) p1Got.push(`${p1GainFoc.toLocaleString()} 🫓`);
        if (p1GainDia > 0) p1Got.push(`${p1GainDia} 💎`);
        if (p1GrantSkins.length > 0) p1Got.push(`${p1GrantSkins.length} скін(ів)`);

        const p2Got = [];
        if (p2GainFoc > 0) p2Got.push(`${p2GainFoc.toLocaleString()} 🫓`);
        if (p2GainDia > 0) p2Got.push(`${p2GainDia} 💎`);
        if (p2GrantSkins.length > 0) p2Got.push(`${p2GrantSkins.length} скін(ів)`);

        await sendTg(trade.p1.id, `🎉 *Трейд успішно здійснено!*\nТи отримав від ${trade.p2.name}: ${p1Got.join(', ') || 'нічого'}.\nЗайди в гру, щоб переглянути інвентар!`, { parse_mode: 'Markdown' });
        await sendTg(trade.p2.id, `🎉 *Трейд успішно здійснено!*\nТи отримав від ${trade.p1.name}: ${p2Got.join(', ') || 'нічого'}.\nЗайди в гру, щоб переглянути інвентар!`, { parse_mode: 'Markdown' });
      }

      await saveTrade(trade);
      return res.status(200).json({ ok: true, stage: trade.stage, p1Confirmed: trade.p1Confirmed, p2Confirmed: trade.p2Confirmed });
    }

    // 6. Скасування трейду (Cancel)
    if (action === 'cancel') {
      trade.stage = 'cancelled';
      trade.cancelledReason = body.reason || 'Скасовано учасником обміну';
      await saveTrade(trade);

      const otherId = isP1 ? trade.p2?.id : trade.p1.id;
      if (otherId) {
        await sendTg(otherId, `❌ Обмін скасовано іншим гравцем.`);
      }

      return res.status(200).json({ ok: true, stage: 'cancelled' });
    }

    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('Trade API error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};
