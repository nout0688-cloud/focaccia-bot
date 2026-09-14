/**
 * Dynamic Leaderboard Image Generator for Telegram
 * GET /api/leaderboard-image
 */
const { Resvg } = require('@resvg/resvg-js');

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

function formatNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n < 1000) return String(Math.floor(n));
  const units = ['', 'k', 'M', 'B', 'T', 'Qa', 'Qi'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}${units[i]}`;
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = async function handler(req, res) {
  try {
    const lbRaw = await redis('HGETALL', 'leaderboard');
    let players = [];
    if (lbRaw?.result && Array.isArray(lbRaw.result)) {
      for (let i = 0; i < lbRaw.result.length; i += 2) {
        try {
          const p = JSON.parse(lbRaw.result[i + 1]);
          if (p.n && !p.n.includes('\uFFFD')) {
            players.push({
              name: p.n,
              username: p.u || '',
              total: Number(p.t) || 0,
              prestige: parseInt(p.p, 10) || 0,
              diamonds: parseInt(p.d, 10) || 0,
            });
          }
        } catch {}
      }
    }

    players.sort((a, b) => b.total - a.total);
    const top5 = players.slice(0, 5);

    // Fallback if empty or fewer than 5
    while (top5.length < 5) {
      top5.push({
        name: `Пекар #${top5.length + 1}`,
        username: '',
        total: 0,
        prestige: 0,
        diamonds: 0,
      });
    }

    const width = 920;
    const height = 540;
    const startY = 125;
    const rowH = 68;
    const gap = 11;

    let rowsSvg = '';
    top5.forEach((p, i) => {
      const y = startY + i * (rowH + gap);
      const isFirst = i === 0;
      const isSecond = i === 1;
      const isThird = i === 2;

      const bgFill = isFirst
        ? 'rgba(245, 158, 11, 0.14)'
        : isSecond
        ? 'rgba(148, 163, 184, 0.09)'
        : isThird
        ? 'rgba(217, 119, 6, 0.09)'
        : 'rgba(255, 255, 255, 0.04)';

      const strokeColor = isFirst
        ? '#fbbf24'
        : isSecond
        ? '#94a3b8'
        : isThird
        ? '#d97706'
        : 'rgba(255, 255, 255, 0.08)';

      const strokeWidth = isFirst ? 2 : 1;
      const rankBadge = isFirst ? '🥇 #1' : isSecond ? '🥈 #2' : isThird ? '🥉 #3' : `  #${i + 1}`;
      const rankColor = isFirst ? '#fde047' : isSecond ? '#f1f5f9' : isThird ? '#fbbf24' : '#64748b';

      const safeName = escapeXml(p.name.slice(0, 20));
      const handle = p.username ? ` (@${escapeXml(p.username.slice(0, 14))})` : '';
      const totalStr = `${formatNum(p.total)} 🫓`;
      const prestigeStr = p.prestige > 0 ? `★ ${p.prestige}` : '';

      rowsSvg += `
        <rect x="50" y="${y}" width="820" height="${rowH}" rx="16" fill="${bgFill}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>
        <text x="80" y="${y + 42}" fill="${rankColor}" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="800">${rankBadge}</text>
        <text x="180" y="${y + 42}" fill="#f8fafc" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700">${safeName}<tspan fill="#94a3b8" font-size="15" font-weight="500">${handle}</tspan></text>
        ${prestigeStr ? `<text x="560" y="${y + 42}" fill="#c084fc" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700">${prestigeStr}</text>` : ''}
        <text x="840" y="${y + 42}" text-anchor="end" fill="#f59e0b" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="800">${totalStr}</text>
      `;
    });

    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="mainBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0b0f19"/>
          <stop offset="40%" stop-color="#1e1b4b"/>
          <stop offset="100%" stop-color="#020617"/>
        </linearGradient>
        <linearGradient id="goldText" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#fef08a"/>
          <stop offset="50%" stop-color="#f59e0b"/>
          <stop offset="100%" stop-color="#d97706"/>
        </linearGradient>
      </defs>

      <!-- Background -->
      <rect width="100%" height="100%" fill="url(#mainBg)"/>

      <!-- Ambient glow lights -->
      <circle cx="180" cy="90" r="220" fill="#f59e0b" opacity="0.12"/>
      <circle cx="760" cy="420" r="240" fill="#6366f1" opacity="0.12"/>

      <!-- Title Header -->
      <text x="460" y="58" text-anchor="middle" fill="url(#goldText)" font-family="system-ui, -apple-system, sans-serif" font-size="32" font-weight="900" letter-spacing="2">🏆 ТОП-5 НАЙКРАЩИХ ПЕКАРІВ 🫓</text>
      <text x="460" y="90" text-anchor="middle" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600">Офіційний лідерборд Фокача Клікер • Оновлюється в реальному часі</text>

      <!-- Leaderboard rows -->
      ${rowsSvg}

      <!-- Footer -->
      <text x="460" y="518" text-anchor="middle" fill="#64748b" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="500">t.me/focaccia_clicker_bot • Змагайся та піднімайся на перше місце!</text>
    </svg>`;

    const resvg = new Resvg(svg, {
      font: {
        loadSystemFonts: true,
      },
    });
    const pngBuffer = resvg.render().asPng();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    return res.status(200).end(pngBuffer);
  } catch (err) {
    console.error('Error generating leaderboard image:', err);
    return res.status(500).json({ error: err.message });
  }
};
