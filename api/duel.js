/**
 * TapSentinel Duels v2 — атомарные комнаты дуэлей.
 * Кто быстрее накликает 100 фокач. Сервер — источник истины, гонок чтение-запись нет.
 *
 * Ключи:
 *   duel:{id}        — метаданные матча (игроки, стадия, тайминги)
 *   duel_scores:{id} — hash: userId → счёт (HINCRBY, атомарно)
 *   duel_seen:{id}   — hash: userId → lastSeen (HSET, атомарно)
 *   duel_result:{id} — результат (SETNX — пишется ОДИН раз, первый достигший 100 побеждает)
 *   duel_lasttap:{id}— hash: userId → ts последнего тап-репорта
 *
 * Стадии: challenge (TTL 5м) → accepted → countdown (3с) → live
 *         → paused (соперник вышел, 30с → нокаут) → finished | cancelled
 * Финиш: 100 тапов | время 15 мин (ничья) | выход > 30с | 3 страйка темпа (чит)
 */

const GOAL = 100;
const MAX_RATE = 15;                // тапов/с — физический предел
const RATE_VIOLATIONS = 3;          // страйков темпа → чит-финиш
const PAUSE_MS = 30 * 1000;         // выход соперника → пауза → нокаут
const DUEL_LIMIT = 15 * 60 * 1000;  // максимальная длительность
const DUEL_TTL = 5 * 60 * 1000;     // время на ответ на вызов
const ACCEPT_TTL = 5 * 60 * 1000;   // время войти в мини-апп
const FRESH_MS = 30 * 24 * 3600 * 1000;
const KARMA_MIN = 25;               // ниже — «Тінь бабусі», дуэли закрыты
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

async function getDuel(duelId) {
  const raw = await redis('GET', `duel:${duelId}`);
  if (!raw?.result) return null;
  try { return JSON.parse(raw.result); } catch { return null; }
}

async function saveDuel(duel) {
  const ttl = duel.stage === 'finished' || duel.stage === 'cancelled' ? 3600 : 7200;
  await redis('SET', `duel:${duel.id}`, JSON.stringify(duel), 'EX', ttl);
}

