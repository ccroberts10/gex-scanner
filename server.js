#!/usr/bin/env node
‘use strict’;

const cron = require(‘node-cron’);
const http = require(‘http’);

try { require(‘dotenv’).config(); } catch(e) {}

let fetch;
try { fetch = require(‘node-fetch’); if (fetch.default) fetch = fetch.default; }
catch(e) { fetch = global.fetch; }

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
tradierToken:    (process.env.TRADIER_TOKEN      || ‘’).replace(/^[”’]|[”’]$/g, ‘’).trim(),
pushoverUser:    (process.env.PUSHOVER_USER_KEY  || ‘’).replace(/^[”’]|[”’]$/g, ‘’).trim(),
pushoverToken:   (process.env.PUSHOVER_APP_TOKEN || ‘’).replace(/^[”’]|[”’]$/g, ‘’).trim(),
anthropicKey:    (process.env.ANTHROPIC_API_KEY  || ‘’).replace(/^[”’]|[”’]$/g, ‘’).trim(),
};
const PORT = process.env.PORT || 8081;

// ─── LOGGING ──────────────────────────────────────────────────────────────────
const logLines = [];
function log(type, msg) {
const time = new Date().toISOString();
const icons = { ok: ‘✓’, warn: ‘⚠’, err: ‘✗’, info: ‘·’ };
console.log(’[’ + time + ’] ’ + (icons[type] || ‘·’) + ’ ’ + msg);
logLines.push({ type, msg, time });
if (logLines.length > 200) logLines.shift();
}

// ─── PUSHOVER ─────────────────────────────────────────────────────────────────
async function sendPushover(title, message, priority) {
priority = priority || 0;
if (!CONFIG.pushoverToken || !CONFIG.pushoverUser) return { status: 0 };
try {
const form = new URLSearchParams({
token: CONFIG.pushoverToken, user: CONFIG.pushoverUser,
title: String(title).slice(0, 250), message: String(message).slice(0, 1024),
priority: String(priority), sound: ‘cashregister’,
});
const res = await fetch(‘https://api.pushover.net/1/messages.json’, {
method: ‘POST’, headers: { ‘Content-Type’: ‘application/x-www-form-urlencoded’ },
body: form.toString(),
});
const data = await res.json();
if (data.status === 1) log(‘ok’, ’Pushover sent: ’ + title.slice(0, 60));
return data;
} catch(e) { log(‘warn’, ’Pushover failed: ’ + e.message); return { status: 0 }; }
}

// ─── GEX SCANNER (inline from gexScanner.js) ─────────────────────────────────
let gexData    = null;
let gexRunning = false;
let gexLastRun = null;

async function fetchSpot(symbol) {
try {
const res = await fetch(‘https://api.tradier.com/v1/markets/quotes?symbols=’ + symbol,
{ headers: { ‘Authorization’: ’Bearer ’ + CONFIG.tradierToken, ‘Accept’: ‘application/json’ } });
if (!res.ok) return null;
const json = await res.json();
const q = json.quotes && json.quotes.quote;
return q && q.last ? parseFloat(q.last) : null;
} catch(e) { log(‘warn’, ’fetchSpot ’ + symbol + ’: ’ + e.message); return null; }
}

async function fetchChainForGEX(symbol) {
const results = [];
try {
const expRes = await fetch(
‘https://api.tradier.com/v1/markets/options/expirations?symbol=’ + symbol + ‘&includeAllRoots=true’,
{ headers: { ‘Authorization’: ’Bearer ’ + CONFIG.tradierToken, ‘Accept’: ‘application/json’ } }
);
if (!expRes.ok) return [];
const expJson = await expRes.json();
const expirations = expJson.expirations && expJson.expirations.date;
if (!expirations) return [];

```
const today   = new Date(); today.setHours(0, 0, 0, 0);
const cutoff  = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
const expList = (Array.isArray(expirations) ? expirations : [expirations])
  .filter(function(e) { const d = new Date(e + 'T00:00:00'); return d >= today && d <= cutoff; })
  .slice(0, 8);

log('info', symbol + ' fetching ' + expList.length + ' expirations');

for (const exp of expList) {
  try {
    const chainRes = await fetch(
      'https://api.tradier.com/v1/markets/options/chains?symbol=' + symbol + '&expiration=' + exp + '&greeks=true',
      { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
    );
    if (!chainRes.ok) continue;
    const chainJson = await chainRes.json();
    const opts = chainJson.options && chainJson.options.option;
    if (opts && opts.length) {
      opts.forEach(function(o) { o._expiry = exp; o._symbol = symbol; });
      results.push(...opts);
    }
    await new Promise(function(r) { setTimeout(r, 350); });
  } catch(e) { log('warn', symbol + ' chain ' + exp + ': ' + e.message); }
}
log('info', symbol + ' ' + results.length + ' contracts fetched');
return results;
```

} catch(e) { log(‘err’, ’fetchChainForGEX ’ + symbol + ’: ’ + e.message); return []; }
}

