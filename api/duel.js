/**
 * TapSentinel Duels — комнаты дуэлей.
 * Кто быстрее накликает 100 фокач. Стейт-машина в Redis, сервер — источник истины.
 *
 * POST { action: 'challenge', from, fromName, to }            → создать вызов (TTL 5 мин)
 * POST { action: 'accept'|'decline', duelId, userId }          → ответ на вызов
 * POST { action: 'sync', duelId, userId, delta }               → тикер игрока (+ пакет тапов)
 * GET  /api/duel?duelId=&userId=                               → снапшот состояния
 *
 * Стадии: challenge → accepted → (оба в мини-аппе) countdown → live
 *         → paused (соперник вышел, 30с) → finished | cancelled
 * Финиш: 100 тапов | время 15 мин (ничья) | выход > 30с (нокаут) | 3 детекта темпа (чит)
 */

const DUEL_TTL = 5 * 60 * 1000;          // время на ответ на вызов
const ACCEPT_TTL = 5 * 60 * 1000;        // время зайти в мини-апп после принятия
const COUNTDOWN_MS = 3000;               // отсчёт 3-2-1
const GOAL = 100;                        // фокач до победы
const MAX_RATE = 15;                     // тапов/с — физический предел
const RATE_VIOLATIONS = 3;               // страйков темпа → чит-финиш
const PAUSE_MS = 30 * 1000;              // выход соперника → пауза → нокаут
const DUEL_LIMIT = 15 * 60 * 1000;       // максимальная длительность дуэли
const KARMA_MIN = 25; // ниже — «Тінь бабусі», дуэли закрыты
const BOT_TOKEN = process.env.BOT_TOKEN;

const DUEL_SITE = 'https://nout0688-cloud.github.io/focaccia-clicker/?duel=';

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
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(chatId), text, ...extra }),
    });
  } catch { /* ignore */ }
}

async function getDuel(duelId) {
  const raw = await redis('GET', `duel:${duelId}`);
  if (!raw?.result) return null;
  try { return JSON.parse(raw.result); } catch { return null; }
}

async function saveDuel(duel) {
  const ttl = duel.stage === 'finished' || duel.stage === 'cancelled' ? 3600 : 7200;
  await redis('SET', `duel:${duel.id}`, JSON.stringify(duel), 'EX', ttl);
}

async function getKarma(userId) {
  const raw = await redis('HGET', 'ac_karma', String(userId));
  if (!raw?.result) return 100;
  try { return Math.max(0, Math.min(100, JSON.parse(raw.result).k || 0)); } catch { return 100; }
}

async function setKarma(userId, karma) {
  await redis('HSET', 'ac_karma', String(userId), JSON.stringify({ k: karma, on: 0, ts: Date.now() }));
}

