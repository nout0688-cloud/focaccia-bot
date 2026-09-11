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
const TRADE_SITE = 'https://nout0688-cloud.github.io/focaccia-clicker/?v=1.4.0&trade=';
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
    // 1. Отримати актуальний баланс користувача
    if (action === 'get_balance') {
      const userId = String(body.userId || req.query.userId || '');
      if (!userId) return res.status(400).json({ ok: false, error: 'no_userId' });
      const bal = await getUserBalance(userId);
      return res.status(200).json({ ok: true, focaccia: bal.f, diamonds: bal.d });
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
      if (to && from === to) {
        return res.status(400).json({ ok: false, error: 'self_trade_not_allowed' });
      }

      const tradeId = `tr_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const trade = {
        id: tradeId,
        stage: 'active', // active | completed | cancelled
        p1: { id: from, name: fromName, u: fromU },
        p2: to ? { id: to, name: '', u: '' } : null,
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
      const url = `${TRADE_SITE}${tradeId}`;

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
      const hasP2 = Boolean(trade.p2 && trade.p2.id && trade.p2.id !== 'null' && trade.p2.id !== 'undefined');
      return res.status(200).json({
        ok: true,
        trade: {
          id: trade.id,
          stage: trade.stage,
          p1: { name: trade.p1.name, u: trade.p1.u },
          p2: hasP2 ? { name: trade.p2.name, u: trade.p2.u } : null,
          hasP2,
          isP1: trade.p1.id === userId,
          isP2: hasP2 && trade.p2.id === userId,
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

    let isP1 = trade.p1.id === userId;
    let isP2 = Boolean(trade.p2 && trade.p2.id === userId);
    const isP2Empty = !trade.p2 || !trade.p2.id || trade.p2.id === 'null' || trade.p2.id === 'undefined';

    // Приєднання до відкритого посилання (open trade), якщо p2 ще немає і гравець не p1
    if (!isP1 && !isP2 && isP2Empty) {
      trade.p2 = {
        id: userId,
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
        } : null,
      });
    }

    // 3. Синхронізація пропозицій (Sync)
    if (action === 'sync') {
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
        opp: opp ? {
          id: opp.id,
          name: opp.name || 'Партнер',
          u: opp.u || '',
          offer: oppOffer,
          locked: oppLocked,
          confirmed: oppConfirmed,
          online: (now - oppSeen) < 10000,
        } : null,
      });
    }

    // 4. Зафіксувати або розблокувати пропозицію (Lock)
    if (action === 'lock') {
      if (trade.stage !== 'active') return res.status(200).json({ ok: false, error: 'trade_not_active' });
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

        // Атомарне оновлення балансів:
        const nextP1F = Math.max(0, balP1.f - trade.p1Offer.focaccia + trade.p2Offer.focaccia);
        const nextP1D = Math.max(0, balP1.d - trade.p1Offer.diamonds + trade.p2Offer.diamonds);
        const nextP2F = Math.max(0, balP2.f - trade.p2Offer.focaccia + trade.p1Offer.focaccia);
        const nextP2D = Math.max(0, balP2.d - trade.p2Offer.diamonds + trade.p1Offer.diamonds);

        await setUserBalance(trade.p1.id, nextP1F, nextP1D);
        await setUserBalance(trade.p2.id, nextP2F, nextP2D);

        // Обмін скінами через черги винагород
        if (trade.p1Offer.skins.length > 0) {
          // P1 втрачає свої скіни, P2 отримує їх
          await redis('SET', `lost_skins:${trade.p1.id}`, JSON.stringify(trade.p1Offer.skins));
          await redis('SET', `reward_skins:${trade.p2.id}`, JSON.stringify(trade.p1Offer.skins));
        }
        if (trade.p2Offer.skins.length > 0) {
          // P2 втрачає свої скіни, P1 отримує їх
          await redis('SET', `lost_skins:${trade.p2.id}`, JSON.stringify(trade.p2Offer.skins));
          await redis('SET', `reward_skins:${trade.p1.id}`, JSON.stringify(trade.p2Offer.skins));
        }

        trade.stage = 'completed';
        trade.completedAt = now;
        await saveTrade(trade);

        // Надсилаємо привітальні сповіщення у Telegram
        const p1Got = [];
        if (trade.p2Offer.focaccia > 0) p1Got.push(`${trade.p2Offer.focaccia.toLocaleString()} 🫓`);
        if (trade.p2Offer.diamonds > 0) p1Got.push(`${trade.p2Offer.diamonds} 💎`);
        if (trade.p2Offer.skins.length > 0) p1Got.push(`${trade.p2Offer.skins.length} скін(ів)`);

        const p2Got = [];
        if (trade.p1Offer.focaccia > 0) p2Got.push(`${trade.p1Offer.focaccia.toLocaleString()} 🫓`);
        if (trade.p1Offer.diamonds > 0) p2Got.push(`${trade.p1Offer.diamonds} 💎`);
        if (trade.p1Offer.skins.length > 0) p2Got.push(`${trade.p1Offer.skins.length} скін(ів)`);

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
