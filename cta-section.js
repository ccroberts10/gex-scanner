// cta-section.js
// CTA positioning module for gex-app - additive only, no modifications to existing code.
// Exposes:
//   getCTAState()          - current CTA state object (or null)
//   refreshCTA(fetch, log) - manually trigger a refresh
//   startCTAPolling(...)   - start background polling
//   handleCTARequest(...)  - handles HTTP requests for /api/cta routes
//   renderCTASection()     - returns HTML fragment to inject into dashboard
//
// Uses no external dependencies beyond what gex-app already has (node-fetch).

'use strict';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CTA_UNIVERSE = [
  { symbol: 'SPY', name: 'S&P 500',      assetClass: 'equity',    weight: 0.18 },
  { symbol: 'QQQ', name: 'Nasdaq 100',   assetClass: 'equity',    weight: 0.10 },
  { symbol: 'IWM', name: 'Russell 2000', assetClass: 'equity',    weight: 0.07 },
  { symbol: 'IEF', name: '7-10Y Treas',  assetClass: 'rates',     weight: 0.15 },
  { symbol: 'TLT', name: '20Y+ Treas',   assetClass: 'rates',     weight: 0.10 },
  { symbol: 'GLD', name: 'Gold',         assetClass: 'commodity', weight: 0.10 },
  { symbol: 'USO', name: 'Crude Oil',    assetClass: 'commodity', weight: 0.10 },
  { symbol: 'UUP', name: 'US Dollar',    assetClass: 'fx',        weight: 0.10 },
  { symbol: 'FXE', name: 'Euro',         assetClass: 'fx',        weight: 0.05 },
  { symbol: 'FXY', name: 'Yen',          assetClass: 'fx',        weight: 0.05 },
];

const LOOKBACKS = [
  { days: 20,  weight: 0.40 },
  { days: 50,  weight: 0.30 },
  { days: 100, weight: 0.20 },
  { days: 200, weight: 0.10 },
];

const CTA_TOTAL_AUM_BILLIONS = 350;
const CTA_EQUITY_ALLOCATION  = 0.35;
const TRIGGER_FLOW_FRACTION  = { 20: 0.25, 50: 0.30, 100: 0.25, 200: 0.20 };

