/**
 * TapSentinel Duels v3 — дуэли со ставками (эскроу на сервере).
 *
 * Флоу: вызов (валюта+ставка+цель+время) → принятие → оба в мини-аппе →
 * ставка списывается у обоих → отсчёт → бой (кто быстрее наберёт goal) → финиш.
 *
 * Ключи:
 *   duel:{id}         — метаданные матча (игроки, ставка, стадия)
 *   duel_scores:{id}  — hash: userId → тапы (HINCRBY, атомарно)
 *   duel_seen:{id}    — hash: userId → lastSeen
 *   duel_result:{id}  — результат (SETNX — пишется один раз)
 *   duel_escrow:{id}  — hash: userId → ставка, внесённая при старте
 *   duel_lasttap:{id} — hash: userId → ts последнего тап-репорта
 *   duel_viol:{id}    — hash: userId → страйки темпа
 *
 * Финиш: goal тапов | 15 мин (ничья) | выход > 30с (нокаут) | 3 страйка (чит).
 * Ставка (эскроу) уходит победителю — игроки получают её в дуэльном мини-аппе.
 */

const GOAL_DEFAULT = 100;
const GOAL_MIN = 10;
const GOAL_MAX = 100000;
const MAX_RATE = 15;                // тапов/с — физический предел
const RATE_VIOLATIONS = 3;          // страйков темпа → чит-финиш
const PAUSE_MS = 30 * 1000;         // выход соперника → пауза → нокаут
const DUEL_LIMIT = 15 * 60 * 1000;  // максимальная длительность
const DUEL_TTL = 5 * 60 * 1000;     // время на ответ на вызов
const ACCEPT_TTL = 5 * 60 * 1000;   // время войти в мини-апп
const KARMA_MIN = 25;               // ниже — «Тінь бабусі», дуэли закрыты
const BOT_TOKEN = process.env.BOT_TOKEN;
const DUEL_SITE = 'https://nout0688-cloud.github.io/focaccia-clicker/?v=';

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
  if (!BOT_TOKEN) return null;
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

const DUEL_MSG_CLEANUP_TTL = 15 * 60 * 1000; // 15 хвилин

async function scheduleMessageDeletion(chatId, messageId, delayMs = DUEL_MSG_CLEANUP_TTL) {
  if (!chatId || !messageId) return;
  try {
    const expireAt = Date.now() + delayMs;
    await redis('ZADD', 'duel_msg_cleanup', String(expireAt), `${chatId}:${messageId}`);
  } catch (e) {
    console.error('scheduleMessageDeletion error:', e);
  }
}

async function cleanupExpiredMessages(botToken) {
  const token = botToken || BOT_TOKEN;
  if (!token) return;
  try {
    const now = Date.now();
    const raw = await redis('ZRANGEBYSCORE', 'duel_msg_cleanup', '0', String(now));
    if (raw?.result && Array.isArray(raw.result) && raw.result.length > 0) {
      const items = raw.result;
      await Promise.allSettled(
        items.map(async (item) => {
          const sep = item.indexOf(':');
          if (sep === -1) return;
          const cId = item.slice(0, sep);
          const mId = item.slice(sep + 1);
          if (cId && mId) {
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: Number(cId), message_id: Number(mId) }),
            }).catch(() => {});
          }
        })
      );
      await redis('ZREMRANGEBYSCORE', 'duel_msg_cleanup', '0', String(now));
    }
  } catch (err) {
    console.error('cleanupExpiredMessages error:', err);
  }
}

