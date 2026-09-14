/**
 * Dynamic Leaderboard JPEG Image Generator for Telegram
 * GET /api/leaderboard-image
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const jpeg = require('jpeg-js');

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
  if (!n || isNaN(n) || !isFinite(n)) return '0';
  if (n < 1000) return String(Math.floor(n));
  const units = ['', 'k', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`.trim();
}

function normalizeName(str) {
  if (!str) return 'Пекар';
  let norm = String(str).normalize('NFKD');
  norm = norm.replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, '').trim();
  return norm || 'Пекар';
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
              name: normalizeName(p.n),
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

    const width = 960;
    const height = 580;
    const startY = 135;
    const rowH = 68;
    const gap = 12;

    let rowsSvg = '';
    top5.forEach((p, i) => {
      const y = startY + i * (rowH + gap);
      const isFirst = i === 0;
      const isSecond = i === 1;
      const isThird = i === 2;

      const bgFill = isFirst
        ? 'rgba(245, 158, 11, 0.14)'
        : isSecond
        ? 'rgba(148, 163, 184, 0.10)'
        : isThird
        ? 'rgba(217, 119, 6, 0.10)'
        : 'rgba(255, 255, 255, 0.04)';

      const strokeColor = isFirst
        ? '#fbbf24'
        : isSecond
        ? '#94a3b8'
        : isThird
        ? '#d97706'
        : 'rgba(255, 255, 255, 0.08)';

      const strokeWidth = isFirst ? 2 : 1;
      const rankBadge = isFirst ? '1' : isSecond ? '2' : isThird ? '3' : `${i + 1}`;
      const rankBadgeBg = isFirst ? '#f59e0b' : isSecond ? '#94a3b8' : isThird ? '#d97706' : '#334155';
      const rankBadgeText = isFirst ? '#000000' : isSecond ? '#000000' : isThird ? '#ffffff' : '#94a3b8';

      const safeName = escapeXml(p.name.slice(0, 18));
      const handle = p.username ? ` (@${escapeXml(p.username.slice(0, 16))})` : '';
      const totalStr = `${formatNum(p.total)}`;
      const prestigeStr = p.prestige > 0 ? `Престиж ${p.prestige.toLocaleString()}` : '';

      rowsSvg += `
        <rect x="50" y="${y}" width="860" height="${rowH}" rx="18" fill="${bgFill}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>
        
        <!-- Rank Pill -->
        <rect x="70" y="${y + 16}" width="42" height="36" rx="10" fill="${rankBadgeBg}"/>
        <text x="91" y="${y + 42}" text-anchor="middle" fill="${rankBadgeText}" font-family="Arial" font-size="20" font-weight="bold">${rankBadge}</text>
        
        <!-- Player Info with tspan -->
        <text x="130" y="${y + 43}" font-family="Arial">
          <tspan fill="#f8fafc" font-size="22" font-weight="bold">${safeName}</tspan>
          ${handle ? `<tspan fill="#94a3b8" font-size="16">   ${handle}</tspan>` : ''}
        </text>
        
        <!-- Prestige -->
        ${prestigeStr ? `
          <rect x="535" y="${y + 19}" width="150" height="30" rx="8" fill="rgba(168, 85, 247, 0.15)" stroke="rgba(168, 85, 247, 0.4)" stroke-width="1"/>
          <text x="610" y="${y + 39}" text-anchor="middle" fill="#c084fc" font-family="Arial" font-size="14" font-weight="bold">${prestigeStr}</text>
        ` : ''}

        <!-- Total Score + Golden Focaccia SVG Icon -->
        <text x="855" y="${y + 43}" text-anchor="end" fill="#f59e0b" font-family="Arial" font-size="23" font-weight="bold">${totalStr}</text>
        <g transform="translate(865, ${y + 24})">
          <ellipse cx="14" cy="10" rx="13" ry="9" fill="#f59e0b" stroke="#fbbf24" stroke-width="1.5"/>
          <circle cx="9" cy="8" r="1.5" fill="#78350f"/>
          <circle cx="14" cy="11" r="1.5" fill="#78350f"/>
          <circle cx="19" cy="8" r="1.5" fill="#78350f"/>
        </g>
      `;
    });

    const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
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

      <!-- Ambient Glow -->
      <circle cx="150" cy="80" r="200" fill="#f59e0b" opacity="0.10"/>
      <circle cx="800" cy="450" r="220" fill="#6366f1" opacity="0.12"/>

      <!-- Main Title -->
      <text x="480" y="62" text-anchor="middle" fill="url(#goldText)" font-family="Arial" font-size="36" font-weight="bold" letter-spacing="3">ТОП ПО ФОКАЧІ 2026</text>
      <text x="480" y="98" text-anchor="middle" fill="#94a3b8" font-family="Arial" font-size="16">Офіційний рейтинг пекарів серверу • Оновлюється в реальному часі</text>

      <!-- Rows -->
      ${rowsSvg}

      <!-- Footer -->
      <text x="480" y="555" text-anchor="middle" fill="#64748b" font-family="Arial" font-size="13">@focaca_robot • Випікай фокачі та побий рекорд першого місця!</text>
    </svg>
    `;

    // Locate font files robustly
    const fontCandidates = [
      path.join(__dirname, 'fonts/arial.ttf'),
      path.join(__dirname, 'fonts/arialbd.ttf'),
      path.join(__dirname, '../fonts/arial.ttf'),
      path.join(__dirname, '../fonts/arialbd.ttf'),
      path.join(process.cwd(), 'api/fonts/arial.ttf'),
      path.join(process.cwd(), 'api/fonts/arialbd.ttf'),
      path.join(process.cwd(), 'fonts/arial.ttf'),
      path.join(process.cwd(), 'fonts/arialbd.ttf'),
    ];
    const existingFonts = fontCandidates.filter(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });

    const resvg = new Resvg(svg, {
      font: {
        fontFiles: existingFonts,
        fontDirs: [
          path.join(__dirname, 'fonts'),
          path.join(process.cwd(), 'api/fonts'),
          path.join(process.cwd(), 'fonts'),
        ],
        defaultFontFamily: 'Arial',
        loadSystemFonts: false,
      },
    });

    const renderObj = resvg.render();
    const jpegData = jpeg.encode({
      data: renderObj.pixels,
      width: renderObj.width,
      height: renderObj.height,
    }, 85);
    const buf = Buffer.from(jpegData.data);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=5, s-maxage=5');
    return res.status(200).end(buf);
  } catch (err) {
    console.error('Error generating leaderboard image:', err);
    return res.status(500).json({ error: err.message });
  }
};