// результат пишется ОДИН раз (SETNX): первый достигший цели — победитель навсегда
async function finishDuel(duel, winner, reason) {
  const set = await redis('SET', `duel_result:${duel.id}`, JSON.stringify({ winner, reason, ts: Date.now() }), 'NX');
  if (!set?.result) return null; // уже зафиксировано другим финишем
  duel.stage = 'finished';
  duel.winner = winner;
  duel.reason = reason;
  await saveDuel(duel);

  const draw = winner === 'draw';
  if (!draw) {
    await grantReward(winner, 5);
    const loser = winner === duel.p1.id ? duel.p2.id : duel.p1.id;
    const winText =
      reason === 'cheat' ? '🏆 Соперник возможно использовал стороннее ПО — победа за тобой!' :
      reason === 'forfeit' ? '🏆 Соперник покинул дуэль — победа за тобой!' :
      '🏆 Ты первым накликал 100 фокач! +5💎';
    const loseText =
      reason === 'cheat' ? '🚫 Обнаружено стороннее ПО — поражение. −10 кармы.' :
      reason === 'forfeit' ? '🏃 Соперник покинул дуэль — поражение.' :
      '💔 Соперник был быстрее.';
    await sendTg(winner, winText + ' +5💎 (забери в основной игре)');
    await sendTg(loser, loseText);
    if (reason === 'cheat') {
      const k = await getKarma(loser);
      await setKarma(loser, Math.max(0, k - 10));
    }
  } else {
    await grantReward(duel.p1.id, 2);
    await grantReward(duel.p2.id, 2);
    await sendTg(duel.p1.id, '🤝 Время вышло — ничья! +2💎 обоим');
    await sendTg(duel.p2.id, '🤝 Время вышло — ничья! +2💎 обоим');
  }
  return { winner, reason };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) return res.status(200).json({ ok: false, error: 'no kv' });

  const now = Date.now();

  try {
    // ===== POST — действия =====
    if (req.method === 'POST') {
      const body = req.body || {};
      const action = body.action;

      // --- создать вызов ---
      if (action === 'challenge') {
        const from = String(body.from || '');
        const to = String(body.to || '');
        const fromName = String(body.fromName || 'Гравець').replace(/\uFFFD/g, '').trim().slice(0, 24) || 'Гравець';
        const fromU = String(body.fromU || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
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
          p1: { id: from, name: fromName, u: fromU },
          p2: { id: to, name: '', u: '' },
          createdAt: now, expiresAt: now + DUEL_TTL,
        };
        await saveDuel(duel);
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
        duel.p2.name = String(body.name || duel.p2.name || 'Гравець').replace(/\uFFFD/g, '').trim().slice(0, 24) || 'Гравець';
        duel.p2.u = String(body.u || duel.p2.u || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
        duel.stage = 'accepted';
        duel.acceptedAt = now;
        await saveDuel(duel);
        const url = `${DUEL_SITE}${duelId}`;
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

      // sync обрабатывается общим игровым циклом ниже
      if (action !== 'sync') {
        return res.status(400).json({ ok: false, error: 'unknown action' });
      }
    }

    // ===== GET/POST sync — игровой цикл (единый для обоих игроков) =====
    const isGet = req.method === 'GET';
    const q = isGet ? req.query : req.body || {};
    const duelId = String(q.duelId || '');
    const userId = String(q.userId || '');
    const delta = isGet ? 0 : Math.max(0, Math.min(Math.floor(Number(q.delta)) || 0, 200));

    const duel = await getDuel(duelId);
    if (!duel) return res.status(200).json({ ok: false, error: 'not found', v: 'v5.1.1' });
    const isP1 = duel.p1.id === userId;
    const isP2 = duel.p2.id === userId;
    if (!isP1 && !isP2) return res.status(200).json({ ok: false, error: 'not a player' });
    const me = isP1 ? duel.p1 : duel.p2;
    const opp = isP1 ? duel.p2 : duel.p1;

    // присутствие — атомарно
    await redis('HSET', `duel_seen:${duelId}`, userId, String(now));

    // истёкший вызов
    if (duel.stage === 'challenge' && now > duel.expiresAt) {
      duel.stage = 'cancelled';
      duel.reason = 'timeout';
      await saveDuel(duel);
      await sendTg(duel.p1.id, '⏱ Соперник не ответил за 5 минут — дуэль отменена.');
      return res.status(200).json({ ok: false, error: 'expired', stage: 'cancelled' });
    }

    // вход игрока в мини-апп: оба внутри → отсчёт
    if (duel.stage === 'accepted') {
      const seen1 = await redis('HGET', `duel_seen:${duelId}`, duel.p1.id);
      const seen2 = await redis('HGET', `duel_seen:${duelId}`, duel.p2.id);
      if (seen1?.result && seen2?.result) {
        duel.stage = 'countdown';
        duel.startTs = now + 7000; // 4с интро (VS) + 3с отсчёт
        await saveDuel(duel);
      } else if (duel.acceptedAt && now - duel.acceptedAt > ACCEPT_TTL) {
        // соперник так и не вошёл — техническое поражение
        const joinedId = seen1?.result ? duel.p1.id : duel.p2.id;
        const fin = await finishDuel(duel, joinedId, 'forfeit');
        return res.status(200).json({ ok: true, stage: 'finished', winner: fin?.winner, reason: 'forfeit' });
      }
    }

    // отсчёт закончился → бой
    if (duel.stage === 'countdown' && duel.startTs && now >= duel.startTs) {
      duel.stage = 'live';
      await saveDuel(duel);
    }

    // пауза: соперник не пингует 15с → пауза на экране; 30с → нокаут оставшемуся
    if (duel.stage === 'live' || duel.stage === 'paused') {
      const oppSeenRaw = await redis('HGET', `duel_seen:${duelId}`, opp.id);
      const oppSeenTs = oppSeenRaw?.result ? parseInt(oppSeenRaw.result) : 0;
      const oppGone = oppSeenTs > 0 && now - oppSeenTs > PAUSE_MS / 2;
      if (duel.stage === 'live' && oppGone) {
        duel.stage = 'paused';
        duel.pausedAt = now;
        duel.missing = opp.id;
        await saveDuel(duel);
      } else if (duel.stage === 'paused') {
        if (!oppGone) {
          duel.pausedTotal = (duel.pausedTotal || 0) + (now - (duel.pausedAt || now));
          duel.startTs = (duel.startTs || now) + (now - (duel.pausedAt || now));
          duel.stage = 'live';
          duel.missing = null;
          delete duel.pausedAt;
          await saveDuel(duel);
        } else if (now - (duel.pausedAt || now) > PAUSE_MS) {
          const fin = await finishDuel(duel, userId, 'forfeit');
          return res.status(200).json({ ok: true, stage: 'finished', winner: fin?.winner || userId, reason: 'forfeit', v: 'v5.1.1' });
        }
      }
      // лимит времени: 15 минут чистой игры → ничья
      if (duel.stage === 'live' && duel.startTs && now - duel.startTs > DUEL_LIMIT) {
        await finishDuel(duel, 'draw', 'time');
        return res.status(200).json({ ok: true, stage: 'finished', winner: 'draw', reason: 'time', v: 'v5.1.1' });
      }
    }

    // отсчёт закончился → бой
    if (duel.stage === 'countdown' && duel.startTs && now >= duel.startTs) {
      duel.stage = 'live';
      await saveDuel(duel);
    }

    // тапы игрока: атомарный инкремент (гонки исключены)
    let myScore = 0;
    if ((duel.stage === 'live') && delta > 0) {
      myScore = parseInt((await redis('HINCRBY', `duel_scores:${duelId}`, userId, String(delta)))?.result || '0', 10);

      // валидация темпа: implied CPS между репортами; 3 страйка → чит-финиш
      const prevTapRaw = await redis('HGET', `duel_lasttap:${duelId}`, userId);
      const prevTap = prevTapRaw?.result ? parseInt(prevTapRaw.result) : 0;
      await redis('HSET', `duel_lasttap:${duelId}`, userId, String(now));
      const dMs = Math.max(1, now - prevTap);
      if (prevTap > 0 && (delta * 1000) / dMs > MAX_RATE) {
        const v = parseInt((await redis('HINCRBY', `duel_viol:${duelId}`, userId, '1'))?.result || '0', 10);
        if (v >= RATE_VIOLATIONS) {
          const fin = await finishDuel(duel, opp.id, 'cheat');
          await setKarma(userId, Math.max(0, (await getKarma(userId)) - 10));
          return res.status(200).json({ ok: true, stage: 'finished', winner: opp.id, reason: 'cheat', v: 'v5.1.1' });
        }
      }

      if (myScore >= GOAL) {
        const fin = await finishDuel(duel, userId, '100');
        const winner = fin ? fin.winner : (await getDuel(duelId))?.winner || userId;
        return res.status(200).json({ ok: true, stage: 'finished', winner, reason: '100', v: 'v5.1.1' });
      }
    }

    // пауза: соперник не пингует → нокаут оставшемуся + лимит времени (дубли не нужны)
    if (duel.stage === 'live') {
      const oppSeenRaw = await redis('HGET', `duel_seen:${duelId}`, opp.id);
      const oppSeenTs = oppSeenRaw?.result ? parseInt(oppSeenRaw.result) : 0;
      if (oppSeenTs > 0 && now - oppSeenTs > PAUSE_MS) {
        const fin = await finishDuel(duel, userId, 'forfeit');
        return res.status(200).json({ ok: true, stage: 'finished', winner: fin?.winner || userId, reason: 'forfeit', v: 'v5.1.1' });
      }
    }

    // снапшот для игрока
    const rawScores = await redis('HGETALL', `duel_scores:${duelId}`);
    const scores = {};
    if (rawScores?.result) {
      for (let i = 0; i < rawScores.result.length; i += 2) scores[rawScores.result[i]] = parseInt(rawScores.result[i + 1]) || 0;
    }
    myScore = scores[userId] || 0;
    const oppScore = scores[opp.id] || 0;
    const oppSeen = await redis('HGET', `duel_seen:${duelId}`, opp.id);
    const oppSeenTs = oppSeen?.result ? parseInt(oppSeen.result) : 0;
    const oppMissing = duel.stage === 'paused' || (duel.stage === 'live' && oppSeenTs > 0 && now - oppSeenTs > PAUSE_MS / 2);
    const pausedLeft = duel.stage === 'paused' ? Math.max(0, PAUSE_MS - (now - (duel.pausedAt || now))) : 0;

    return res.status(200).json({
      ok: true, v: 'v5.1.1',
      stage: duel.stage,
      me: { id: me.id, name: me.name, u: me.u || '', score: myScore },
      opp: { id: opp.id, name: opp.name, u: opp.u || '', score: oppScore, missing: oppMissing },
      goal: GOAL,
      startTs: duel.startTs || 0,
      elapsed: duel.startTs ? Math.max(0, now - duel.startTs) : 0,
      limit: DUEL_LIMIT,
      serverNow: now,
      winner: duel.winner || null,
      reason: duel.reason || null,
      pausedLeft,
    });
  } catch (err) {
    console.error('Duel error:', err);
    return res.status(200).json({ ok: false, error: 'internal' });
  }
};