// награда победителю через существующий reward-механизм (забирается в основной игре)
async function grantReward(userId, amount) {
  const raw = await redis('GET', `reward:${userId}`);
  const cur = raw?.result ? parseInt(raw.result, 10) : 0;
  await redis('SET', `reward:${userId}`, String(cur + amount));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) return res.status(200).json({ ok: false, error: 'no kv' });

  const now = Date.now();

  try {
    // ===== GET — снапшот состояния для игрока (+ побочные проверки стадий) =====
    if (req.method === 'GET') {
      const duelId = String(req.query.duelId || '');
      const userId = String(req.query.userId || '');
      const duel = await getDuel(duelId);
      if (!duel) return res.status(200).json({ ok: false, error: 'not found' });

      const isP1 = duel.p1.id === userId;
      const isP2 = duel.p2.id === userId;
      if (!isP1 && !isP2) return res.status(200).json({ ok: false, error: 'not a player' });
      const me = isP1 ? duel.p1 : duel.p2;
      const opp = isP1 ? duel.p2 : duel.p1;

      // истёк вызов
      if (duel.stage === 'challenge' && now > duel.expiresAt) {
        duel.stage = 'cancelled';
        duel.reason = 'timeout';
        await saveDuel(duel);
        await sendTg(duel.p1.id, '⏱ Соперник не ответил за 5 минут — дуэль отменена.');
        return res.status(200).json({ ok: false, error: 'expired', stage: 'cancelled' });
      }

      // вход игрока в мини-апп (первый sync = он в игре)
      if (duel.stage === 'accepted') {
        duel.lastSeen = duel.lastSeen || {};
        duel.lastSeen[userId] = now;
        if (duel.lastSeen[duel.p1.id] && duel.lastSeen[duel.p2.id]) {
          duel.stage = 'countdown';
          duel.startTs = now + COUNTDOWN_MS;
          await saveDuel(duel);
        } else {
          await saveDuel(duel);
          // долгое ожидание входа — не зашёл → техническое поражение
          const otherJoined = !!duel.lastSeen[opp.id];
          if (otherJoined && duel.acceptedAt && now - duel.acceptedAt > ACCEPT_TTL) {
            duel.stage = 'finished';
            duel.winner = opp.id;
            duel.reason = 'forfeit';
            await saveDuel(duel);
            await grantReward(opp.id, 5);
            await sendTg(opp.id, '🏆 Соперник не вошёл в игру — победа за тобой! +5💎');
          }
        }
      }

      // живая дуэль: пауза/нокаут/лимит времени
      if (duel.stage === 'live' || duel.stage === 'paused') {
        duel.lastSeen = duel.lastSeen || {};
        duel.lastSeen[userId] = now;
        const oppSeen = duel.lastSeen[opp.id] || 0;
        if (duel.stage === 'live' && now - oppSeen > PAUSE_MS) {
          duel.stage = 'paused';
          duel.pausedAt = now;
          duel.missing = opp.id;
          await saveDuel(duel);
        } else if (duel.stage === 'paused') {
          if (now - oppSeen < PAUSE_MS / 2) {
            // соперник вернулся — сдвигаем старт, чтобы время паузы не считалось
            duel.startTs = (duel.startTs || now) + (now - (duel.pausedAt || now));
            duel.stage = 'live';
            duel.missing = null;
            delete duel.pausedAt;
            await saveDuel(duel);
          } else if (now - (duel.pausedAt || now) > PAUSE_MS) {
            duel.stage = 'finished';
            duel.winner = userId;      // тот, кто остался — победил
            duel.reason = 'forfeit';
            await saveDuel(duel);
            await grantReward(userId, 5);
            await sendTg(userId, '🏆 Соперник покинул дуэль — победа за тобой! +5💎');
          }
        }
        // лимит длительности: 15 минут → ничья
        if (duel.stage === 'live' && duel.startTs && now - duel.startTs > DUEL_LIMIT) {
          duel.stage = 'finished';
          duel.winner = 'draw';
          duel.reason = 'time';
          duel.scores[duel.p1.id] = duel.scores[duel.p1.id] || 0;
          duel.scores[duel.p2.id] = duel.scores[duel.p2.id] || 0;
          await saveDuel(duel);
          await grantReward(duel.p1.id, 2);
          await grantReward(duel.p2.id, 2);
        }
      }

      const myScore = duel.scores?.[me.id] || 0;
      const oppScore = duel.scores?.[opp.id] || 0;
      return res.status(200).json({
        ok: true,
        stage: duel.stage,
        me: { id: me.id, name: me.name, score: myScore },
        opp: { id: opp.id, name: opp.name, score: oppScore, missing: duel.missing === opp.id },
        goal: GOAL,
        startTs: duel.startTs || 0,
        elapsed: duel.startTs ? Math.max(0, now - duel.startTs) : 0,
        limit: DUEL_LIMIT,
        serverNow: now,
        winner: duel.winner || null,
        reason: duel.reason || null,
        pausedLeft: duel.stage === 'paused' ? Math.max(0, PAUSE_MS - (now - (duel.pausedAt || now))) : 0,
      });
    }

    // ===== POST — действия =====
    if (req.method === 'POST') {
      const body = req.body || {};
      const action = body.action;

      // --- создать вызов ---
      if (action === 'challenge') {
        const from = String(body.from || '');
        const to = String(body.to || '');
        const fromName = String(body.fromName || 'Гравець').slice(0, 24);
        if (!/^\d{1,20}$/.test(from) || !/^\d{1,20}$/.test(to) || from === to) {
          return res.status(400).json({ ok: false, error: 'invalid players' });
        }
        const kFrom = await getKarma(from);
        const kTo = await getKarma(to);
        if (kFrom < KARMA_MIN || kTo < KARMA_MIN) {
          return res.status(200).json({ ok: false, error: 'shadow', karma: Math.min(kFrom, kTo) });
        }
        const duelId = `d${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        const duel = {
          id: duelId,
          stage: 'challenge',
          p1: { id: from, name: fromName },
          p2: { id: to, name: '' },
          scores: {}, lastSeen: {}, violations: {},
          createdAt: now, expiresAt: now + DUEL_TTL,
        };
        await saveDuel(duel);
        // уведомление сопернику через бота
        await sendTg(to, `⚔️ Тебя вызвали на дуэль! (${fromName})\n⏱ 5 минут на ответ.`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '⚔️ Начать', callback_data: `duel:accept:${duelId}` },
                { text: '❌ Отказ', callback_data: `duel:decline:${duelId}` },
              ],
            ],
          },
        });
        return res.status(200).json({ ok: true, duelId });
      }

      const duelId = String(body.duelId || '');
      const userId = String(body.userId || '');
      const duel = await getDuel(duelId);
      if (!duel) return res.status(200).json({ ok: false, error: 'not found' });
      const isP1 = duel.p1.id === userId;
      const isP2 = duel.p2.id === userId;
      if (!isP1 && !isP2) return res.status(200).json({ ok: false, error: 'not a player' });
      const me = isP1 ? duel.p1 : duel.p2;
      const opp = isP1 ? duel.p2 : duel.p1;

      // --- принять вызов ---
      if (action === 'accept') {
        if (duel.stage !== 'challenge') return res.status(200).json({ ok: false, error: 'gone' });
        if (now > duel.expiresAt) {
          duel.stage = 'cancelled';
          duel.reason = 'timeout';
          await saveDuel(duel);
          await sendTg(duel.p1.id, '⏱ Соперник не ответил за 5 минут — дуэль отменена.');
          return res.status(200).json({ ok: false, error: 'expired' });
        }
        duel.p2.name = duel.p2.name || opp.name || 'Гравець';
        duel.stage = 'accepted';
        duel.acceptedAt = now;
        await saveDuel(duel);
        const url = `${DUEL_SITE}?duel=${duelId}`;
        const kb = { inline_keyboard: [[{ text: '🎮 Войти в дуэль', web_app: { url } }]] };
        await sendTg(duel.p1.id, `⚔️ ${me.name} принял вызов! Войди в дуэль.`, { reply_markup: kb });
        await sendTg(duel.p2.id, '⚔️ Войди в дуэль. Кто быстрее накликает 100 фокач!', { reply_markup: kb });
        return res.status(200).json({ ok: true, url });
      }

      // --- отклонить ---
      if (action === 'decline') {
        if (duel.stage !== 'challenge') return res.status(200).json({ ok: false, error: 'gone' });
        duel.stage = 'cancelled';
        duel.reason = 'declined';
        await saveDuel(duel);
        await sendTg(duel.p1.id, `❌ ${me.name || 'Соперник'} отклонил вызов.`);
        return res.status(200).json({ ok: true });
      }

      // --- sync: пакет тапов + снапшот (основной цикл игры) ---
      if (action === 'sync') {
        if (duel.stage !== 'live') {
          // всё равно отмечаем присутствие (для resume)
          duel.lastSeen = duel.lastSeen || {};
          duel.lastSeen[userId] = now;
          if (duel.stage === 'paused') {
            const oppSeen = duel.lastSeen[opp.id] || 0;
            if (now - oppSeen < PAUSE_MS / 2) {
              duel.startTs = (duel.startTs || now) + (now - (duel.pausedAt || now));
              duel.stage = 'live';
              duel.missing = null;
              delete duel.pausedAt;
            }
          }
          await saveDuel(duel);
          return res.status(200).json({ ok: true, stage: duel.stage, me: { score: duel.scores?.[me.id] || 0 }, opp: { score: duel.scores?.[opp.id] || 0, missing: duel.missing === opp.id }, pausedLeft: duel.stage === 'paused' ? Math.max(0, PAUSE_MS - (now - (duel.pausedAt || now))) : 0 });
        }

        const delta = Math.max(0, Math.min(Math.floor(Number(body.delta)) || 0, 200));
        duel.lastSeen = duel.lastSeen || {};
        duel.lastSeen[userId] = now;

        // валидация темпа: implied CPS за окно между репортами
        const prevTap = duel.lastTapAt?.[userId] || 0;
        duel.lastTapAt = duel.lastTapAt || {};
        duel.lastTapAt[userId] = now;
        const dMs = Math.max(1, now - prevTap);
        const impliedCps = (delta * 1000) / dMs;
        if (impliedCps > MAX_RATE) {
          duel.violations[userId] = (duel.violations[userId] || 0) + 1;
          if (duel.violations[userId] >= RATE_VIOLATIONS) {
            // 3+ детекта темпа — соперник возможно использует стороннее ПО
            duel.stage = 'finished';
            duel.winner = opp.id;
            duel.reason = 'cheat';
            duel.scores[opp.id] = Math.max(duel.scores[opp.id] || 0, GOAL);
            await saveDuel(duel);
            const k = await getKarma(userId);
            await setKarma(userId, Math.max(0, k - 10));
            await grantReward(opp.id, 5);
            await sendTg(opp.id, '🏆 Соперник возможно использовал стороннее ПО — победа за тобой! +5💎');
            await sendTg(userId, '🚫 Обнаружено стороннее ПО — поражение. −10 кармы.');
            return res.status(200).json({ ok: true, stage: 'finished', winner: opp.id, reason: 'cheat', me: { score: duel.scores[me.id] || 0 }, opp: { score: GOAL } });
          }
        }

        duel.scores[userId] = (duel.scores[userId] || 0) + delta;
        const myScore = duel.scores[userId] || 0;
        if (myScore >= GOAL) {
          duel.stage = 'finished';
          duel.winner = userId;
          duel.reason = '100';
          duel.scores[userId] = GOAL;
          await saveDuel(duel);
          await grantReward(userId, 5); // победителю +5 алмазов (заберёт в основной игре)
          return res.status(200).json({ ok: true, stage: 'finished', winner: userId, reason: '100', me: { score: GOAL }, opp: { score: duel.scores[opp.id] || 0 } });
        }
        await saveDuel(duel);
        return res.status(200).json({
          ok: true, stage: duel.stage, me: { score: myScore },
          opp: { score: duel.scores[opp.id] || 0, missing: duel.missing === opp.id },
          pausedLeft: duel.stage === 'paused' ? Math.max(0, PAUSE_MS - (now - (duel.pausedAt || now))) : 0,
        });
      }

      return res.status(400).json({ ok: false, error: 'unknown action' });
    }

    return res.status(405).json({ ok: false, error: 'method' });
  } catch (err) {
    console.error('Duel error:', err);
    return res.status(200).json({ ok: false, error: 'internal' });
  }
};