async function sendDuelTg(chatId, text, extra = {}, delayMs = DUEL_MSG_CLEANUP_TTL) {
  const res = await sendTg(chatId, text, extra);
  if (res?.result?.message_id) {
    await scheduleMessageDeletion(chatId, res.result.message_id, delayMs);
  }
  return res;
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
async function grantFocaccia(userId, amount) {
  if (amount <= 0) return;
  const raw = await redis('GET', `reward:${userId}`);
  const cur = raw?.result ? parseInt(raw.result, 10) : 0;
  await redis('SET', `reward:${userId}`, String(cur + amount));
}

async function grantDiamonds(userId, amount) {
  if (amount <= 0) return;
  const raw = await redis('GET', `reward_gem:${userId}`);
  const cur = raw?.result ? parseInt(raw.result, 10) : 0;
  await redis('SET', `reward_gem:${userId}`, String(cur + amount));
  await redis('SET', `reward_gem_source:${userId}`, 'duel');
}

async function getUserBalance(userId, cur) {
  const uid = String(userId);
  let bal = null;
  const balData = await redis('HGET', 'user_balance', uid);
  if (balData?.result) {
    try {
      const bObj = JSON.parse(balData.result);
      const val = cur === 'gem' ? Number(bObj.d) : Number(bObj.f);
      if (!isNaN(val) && val > 0) bal = val;
    } catch { /* fallback */ }
  }
  // Fallback: перевіряємо leaderboard hash (якщо баланс фокач ще не репортився або 0)
  const lbData = await redis('HGET', 'leaderboard', uid);
  if (lbData?.result) {
    try {
      const lbObj = JSON.parse(lbData.result);
      if (cur === 'foc' && typeof lbObj.t === 'number') {
        bal = Math.max(bal || 0, lbObj.t);
      }
    } catch { /* fallback */ }
  }
  return bal;
}

async function getDuel(duelId) {
  const raw = await redis('GET', `duel:${duelId}`);
  if (!raw?.result) return null;
  try { return JSON.parse(raw.result); } catch { return null; }
}

// Если finishDuel вернул null (SETNX занят — кто-то уже зафиксировал победителя раньше),
// читаем duel_result из Redis и возвращаем реального победителя.
// Это устраняет race condition: захардкоженный winner в return-блоке мог перебить настоящего победителя.
async function getTrueWinner(duelId, fallbackWinner) {
  try {
    const raw = await redis('GET', `duel_result:${duelId}`);
    if (raw?.result) {
      const parsed = JSON.parse(raw.result);
      if (parsed?.winner) return { winner: parsed.winner, reason: parsed.reason };
    }
  } catch { /* fallback */ }
  return { winner: fallbackWinner, reason: null };
}

async function saveDuel(duel) {
  const ttl = duel.stage === 'finished' || duel.stage === 'cancelled' ? 3600 : 7200;
  await redis('SET', `duel:${duel.id}`, JSON.stringify(duel), 'EX', ttl);
}

// результат пишется ОДИН раз (SETNX): первый достигший цели — победитель навсегда.
// Ставка-банк: escrow обоих игроков уходит победителю (выдаётся в дуэльном мини-аппе и на сервере).
async function finishDuel(duel, winner, reason) {
  if (!winner || winner === 'none' || reason === 'no_funds' || duel.stage === 'cancelled') {
    duel.stage = 'cancelled';
    duel.winner = null;
    duel.reason = reason || 'cancelled';
    await saveDuel(duel);
    return null;
  }

  const set = await redis('SET', `duel_result:${duel.id}`, JSON.stringify({ winner, reason, ts: Date.now() }), 'NX');
  if (!set?.result) return null; // уже зафиксировано другим финишем
  const preStage = duel.stage; // сохраняем stage ДО изменения
  duel.stage = 'finished';
  duel.winner = winner;
  duel.reason = reason;
  await saveDuel(duel);

  const sym = duel.stakeCur === 'gem' ? '💎' : '🫓';
  // Якщо бій не розпочався (forfeit до старту гри) — банк НЕ подвоюється, а лише повертається своя ставка!
  const isPreGameForfeit = reason === 'forfeit' && (!duel.startTs || preStage !== 'live');
  const totalPot = isPreGameForfeit ? (duel.stake || 0) : ((duel.stake || 0) * 2);
  const draw = winner === 'draw';

  if (!draw) {
    if (duel.stakeCur === 'gem') {
      await grantDiamonds(winner, totalPot + (isPreGameForfeit ? 0 : 5));
    } else {
      if (totalPot > 0) await grantFocaccia(winner, totalPot);
      if (!isPreGameForfeit) await grantDiamonds(winner, 5);
    }
    const loser = winner === duel.p1.id ? duel.p2.id : duel.p1.id;
    const winText =
      reason === 'cheat' ? `🏆 Перемога! Суперник використав стороннє ПЗ.\n💰 Твій виграш: ${totalPot.toLocaleString('ru')} ${sym}!\n🎁 Бонус: +5 💎` :
      reason === 'forfeit' ? (isPreGameForfeit ? `ℹ️ Суперник не увійшов у дуель.\n💰 Твою ставку ${totalPot.toLocaleString('ru')} ${sym} повернуто.` : `🏆 Перемога! Суперник покинув дуель під час бою.\n💰 Твій виграш: ${totalPot.toLocaleString('ru')} ${sym}!\n🎁 Бонус: +5 💎`) :
      `🏆 ПЕРЕМОГА В ДУЕЛІ!\n💰 Твій виграш: ${totalPot.toLocaleString('ru')} ${sym} (банк дуелі)!\n🎁 Бонус: +5 💎 (забери в грі)`;
    const loseText =
      reason === 'cheat' ? '🚫 Виявлено стороннє ПЗ — поразка. −10 карми.' :
      reason === 'forfeit' ? `🏃 Поразка — ти покинув дуель.\n💸 Втрачено: ${(duel.stake || 0).toLocaleString('ru')} ${sym}` :
      `💔 Суперник наклікав швидше.\n💸 Втрачено: ${(duel.stake || 0).toLocaleString('ru')} ${sym}`;
    await sendTg(winner, winText);
    await sendTg(loser, loseText);
    if (reason === 'cheat') {
      const k = await getKarma(loser);
      await setKarma(loser, Math.max(0, k - 10));
    }
  } else {
    if (duel.stake > 0) {
      if (duel.stakeCur === 'gem') {
        await grantDiamonds(duel.p1.id, duel.stake + 2);
        await grantDiamonds(duel.p2.id, duel.stake + 2);
      } else {
        await grantFocaccia(duel.p1.id, duel.stake);
        await grantFocaccia(duel.p2.id, duel.stake);
        await grantDiamonds(duel.p1.id, 2);
        await grantDiamonds(duel.p2.id, 2);
      }
    } else {
      await grantDiamonds(duel.p1.id, 2);
      await grantDiamonds(duel.p2.id, 2);
    }
    await sendTg(duel.p1.id, `🤝 Час вийшов — нічия!\n💰 Ставка ${(duel.stake || 0).toLocaleString('ru')} ${sym} повернута.\n🎁 Бонус: +2 💎 обом`);
    await sendTg(duel.p2.id, `🤝 Час вийшов — нічия!\n💰 Ставка ${(duel.stake || 0).toLocaleString('ru')} ${sym} повернута.\n🎁 Бонус: +2 💎 обом`);
  }
  return { winner, reason };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) return res.status(200).json({ ok: false, error: 'no kv' });

  // 🧹 Автоматичне видалення застарілих повідомлень налаштування дуелей (>15 хв)
  await cleanupExpiredMessages(BOT_TOKEN);

  const now = Date.now();

  try {
    // --- дізнатися баланс користувача (GET) ---
    if (req.method === 'GET' && req.query.action === 'get_balance') {
      const uId = String(req.query.userId || '');
      if (!uId) return res.status(400).json({ ok: false, error: 'no userId' });
      const f = (await getUserBalance(uId, 'foc')) || 0;
      const d = (await getUserBalance(uId, 'gem')) || 0;
      return res.status(200).json({ ok: true, focaccia: f, diamonds: d });
    }

    // --- список активних гравців для вибору суперника (GET або POST) ---
    if ((req.method === 'GET' && req.query.action === 'get_active_players') || (req.method === 'POST' && req.body?.action === 'get_active_players')) {
      const myId = String(req.query.userId || req.body?.userId || '');
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

    // --- пошук гравця за @username або ID (GET або POST) ---
    if ((req.method === 'GET' && req.query.action === 'find_player') || (req.method === 'POST' && req.body?.action === 'find_player')) {
      const q = String(req.query.q || req.body?.q || '').trim();
      if (!q) return res.status(400).json({ ok: false, error: 'empty_query' });
      const cleanQ = q.replace(/^@/, '').toLowerCase();

      // 1. Числовий ID
      if (/^\d{5,20}$/.test(q)) {
        const uData = await redis('HGET', 'users', q);
        let name = 'Гравець';
        let username = '';
        if (uData?.result) {
          try {
            const parsed = JSON.parse(uData.result);
            if (parsed.name || parsed.first_name) name = parsed.name || parsed.first_name;
            if (parsed.username) username = parsed.username;
          } catch {}
        }
        return res.status(200).json({ ok: true, player: { id: q, name, username } });
      }

      // 2. Хеш таблиця usernames
      const mappedId = await redis('HGET', 'usernames', cleanQ);
      if (mappedId?.result) {
        const id = String(mappedId.result);
        let name = cleanQ;
        const uData = await redis('HGET', 'users', id);
        if (uData?.result) {
          try {
            const parsed = JSON.parse(uData.result);
            if (parsed.name || parsed.first_name) name = parsed.name || parsed.first_name;
          } catch {}
        }
        return res.status(200).json({ ok: true, player: { id, name, username: cleanQ } });
      }

      // 3. Хеш users
      const usersRaw = await redis('HGETALL', 'users');
      if (usersRaw?.result && Array.isArray(usersRaw.result)) {
        for (let i = 0; i < usersRaw.result.length; i += 2) {
          const id = String(usersRaw.result[i]);
          try {
            const u = JSON.parse(usersRaw.result[i + 1]);
            if (u.username && u.username.toLowerCase() === cleanQ) {
              return res.status(200).json({ ok: true, player: { id, name: u.name || u.first_name || id, username: u.username } });
            }
          } catch {}
        }
      }

      // 4. Хеш leaderboard
      const lbRaw = await redis('HGETALL', 'leaderboard');
      if (lbRaw?.result && Array.isArray(lbRaw.result)) {
        for (let i = 0; i < lbRaw.result.length; i += 2) {
          const id = String(lbRaw.result[i]);
          try {
            const lb = JSON.parse(lbRaw.result[i + 1]);
            if (lb.u && lb.u.toLowerCase() === cleanQ) {
              return res.status(200).json({ ok: true, player: { id, name: lb.n || id, username: lb.u } });
            }
          } catch {}
        }
      }

      return res.status(200).json({ ok: false, error: 'not_found' });
    }

    // --- попередній перегляд відкритої дуелі для підключення (GET) ---
    if (req.method === 'GET' && req.query.action === 'preview') {
      const duelId = String(req.query.duelId || '');
      const duel = await getDuel(duelId);
      if (!duel) return res.status(200).json({ ok: false, error: 'not found' });
      return res.status(200).json({
        ok: true,
        duel: {
          id: duel.id,
          stage: duel.stage,
          isOpen: Boolean(duel.isOpen),
          creator: duel.p1,
          stakeCur: duel.stakeCur,
          stake: duel.stake,
          goal: duel.goal,
          timeMs: duel.timeMs,
          expiresAt: duel.expiresAt,
        },
      });
    }

    // ===== POST — действия =====
    if (req.method === 'POST') {
      const body = req.body || {};
      const action = body.action;

      // --- дізнатися баланс користувача (POST) ---
      if (action === 'get_balance') {
        const uId = String(body.userId || req.query.userId || '');
        if (!uId) return res.status(400).json({ ok: false, error: 'no userId' });
        const f = (await getUserBalance(uId, 'foc')) || 0;
        const d = (await getUserBalance(uId, 'gem')) || 0;
        return res.status(200).json({ ok: true, focaccia: f, diamonds: d });
      }

      // --- створити виклик (персональний або відкритий) ---
      if (action === 'challenge') {
        const from = String(body.from || '');
        const to = String(body.to || '').trim();
        const isOpen = !to || to === 'null' || to === 'open';
        const fromName = String(body.fromName || 'Гравець').replace(/\uFFFD/g, '').trim().slice(0, 24) || 'Гравець';
        const fromU = String(body.fromU || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);

        if (!/^\d{1,20}$/.test(from)) {
          return res.status(400).json({ ok: false, error: 'invalid creator' });
        }
        if (!isOpen && (!/^\d{1,20}$/.test(to) || from === to)) {
          return res.status(400).json({ ok: false, error: 'invalid opponent' });
        }

        const stakeCur = body.stakeCur === 'gem' ? 'gem' : 'foc';
        const stake = Math.max(0, Math.min(Math.floor(Number(body.stake)) || 0, 1e21));
        const goal = Math.max(GOAL_MIN, Math.min(Math.floor(Number(body.goal)) || GOAL_DEFAULT, GOAL_MAX));
        const timeMs = Math.max(60000, Math.min(Math.floor(Number(body.timeMs)) || 180000, DUEL_LIMIT));

        const kFrom = await getKarma(from);
        if (kFrom < KARMA_MIN) {
          return res.status(200).json({ ok: false, error: 'shadow', karma: kFrom });
        }

        if (!isOpen) {
          const kTo = await getKarma(to);
          if (kTo < KARMA_MIN) {
            return res.status(200).json({ ok: false, error: 'shadow', karma: kTo });
          }
        }

        // Валідація балансу творця
        if (stake > 0) {
          const fromBal = await getUserBalance(from, stakeCur);
          if (fromBal !== null && fromBal < stake) {
            return res.status(200).json({ ok: false, error: 'no_funds_creator' });
          }

          if (!isOpen) {
            const toBal = await getUserBalance(to, stakeCur);
            if (toBal !== null && toBal < stake) {
              return res.status(200).json({ ok: false, error: 'no_funds_opponent' });
            }
          }
        }

        const toName = String(body.toName || '').replace(/\uFFFD/g, '').trim().slice(0, 24);
        const toU = String(body.toU || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
        const duelId = `d${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        const duel = {
          id: duelId,
          stage: 'challenge',
          isOpen,
          p1: { id: from, name: fromName, u: fromU },
          p2: { id: isOpen ? '' : to, name: toName, u: toU },
          stakeCur, stake, goal, timeMs,
          createdAt: now, expiresAt: now + DUEL_TTL,
        };
        await saveDuel(duel);

        const sym = stakeCur === 'gem' ? '💎' : '🫓';
        const webAppUrl = `${DUEL_SITE}${Date.now()}&duel=${duelId}`;

        if (!isOpen) {
          await sendDuelTg(to, `⚔️ ${fromName} кинув тобі виклик на дуель!\n💰 Ставка: ${stake.toLocaleString('ru')} ${sym}\n🎯 Ціль: ${goal.toLocaleString('ru')} тапів\n⏱ Раунд: ${Math.round(timeMs / 60000)} хв\n\nУ тебе спишуть ставку одразу після старту бою. 5 хвилин на відповідь.`, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '⚔️ Прийняти виклик', web_app: { url: webAppUrl } },
                  { text: '❌ Відхилити', callback_data: `duel:decline:${duelId}` },
                ],
              ],
            },
          });
        }

        return res.status(200).json({ ok: true, duelId, url: webAppUrl, isOpen });
      }

      // --- приєднатися до відкритої дуелі ---
      if (action === 'join_open') {
        const duelId = String(body.duelId || '');
        const userId = String(body.userId || '');
        const name = String(body.name || 'Гравець').replace(/\uFFFD/g, '').trim().slice(0, 24) || 'Гравець';
        const u = String(body.u || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);

        if (!duelId || !userId || !/^\d{1,20}$/.test(userId)) {
          return res.status(400).json({ ok: false, error: 'invalid params' });
        }
        const duel = await getDuel(duelId);
        if (!duel) return res.status(200).json({ ok: false, error: 'not found' });
        if (duel.stage !== 'challenge') return res.status(200).json({ ok: false, error: 'not available' });
        if (duel.p1.id === userId) return res.status(200).json({ ok: false, error: 'cannot join own duel' });
        if (duel.p2.id && duel.p2.id !== userId) return res.status(200).json({ ok: false, error: 'already full' });

        const k = await getKarma(userId);
        if (k < KARMA_MIN) return res.status(200).json({ ok: false, error: 'shadow', karma: k });

        if (duel.stake > 0) {
          const bal = await getUserBalance(userId, duel.stakeCur);
          if (bal !== null && bal < duel.stake) {
            return res.status(200).json({ ok: false, error: 'no_funds' });
          }
        }

        duel.p2 = { id: userId, name, u };
        duel.stage = 'accepted';
        duel.acceptedAt = now;
        await saveDuel(duel);

        const sym = duel.stakeCur === 'gem' ? '💎' : '🫓';
        const webAppUrl = `${DUEL_SITE}${Date.now()}&duel=${duelId}`;
        await sendDuelTg(duel.p1.id, `⚔️ ${name} приєднався до твоєї дуелі!\n💰 Банк: ${(duel.stake * 2).toLocaleString('ru')} ${sym}\nПереходь у бій!`, {
          reply_markup: {
            inline_keyboard: [[{ text: '🎮 Увійти в дуель', web_app: { url: webAppUrl } }]],
          },
        });

        return res.status(200).json({ ok: true, duelId, stage: 'accepted', url: webAppUrl });
      }

      // --- скасувати виклик/кімнату творцем ---
      if (action === 'cancel') {
        const duelId = String(body.duelId || '');
        const userId = String(body.userId || '');
        if (!duelId || !userId) return res.status(400).json({ ok: false, error: 'invalid params' });
        const duel = await getDuel(duelId);
        if (!duel) return res.status(200).json({ ok: false, error: 'not found' });
        if (duel.p1.id !== userId) return res.status(200).json({ ok: false, error: 'not creator' });
        if (duel.stage !== 'challenge') return res.status(200).json({ ok: false, error: 'already started' });

        duel.stage = 'cancelled';
        duel.reason = 'creator_cancelled';
        await saveDuel(duel);
        if (duel.p2?.id) {
          await sendDuelTg(duel.p2.id, `❌ ${duel.p1.name || 'Суперник'} скасував виклик на дуель.`);
        }
        return res.status(200).json({ ok: true, stage: 'cancelled' });
      }

      const duelId = String(body.duelId || '');
      const userId = String(body.userId || '');
      if (!duelId || !userId || !/^\d{1,20}$/.test(userId)) {
        return res.status(400).json({ ok: false, error: 'invalid params' });
      }
      const duel = await getDuel(duelId);
      if (!duel) return res.status(200).json({ ok: false, error: 'not found' });
      const isP1 = String(duel.p1.id) === userId;
      const isP2 = String(duel.p2?.id || '') === userId;
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
          await sendDuelTg(duel.p1.id, '⏱ Соперник не ответил за 5 минут — дуэль отменена.');
          return res.status(200).json({ ok: false, error: 'expired' });
        }
        duel.p2.name = String(body.name || duel.p2.name || 'Гравець').replace(/\uFFFD/g, '').trim().slice(0, 24) || 'Гравець';
        duel.p2.u = String(body.u || duel.p2.u || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
        duel.stage = 'accepted';
        duel.acceptedAt = now;
        await saveDuel(duel);
        const url = `${DUEL_SITE}${Date.now()}&duel=${duelId}`;
        const sym = duel.stakeCur === 'gem' ? '💎' : '🫓';
        const kb = { inline_keyboard: [[{ text: '🎮 Войти в дуэль', web_app: { url } }]] };
        await sendDuelTg(duel.p1.id, `⚔️ ${me.name} принял вызов!\n💰 Банк: ${(duel.stake * 2).toLocaleString('ru')} ${sym}`, { reply_markup: kb });
        await sendDuelTg(duel.p2.id, `⚔️ Войди в дуэль. Банк: ${(duel.stake * 2).toLocaleString('ru')} ${sym}`, { reply_markup: kb });
        return res.status(200).json({ ok: true, url });
      }

      // --- отклонить ---
      if (action === 'decline') {
        if (duel.stage !== 'challenge') return res.status(200).json({ ok: false, error: 'gone' });
        duel.stage = 'cancelled';
        duel.reason = 'declined';
        await saveDuel(duel);
        await sendDuelTg(duel.p1.id, `❌ ${me.name || 'Соперник'} отклонил вызов.`);
        return res.status(200).json({ ok: true });
      }

      // --- внести ставку (эскроу) ---
      if (action === 'escrow') {
        const paid = Math.floor(Number(body.paid)) || 0;
        if (paid > 0) {
          await redis('HSET', `duel_escrow:${duelId}`, userId, String(paid));
        }
        return res.status(200).json({ ok: true });
      }

      // --- недостаточно средств на ставку: дуэль СКАСОВУЄТЬСЯ, банк НЕ видається нікому ---
      if (action === 'no_funds') {
        duel.stage = 'cancelled';
        duel.reason = 'no_funds';
        duel.winner = null;
        await saveDuel(duel);
        await redis('SET', `duel_result:${duel.id}`, JSON.stringify({ winner: null, reason: 'no_funds', ts: now }), 'NX');

        const sym = duel.stakeCur === 'gem' ? '💎' : '🫓';

        // Якщо у суперника (opp) вже було списано ставку на сервері (escrow) — повертаємо ВИКЛЮЧНО його ставку
        const oppPaidRaw = await redis('HGET', `duel_escrow:${duelId}`, opp.id);
        const oppPaid = oppPaidRaw?.result ? parseInt(oppPaidRaw.result, 10) : 0;
        if (oppPaid > 0) {
          if (duel.stakeCur === 'gem') {
            await grantDiamonds(opp.id, oppPaid);
          } else {
            await grantFocaccia(opp.id, oppPaid);
          }
          await redis('HDEL', `duel_escrow:${duelId}`, opp.id);
        }
        await redis('DEL', `duel_escrow:${duelId}`);

        await sendDuelTg(userId, `❌ У тебе недостатньо коштів для ставки (${(duel.stake || 0).toLocaleString('ru')} ${sym}) — дуель скасовано. Банк не виплачується.`);
        await sendDuelTg(opp.id, `❌ Дуель скасовано: у суперника недостатньо коштів для ставки (${(duel.stake || 0).toLocaleString('ru')} ${sym}). Якщо вашу ставку було списано — її повернуто.`);

        return res.status(200).json({ ok: true, stage: 'cancelled', winner: null, reason: 'no_funds' });
      }

      if (action && action !== 'sync') {
        return res.status(400).json({ ok: false, error: 'unknown action' });
      }
    }

    // ===== GET/POST sync — игровой цикл (единый для обоих игроков) =====
    const isGet = req.method === 'GET';
    const q = isGet ? req.query : req.body || {};
    const duelId = String(q.duelId || '');
    const userId = String(q.userId || '');
    if (!duelId || !userId || !/^\d{1,20}$/.test(userId)) {
      return res.status(400).json({ ok: false, error: 'invalid params' });
    }
    const delta = isGet ? 0 : Math.max(0, Math.min(Math.floor(Number(q.delta)) || 0, 200));

    const duel = await getDuel(duelId);
    if (!duel) return res.status(200).json({ ok: false, error: 'not found', v: 'v5.1.1' });
    const isP1 = String(duel.p1.id) === userId;
    const isP2 = String(duel.p2?.id || '') === userId;
    if (!isP1 && !isP2) return res.status(200).json({ ok: false, error: 'not a player', isOpen: Boolean(duel.isOpen) });
    const me = isP1 ? duel.p1 : duel.p2;
    const opp = isP1 ? duel.p2 : duel.p1;

    // присутствие — атомарно
    await redis('HSET', `duel_seen:${duelId}`, userId, String(now));

    // Якщо це виклик гравцю 2 і гравець 2 увійшов у синхронізацію — автоматично оновлюємо дані та переводимо в accepted
    if (isP2) {
      if (q.name && (!duel.p2.name || duel.p2.name === 'Гравець' || duel.p2.name === 'Суперник')) {
        duel.p2.name = String(q.name).replace(/\uFFFD/g, '').trim().slice(0, 24) || duel.p2.name || 'Гравець';
      }
      if (q.u && !duel.p2.u) {
        duel.p2.u = String(q.u).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
      }
      if (duel.stage === 'challenge') {
        duel.stage = 'accepted';
        duel.acceptedAt = now;
        await saveDuel(duel);
      }
    }

    if (isP1) {
      if (q.name && (!duel.p1.name || duel.p1.name === 'Гравець')) {
        duel.p1.name = String(q.name).replace(/\uFFFD/g, '').trim().slice(0, 24) || duel.p1.name || 'Гравець';
      }
      if (q.u && !duel.p1.u) {
        duel.p1.u = String(q.u).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
      }
    }

    // истёкший вызов
    if (duel.stage === 'challenge' && now > duel.expiresAt) {
      duel.stage = 'cancelled';
      duel.reason = 'timeout';
      await saveDuel(duel);
      await sendDuelTg(duel.p1.id, '⏱ Соперник не ответил за 5 минут — дуэль отменена.');
      return res.status(200).json({ ok: false, error: 'expired', stage: 'cancelled' });
    }

    // вход обоих игроков в мини-апп: оба внутри и пингуют (< 20с) → запускаем отсчёт
    if (duel.stage === 'accepted' || (duel.stage === 'challenge' && duel.p2?.id && !duel.isOpen)) {
      const seen1Raw = await redis('HGET', `duel_seen:${duelId}`, String(duel.p1.id));
      const seen2Raw = await redis('HGET', `duel_seen:${duelId}`, String(duel.p2.id));
      const seen1Ts = seen1Raw?.result ? parseInt(seen1Raw.result, 10) : 0;
      const seen2Ts = seen2Raw?.result ? parseInt(seen2Raw.result, 10) : 0;
      const isSeen1Recent = seen1Ts > 0 && (now - seen1Ts) < 20000;
      const isSeen2Recent = seen2Ts > 0 && (now - seen2Ts) < 20000;

      if (isSeen1Recent && isSeen2Recent) {
        duel.stage = 'countdown';
        duel.startTs = now + 7000; // 4с интро VS + 3с отсчёт
        await saveDuel(duel);
      } else if (duel.acceptedAt && (now - duel.acceptedAt) > ACCEPT_TTL) {
        // соперник так и не вошёл — техническое поражение
        const joinedId = isSeen1Recent ? duel.p1.id : (isSeen2Recent ? duel.p2.id : null);
        if (joinedId) {
          const fin = await finishDuel(duel, joinedId, 'forfeit');
          return res.status(200).json({ ok: true, stage: 'finished', winner: fin?.winner, reason: 'forfeit' });
        }
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
          const { winner: trueWinner } = fin ?? await getTrueWinner(duelId, userId);
          return res.status(200).json({ ok: true, stage: 'finished', winner: trueWinner, reason: 'forfeit', v: 'v5.1.1' });
        }
      }
      // лимит времени: 15 минут чистой игры → ничья
      if (duel.stage === 'live' && duel.startTs && now - duel.startTs > DUEL_LIMIT) {
        const fin = await finishDuel(duel, 'draw', 'time');
        const { winner: trueWinner, reason: trueReason } = fin ?? await getTrueWinner(duelId, 'draw');
        return res.status(200).json({ ok: true, stage: 'finished', winner: trueWinner, reason: trueReason || 'time', v: 'v5.1.1' });
      }
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
          const { winner: trueWinner } = fin ?? await getTrueWinner(duelId, opp.id);
          return res.status(200).json({ ok: true, stage: 'finished', winner: trueWinner, reason: 'cheat', v: 'v5.1.1' });
        }
      }

      if (duel.goal && myScore >= duel.goal) {
        const fin = await finishDuel(duel, userId, '100');
        const { winner: trueWinner } = fin ?? await getTrueWinner(duelId, userId);
        return res.status(200).json({ ok: true, stage: 'finished', winner: trueWinner, reason: '100', v: 'v5.1.1' });
      }
    }

    // пауза: соперник не пингует → нокаут оставшемуся + лимит времени (дубли не нужны)
    if (duel.stage === 'live') {
      const oppSeenRaw = await redis('HGET', `duel_seen:${duelId}`, opp.id);
      const oppSeenTs = oppSeenRaw?.result ? parseInt(oppSeenRaw.result) : 0;
      if (oppSeenTs > 0 && now - oppSeenTs > PAUSE_MS) {
        const fin = await finishDuel(duel, userId, 'forfeit');
        const { winner: trueWinner } = fin ?? await getTrueWinner(duelId, userId);
        return res.status(200).json({ ok: true, stage: 'finished', winner: trueWinner, reason: 'forfeit', v: 'v5.1.1' });
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

    const escrowRaw = await redis('HGETALL', `duel_escrow:${duelId}`);
    let pot = 0;
    let myPaid = 0;
    if (escrowRaw?.result) {
      for (let i = 0; i < escrowRaw.result.length; i += 2) {
        const val = parseInt(escrowRaw.result[i + 1]) || 0;
        pot += val;
        if (escrowRaw.result[i] === userId) myPaid = val;
      }
    }
    if (pot <= 0 && duel.stake) {
      pot = duel.stake * 2;
      myPaid = duel.stake;
    }

    return res.status(200).json({
      ok: true, v: 'v5.1.1',
      stage: duel.stage,
      isOpen: Boolean(duel.isOpen),
      creatorId: String(duel.p1.id),
      isCreator: String(duel.p1.id) === userId,
      me: { id: me.id, name: me.name, u: me.u || '', score: myScore },
      opp: { id: opp.id, name: opp.name, u: opp.u || '', score: oppScore, missing: oppMissing },
      goal: duel.goal || GOAL_DEFAULT,
      stakeCur: duel.stakeCur || 'foc',
      stake: duel.stake || 0,
      startTs: duel.startTs || 0,
      elapsed: duel.startTs ? Math.max(0, now - duel.startTs) : 0,
      limit: duel.timeMs || DUEL_LIMIT,
      serverNow: now,
      winner: duel.winner || null,
      reason: duel.reason || null,
      pausedLeft,
      pot,
      myPaid,
    });
  } catch (err) {
    console.error('Duel error:', err);
    return res.status(200).json({ ok: false, error: 'internal', details: err?.message || String(err) });
  }
};