// Tradier daily history endpoint (uses same token as GEX scanner)
const TRADIER_TOKEN = (process.env.TRADIER_TOKEN || '').replace(/^["']|["']$/g, '').trim();

// ─── STATE ────────────────────────────────────────────────────────────────────
let ctaState = null;
let ctaRunning = false;
let ctaLastRun = null;
let pollTimer = null;
let historicalScores = []; // { timestamp, composite }

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────
function sma(arr, period) {
  if (!arr || arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

function atrFromBars(bars, period) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trs.push(tr);
  }
  let sum = 0;
  for (let i = trs.length - period; i < trs.length; i++) sum += trs[i];
  return sum / period;
}

function tanhSafe(x) {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

function classifyPosition(p) {
  if (p === null || p === undefined) return 'unknown';
  if (p >= 0.75) return 'max long';
  if (p >= 0.25) return 'long';
  if (p >= -0.25) return 'neutral';
  if (p >= -0.75) return 'short';
  return 'max short';
}

function classifyComposite(c) {
  if (c === null) return 'unknown';
  if (c >= 75) return 'max long crowded';
  if (c >= 25) return 'long';
  if (c >= -25) return 'neutral';
  if (c >= -75) return 'short';
  return 'max short crowded';
}

function interpretComposite(c) {
  if (c === null) return 'No data yet.';
  if (c >= 75) return 'CTAs are crowded long. Mechanical downside risk if shorter MAs break — they will be forced sellers into weakness.';
  if (c >= 25) return 'Net long positioning. Trend-followers supportive, but watch for MA breaks that could flip flow.';
  if (c >= -25) return 'Neutral. Low mechanical flow risk in either direction. Discretionary flow dominates.';
  if (c >= -75) return 'Net short positioning. Trend-followers pressuring lower, but vulnerable to short-cover squeeze on upside breaks.';
  return 'CTAs are crowded short. Significant squeeze risk on any meaningful upside break of shorter MAs.';
}

// ─── DATA FETCH (Tradier daily bars - already in your stack) ──────────────────
async function fetchTradierDailyBars(fetch, symbol, days) {
  if (!TRADIER_TOKEN) throw new Error('TRADIER_TOKEN not set');

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(days * 1.6));
  const fmt = (d) => d.toISOString().split('T')[0];

  const url = 'https://api.tradier.com/v1/markets/history?symbol=' + encodeURIComponent(symbol) +
              '&interval=daily&start=' + fmt(start) + '&end=' + fmt(end);
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + TRADIER_TOKEN, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('Tradier ' + symbol + ' HTTP ' + res.status);
  const json = await res.json();
  const day = json && json.history && json.history.day;
  if (!day) throw new Error('No history data for ' + symbol);

  const arr = Array.isArray(day) ? day : [day];
  return arr.map(b => ({
    date: b.date,
    open: parseFloat(b.open),
    high: parseFloat(b.high),
    low: parseFloat(b.low),
    close: parseFloat(b.close),
    volume: parseInt(b.volume) || 0,
  })).filter(b => !isNaN(b.close));
}

// ─── CORE CALCS ───────────────────────────────────────────────────────────────
function calculatePositioning(bars) {
  if (!bars || bars.length < 201) return { position: null, error: 'insufficient_history' };

  const closes = bars.map(b => b.close);
  const currentPrice = closes[closes.length - 1];
  const atr20 = atrFromBars(bars, 20);
  if (!atr20 || atr20 === 0) return { position: null, error: 'invalid_atr' };

  const momentum = {};
  let rawSignal = 0;

  for (const lb of LOOKBACKS) {
    const ma = sma(closes, lb.days);
    if (!ma) continue;
    const mom = (currentPrice - ma) / atr20;
    momentum[lb.days] = {
      ma: ma,
      momentum: mom,
      pctFromMA: ((currentPrice - ma) / ma) * 100,
    };
    rawSignal += lb.weight * mom;
  }

  const position = tanhSafe(rawSignal / 3);
  return {
    position: position,
    positionPct: position * 100,
    momentum: momentum,
    currentPrice: currentPrice,
    atr20: atr20,
  };
}

function calculateTriggers(bars, currentPrice) {
  const closes = bars.map(b => b.close);
  const triggers = [];
  const equityAUM = CTA_TOTAL_AUM_BILLIONS * CTA_EQUITY_ALLOCATION;

  for (const lb of LOOKBACKS) {
    const ma = sma(closes, lb.days);
    if (!ma) continue;
    const distance = currentPrice - ma;
    const distancePct = (distance / currentPrice) * 100;
    const flowFraction = TRIGGER_FLOW_FRACTION[lb.days] || 0.2;
    triggers.push({
      lookback: lb.days,
      level: Math.round(ma * 100) / 100,
      distance: Math.round(distance * 100) / 100,
      distancePct: Math.round(distancePct * 100) / 100,
      direction: currentPrice > ma ? 'sell_trigger' : 'buy_trigger',
      estimatedFlowB: Math.round(equityAUM * flowFraction * 10) / 10,
    });
  }
  return triggers.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
}

// ─── REFRESH ──────────────────────────────────────────────────────────────────
async function refreshCTA(fetch, log) {
  if (ctaRunning) { log && log('warn', 'CTA refresh already running'); return ctaState; }
  ctaRunning = true;
  log && log('info', '== CTA refresh starting ==');

  const errors = [];
  const assets = [];
  let weightedPosition = 0;
  let totalWeight = 0;
  let spyTriggers = [];

  try {
    for (const asset of CTA_UNIVERSE) {
      try {
        const bars = await fetchTradierDailyBars(fetch, asset.symbol, 250);
        const pos = calculatePositioning(bars);

        if (pos.position === null) {
          errors.push(asset.symbol + ': ' + pos.error);
          continue;
        }

        assets.push({
          symbol: asset.symbol,
          name: asset.name,
          assetClass: asset.assetClass,
          weight: asset.weight,
          position: pos.position,
          positionPct: Math.round(pos.positionPct * 10) / 10,
          currentPrice: pos.currentPrice,
          momentum: pos.momentum,
          state: classifyPosition(pos.position),
        });

        weightedPosition += pos.position * asset.weight;
        totalWeight += asset.weight;

        if (asset.symbol === 'SPY') {
          spyTriggers = calculateTriggers(bars, pos.currentPrice);
        }

        // Throttle to be polite to Tradier
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        errors.push(asset.symbol + ': ' + e.message);
        log && log('warn', 'CTA ' + asset.symbol + ': ' + e.message);
      }
    }

    const composite = totalWeight > 0
      ? Math.round((weightedPosition / totalWeight) * 100 * 10) / 10
      : null;

    // Deltas
    const now = Date.now();
    let delta1d = null;
    let delta1w = null;
    if (composite !== null) {
      const oneDayAgo = historicalScores.find(s =>
        now - s.timestamp >= 23 * 3600000 && now - s.timestamp <= 25 * 3600000);
      const oneWeekAgo = historicalScores.find(s =>
        now - s.timestamp >= 6.5 * 86400000 && now - s.timestamp <= 7.5 * 86400000);
      if (oneDayAgo) delta1d = Math.round((composite - oneDayAgo.composite) * 10) / 10;
      if (oneWeekAgo) delta1w = Math.round((composite - oneWeekAgo.composite) * 10) / 10;
      historicalScores.push({ timestamp: now, composite });
      if (historicalScores.length > 800) historicalScores.shift();
    }

    ctaState = {
      timestamp: new Date().toISOString(),
      ts: new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true }),
      composite: composite,
      compositeState: classifyComposite(composite),
      compositeDelta1d: delta1d,
      compositeDelta1w: delta1w,
      assets: assets,
      triggers: spyTriggers,
      universe: CTA_UNIVERSE.length,
      universeFetched: assets.length,
      errors: errors,
      interpretation: interpretComposite(composite),
    };
    ctaLastRun = new Date().toISOString();

    log && log('ok', '== CTA complete — score: ' + composite + ' (' + classifyComposite(composite) + ') | ' + assets.length + '/' + CTA_UNIVERSE.length + ' assets ==');
  } catch (e) {
    log && log('err', 'CTA refresh failed: ' + e.message);
  } finally {
    ctaRunning = false;
  }

  return ctaState;
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
function startCTAPolling(fetch, log) {
  if (pollTimer) return;
  // Initial fetch 10s after startup so it doesn't collide with GEX startup scan
  setTimeout(() => refreshCTA(fetch, log), 10000);
  // Then refresh every 30 minutes (CTA positioning doesn't move that fast - daily bars)
  pollTimer = setInterval(() => {
    const now = new Date();
    const day = now.getUTCDay();
    const hourUTC = now.getUTCHours();
    if (day === 0 || day === 6) return;
    if (hourUTC < 13 || hourUTC > 22) return;
    refreshCTA(fetch, log);
  }, 30 * 60 * 1000);
}

// ─── HTTP HANDLER ─────────────────────────────────────────────────────────────
// Returns true if the request was handled by this module
async function handleCTARequest(req, res, fetch, log) {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/cta') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(ctaState || { loading: true, running: ctaRunning }));
    return true;
  }

  if (req.method === 'POST' && url === '/api/cta/refresh') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running: ctaRunning }));
    if (!ctaRunning) refreshCTA(fetch, log);
    return true;
  }

  if (req.method === 'GET' && url === '/api/cta/score') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      composite: ctaState ? ctaState.composite : null,
      state: ctaState ? ctaState.compositeState : 'unknown',
      timestamp: ctaState ? ctaState.timestamp : null,
    }));
    return true;
  }

  return false;
}