function calculateGEX(contracts, spotPrice) {
if (!contracts || !contracts.length || !spotPrice) return null;
const strikeMap = {};
let totalGEX = 0, contractsUsed = 0, contractsSkipped = 0;

contracts.forEach(function(o) {
const gamma  = o.greeks && o.greeks.gamma ? parseFloat(o.greeks.gamma) : null;
const oi     = o.open_interest ? parseInt(o.open_interest) : 0;
const strike = o.strike ? parseFloat(o.strike) : null;
const type   = (o.option_type || ‘’).toLowerCase();

```
if (!gamma || isNaN(gamma) || gamma <= 0) { contractsSkipped++; return; }
if (!oi || oi <= 0)                       { contractsSkipped++; return; }
if (!strike || isNaN(strike))             { contractsSkipped++; return; }
if (type !== 'call' && type !== 'put')    { contractsSkipped++; return; }
if (Math.abs(strike - spotPrice) / spotPrice > 0.20) { contractsSkipped++; return; }

const notional   = gamma * oi * 100 * spotPrice * spotPrice / 100;
const dealerSign = type === 'call' ? 1 : -1;
const gex        = dealerSign * notional;

if (!strikeMap[strike]) strikeMap[strike] = { strike, callGEX: 0, putGEX: 0, netGEX: 0, callOI: 0, putOI: 0 };
if (type === 'call') { strikeMap[strike].callGEX += gex; strikeMap[strike].callOI += oi; }
else                 { strikeMap[strike].putGEX  += gex; strikeMap[strike].putOI  += oi; }
strikeMap[strike].netGEX += gex;
totalGEX += gex;
contractsUsed++;
```

});

log(‘info’, ‘GEX: ’ + contractsUsed + ’ used / ’ + contractsSkipped + ’ skipped’);

const strikes = Object.values(strikeMap).map(function(s) {
return {
strike: s.strike, callGEX: Math.round(s.callGEX), putGEX: Math.round(s.putGEX),
netGEX: Math.round(s.netGEX), callOI: s.callOI, putOI: s.putOI,
magnitude: Math.abs(Math.round(s.netGEX)), direction: s.netGEX >= 0 ? ‘positive’ : ‘negative’,
};
}).sort(function(a, b) { return a.strike - b.strike; });

if (!strikes.length) return null;

// Find flip point
let cumGEX = 0, flipPoint = null, prevStrike = null, prevCum = 0;
for (const s of strikes) {
prevCum = cumGEX; cumGEX += s.netGEX;
if (prevStrike !== null && ((prevCum < 0 && cumGEX >= 0) || (prevCum > 0 && cumGEX <= 0))) {
flipPoint = Math.round(prevStrike + (s.strike - prevStrike) * Math.abs(prevCum) / (Math.abs(prevCum) + Math.abs(cumGEX)));
}
prevStrike = s.strike;
}
if (!flipPoint) {
const near = strikes.filter(function(s) { return Math.abs(s.strike - spotPrice) / spotPrice < 0.05; });
if (near.length) flipPoint = near.reduce(function(b, s) { return Math.abs(s.netGEX) < Math.abs(b.netGEX) ? s : b; }).strike;
}

const byMag      = strikes.slice().sort(function(a, b) { return b.magnitude - a.magnitude; });
const topSupport    = byMag.filter(function(s) { return s.netGEX < 0 && s.strike <= spotPrice; }).slice(0, 5);
const topResistance = byMag.filter(function(s) { return s.netGEX > 0 && s.strike >= spotPrice; }).slice(0, 5);
const topLevels     = byMag.slice(0, 10);

const netGEXBillions = parseFloat((totalGEX / 1e9).toFixed(2));
let regime, regimeColor, regimeDesc;
if      (totalGEX > 2e9)  { regime = ‘STRONG PIN’; regimeColor = ‘#39ff14’; regimeDesc = ‘Dealers long gamma — range-bound, fades work’; }
else if (totalGEX > 0)    { regime = ‘MILD PIN’;   regimeColor = ‘#ffd166’; regimeDesc = ‘Mild pinning — slow drift, fades likely to work’; }
else if (totalGEX > -2e9) { regime = ‘MILD TREND’; regimeColor = ‘#ff6b35’; regimeDesc = ‘Slight negative GEX — trending possible, breakouts can extend’; }
else                       { regime = ‘TRENDING’;   regimeColor = ‘#ff2d55’; regimeDesc = ‘Dealers short gamma — volatile, trending, breakouts extend’; }

return { spotPrice, totalGEX: Math.round(totalGEX), netGEXBillions, regime, regimeColor, regimeDesc, flipPoint, strikes, topSupport, topResistance, topLevels, contractsUsed, contractsSkipped };
}

function combineGEX(spxGEX, spyGEX) {
if (!spxGEX && !spyGEX) return null;
if (!spxGEX) return spyGEX;
if (!spyGEX) return spxGEX;

const combined = {};
spxGEX.strikes.forEach(function(s) {
if (!combined[s.strike]) combined[s.strike] = { strike: s.strike, netGEX: 0, callOI: 0, putOI: 0 };
combined[s.strike].netGEX += s.netGEX * 0.6;
combined[s.strike].callOI += s.callOI; combined[s.strike].putOI += s.putOI;
});
spyGEX.strikes.forEach(function(s) {
const eq = Math.round(s.strike * 10);
if (!combined[eq]) combined[eq] = { strike: eq, netGEX: 0, callOI: 0, putOI: 0 };
combined[eq].netGEX += (s.netGEX * 10) * 0.4;
combined[eq].callOI += s.callOI; combined[eq].putOI += s.putOI;
});

const spotPrice = spxGEX.spotPrice;
const strikes = Object.values(combined).map(function(s) {
return { strike: s.strike, netGEX: Math.round(s.netGEX), callOI: s.callOI, putOI: s.putOI,
totalOI: s.callOI + s.putOI, magnitude: Math.abs(Math.round(s.netGEX)), direction: s.netGEX >= 0 ? ‘positive’ : ‘negative’ };
}).sort(function(a, b) { return a.strike - b.strike; });

const totalGEX = strikes.reduce(function(sum, s) { return sum + s.netGEX; }, 0);
const byMag    = strikes.slice().sort(function(a, b) { return b.magnitude - a.magnitude; });

let cumGEX = 0, flipPoint = null, prevStrike = null, prevCum = 0;
for (const s of strikes) {
prevCum = cumGEX; cumGEX += s.netGEX;
if (prevStrike !== null && ((prevCum < 0 && cumGEX >= 0) || (prevCum > 0 && cumGEX <= 0))) {
flipPoint = Math.round(prevStrike + (s.strike - prevStrike) * Math.abs(prevCum) / (Math.abs(prevCum) + Math.abs(cumGEX)));
}
prevStrike = s.strike;
}

// Fallback 1: use SPX flip directly (most reliable single source)
if (!flipPoint && spxGEX && spxGEX.flipPoint) {
flipPoint = spxGEX.flipPoint;
}

// Fallback 2: strike where cumulative GEX is closest to zero
if (!flipPoint && strikes.length) {
var runningGEX2 = 0, closestFlip = null, closestDiff = Infinity;
for (var fi = 0; fi < strikes.length; fi++) {
runningGEX2 += strikes[fi].netGEX;
if (Math.abs(runningGEX2) < closestDiff) { closestDiff = Math.abs(runningGEX2); closestFlip = strikes[fi].strike; }
}
flipPoint = closestFlip;
}

const netGEXBillions = parseFloat((totalGEX / 1e9).toFixed(2));
let regime, regimeColor, regimeDesc;
if      (totalGEX > 2e9)  { regime = ‘STRONG PIN’; regimeColor = ‘#39ff14’; regimeDesc = ‘Dealers long gamma — range-bound, fades work’; }
else if (totalGEX > 0)    { regime = ‘MILD PIN’;   regimeColor = ‘#ffd166’; regimeDesc = ‘Mild pinning — slow drift’; }
else if (totalGEX > -2e9) { regime = ‘MILD TREND’; regimeColor = ‘#ff6b35’; regimeDesc = ‘Trending possible — breakouts can extend’; }
else                       { regime = ‘TRENDING’;   regimeColor = ‘#ff2d55’; regimeDesc = ‘Dealers short gamma — volatile, trending session’; }

// ── Near-spot strikes: all strikes within 3% of spot ──────────────────────
const nearSpotStrikes = strikes.filter(function(s) {
return Math.abs(s.strike - spotPrice) / spotPrice <= 0.03;
}).sort(function(a, b) { return a.strike - b.strike; });

// ── Control band detection ─────────────────────────────────────────────────
// Find the largest cluster of consecutive positive GEX strikes near spot
// A cluster = consecutive strikes (within 25pts of each other) all positive GEX
const controlBands = [];
let currentBand = null;
const posStrikes = strikes.filter(function(s) { return s.netGEX > 0; })
.sort(function(a, b) { return a.strike - b.strike; });

for (var ci = 0; ci < posStrikes.length; ci++) {
const s = posStrikes[ci];
if (!currentBand) {
currentBand = { low: s.strike, high: s.strike, totalGEX: s.netGEX, strikes: [s] };
} else if (s.strike - currentBand.high <= 25) {
currentBand.high = s.strike;
currentBand.totalGEX += s.netGEX;
currentBand.strikes.push(s);
} else {
if (currentBand.strikes.length >= 2) controlBands.push(currentBand);
currentBand = { low: s.strike, high: s.strike, totalGEX: s.netGEX, strikes: [s] };
}
}
if (currentBand && currentBand.strikes.length >= 2) controlBands.push(currentBand);

// Sort by total GEX magnitude, pick top 3
controlBands.sort(function(a, b) { return b.totalGEX - a.totalGEX; });
const topControlBands = controlBands.slice(0, 3).map(function(b) {
return {
low: b.low, high: b.high,
totalGEX: Math.round(b.totalGEX),
totalGEXB: parseFloat((b.totalGEX / 1e9).toFixed(2)),
strikeCount: b.strikes.length,
nearSpot: Math.abs(((b.low + b.high) / 2) - spotPrice) / spotPrice <= 0.05,
aboveSpot: b.low > spotPrice,
belowSpot: b.high < spotPrice,
label: b.low === b.high ? String(b.low) : b.low + ‘-’ + b.high,
};
});

// ── Negative GEX clusters (air pockets / acceleration zones) ──────────────
const negStrikes = strikes.filter(function(s) { return s.netGEX < 0; })
.sort(function(a, b) { return a.strike - b.strike; });
const negBands = [];
let currentNeg = null;
for (var ni = 0; ni < negStrikes.length; ni++) {
const s = negStrikes[ni];
if (!currentNeg) {
currentNeg = { low: s.strike, high: s.strike, totalGEX: s.netGEX, strikes: [s] };
} else if (s.strike - currentNeg.high <= 25) {
currentNeg.high = s.strike;
currentNeg.totalGEX += s.netGEX;
currentNeg.strikes.push(s);
} else {
if (currentNeg.strikes.length >= 2) negBands.push(currentNeg);
currentNeg = { low: s.strike, high: s.strike, totalGEX: s.netGEX, strikes: [s] };
}
}
if (currentNeg && currentNeg.strikes.length >= 2) negBands.push(currentNeg);
negBands.sort(function(a, b) { return a.totalGEX - b.totalGEX; }); // most negative first
const topNegBands = negBands.slice(0, 2).map(function(b) {
return {
low: b.low, high: b.high,
totalGEX: Math.round(b.totalGEX),
totalGEXB: parseFloat((b.totalGEX / 1e9).toFixed(2)),
strikeCount: b.strikes.length,
label: b.low === b.high ? String(b.low) : b.low + ‘-’ + b.high,
};
});

return {
spotPrice, totalGEX: Math.round(totalGEX), netGEXBillions, regime, regimeColor, regimeDesc, flipPoint,
strikes, nearSpotStrikes, topControlBands, topNegBands,
topSupport: byMag.filter(function(s) { return s.netGEX < 0 && s.strike <= spotPrice; }).slice(0, 5),
topResistance: byMag.filter(function(s) { return s.netGEX > 0 && s.strike >= spotPrice; }).slice(0, 5),
topLevels: byMag.slice(0, 10), spxGEX, spyGEX,
};
}

// ─── AI RECAP ────────────────────────────────────────────────────────────────
async function generateGEXRecap(data) {
if (!CONFIG.anthropicKey) { log(‘warn’, ‘No ANTHROPIC_API_KEY — skipping AI recap’); return; }
try {
const spot     = data.spotPrice;
const flip     = data.flipPoint || ‘unknown’;
const spyFlip  = data.spyGEX && data.spyGEX.flipPoint ? data.spyGEX.flipPoint : null;
const ptsToFlip = data.flipPoint ? (data.flipPoint - spot).toFixed(0) : null;

```
const supportStr = (data.topSupport || []).slice(0, 4).map(function(s) {
  return s.strike + ' ($' + Math.round(s.netGEX / 1e6) + 'M)';
}).join(', ');
const resistStr = (data.topResistance || []).slice(0, 4).map(function(s) {
  return s.strike + ' ($' + Math.round(s.netGEX / 1e6) + 'M)';
}).join(', ');

const prompt = [
  'You are a derivatives market analyst. Based on this GEX (Gamma Exposure) data, write a brief trading recap.',
  '',
  'GEX DATA:',
  'Regime: ' + data.regime + ' (' + data.regimeDesc + ')',
  'Net GEX: ' + (data.netGEXBillions >= 0 ? '+' : '') + data.netGEXBillions + 'B',
  'SPX Spot: ' + spot,
  'SPX GEX Flip Point: ' + flip + (ptsToFlip ? ' (' + (ptsToFlip > 0 ? '+' : '') + ptsToFlip + ' pts from spot)' : ''),
  spyFlip ? 'SPY GEX Flip: ' + spyFlip + ' (SPX equiv ~' + Math.round(spyFlip * 10) + ')' : '',
  'Key Resistance above spot: ' + (resistStr || 'none'),
  'Key Support below spot: ' + (supportStr || 'none'),
  '',
  'Write exactly 4 sentences. No bullet points. Plain English only.',
  'Sentence 1: What the regime and net GEX mean for todays session character (trending vs pinning).',
  'Sentence 2: Where the key resistance levels are and what happens if price reaches them.',
  'Sentence 3: Where the key support levels are and what happens if those break.',
  'Sentence 4 (ACTIONABLE): One specific, direct trading instruction for today based on this data. Name price levels. Be blunt.',
].filter(Boolean).join('\n');

const ctrl = new AbortController();
const tid  = setTimeout(function() { ctrl.abort(); }, 20000);
const res  = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.anthropicKey, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300,
    messages: [{ role: 'user', content: prompt }] }),
  signal: ctrl.signal,
});
clearTimeout(tid);
const json = await res.json();
const text = json.content && json.content[0] && json.content[0].text ? json.content[0].text.trim() : null;
if (text) {
  data.aiRecap = text;
  log('ok', 'GEX AI recap generated');
}
```

} catch(e) {
log(‘warn’, ’GEX AI recap failed: ’ + e.message);
}
}

async function runGEXScan(label) {
if (gexRunning) { log(‘warn’, ‘GEX already running’); return; }
if (!CONFIG.tradierToken) { log(‘warn’, ‘No TRADIER_TOKEN’); return; }
gexRunning = true;
label = label || new Date().toLocaleTimeString(‘en-US’, { timeZone: ‘America/Denver’, hour12: true });
log(‘info’, ‘== GEX scan starting (’ + label + ‘) ==’);
try {
const [spxSpot, spySpot] = await Promise.all([fetchSpot(‘SPX’), fetchSpot(‘SPY’)]);
log(‘info’, ’Spots — SPX: ’ + spxSpot + ’  SPY: ’ + spySpot);

```
const spxContracts = spxSpot ? await fetchChainForGEX('SPX') : [];
const spyContracts = spySpot ? await fetchChainForGEX('SPY') : [];

const spxGEX = spxContracts.length ? calculateGEX(spxContracts, spxSpot) : null;
const spyGEX = spyContracts.length ? calculateGEX(spyContracts, spySpot) : null;

if (spxGEX) log('ok', 'SPX GEX: ' + spxGEX.netGEXBillions + 'B | flip: ' + spxGEX.flipPoint);
if (spyGEX) log('ok', 'SPY GEX: ' + spyGEX.netGEXBillions + 'B | flip: ' + spyGEX.flipPoint);

const combined = combineGEX(spxGEX, spyGEX);
if (!combined) { log('err', 'GEX combination failed'); return; }

combined.ts       = new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true });
combined.runLabel = label;
gexData    = combined;
gexLastRun = new Date().toISOString();

log('ok', '== GEX complete — ' + combined.regime + ' | flip: ' + combined.flipPoint + ' | net: ' + combined.netGEXBillions + 'B ==');

// AI Recap
await generateGEXRecap(combined);

// Pushover
const spot = combined.spotPrice;
const supportStr = (combined.topSupport || []).slice(0, 3).map(function(s) {
  return s.strike + ' ($' + Math.round(s.netGEX / 1e6) + 'M)';
}).join(' | ');
const resistStr = (combined.topResistance || []).slice(0, 3).map(function(s) {
  return s.strike + ' ($' + Math.round(s.netGEX / 1e6) + 'M)';
}).join(' | ');

await sendPushover(
  'GEX — ' + label + ' (' + combined.regime + ')',
  ['Spot: ' + spot + '  Net GEX: ' + (combined.netGEXBillions >= 0 ? '+' : '') + combined.netGEXBillions + 'B',
   'Flip: ' + (combined.flipPoint || 'N/A'),
   combined.regimeDesc, '',
   'Support: ' + (supportStr || 'none'),
   'Resistance: ' + (resistStr || 'none'),
  ].join('\n'), 0
);
```

} catch(e) {
log(‘err’, ’runGEXScan: ’ + e.message);
} finally {
gexRunning = false;
}
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CTA POSITIONING MODULE ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// Tracks Commodity Trading Advisor (trend-follower) positioning across 10 ETFs.
// Outputs composite score (-100 to +100), SPY trigger ladder, per-asset table.
// Uses existing TRADIER_TOKEN. Refreshes every 30 min during market hours.

const CTA_UNIVERSE = [
{ symbol: ‘SPY’, name: ‘S&P 500’,      assetClass: ‘equity’,    weight: 0.18 },
{ symbol: ‘QQQ’, name: ‘Nasdaq 100’,   assetClass: ‘equity’,    weight: 0.10 },
{ symbol: ‘IWM’, name: ‘Russell 2000’, assetClass: ‘equity’,    weight: 0.07 },
{ symbol: ‘IEF’, name: ‘7-10Y Treas’,  assetClass: ‘rates’,     weight: 0.15 },
{ symbol: ‘TLT’, name: ‘20Y+ Treas’,   assetClass: ‘rates’,     weight: 0.10 },
{ symbol: ‘GLD’, name: ‘Gold’,         assetClass: ‘commodity’, weight: 0.10 },
{ symbol: ‘USO’, name: ‘Crude Oil’,    assetClass: ‘commodity’, weight: 0.10 },
{ symbol: ‘UUP’, name: ‘US Dollar’,    assetClass: ‘fx’,        weight: 0.10 },
{ symbol: ‘FXE’, name: ‘Euro’,         assetClass: ‘fx’,        weight: 0.05 },
{ symbol: ‘FXY’, name: ‘Yen’,          assetClass: ‘fx’,        weight: 0.05 },
];

const CTA_LOOKBACKS = [
{ days: 20,  weight: 0.40 },
{ days: 50,  weight: 0.30 },
{ days: 100, weight: 0.20 },
{ days: 200, weight: 0.10 },
];

const CTA_TOTAL_AUM_BILLIONS = 350;
const CTA_EQUITY_ALLOCATION  = 0.35;
const CTA_TRIGGER_FLOW_FRACTION = { 20: 0.25, 50: 0.30, 100: 0.25, 200: 0.20 };

let ctaState = null;
let ctaRunning = false;
let ctaHistoricalScores = [];

function ctaSMA(arr, period) {
if (!arr || arr.length < period) return null;
let sum = 0;
for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
return sum / period;
}

function ctaATR(bars, period) {
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

function ctaTanh(x) {
if (x > 20) return 1;
if (x < -20) return -1;
const e2x = Math.exp(2 * x);
return (e2x - 1) / (e2x + 1);
}

function ctaClassifyPosition(p) {
if (p === null || p === undefined) return ‘unknown’;
if (p >= 0.75) return ‘max long’;
if (p >= 0.25) return ‘long’;
if (p >= -0.25) return ‘neutral’;
if (p >= -0.75) return ‘short’;
return ‘max short’;
}

function ctaClassifyComposite(c) {
if (c === null) return ‘unknown’;
if (c >= 75) return ‘max long crowded’;
if (c >= 25) return ‘long’;
if (c >= -25) return ‘neutral’;
if (c >= -75) return ‘short’;
return ‘max short crowded’;
}

function ctaInterpret(c) {
if (c === null) return ‘No data yet.’;
if (c >= 75) return ‘CTAs are crowded long. Mechanical downside risk if shorter MAs break — they will be forced sellers into weakness.’;
if (c >= 25) return ‘Net long positioning. Trend-followers supportive, but watch for MA breaks that could flip flow.’;
if (c >= -25) return ‘Neutral. Low mechanical flow risk in either direction. Discretionary flow dominates.’;
if (c >= -75) return ‘Net short positioning. Trend-followers pressuring lower, but vulnerable to short-cover squeeze on upside breaks.’;
return ‘CTAs are crowded short. Significant squeeze risk on any meaningful upside break of shorter MAs.’;
}

async function fetchCTABars(symbol, days) {
if (!CONFIG.tradierToken) throw new Error(‘TRADIER_TOKEN not set’);
const end = new Date();
const start = new Date();
start.setDate(start.getDate() - Math.ceil(days * 1.6));
const fmt = (d) => d.toISOString().split(‘T’)[0];
const url = ‘https://api.tradier.com/v1/markets/history?symbol=’ + encodeURIComponent(symbol) +
‘&interval=daily&start=’ + fmt(start) + ‘&end=’ + fmt(end);
const res = await fetch(url, {
headers: { ‘Authorization’: ’Bearer ’ + CONFIG.tradierToken, ‘Accept’: ‘application/json’ }
});
if (!res.ok) throw new Error(’Tradier ’ + symbol + ’ HTTP ’ + res.status);
const json = await res.json();
const day = json && json.history && json.history.day;
if (!day) throw new Error(’No history for ’ + symbol);
const arr = Array.isArray(day) ? day : [day];
return arr.map(function(b) {
return {
date: b.date,
open: parseFloat(b.open),
high: parseFloat(b.high),
low: parseFloat(b.low),
close: parseFloat(b.close),
volume: parseInt(b.volume) || 0,
};
}).filter(function(b) { return !isNaN(b.close); });
}

function ctaCalculatePositioning(bars) {
if (!bars || bars.length < 201) return { position: null, error: ‘insufficient_history’ };
const closes = bars.map(function(b) { return b.close; });
const currentPrice = closes[closes.length - 1];
const atr20 = ctaATR(bars, 20);
if (!atr20 || atr20 === 0) return { position: null, error: ‘invalid_atr’ };

const momentum = {};
let rawSignal = 0;

for (const lb of CTA_LOOKBACKS) {
const ma = ctaSMA(closes, lb.days);
if (!ma) continue;
const mom = (currentPrice - ma) / atr20;
momentum[lb.days] = {
ma: ma,
momentum: mom,
pctFromMA: ((currentPrice - ma) / ma) * 100,
};
rawSignal += lb.weight * mom;
}

const position = ctaTanh(rawSignal / 3);
return {
position: position,
positionPct: position * 100,
momentum: momentum,
currentPrice: currentPrice,
atr20: atr20,
};
}

function ctaCalculateTriggers(bars, currentPrice) {
const closes = bars.map(function(b) { return b.close; });
const triggers = [];
const equityAUM = CTA_TOTAL_AUM_BILLIONS * CTA_EQUITY_ALLOCATION;
for (const lb of CTA_LOOKBACKS) {
const ma = ctaSMA(closes, lb.days);
if (!ma) continue;
const distance = currentPrice - ma;
const distancePct = (distance / currentPrice) * 100;
const flowFraction = CTA_TRIGGER_FLOW_FRACTION[lb.days] || 0.2;
triggers.push({
lookback: lb.days,
level: Math.round(ma * 100) / 100,
distance: Math.round(distance * 100) / 100,
distancePct: Math.round(distancePct * 100) / 100,
direction: currentPrice > ma ? ‘sell_trigger’ : ‘buy_trigger’,
estimatedFlowB: Math.round(equityAUM * flowFraction * 10) / 10,
});
}
return triggers.sort(function(a, b) { return Math.abs(a.distancePct) - Math.abs(b.distancePct); });
}

async function refreshCTA() {
if (ctaRunning) { log(‘warn’, ‘CTA refresh already running’); return ctaState; }
ctaRunning = true;
log(‘info’, ‘== CTA refresh starting ==’);

const errors = [];
const assets = [];
let weightedPosition = 0;
let totalWeight = 0;
let spyTriggers = [];

try {
for (const asset of CTA_UNIVERSE) {
try {
const bars = await fetchCTABars(asset.symbol, 250);
const pos = ctaCalculatePositioning(bars);
if (pos.position === null) {
errors.push(asset.symbol + ’: ’ + pos.error);
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
state: ctaClassifyPosition(pos.position),
});
weightedPosition += pos.position * asset.weight;
totalWeight += asset.weight;
if (asset.symbol === ‘SPY’) {
spyTriggers = ctaCalculateTriggers(bars, pos.currentPrice);
}
await new Promise(function(r) { setTimeout(r, 250); });
} catch (e) {
errors.push(asset.symbol + ’: ’ + e.message);
log(‘warn’, ’CTA ’ + asset.symbol + ’: ’ + e.message);
}
}

```
const composite = totalWeight > 0
  ? Math.round((weightedPosition / totalWeight) * 100 * 10) / 10
  : null;

const now = Date.now();
let delta1d = null;
let delta1w = null;
if (composite !== null) {
  const oneDayAgo = ctaHistoricalScores.find(function(s) {
    return now - s.timestamp >= 23 * 3600000 && now - s.timestamp <= 25 * 3600000;
  });
  const oneWeekAgo = ctaHistoricalScores.find(function(s) {
    return now - s.timestamp >= 6.5 * 86400000 && now - s.timestamp <= 7.5 * 86400000;
  });
  if (oneDayAgo) delta1d = Math.round((composite - oneDayAgo.composite) * 10) / 10;
  if (oneWeekAgo) delta1w = Math.round((composite - oneWeekAgo.composite) * 10) / 10;
  ctaHistoricalScores.push({ timestamp: now, composite: composite });
  if (ctaHistoricalScores.length > 800) ctaHistoricalScores.shift();
}

ctaState = {
  timestamp: new Date().toISOString(),
  ts: new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true }),
  composite: composite,
  compositeState: ctaClassifyComposite(composite),
  compositeDelta1d: delta1d,
  compositeDelta1w: delta1w,
  assets: assets,
  triggers: spyTriggers,
  universe: CTA_UNIVERSE.length,
  universeFetched: assets.length,
  errors: errors,
  interpretation: ctaInterpret(composite),
};

log('ok', '== CTA complete — score: ' + composite + ' (' + ctaClassifyComposite(composite) + ') | ' + assets.length + '/' + CTA_UNIVERSE.length + ' assets ==');
```

} catch(e) {
log(‘err’, ’CTA refresh failed: ’ + e.message);
} finally {
ctaRunning = false;
}
return ctaState;
}

function startCTAPolling() {
// Initial fetch 10s after startup so it doesn’t collide with GEX startup scan (5s)
setTimeout(function() { refreshCTA(); }, 10000);
// Refresh every 30 min during market hours weekdays
setInterval(function() {
const now = new Date();
const day = now.getUTCDay();
const hourUTC = now.getUTCHours();
if (day === 0 || day === 6) return;
if (hourUTC < 13 || hourUTC > 22) return;
refreshCTA();
}, 30 * 60 * 1000);
}

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
</div>`;
  }

let compColor = ‘#ffd166’;
if (d.composite >= 25) compColor = ‘#39ff14’;
else if (d.composite <= -25) compColor = ‘#ff2d55’;
if (Math.abs(d.composite) >= 75) compColor = ‘#ff6b35’;

const barFill = d.composite !== null ? Math.min(Math.abs(d.composite), 100) / 2 : 0;
const barSide = d.composite >= 0 ? ‘left:50%’ : ‘right:50%’;

const triggerRows = (d.triggers || []).map(function(t) {
const distCol = t.direction === ‘sell_trigger’ ? ‘#ff2d55’ : ‘#39ff14’;
const arrow = t.direction === ‘sell_trigger’ ? ‘▼’ : ‘▲’;
const label = t.direction === ‘sell_trigger’ ? ‘BREAK = FORCED SELLING’ : ‘BREAK = FORCED BUYING’;
return `<div style="padding:12px 20px;border-bottom:1px solid #0d1f2d;display:grid;grid-template-columns:80px 1fr 90px 100px 110px;gap:12px;align-items:center"> <div style="font-size:11px;color:#4a6070;letter-spacing:1px">${t.lookback}-DAY MA</div> <div class="mono" style="font-size:18px;font-weight:700;color:#d8eaf5">$${t.level}</div> <div class="mono" style="font-size:13px;color:${distCol};text-align:right">${t.distancePct >= 0 ? '+' : ''}${t.distancePct}%</div> <div class="mono" style="font-size:12px;color:#ffd166;text-align:right">~$${t.estimatedFlowB}B</div> <div style="font-size:9px;color:${distCol};letter-spacing:1px;text-align:right">${arrow} ${label}</div> </div>`;
}).join(’’);

const assetRows = (d.assets || []).map(function(a) {
let posCol = ‘#ffd166’;
if (a.positionPct >= 25) posCol = ‘#39ff14’;
else if (a.positionPct <= -25) posCol = ‘#ff2d55’;
if (Math.abs(a.positionPct) >= 75) posCol = ‘#ff6b35’;

```
const m20 = a.momentum[20] ? a.momentum[20].pctFromMA : null;
const m50 = a.momentum[50] ? a.momentum[50].pctFromMA : null;
const m200 = a.momentum[200] ? a.momentum[200].pctFromMA : null;

const colorFor = function(v) {
  if (v === null || v === undefined) return '#4a6070';
  if (v > 1) return '#39ff14';
  if (v < -1) return '#ff2d55';
  return '#ffd166';
};
const fmtPct = function(v) {
  return v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
};

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
```

}).join(’’);

const errorBox = (d.errors && d.errors.length) ? ` <div style="margin:0 20px 16px 20px;padding:10px 14px;background:rgba(255,45,85,0.08);border-left:3px solid #ff2d55;border-radius:0 6px 6px 0;font-size:11px;color:#ff6b35;font-family:'Space Mono',monospace"> ${d.errors.map(function(e) { return '· ' + e; }).join('<br>')} </div>` : ‘’;

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

```
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
```

  </div>
</div>

<div class="card">
  <div class="card-head">
    <span class="card-title">&#127919; SPY Trigger Ladder — Forced Flow Levels</span>
    <span style="font-size:11px;color:#4a6070">Sorted by proximity to current price</span>
  </div>
  <div>
    ${triggerRows || '<div style="padding:30px;text-align:center;color:#4a6070;font-size:12px">No trigger data available</div>'}
  </div>
</div>

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
</div>`;
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function startScheduler() {
// 8:00am MST = 15:00 UTC (MDT)
cron.schedule(‘0 15 * * 1-5’, function() { runGEXScan(‘8:00am MST’); });
// 9:30am MST = 16:30 UTC
cron.schedule(‘30 16 * * 1-5’, function() { runGEXScan(‘9:30am MST’); });
log(‘info’, ‘GEX scheduler started — 8:00am + 9:30am MST weekdays’);
}

// ─── HTML DASHBOARD ───────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,’&’).replace(/</g,’<’).replace(/>/g,’>’); }

function renderHTML() {
const d = gexData;
const logHTML = […logLines].reverse().slice(0, 60).map(function(l) {
const c = { ok: ‘#39ff14’, warn: ‘#ff6b35’, err: ‘#ff2d55’, info: ‘#4a6272’ }[l.type] || ‘#4a6272’;
return ‘<div style="color:' + c + '">[’ + l.time.slice(11,19) + ‘] ’ + esc(l.msg) + ‘</div>’;
}).join(’’);

return `<!DOCTYPE html>

<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GEX Scanner</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070a0f;color:#d8eaf5;font-family:'Space Grotesk',sans-serif;font-size:14px;min-height:100vh}
.wrap{max-width:1100px;margin:0 auto;padding:20px 24px}
.card{background:#0c1118;border:1px solid #1a2535;border-radius:12px;margin-bottom:16px;overflow:hidden}
.card-head{padding:14px 20px;border-bottom:1px solid #1a2535;display:flex;align-items:center;justify-content:space-between}
.card-title{font-size:11px;font-weight:600;letter-spacing:2px;color:#4a6070;text-transform:uppercase}
.btn{padding:8px 18px;font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;cursor:pointer;border:none;border-radius:6px;transition:all .15s}
.bp{background:#00d4ff;color:#070a0f}.bp:hover{background:#33ddff}
.bs{background:transparent;color:#00d4ff;border:1px solid rgba(0,212,255,.35)}.bs:hover{background:rgba(0,212,255,.08)}
nav{border-bottom:1px solid #1a2535;padding:0 24px;display:flex;align-items:center;justify-content:space-between;background:rgba(7,10,15,.95);position:sticky;top:0;z-index:100;height:56px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.mono{font-family:'Space Mono',monospace}
</style>
</head>
<body>
<nav>
  <div style="display:flex;align-items:center;gap:10px">
    <div class="mono" style="font-size:18px;font-weight:700;color:#00d4ff;letter-spacing:3px">GEX</div>
    <div style="width:6px;height:6px;border-radius:50%;background:${gexRunning?'#ff6b35':'#00f076'};box-shadow:0 0 8px ${gexRunning?'#ff6b35':'#00f076'};animation:pulse 2s infinite"></div>
    <div style="color:#4a6070;font-size:12px">${gexRunning?'SCANNING':'LIVE'}</div>
  </div>
  <div style="display:flex;gap:10px">
    <button class="btn bs" onclick="triggerScan(this)">&#9654; Run Now</button>
    <button class="btn bs" onclick="testPush(this)">&#128276; Test Alert</button>
  </div>
</nav>
<div class="wrap">

<!-- PRE-MARKET PANEL -->

<div class="card" style="margin-bottom:16px">
  <div class="card-head">
    <span class="card-title">&#9728; Pre-Market Recalculator</span>
    <span style="font-size:11px;color:#4a6070">Enter futures/pre-market SPX price to recalculate levels</span>
  </div>
  <div style="padding:16px 20px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
    <div>
      <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:6px">SPX PRE-MARKET PRICE</div>
      <input type="number" id="pm-price" placeholder="e.g. 6540" step="1" min="1000" max="20000"
        style="background:#111820;border:1px solid #1a2535;color:#d8eaf5;padding:9px 13px;font-family:'Space Mono',monospace;font-size:16px;font-weight:700;width:160px;border-radius:6px;outline:none"
        onkeydown="if(event.key==='Enter')recalcPM()">
    </div>
    <button class="btn bp" onclick="recalcPM()" style="margin-bottom:1px">&#8635; Recalculate</button>
    <button class="btn bs" onclick="clearPM()" style="margin-bottom:1px">Clear</button>
    <span id="pm-msg" style="font-size:12px;color:#4a6070"></span>
  </div>
  <div id="pm-result"></div>
</div>

${d ? `

<!-- REGIME CARD -->

<div class="card">
  <div class="card-head">
    <span class="card-title">GEX Regime — SPX + SPY Combined</span>
    <span style="font-size:11px;color:#4a6070">${esc(d.ts || '')}</span>
  </div>
  <div style="padding:24px">
    <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:20px">
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">REGIME</div>
        <div class="mono" style="font-size:36px;font-weight:700;color:${esc(d.regimeColor)}">${esc(d.regime)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">NET GEX</div>
        <div class="mono" style="font-size:36px;font-weight:700;color:${d.netGEXBillions >= 0 ? '#39ff14' : '#ff2d55'}">${d.netGEXBillions >= 0 ? '+' : ''}${d.netGEXBillions}B</div>
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">SPX SPOT</div>
        <div class="mono" style="font-size:36px;font-weight:700;color:#d8eaf5">${d.spotPrice}</div>
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">SPX FLIP</div>
        <div class="mono" style="font-size:36px;font-weight:700;color:#ffd166">${d.flipPoint || 'N/A'}</div>
        ${d.flipPoint ? `<div style="font-size:11px;color:#4a6070;margin-top:2px">${d.flipPoint > d.spotPrice ? '+' : ''}${(d.flipPoint - d.spotPrice).toFixed(0)} pts away</div>` : ''}
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">SPY FLIP</div>
        <div class="mono" style="font-size:36px;font-weight:700;color:#ffd166">${(d.spyGEX && d.spyGEX.flipPoint) ? d.spyGEX.flipPoint : 'N/A'}</div>
        ${(d.spyGEX && d.spyGEX.flipPoint && d.spyGEX.spotPrice) ? `<div style="font-size:11px;color:#4a6070;margin-top:2px">${d.spyGEX.flipPoint > d.spyGEX.spotPrice ? '+' : ''}${(d.spyGEX.flipPoint - d.spyGEX.spotPrice).toFixed(0)} pts away</div>` : ''}
      </div>
    </div>
    <div style="padding:12px 16px;background:#111820;border-left:3px solid ${esc(d.regimeColor)};border-radius:0 6px 6px 0;font-size:13px;color:#8aa0b0">
      ${esc(d.regimeDesc)}
      ${d.flipPoint ? ` &middot; Flip at <strong style="color:#ffd166">${d.flipPoint}</strong> (${Math.abs(d.flipPoint - d.spotPrice).toFixed(0)} pts ${d.flipPoint > d.spotPrice ? 'above' : 'below'} spot)` : ''}
    </div>
  </div>
</div>

${d.aiRecap ? `

<!-- AI RECAP -->

<div class="card" style="margin-bottom:16px">
  <div class="card-head">
    <span class="card-title">&#129302; AI Interpretation &amp; Actionable Takeaway</span>
    <span style="font-size:11px;color:#4a6070">${esc(d.ts || '')}</span>
  </div>
  <div style="padding:18px 20px">
    <div style="font-size:13px;color:#d8eaf5;line-height:1.9">${(function() {
      var sentences = d.aiRecap.split(/(?<=[.!?])\s+/);
      var last = sentences.pop();
      return sentences.map(function(s) { return esc(s); }).join(' ') +
        (last ? ' <div style="margin-top:14px;padding:12px 16px;background:#111820;border-left:3px solid #00d4ff;border-radius:0 6px 6px 0;font-size:13px;font-weight:600;color:#00d4ff">' + esc(last) + '</div>' : '');
    })()}</div>
  </div>
</div>
` : ''}

<!-- KEY LEVELS -->

<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
  <!-- RESISTANCE -->
  <div class="card">
    <div class="card-head"><span class="card-title">&#9650; Resistance (Dealer Supply)</span></div>
    <div>
      ${(d.topResistance || []).map(function(s) {
        const pct = ((s.strike - d.spotPrice) / d.spotPrice * 100).toFixed(1);
        const gexM = Math.round(s.netGEX / 1e6);
        return `<div style="padding:12px 20px;border-bottom:1px solid #0d1f2d;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="mono" style="font-size:18px;font-weight:700;color:#39ff14">${s.strike}</div>
            <div style="font-size:10px;color:#4a6070">+${pct}% from spot</div>
          </div>
          <div style="text-align:right">
            <div class="mono" style="font-size:14px;color:#39ff14">+$${gexM}M GEX</div>
            <div style="font-size:10px;color:#4a6070">DEALER SUPPLY / BSL</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- SUPPORT -->

  <div class="card">
    <div class="card-head"><span class="card-title">&#9660; Support (Dealer Demand)</span></div>
    <div>
      ${(d.topSupport || []).slice().reverse().map(function(s) {
        const pct = ((s.strike - d.spotPrice) / d.spotPrice * 100).toFixed(1);
        const gexM = Math.round(s.netGEX / 1e6);
        return `<div style="padding:12px 20px;border-bottom:1px solid #0d1f2d;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="mono" style="font-size:18px;font-weight:700;color:#ff2d55">${s.strike}</div>
            <div style="font-size:10px;color:#4a6070">${pct}% from spot</div>
          </div>
          <div style="text-align:right">
            <div class="mono" style="font-size:14px;color:#ff2d55">$${gexM}M GEX</div>
            <div style="font-size:10px;color:#4a6070">DEALER DEMAND / SSL</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>
</div>

${(d.topControlBands && d.topControlBands.length) ? `

<!-- CONTROL BANDS -->

<div class="card" style="margin-bottom:16px">
  <div class="card-head">
    <span class="card-title">&#127919; Control Bands &amp; Air Pockets</span>
    <span style="font-size:11px;color:#4a6070">Clusters of consecutive strikes — where market gets pinned or accelerates</span>
  </div>
  <div style="padding:16px 20px">
    <div style="font-size:10px;color:#39ff14;letter-spacing:2px;margin-bottom:10px">POSITIVE GEX BANDS — PINNING / SUPPORT / RESISTANCE</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px">
      ${(d.topControlBands || []).map(function(b) {
        var pos  = b.aboveSpot ? 'ABOVE SPOT' : b.belowSpot ? 'BELOW SPOT' : 'AT SPOT';
        var col  = b.nearSpot ? '#39ff14' : '#ffd166';
        var role = b.aboveSpot ? 'RESISTANCE / CAP' : b.belowSpot ? 'SUPPORT / FLOOR' : 'CONTROL ZONE';
        return `<div style="padding:14px 16px;background:#111820;border-radius:8px;border-left:4px solid ${col};min-width:160px;flex:1">
          <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">${pos} — ${role}</div>
          <div class="mono" style="font-size:22px;font-weight:700;color:${col}">${b.label}</div>
          <div class="mono" style="font-size:14px;color:${col};margin-top:2px">+${b.totalGEXB}B combined</div>
          <div style="font-size:10px;color:#4a6070;margin-top:4px">${b.strikeCount} strikes in cluster</div>
        </div>`;
      }).join('')}
    </div>
    ${(d.topNegBands && d.topNegBands.length) ? `
    <div style="font-size:10px;color:#ff2d55;letter-spacing:2px;margin-bottom:10px">NEGATIVE GEX BANDS — AIR POCKETS / ACCELERATION ZONES</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px">
      ${(d.topNegBands || []).map(function(b) {
        return `<div style="padding:14px 16px;background:#111820;border-radius:8px;border-left:4px solid #ff2d55;min-width:160px;flex:1">
          <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">AIR POCKET — MOVES ACCELERATE HERE</div>
          <div class="mono" style="font-size:22px;font-weight:700;color:#ff2d55">${b.label}</div>
          <div class="mono" style="font-size:14px;color:#ff2d55;margin-top:2px">${b.totalGEXB}B combined</div>
          <div style="font-size:10px;color:#4a6070;margin-top:4px">${b.strikeCount} strikes in cluster</div>
        </div>`;
      }).join('')}
    </div>
    ` : ''}
  </div>
</div>
` : ''}

${(d.nearSpotStrikes && d.nearSpotStrikes.length) ? `

<!-- NEAR SPOT DETAIL -->

<div class="card" style="margin-bottom:16px">
  <div class="card-head">
    <span class="card-title">&#128269; Strike-by-Strike — Within 3% of Spot (${d.spotPrice})</span>
    <span style="font-size:11px;color:#4a6070">Every strike with GEX data near current price</span>
  </div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-family:Space Mono,monospace;font-size:12px">
      <tr style="color:#4a6070;font-size:10px;letter-spacing:1px;border-bottom:1px solid #1a2535">
        <td style="padding:8px 16px">STRIKE</td>
        <td style="padding:8px 16px">NET GEX</td>
        <td style="padding:8px 16px">CALL OI</td>
        <td style="padding:8px 16px">PUT OI</td>
        <td style="padding:8px 16px">VS SPOT</td>
        <td style="padding:8px 16px">ROLE</td>
      </tr>
      ${(d.nearSpotStrikes || []).map(function(s) {
        var col     = s.netGEX >= 0 ? '#39ff14' : '#ff2d55';
        var gexM    = Math.round(s.netGEX / 1e6);
        var pct     = ((s.strike - d.spotPrice) / d.spotPrice * 100).toFixed(1);
        var isSpot  = Math.abs(s.strike - d.spotPrice) <= 5;
        var role    = isSpot ? 'AT SPOT' : s.netGEX > 0 && s.strike > d.spotPrice ? 'RESISTANCE' : s.netGEX > 0 && s.strike < d.spotPrice ? 'SUPPORT' : s.strike > d.spotPrice ? 'AIR POCKET ↑' : 'AIR POCKET ↓';
        var rowBg   = isSpot ? 'background:rgba(0,212,255,0.06)' : '';
        return `<tr style="border-bottom:1px solid #0d1f2d;${rowBg}">
          <td style="padding:8px 16px;color:#d8eaf5;font-weight:700">${s.strike}${isSpot ? ' <span style="color:#00d4ff;font-size:9px">◀ SPOT</span>' : ''}</td>
          <td style="padding:8px 16px;color:${col};font-weight:700">${gexM >= 0 ? '+' : ''}$${gexM}M</td>
          <td style="padding:8px 16px;color:#8aa0b0">${(s.callOI || 0).toLocaleString()}</td>
          <td style="padding:8px 16px;color:#8aa0b0">${(s.putOI  || 0).toLocaleString()}</td>
          <td style="padding:8px 16px;color:#4a6070">${pct >= 0 ? '+' : ''}${pct}%</td>
          <td style="padding:8px 16px;color:${col};font-size:10px;letter-spacing:1px">${role}</td>
        </tr>`;
      }).join('')}
    </table>
  </div>
</div>
` : ''}

<!-- GEX BAR CHART -->

<div class="card">
  <div class="card-head"><span class="card-title">GEX by Strike — Top 15 Levels</span></div>
  <div style="padding:16px 20px" id="gex-bars">
    ${(function() {
      const levels = (d.topLevels || []).slice(0, 15);
      const maxMag = Math.max(...levels.map(function(s) { return s.magnitude; }), 1);
      return levels.map(function(s) {
        const pct  = (s.magnitude / maxMag * 100).toFixed(1);
        const col  = s.netGEX >= 0 ? '#39ff14' : '#ff2d55';
        const gexM = Math.round(s.netGEX / 1e6);
        const isFlip = d.flipPoint && Math.abs(s.strike - d.flipPoint) <= 5;
        const isSpot = Math.abs(s.strike - d.spotPrice) <= 5;
        return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
          <div class="mono" style="width:55px;font-size:13px;font-weight:700;color:${col};flex-shrink:0">${s.strike}</div>
          <div style="flex:1;height:20px;background:#0d1f2d;border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${col};border-radius:3px;opacity:0.85"></div>
          </div>
          <div class="mono" style="width:70px;font-size:11px;color:${col};text-align:right;flex-shrink:0">${gexM >= 0 ? '+' : ''}$${gexM}M</div>
          ${isFlip ? '<div style="font-size:9px;font-weight:700;color:#ffd166;letter-spacing:1px;flex-shrink:0">FLIP</div>' : ''}
          ${isSpot ? '<div style="font-size:9px;font-weight:700;color:#00d4ff;letter-spacing:1px;flex-shrink:0">SPOT</div>' : ''}
        </div>`;
      }).join('');
    })()}
  </div>
</div>
` : `
<div class="card">
  <div style="padding:60px;text-align:center;color:#4a6070">
    <div style="font-size:14px;margin-bottom:12px">No GEX data yet</div>
    <div style="font-size:12px">Auto-runs at 8:00am and 9:30am MST weekdays</div>
    <div style="margin-top:20px"><button class="btn bp" onclick="triggerScan(this)">&#9654; Run Now</button></div>
  </div>
</div>
`}

${renderCTASection()}

<!-- LOG -->

<div class="card">
  <div class="card-head"><span class="card-title">Activity Log</span></div>
  <div style="background:#070a0f;padding:14px 20px;font-family:'Space Mono',monospace;font-size:11px;line-height:1.9;max-height:240px;overflow-y:auto;color:#8aa0b0">
    ${logHTML || '<span style="color:#4a6070">No activity yet</span>'}
  </div>
</div>

</div>
<script>
function recalcPM() {
  var spot = parseFloat(document.getElementById('pm-price').value);
  var msg  = document.getElementById('pm-msg');
  var res  = document.getElementById('pm-result');
  if (!spot || spot < 1000 || spot > 20000) { msg.textContent = 'Enter a valid SPX price (e.g. 6540)'; msg.style.color='#ff2d55'; return; }
  msg.textContent = 'Recalculating...'; msg.style.color = '#00d4ff';
  fetch('/api/recalc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spotPrice: spot }) })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.error) { msg.textContent = 'Error: ' + d.error; msg.style.color='#ff2d55'; return; }
    msg.textContent = 'Done — ' + d.runLabel; msg.style.color = '#39ff14';

```
var closePrice = d.spxGEX && d.spxGEX.spotPrice ? d.spxGEX.spotPrice : (d.spotPrice || spot);
var gapPct = ((spot - closePrice) / closePrice * 100).toFixed(2);
var gapDir = gapPct >= 0 ? 'GAP UP' : 'GAP DOWN';
var gapCol = gapPct >= 0 ? '#39ff14' : '#ff2d55';
var flipAbove = d.flipPoint && spot < d.flipPoint;

var supportRows = (d.topSupport || []).slice().reverse().map(function(s) {
  var pct = ((s.strike - spot) / spot * 100).toFixed(1);
  return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0d1f2d">' +
    '<span class="mono" style="color:#ff2d55;font-weight:700">' + s.strike + '</span>' +
    '<span style="color:#4a6070;font-size:11px">' + pct + '%</span>' +
    '<span class="mono" style="color:#ff2d55;font-size:11px">$' + Math.round(s.netGEX/1e6) + 'M</span>' +
  '</div>';
}).join('');

var resistRows = (d.topResistance || []).map(function(s) {
  var pct = ((s.strike - spot) / spot * 100).toFixed(1);
  return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0d1f2d">' +
    '<span class="mono" style="color:#39ff14;font-weight:700">' + s.strike + '</span>' +
    '<span style="color:#4a6070;font-size:11px">+' + pct + '%</span>' +
    '<span class="mono" style="color:#39ff14;font-size:11px">+$' + Math.round(s.netGEX/1e6) + 'M</span>' +
  '</div>';
}).join('');

res.innerHTML =
  '<div style="padding:16px 20px;border-top:1px solid #1a2535;background:#070a0f">' +
    '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px">' +
      '<div style="padding:12px 16px;background:#111820;border-radius:8px;border-left:3px solid ' + d.regimeColor + '">' +
        '<div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">REGIME @ ' + spot + '</div>' +
        '<div class="mono" style="font-size:22px;font-weight:700;color:' + d.regimeColor + '">' + d.regime + '</div>' +
        '<div style="font-size:11px;color:#8aa0b0;margin-top:4px">' + d.regimeDesc + '</div>' +
      '</div>' +
      '<div style="padding:12px 16px;background:#111820;border-radius:8px;border-left:3px solid #ffd166">' +
        '<div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">GEX FLIP</div>' +
        '<div class="mono" style="font-size:22px;font-weight:700;color:#ffd166">' + (d.flipPoint || 'N/A') + '</div>' +
        '<div style="font-size:11px;color:#8aa0b0;margin-top:4px">' + (flipAbove ? 'Spot BELOW flip — negative gamma' : 'Spot ABOVE flip — positive gamma') + '</div>' +
      '</div>' +
      '<div style="padding:12px 16px;background:#111820;border-radius:8px;border-left:3px solid ' + gapCol + '">' +
        '<div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">VS CLOSE</div>' +
        '<div class="mono" style="font-size:22px;font-weight:700;color:' + gapCol + '">' + (gapPct >= 0 ? '+' : '') + gapPct + '%</div>' +
        '<div style="font-size:11px;color:#8aa0b0;margin-top:4px">' + gapDir + ' from close</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
      '<div>' +
        '<div style="font-size:10px;color:#39ff14;letter-spacing:2px;margin-bottom:8px">&#9650; RESISTANCE ABOVE ' + spot + '</div>' +
        (resistRows || '<div style="color:#4a6070;font-size:12px">None in range</div>') +
      '</div>' +
      '<div>' +
        '<div style="font-size:10px;color:#ff2d55;letter-spacing:2px;margin-bottom:8px">&#9660; SUPPORT BELOW ' + spot + '</div>' +
        (supportRows || '<div style="color:#4a6070;font-size:12px">None in range</div>') +
      '</div>' +
    '</div>' +
  '</div>';
```

})
.catch(function(e) { msg.textContent = ‘Failed: ’ + e.message; msg.style.color=’#ff2d55’; });
}
function clearPM() {
document.getElementById(‘pm-price’).value = ‘’;
document.getElementById(‘pm-result’).innerHTML = ‘’;
document.getElementById(‘pm-msg’).textContent = ‘’;
}
function triggerScan(btn) {
btn.disabled = true; btn.textContent = ‘Scanning…’;
fetch(’/api/scan’, { method: ‘POST’ }).then(function() {
var secs = 120;
var iv = setInterval(function() {
secs–;
btn.textContent = ‘Scanning… ’ + secs + ‘s’;
if (secs <= 0) { clearInterval(iv); location.reload(); }
}, 1000);
setTimeout(function() { clearInterval(iv); location.reload(); }, 120000);
}).catch(function() { btn.disabled = false; btn.textContent = ‘▶ Run Now’; });
}
function testPush(btn) {
btn.disabled = true; btn.textContent = ‘Sending…’;
fetch(’/api/test-push’, { method: ‘POST’ }).then(function(r) { return r.json(); }).then(function(d) {
btn.textContent = d.status === 1 ? ‘Sent!’ : ‘Failed’;
setTimeout(function() { btn.disabled = false; btn.textContent = ‘🔔 Test Alert’; }, 3000);
}).catch(function() { btn.disabled = false; btn.textContent = ‘🔔 Test Alert’; });
}
function refreshCTA(btn) {
btn.disabled = true; btn.textContent = ‘Refreshing…’;
fetch(’/api/cta/refresh’, { method: ‘POST’ }).then(function() {
var secs = 30;
var iv = setInterval(function() {
secs–;
btn.textContent = ’Refreshing… ’ + secs + ‘s’;
if (secs <= 0) { clearInterval(iv); location.reload(); }
}, 1000);
setTimeout(function() { clearInterval(iv); location.reload(); }, 30000);
}).catch(function() { btn.disabled = false; btn.textContent = ‘\u21BB Refresh CTA’; });
}
// Auto-refresh every 5 min
setTimeout(function() { location.reload(); }, 300000);
</script>

</body></html>`;
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
http.createServer(async function(req, res) {
const url = req.url.split(’?’)[0];

// ─── CTA routes ─────────────────────────────────────────────────────────────
if (req.method === ‘GET’ && url === ‘/api/cta’) {
res.writeHead(200, { ‘Content-Type’: ‘application/json’, ‘Cache-Control’: ‘no-store’ });
res.end(JSON.stringify(ctaState || { loading: true, running: ctaRunning }));
return;
}
if (req.method === ‘POST’ && url === ‘/api/cta/refresh’) {
res.writeHead(200, { ‘Content-Type’: ‘application/json’ });
res.end(JSON.stringify({ ok: true, running: ctaRunning }));
if (!ctaRunning) refreshCTA();
return;
}
if (req.method === ‘GET’ && url === ‘/api/cta/score’) {
res.writeHead(200, { ‘Content-Type’: ‘application/json’, ‘Cache-Control’: ‘no-store’ });
res.end(JSON.stringify({
composite: ctaState ? ctaState.composite : null,
state: ctaState ? ctaState.compositeState : ‘unknown’,
timestamp: ctaState ? ctaState.timestamp : null,
}));
return;
}

if (req.method === ‘POST’ && url === ‘/api/scan’) {
res.writeHead(200, { ‘Content-Type’: ‘application/json’ });
res.end(JSON.stringify({ ok: true }));
if (!gexRunning) runGEXScan(‘Manual’);
return;
}
if (req.method === ‘GET’ && url === ‘/api/gex’) {
res.writeHead(200, { ‘Content-Type’: ‘application/json’, ‘Cache-Control’: ‘no-store’ });
res.end(JSON.stringify(gexData || { loading: true }));
return;
}
if (req.method === ‘POST’ && url === ‘/api/recalc’) {
let body = ‘’;
req.on(‘data’, function(d) { body += d; });
req.on(‘end’, async function() {
try {
const { spotPrice } = JSON.parse(body);
const spot = parseFloat(spotPrice);
if (!spot || isNaN(spot) || spot < 1000 || spot > 20000) {
res.writeHead(400, { ‘Content-Type’: ‘application/json’ });
res.end(JSON.stringify({ error: ‘Invalid spot price’ }));
return;
}
if (!gexData || !gexData.spxGEX || !gexData.spyGEX) {
res.writeHead(400, { ‘Content-Type’: ‘application/json’ });
res.end(JSON.stringify({ error: ‘No GEX data yet — run a scan first’ }));
return;
}
log(‘info’, ’Pre-market recalc at spot: ’ + spot);

```
    // Recalculate using cached contracts but new spot price
    // We re-run combineGEX with the new spot as reference
    const spxGEX2 = Object.assign({}, gexData.spxGEX, { spotPrice: spot });
    const spySpot2 = spot / 10; // SPY is ~1/10 SPX
    const spyGEX2  = Object.assign({}, gexData.spyGEX, { spotPrice: spySpot2 });

    // Refilter strikes within 20% of new spot
    const filterStrikes = function(strikes, newSpot) {
      return strikes.filter(function(s) {
        return Math.abs(s.strike - newSpot) / newSpot <= 0.20;
      });
    };

    spxGEX2.strikes = filterStrikes(gexData.spxGEX.strikes, spot);
    spyGEX2.strikes = filterStrikes(gexData.spyGEX.strikes, spySpot2);

    const recalcData = combineGEX(spxGEX2, spyGEX2);
    if (!recalcData) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recalc failed' }));
      return;
    }

    recalcData.spotPrice  = spot;
    recalcData.ts         = new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true });
    recalcData.runLabel   = 'Pre-Market @ ' + spot;
    recalcData.premarket  = true;
    recalcData.originalClose = gexData.spotPrice;

    // Re-sort support/resistance relative to new spot
    const byMag = recalcData.strikes.slice().sort(function(a, b) { return b.magnitude - a.magnitude; });
    recalcData.topResistance = byMag.filter(function(s) { return s.netGEX > 0 && s.strike >= spot; }).slice(0, 5);
    recalcData.topSupport    = byMag.filter(function(s) { return s.netGEX < 0 && s.strike <= spot; }).slice(0, 5);
    recalcData.topLevels     = byMag.slice(0, 10);

    log('ok', 'Pre-market recalc done — regime: ' + recalcData.regime + ' flip: ' + recalcData.flipPoint + ' spot: ' + spot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recalcData));
  } catch(e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});
return;
```

}

if (req.method === ‘POST’ && url === ‘/api/test-push’) {
const result = await sendPushover(‘GEX Test’, ‘Pushover working for GEX Scanner!’, 0);
res.writeHead(200, { ‘Content-Type’: ‘application/json’ });
res.end(JSON.stringify(result));
return;
}

res.writeHead(200, { ‘Content-Type’: ‘text/html; charset=utf-8’, ‘Cache-Control’: ‘no-store’ });
res.end(renderHTML());

}).listen(PORT, ‘0.0.0.0’, function() {
log(‘info’, ’GEX Scanner running on port ’ + PORT);
});

// ─── START ────────────────────────────────────────────────────────────────────
log(‘info’, ‘GEX Scanner starting…’);
log(‘info’, ‘Tradier: ’ + (CONFIG.tradierToken ? CONFIG.tradierToken.slice(0,8)+’…’ : ‘NOT SET’));
log(‘info’, ’Pushover: ’ + (CONFIG.pushoverUser ? ‘OK’ : ‘NOT SET’));
startScheduler();
// Run scan 5s after startup
setTimeout(function() { runGEXScan(‘Startup’); }, 5000);
// Start CTA polling 10s after startup
startCTAPolling();