// ─── HTML SECTION RENDERER ────────────────────────────────────────────────────
// Returns HTML fragment styled to match gex-app dashboard (Space Grotesk + Mono,
// cyan/green/red palette). Inject into the dashboard wherever you want it.
function renderCTASection() {
  const d = ctaState;

  if (!d) {
    return `
<!-- ═══ CTA POSITIONING SECTION ═══ -->
<div class="card">
  <div class="card-head">
    <span class="card-title">&#128202; CTA Positioning Monitor</span>
    <span style="font-size:11px;color:#4a6070">Initializing — refreshes every 30 min</span>
  </div>
  <div style="padding:60px;text-align:center;color:#4a6070">
    <div style="font-size:14px;margin-bottom:12px">CTA data loading...</div>
    <div style="font-size:12px">Trend-follower flow estimates across 10 asset classes</div>
    <div style="margin-top:20px"><button class="btn bp" onclick="refreshCTA(this)">&#9654; Refresh Now</button></div>
  </div>
</div>
<script>
function refreshCTA(btn) {
  btn.disabled = true; btn.textContent = 'Refreshing...';
  fetch('/api/cta/refresh', { method: 'POST' }).then(function() {
    setTimeout(function() { location.reload(); }, 8000);
  }).catch(function() { btn.disabled = false; btn.textContent = '\u25B6 Refresh Now'; });
}
</script>
`;
  }

  // Composite color following GEX scanner palette
  let compColor = '#ffd166'; // neutral
  if (d.composite >= 25) compColor = '#39ff14';
  else if (d.composite <= -25) compColor = '#ff2d55';
  if (Math.abs(d.composite) >= 75) compColor = '#ff6b35'; // crowded warning

  // Composite bar: -100 to +100, center is zero
  const barFill = d.composite !== null ? Math.min(Math.abs(d.composite), 100) / 2 : 0;
  const barSide = d.composite >= 0 ? 'left:50%' : 'right:50%';

  // Build trigger ladder rows (SPY)
  const triggerRows = (d.triggers || []).map(t => {
    const distCol = t.direction === 'sell_trigger' ? '#ff2d55' : '#39ff14';
    const arrow = t.direction === 'sell_trigger' ? '&#9660;' : '&#9650;';
    const label = t.direction === 'sell_trigger' ? 'BREAK = FORCED SELLING' : 'BREAK = FORCED BUYING';
    return `<div style="padding:12px 20px;border-bottom:1px solid #0d1f2d;display:grid;grid-template-columns:80px 1fr 90px 100px 110px;gap:12px;align-items:center">
      <div style="font-size:11px;color:#4a6070;letter-spacing:1px">${t.lookback}-DAY MA</div>
      <div class="mono" style="font-size:18px;font-weight:700;color:#d8eaf5">$${t.level}</div>
      <div class="mono" style="font-size:13px;color:${distCol};text-align:right">${t.distancePct >= 0 ? '+' : ''}${t.distancePct}%</div>
      <div class="mono" style="font-size:12px;color:#ffd166;text-align:right">~$${t.estimatedFlowB}B</div>
      <div style="font-size:9px;color:${distCol};letter-spacing:1px;text-align:right">${arrow} ${label}</div>
    </div>`;
  }).join('');

  // Asset rows
  const assetRows = (d.assets || []).map(a => {
    let posCol = '#ffd166';
    if (a.positionPct >= 25) posCol = '#39ff14';
    else if (a.positionPct <= -25) posCol = '#ff2d55';
    if (Math.abs(a.positionPct) >= 75) posCol = '#ff6b35';

    const m20 = a.momentum[20] ? a.momentum[20].pctFromMA : null;
    const m50 = a.momentum[50] ? a.momentum[50].pctFromMA : null;
    const m200 = a.momentum[200] ? a.momentum[200].pctFromMA : null;

    const colorFor = v => {
      if (v === null || v === undefined) return '#4a6070';
      if (v > 1) return '#39ff14';
      if (v < -1) return '#ff2d55';
      return '#ffd166';
    };

    const fmtPct = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';

    return `<tr style="border-bottom:1px solid #0d1f2d">
      <td style="padding:9px 16px;color:#00d4ff;font-weight:700;font-family:'Space Mono',monospace">${a.symbol}</td>
      <td style="padding:9px 16px;color:#8aa0b0;font-size:12px">${a.name}</td>
      <td style="padding:9px 16px;color:#4a6070;font-size:11px;letter-spacing:1px">${a.assetClass.toUpperCase()}</td>
      <td style="padding:9px 16px;color:${posCol};font-weight:700;font-family:'Space Mono',monospace;text-align:right">${a.positionPct >= 0 ? '+' : ''}${a.positionPct}</td>
      <td style="padding:9px 16px;color:${posCol};font-size:10px;letter-spacing:1px;text-align:right">${a.state.toUpperCase()}</td>
      <td style="padding:9px 16px;color:${colorFor(m20)};text-align:right;font-family:'Space Mono',monospace;font-size:11px">${fmtPct(m20)}</td>
      <td style="padding:9px 16px;color:${colorFor(m50)};text-align:right;font-family:'Space Mono',monospace;font-size:11px">${fmtPct(m50)}</td>
      <td style="padding:9px 16px;color:${colorFor(m200)};text-align:right;font-family:'Space Mono',monospace;font-size:11px">${fmtPct(m200)}</td>
    </tr>`;
  }).join('');

  const errorBox = (d.errors && d.errors.length) ? `
    <div style="margin:0 20px 16px 20px;padding:10px 14px;background:rgba(255,45,85,0.08);border-left:3px solid #ff2d55;border-radius:0 6px 6px 0;font-size:11px;color:#ff6b35;font-family:'Space Mono',monospace">
      ${d.errors.map(e => '· ' + e).join('<br>')}
    </div>` : '';

  return `
<!-- ═══ CTA POSITIONING SECTION ═══ -->
<div class="card">
  <div class="card-head">
    <span class="card-title">&#128202; CTA Positioning — Trend-Follower Flow</span>
    <span style="font-size:11px;color:#4a6070">${d.ts || ''} &middot; ${d.universeFetched}/${d.universe} assets</span>
  </div>
  <div style="padding:24px">
    <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:20px">
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">COMPOSITE SCORE</div>
        <div class="mono" style="font-size:36px;font-weight:700;color:${compColor}">${d.composite > 0 ? '+' : ''}${d.composite}</div>
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">REGIME</div>
        <div class="mono" style="font-size:18px;font-weight:700;color:${compColor};text-transform:uppercase">${d.compositeState}</div>
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">1D &Delta;</div>
        <div class="mono" style="font-size:22px;font-weight:700;color:#d8eaf5">${d.compositeDelta1d !== null ? (d.compositeDelta1d > 0 ? '+' : '') + d.compositeDelta1d : '—'}</div>
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">1W &Delta;</div>
        <div class="mono" style="font-size:22px;font-weight:700;color:#d8eaf5">${d.compositeDelta1w !== null ? (d.compositeDelta1w > 0 ? '+' : '') + d.compositeDelta1w : '—'}</div>
      </div>
      <div style="margin-left:auto">
        <button class="btn bs" onclick="refreshCTA(this)">&#8635; Refresh CTA</button>
      </div>
    </div>

    <!-- Composite bar -->
    <div style="position:relative;height:24px;background:#070a0f;border-radius:4px;overflow:hidden;margin-bottom:14px">
      <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#1a2535"></div>
      <div style="position:absolute;top:0;bottom:0;width:${barFill}%;${barSide};background:${compColor};opacity:0.85;border-radius:3px"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:16px">
      <span>MAX SHORT -100</span><span>NEUTRAL 0</span><span>+100 MAX LONG</span>
    </div>

    <div style="padding:12px 16px;background:#111820;border-left:3px solid ${compColor};border-radius:0 6px 6px 0;font-size:13px;color:#8aa0b0">
      ${d.interpretation}
    </div>
  </div>
</div>

<!-- SPY TRIGGER LADDER -->
<div class="card">
  <div class="card-head">
    <span class="card-title">&#127919; SPY Trigger Ladder — Forced Flow Levels</span>
    <span style="font-size:11px;color:#4a6070">Sorted by proximity to current price</span>
  </div>
  <div>
    ${triggerRows || '<div style="padding:30px;text-align:center;color:#4a6070;font-size:12px">No trigger data available</div>'}
  </div>
</div>

<!-- PER-ASSET POSITIONING -->
<div class="card">
  <div class="card-head">
    <span class="card-title">&#128200; Per-Asset CTA Positioning</span>
    <span style="font-size:11px;color:#4a6070">Vol-normalized momentum across 20/50/100/200 day windows</span>
  </div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="color:#4a6070;font-size:10px;letter-spacing:1px;border-bottom:1px solid #1a2535">
        <td style="padding:8px 16px">SYMBOL</td>
        <td style="padding:8px 16px">NAME</td>
        <td style="padding:8px 16px">CLASS</td>
        <td style="padding:8px 16px;text-align:right">POSITION</td>
        <td style="padding:8px 16px;text-align:right">STATE</td>
        <td style="padding:8px 16px;text-align:right">vs 20D</td>
        <td style="padding:8px 16px;text-align:right">vs 50D</td>
        <td style="padding:8px 16px;text-align:right">vs 200D</td>
      </tr>
      ${assetRows}
    </table>
  </div>
  ${errorBox}
</div>

<script>
function refreshCTA(btn) {
  btn.disabled = true; btn.textContent = 'Refreshing...';
  fetch('/api/cta/refresh', { method: 'POST' }).then(function() {
    var secs = 30;
    var iv = setInterval(function() {
      secs--;
      btn.textContent = 'Refreshing... ' + secs + 's';
      if (secs <= 0) { clearInterval(iv); location.reload(); }
    }, 1000);
    setTimeout(function() { clearInterval(iv); location.reload(); }, 30000);
  }).catch(function() { btn.disabled = false; btn.textContent = '\u21BB Refresh CTA'; });
}
</script>
`;
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
function getCTAState() { return ctaState; }

module.exports = {
  getCTAState,
  refreshCTA,
  startCTAPolling,
  handleCTARequest,
  renderCTASection,
};
