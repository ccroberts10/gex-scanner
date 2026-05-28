#!/usr/bin/env node
'use strict';

const cron = require('node-cron');
const http = require('http');

try { require('dotenv').config(); } catch(e) {}

let fetch;
try { fetch = require('node-fetch'); if (fetch.default) fetch = fetch.default; }
catch(e) { fetch = global.fetch; }

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  tradierToken:    (process.env.TRADIER_TOKEN      || '').replace(/^["']|["']$/g, '').trim(),
  alpacaKey:       (process.env.ALPACA_KEY         || process.env.APCA_API_KEY_ID     || '').trim(),
  alpacaSecret:    (process.env.ALPACA_SECRET      || process.env.APCA_API_SECRET_KEY || '').trim(),
  pushoverUser:    (process.env.PUSHOVER_USER_KEY  || '').replace(/^["']|["']$/g, '').trim(),
  pushoverToken:   (process.env.PUSHOVER_APP_TOKEN || '').replace(/^["']|["']$/g, '').trim(),
  anthropicKey:    (process.env.ANTHROPIC_API_KEY  || '').replace(/^["']|["']$/g, '').trim(),
};
const PORT = process.env.PORT || 8081;

// ─── LOGGING ──────────────────────────────────────────────────────────────────
const logLines = [];
function log(type, msg) {
  const time = new Date().toISOString();
  const icons = { ok: '✓', warn: '⚠', err: '✗', info: '·' };
  console.log('[' + time + '] ' + (icons[type] || '·') + ' ' + msg);
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
      priority: String(priority), sound: 'cashregister',
    });
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json();
    if (data.status === 1) log('ok', 'Pushover sent: ' + title.slice(0, 60));
    return data;
  } catch(e) { log('warn', 'Pushover failed: ' + e.message); return { status: 0 }; }
}

// ─── GEX SCANNER (inline from gexScanner.js) ─────────────────────────────────
let gexData    = null;
let gexRunning = false;
let gexLastRun = null;

async function fetchSpot(symbol) {
  try {
    if (symbol === 'SPX') {
      // SPX index is not available on Alpaca IEX feed — derive from SPY*10
      // Try Tradier first since it has SPX directly
      if (CONFIG.tradierToken) {
        try {
          const r = await fetch('https://api.tradier.com/v1/markets/quotes?symbols=SPX',
            { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } });
          if (r.ok) {
            const j = await r.json();
            const q = j.quotes && j.quotes.quote;
            if (q && q.last) { log('info', 'Tradier spot SPX: ' + q.last); return parseFloat(q.last); }
          }
        } catch(e) { log('warn', 'Tradier SPX spot failed: ' + e.message); }
      }
      // Fallback: derive SPX from SPY * 10
      const spyPrice = await fetchSpot('SPY');
      if (spyPrice) {
        const spxEstimate = Math.round(spyPrice * 10 * 100) / 100;
        log('info', 'SPX estimated from SPY*10: ' + spxEstimate);
        return spxEstimate;
      }
      return null;
    }

    // For SPY and other ETFs — use Alpaca snapshot (most reliable)
    const url = 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(symbol) + '/snapshot?feed=iex';
    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': CONFIG.alpacaKey, 'APCA-API-SECRET-KEY': CONFIG.alpacaSecret, 'Accept': 'application/json' }
    });
    if (res.ok) {
      const json = await res.json();
      const price = json && json.latestTrade && json.latestTrade.p ? parseFloat(json.latestTrade.p) :
                    json && json.latestQuote && json.latestQuote.ap ? parseFloat(json.latestQuote.ap) : null;
      if (price) { log('info', 'Alpaca spot ' + symbol + ': ' + price); return price; }
    }
    // Fallback: Alpaca latest trade
    const url2 = 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(symbol) + '/trades/latest?feed=iex';
    const res2 = await fetch(url2, {
      headers: { 'APCA-API-KEY-ID': CONFIG.alpacaKey, 'APCA-API-SECRET-KEY': CONFIG.alpacaSecret, 'Accept': 'application/json' }
    });
    if (res2.ok) {
      const json2 = await res2.json();
      const price2 = json2 && json2.trade && json2.trade.p ? parseFloat(json2.trade.p) : null;
      if (price2) { log('info', 'Alpaca trade ' + symbol + ': ' + price2); return price2; }
    }
    // Final fallback: Tradier
    if (CONFIG.tradierToken) {
      const res3 = await fetch('https://api.tradier.com/v1/markets/quotes?symbols=' + symbol,
        { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } });
      if (res3.ok) {
        const json3 = await res3.json();
        const q = json3.quotes && json3.quotes.quote;
        if (q && q.last) return parseFloat(q.last);
      }
    }
    return null;
  } catch(e) { log('warn', 'fetchSpot ' + symbol + ': ' + e.message); return null; }
}

async function fetchChainForGEX(symbol) {
  const results = [];
  try {
    const expRes = await fetch(
      'https://api.tradier.com/v1/markets/options/expirations?symbol=' + symbol + '&includeAllRoots=true',
      { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
    );
    if (!expRes.ok) {
      const errBody = await expRes.text().catch(function() { return ''; });
      log('err', symbol + ' expirations HTTP ' + expRes.status + ': ' + errBody.slice(0, 200));
      return [];
    }
    const expJson = await expRes.json();
    const expirations = expJson.expirations && expJson.expirations.date;
    if (!expirations) {
      log('warn', symbol + ' no expirations in response: ' + JSON.stringify(expJson).slice(0, 200));
      return [];
    }

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
  } catch(e) { log('err', 'fetchChainForGEX ' + symbol + ': ' + e.message); return []; }
}

function calculateGEX(contracts, spotPrice) {
  if (!contracts || !contracts.length || !spotPrice) return null;
  const strikeMap = {};
  let totalGEX = 0, contractsUsed = 0, contractsSkipped = 0;

  contracts.forEach(function(o) {
    const gamma  = o.greeks && o.greeks.gamma ? parseFloat(o.greeks.gamma) : null;
    const oi     = o.open_interest ? parseInt(o.open_interest) : 0;
    const strike = o.strike ? parseFloat(o.strike) : null;
    const type   = (o.option_type || '').toLowerCase();

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
  });

  log('info', 'GEX: ' + contractsUsed + ' used / ' + contractsSkipped + ' skipped');

  const strikes = Object.values(strikeMap).map(function(s) {
    return {
      strike: s.strike, callGEX: Math.round(s.callGEX), putGEX: Math.round(s.putGEX),
      netGEX: Math.round(s.netGEX), callOI: s.callOI, putOI: s.putOI,
      magnitude: Math.abs(Math.round(s.netGEX)), direction: s.netGEX >= 0 ? 'positive' : 'negative',
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
  if      (totalGEX > 2e9)  { regime = 'STRONG PIN'; regimeColor = '#39ff14'; regimeDesc = 'Dealers long gamma — range-bound, fades work'; }
  else if (totalGEX > 0)    { regime = 'MILD PIN';   regimeColor = '#ffd166'; regimeDesc = 'Mild pinning — slow drift, fades likely to work'; }
  else if (totalGEX > -2e9) { regime = 'MILD TREND'; regimeColor = '#ff6b35'; regimeDesc = 'Slight negative GEX — trending possible, breakouts can extend'; }
  else                       { regime = 'TRENDING';   regimeColor = '#ff2d55'; regimeDesc = 'Dealers short gamma — volatile, trending, breakouts extend'; }

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
             totalOI: s.callOI + s.putOI, magnitude: Math.abs(Math.round(s.netGEX)), direction: s.netGEX >= 0 ? 'positive' : 'negative' };
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
  if      (totalGEX > 2e9)  { regime = 'STRONG PIN'; regimeColor = '#39ff14'; regimeDesc = 'Dealers long gamma — range-bound, fades work'; }
  else if (totalGEX > 0)    { regime = 'MILD PIN';   regimeColor = '#ffd166'; regimeDesc = 'Mild pinning — slow drift'; }
  else if (totalGEX > -2e9) { regime = 'MILD TREND'; regimeColor = '#ff6b35'; regimeDesc = 'Trending possible — breakouts can extend'; }
  else                       { regime = 'TRENDING';   regimeColor = '#ff2d55'; regimeDesc = 'Dealers short gamma — volatile, trending session'; }

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
      label: b.low === b.high ? String(b.low) : b.low + '-' + b.high,
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
      label: b.low === b.high ? String(b.low) : b.low + '-' + b.high,
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
  if (!CONFIG.anthropicKey) { log('warn', 'No ANTHROPIC_API_KEY — skipping AI recap'); return; }
  try {
    const spot     = data.spotPrice;
    const flip     = data.flipPoint || 'unknown';
    const spyFlip  = data.spyGEX && data.spyGEX.flipPoint ? data.spyGEX.flipPoint : null;
    const ptsToFlip = data.flipPoint ? (data.flipPoint - spot).toFixed(0) : null;

    const supportStr = (data.topSupport || []).slice(0, 4).map(function(s) {
      return s.strike + ' ($' + Math.round(s.netGEX / 1e6) + 'M)';
    }).join(', ');
    const resistStr = (data.topResistance || []).slice(0, 4).map(function(s) {
      return s.strike + ' ($' + Math.round(s.netGEX / 1e6) + 'M)';
    }).join(', ');

    const mkt = data.marketContext || {};
    const em0 = mkt.expectedMoves && mkt.expectedMoves[0];
    const em1 = mkt.expectedMoves && mkt.expectedMoves[1];
    const controlBandStr = (data.topControlBands || []).slice(0,2).map(function(b) {
      return b.label + ' (+' + b.totalGEXB + 'B, ' + (b.aboveSpot ? 'resistance' : b.belowSpot ? 'support' : 'at spot') + ')';
    }).join(', ');

    // Pull CTA data if available
    var ctaContext = '';
    try {
      if (ctaState && ctaState.composite !== null && ctaState.composite !== undefined) {
        var spyTrig = (ctaState.triggers || []).slice(0, 2).map(function(t) {
          return t.lookback + 'd MA at $' + t.level + ' (' + (t.distancePct >= 0 ? '+' : '') + t.distancePct + '%, ~$' + t.estimatedFlowB + 'B flow if broken)';
        }).join('; ');
        ctaContext = '\nCTA (Trend-Follower) POSITIONING:\nComposite Score: ' + (ctaState.composite > 0 ? '+' : '') + ctaState.composite + ' (' + ctaState.compositeState + ')\nInterpretation: ' + ctaState.interpretation + '\nNearest SPY Triggers: ' + (spyTrig || 'none');
      }
    } catch(ctaErr) { /* skip */ }

    const prompt = [
      'You are a derivatives market analyst. Write a precise trading recap based on this GEX + market data.',
      '',
      '=== GEX DATA ===',
      'Regime: ' + data.regime + ' — ' + data.regimeDesc,
      'Net GEX: ' + (data.netGEXBillions >= 0 ? '+' : '') + data.netGEXBillions + 'B',
      'SPX Spot: ' + spot,
      'SPX GEX Flip: ' + flip + (ptsToFlip ? ' (' + (ptsToFlip > 0 ? '+' : '') + ptsToFlip + ' pts from spot)' : ''),
      spyFlip ? 'SPY GEX Flip: ' + spyFlip + ' (SPX equiv ~' + Math.round(spyFlip * 10) + ')' : '',
      'Key Resistance: ' + (resistStr || 'none'),
      'Key Support: ' + (supportStr || 'none'),
      controlBandStr ? 'Control Bands: ' + controlBandStr : '',
      '',
      '=== MARKET CONTEXT ===',
      mkt.vix != null ? 'VIX: ' + mkt.vix + ' (' + mkt.vixRegime + ')' + (mkt.vixChange != null ? ', ' + (mkt.vixChange >= 0 ? '+' : '') + mkt.vixChange + '% today' : '') : '',
      mkt.pcRatio != null ? 'Put/Call Ratio: ' + mkt.pcRatio + ' — ' + mkt.pcSentiment : '',
      em0 ? '0DTE Expected Move: +/-' + em0.emPoints + ' pts (' + em0.emPct + '%) — 1-sigma range ' + em0.loTarget + ' to ' + em0.hiTarget : '',
      em1 ? 'Next Expiry EM: +/-' + em1.emPoints + ' pts — 1-sigma range ' + em1.loTarget + ' to ' + em1.hiTarget : '',
      mkt.fomcWarning ? 'HIGH IMPACT EVENT TODAY: ' + mkt.fomcWarning : '',
      ctaContext,
      '',
      'Write exactly 5 sentences. No markdown, no headers, no bold, no bullet points. Plain English paragraphs only. Be specific with price levels.',
      'Sentence 1: Regime + VIX context — what type of session is this and what does the GEX environment mean for how moves will behave today?',
      'Sentence 2: Key GEX levels — name the specific resistance and support strikes, their GEX magnitude, and whether any aligns with the expected move boundary.',
      'Sentence 3: P/C ratio + flip point — what is dealer positioning saying and how far must price travel to flip dealer behavior?',
      'Sentence 4: What CTA positioning adds -- are trend-followers crowded, and do their nearest MA trigger levels agree or disagree with GEX levels? Call out DOUBLE-CONFIRMED levels.',
      mkt.fomcToday ?
        'Sentence 5 (ACTIONABLE): FOMC-specific -- when to trade, debit spreads only, entry zone and target using GEX + expected move. Name exact price levels.' :
        'Sentence 5 (ACTIONABLE): Direct trade instruction integrating GEX + CTA -- entry zone, target, stop, structure. Be blunt.',
    ].filter(Boolean).join('\n');

    const ctrl = new AbortController();
    const tid  = setTimeout(function() { ctrl.abort(); }, 20000);
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800,
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
  } catch(e) {
    log('warn', 'GEX AI recap failed: ' + e.message);
  }
}


// ─── MARKET CONTEXT (VIX, P/C, Expected Move, FOMC) ─────────────────────────
async function fetchMarketContext(spxSpot, spySpot) {
  const ctx = {};
  if (!CONFIG.tradierToken) { log('warn', 'Tradier token not set — skipping market context'); return ctx; }

  // ── VIX ──────────────────────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.tradier.com/v1/markets/quotes?symbols=VIX', {
      headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' }
    });
    if (r.ok) {
      const j = await r.json();
      const q = j.quotes && j.quotes.quote;
      if (q && q.last) {
        ctx.vix = parseFloat(q.last);
        ctx.vixChange = q.prevclose ? parseFloat(((q.last - q.prevclose) / q.prevclose * 100).toFixed(2)) : null;
        ctx.vixRegime = ctx.vix >= 30 ? 'HIGH FEAR' : ctx.vix >= 20 ? 'ELEVATED' : ctx.vix < 15 ? 'COMPLACENT' : 'NORMAL';
        log('info', 'VIX: ' + ctx.vix + ' (' + ctx.vixRegime + ')');
      }
    }
  } catch(e) { log('warn', 'VIX fetch: ' + e.message); }

  // ── Put/Call Ratio (SPY chain) ────────────────────────────────────────────
  try {
    const expRes = await fetch('https://api.tradier.com/v1/markets/options/expirations?symbol=SPY&includeAllRoots=true', {
      headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' }
    });
    if (expRes.ok) {
      const expJson = await expRes.json();
      const exps = expJson.expirations && expJson.expirations.date;
      const expList = Array.isArray(exps) ? exps.slice(0, 3) : [exps];
      let callVol = 0, putVol = 0;
      for (const exp of expList) {
        const chainRes = await fetch(
          'https://api.tradier.com/v1/markets/options/chains?symbol=SPY&expiration=' + exp + '&greeks=false',
          { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
        );
        if (!chainRes.ok) continue;
        const chainJson = await chainRes.json();
        const opts = chainJson.options && chainJson.options.option;
        if (!opts) continue;
        let cv = 0, pv = 0;
        opts.forEach(function(o) {
          if (o.option_type === 'call') cv += (o.volume || 0);
          if (o.option_type === 'put')  pv += (o.volume || 0);
        });
        if (cv + pv > 0) { callVol = cv; putVol = pv; break; }
      }
      if (callVol + putVol > 0) {
        ctx.pcRatio = parseFloat((putVol / callVol).toFixed(3));
        ctx.pcSentiment = ctx.pcRatio > 1.3 ? 'EXTREME FEAR / CONTRARIAN BULLISH' :
                          ctx.pcRatio > 1.0 ? 'ELEVATED PUTS / MILD FEAR' :
                          ctx.pcRatio > 0.7 ? 'NEUTRAL' : 'CALL HEAVY / COMPLACENT';
        log('info', 'P/C: ' + ctx.pcRatio + ' (' + ctx.pcSentiment + ')');
      }
    }
  } catch(e) { log('warn', 'P/C fetch: ' + e.message); }

  // ── Expected Move (ATM straddle SPX 0DTE + next expiry) ──────────────────
  try {
    const expRes = await fetch('https://api.tradier.com/v1/markets/options/expirations?symbol=SPX&includeAllRoots=true', {
      headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' }
    });
    if (expRes.ok) {
      const expJson = await expRes.json();
      const exps = (expJson.expirations && expJson.expirations.date) || [];
      const expList = Array.isArray(exps) ? exps.slice(0, 3) : [exps];
      ctx.expectedMoves = [];
      for (const exp of expList) {
        try {
          const chainRes = await fetch(
            'https://api.tradier.com/v1/markets/options/chains?symbol=SPX&expiration=' + exp + '&greeks=false',
            { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
          );
          if (!chainRes.ok) continue;
          const chain = await chainRes.json();
          const opts  = (chain.options && chain.options.option) || [];
          const calls = opts.filter(function(o) { return o.option_type === 'call'; });
          const puts  = opts.filter(function(o) { return o.option_type === 'put'; });
          const atmCall = calls.reduce(function(best, o) {
            return (!best || Math.abs(o.strike - spxSpot) < Math.abs(best.strike - spxSpot)) ? o : best;
          }, null);
          const atmPut = atmCall && puts.find(function(o) { return o.strike === atmCall.strike; });
          if (atmCall && atmPut) {
            const callMid = ((atmCall.bid || 0) + (atmCall.ask || 0)) / 2;
            const putMid  = ((atmPut.bid  || 0) + (atmPut.ask  || 0)) / 2;
            const straddle = callMid + putMid;
            if (straddle > 0) {
              const today = new Date(); today.setHours(0,0,0,0);
              const expDate = new Date(exp + 'T00:00:00');
              const dte = Math.round((expDate - today) / (1000*60*60*24));
              const emPct = parseFloat((straddle / spxSpot * 100).toFixed(2));
              ctx.expectedMoves.push({
                expiry: exp, dte,
                straddle: parseFloat(straddle.toFixed(2)),
                emPoints: parseFloat(straddle.toFixed(0)),
                emPct,
                hiTarget: Math.round(spxSpot + straddle),
                loTarget: Math.round(spxSpot - straddle),
              });
              log('info', 'EM ' + exp + ' (DTE ' + dte + '): ±' + straddle.toFixed(0) + ' pts (' + emPct + '%)');
            }
          }
        } catch(e) { /* skip this expiry */ }
      }
    }
  } catch(e) { log('warn', 'Expected move fetch: ' + e.message); }

  // ── FOMC / High-Impact Event Detection ───────────────────────────────────
  // Check if today or tomorrow is a known high-impact date
  // FOMC 2026 dates — update annually
  const fomcDates = [
    '2026-01-28','2026-01-29',
    '2026-03-17','2026-03-18',
    '2026-04-28','2026-04-29',
    '2026-06-09','2026-06-10',
    '2026-07-28','2026-07-29',
    '2026-09-15','2026-09-16',
    '2026-11-03','2026-11-04',
    '2026-12-15','2026-12-16',
  ];
  const today = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  ctx.fomcToday    = fomcDates.includes(today);
  ctx.fomcTomorrow = fomcDates.includes(tomorrow);
  ctx.fomcWarning  = ctx.fomcToday ? 'FOMC DAY — expect pre-announcement compression, violent post-release expansion. No naked positions. Debit spreads only. Avoid new entries 13:30-14:00 ET.' :
                     ctx.fomcTomorrow ? 'FOMC TOMORROW — IV may be elevated today. Size down.' : null;
  if (ctx.fomcToday) log('warn', 'FOMC DAY DETECTED');

  return ctx;
}


// ─── PREMARKET HIGH/LOW (Alpaca 1-min bars) ──────────────────────────────────
async function fetchPremarketHighLow(symbol) {
  try {
    // 4:00am to 9:29am ET = 08:00 to 13:29 UTC
    const now = new Date();
    const todayDate = now.toISOString().slice(0, 10);
    const pmStart = todayDate + 'T08:00:00Z'; // 4am ET
    const pmEnd   = todayDate + 'T13:29:00Z'; // 9:29am ET

    const url = 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(symbol) +
      '/bars?start=' + encodeURIComponent(pmStart) +
      '&end='   + encodeURIComponent(pmEnd) +
      '&timeframe=1Min&limit=400&feed=iex&adjustment=raw';

    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': CONFIG.alpacaKey, 'APCA-API-SECRET-KEY': CONFIG.alpacaSecret, 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    const bars = json && json.bars;
    if (!bars || !bars.length) return null;

    let pmHigh = -Infinity, pmLow = Infinity;
    bars.forEach(function(b) {
      if (b.h > pmHigh) pmHigh = b.h;
      if (b.l < pmLow)  pmLow  = b.l;
    });
    if (pmHigh === -Infinity) return null;

    // SPY to SPX conversion if needed
    const mult = symbol === 'SPY' ? 10 : 1;
    return {
      high: Math.round(pmHigh * mult * 100) / 100,
      low:  Math.round(pmLow  * mult * 100) / 100,
      bars: bars.length,
    };
  } catch(e) { log('warn', 'fetchPremarketHighLow ' + symbol + ': ' + e.message); return null; }
}

// ─── FIBONACCI GRID (5-day swing) ────────────────────────────────────────────
async function fetchFibGrid(spotPrice) {
  try {
    // Get 6 days of SPY daily bars to find 5-day swing high/low
    const end = new Date();
    end.setMinutes(end.getMinutes() - 20);
    const start = new Date();
    start.setDate(start.getDate() - 10);

    const url = 'https://data.alpaca.markets/v2/stocks/SPY/bars' +
      '?start=' + encodeURIComponent(start.toISOString()) +
      '&end='   + encodeURIComponent(end.toISOString()) +
      '&timeframe=1Day&limit=10&feed=iex&adjustment=raw';

    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': CONFIG.alpacaKey, 'APCA-API-SECRET-KEY': CONFIG.alpacaSecret, 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    const bars = json && json.bars;
    if (!bars || bars.length < 3) return null;

    // Use last 5 trading days
    const recent = bars.slice(-5);
    let swingHigh = -Infinity, swingLow = Infinity;
    recent.forEach(function(b) {
      if (b.h > swingHigh) swingHigh = b.h;
      if (b.l < swingLow)  swingLow  = b.l;
    });

    // Convert SPY to SPX (×10)
    const hi = Math.round(swingHigh * 10 * 100) / 100;
    const lo = Math.round(swingLow  * 10 * 100) / 100;
    const range = hi - lo;

    // Fib retracement levels (from high down)
    const fibs = {
      swing_high: hi,
      swing_low:  lo,
      fib_236: Math.round((hi - range * 0.236) * 100) / 100,
      fib_382: Math.round((hi - range * 0.382) * 100) / 100,
      fib_500: Math.round((hi - range * 0.500) * 100) / 100,
      fib_618: Math.round((hi - range * 0.618) * 100) / 100,
      fib_786: Math.round((hi - range * 0.786) * 100) / 100,
      // Extension levels (from low up)
      ext_1272: Math.round((lo + range * 1.272) * 100) / 100,
      ext_1618: Math.round((lo + range * 1.618) * 100) / 100,
    };

    // Determine where spot sits
    let fibPosition = 'UNKNOWN';
    if (spotPrice >= hi)               fibPosition = 'ABOVE SWING HIGH — extended';
    else if (spotPrice >= fibs.fib_236) fibPosition = 'ABOVE 23.6% — strong bull';
    else if (spotPrice >= fibs.fib_382) fibPosition = 'ABOVE 38.2% — mild pullback';
    else if (spotPrice >= fibs.fib_500) fibPosition = 'AT 50% — equilibrium';
    else if (spotPrice >= fibs.fib_618) fibPosition = 'AT 61.8% OTE — buy zone';
    else if (spotPrice >= fibs.fib_786) fibPosition = 'AT 78.6% — deep retrace';
    else                                fibPosition = 'BELOW 78.6% — bearish';

    fibs.position = fibPosition;
    fibs.range = Math.round(range * 10 * 100) / 100; // in SPX points
    return fibs;
  } catch(e) { log('warn', 'fetchFibGrid: ' + e.message); return null; }
}

// ─── CONFLUENCE ZONE DETECTOR ─────────────────────────────────────────────────
// Finds price levels where GEX + Fib + EM all stack within 15 SPX points
function detectConfluenceZones(gexData, fibGrid, expectedMoves, spotPrice) {
  if (!gexData || !spotPrice) return [];

  const zones = [];
  const TOLERANCE = 15; // points — within this = confluence

  // Build list of significant levels
  const gexLevels = [];
  (gexData.topResistance || []).forEach(function(s) {
    gexLevels.push({ price: s.strike, type: 'GEX_RESIST', gexM: Math.round(s.netGEX / 1e6), label: 'GEX Resistance $' + Math.round(s.netGEX / 1e6) + 'M' });
  });
  (gexData.topSupport || []).forEach(function(s) {
    gexLevels.push({ price: s.strike, type: 'GEX_SUPPORT', gexM: Math.round(s.netGEX / 1e6), label: 'GEX Support $' + Math.round(s.netGEX / 1e6) + 'M' });
  });
  if (gexData.flipPoint) gexLevels.push({ price: gexData.flipPoint, type: 'GEX_FLIP', label: 'GEX Flip Point' });

  const fibLevels = fibGrid ? [
    { price: fibGrid.fib_236, label: 'Fib 23.6%' },
    { price: fibGrid.fib_382, label: 'Fib 38.2%' },
    { price: fibGrid.fib_500, label: 'Fib 50% (Equilibrium)' },
    { price: fibGrid.fib_618, label: 'Fib 61.8% OTE' },
    { price: fibGrid.fib_786, label: 'Fib 78.6%' },
    { price: fibGrid.ext_1272, label: 'Fib Ext 127.2%' },
    { price: fibGrid.ext_1618, label: 'Fib Ext 161.8%' },
    { price: fibGrid.swing_high, label: '5D Swing High' },
    { price: fibGrid.swing_low,  label: '5D Swing Low' },
  ] : [];

  const emLevels = [];
  (expectedMoves || []).slice(0, 2).forEach(function(em) {
    emLevels.push({ price: em.hiTarget, label: '1σ EM High (' + em.expiry + ')' });
    emLevels.push({ price: em.loTarget, label: '1σ EM Low ('  + em.expiry + ')' });
    // 1.5σ and 2σ
    const emPts = em.emPoints;
    emLevels.push({ price: Math.round(spotPrice + emPts * 1.5), label: '1.5σ EM High (' + em.expiry + ')' });
    emLevels.push({ price: Math.round(spotPrice - emPts * 1.5), label: '1.5σ EM Low ('  + em.expiry + ')' });
    emLevels.push({ price: Math.round(spotPrice + emPts * 2),   label: '2σ EM High ('   + em.expiry + ')' });
    emLevels.push({ price: Math.round(spotPrice - emPts * 2),   label: '2σ EM Low ('    + em.expiry + ')' });
  });

  // For each GEX level, check if any fib or EM level is within tolerance
  gexLevels.forEach(function(gex) {
    const confluences = [];
    const allOther = fibLevels.concat(emLevels);
    allOther.forEach(function(other) {
      if (Math.abs(other.price - gex.price) <= TOLERANCE) {
        confluences.push(other.label + ' (' + other.price + ')');
      }
    });

    if (confluences.length >= 1) {
      const aboveSpot = gex.price > spotPrice;
      const isGEXResist = gex.type === 'GEX_RESIST';
      const isGEXSupport = gex.type === 'GEX_SUPPORT';
      const strength = confluences.length >= 2 ? 'TRIPLE CONFLUENCE' : 'DOUBLE CONFLUENCE';
      const strengthColor = confluences.length >= 2 ? '#ff6b35' : '#ffd166';

      // Determine trade setup
      let setup = '', setupColor = '#d8eaf5', buyOrSell = '';
      if (aboveSpot && isGEXResist) {
        setup = 'FADE / SHORT SETUP — sell into resistance';
        setupColor = '#ff2d55';
        buyOrSell = 'SELL';
      } else if (!aboveSpot && isGEXSupport) {
        setup = 'BUY THE DIP — long at support';
        setupColor = '#39ff14';
        buyOrSell = 'BUY';
      } else if (gex.type === 'GEX_FLIP') {
        setup = aboveSpot ? 'RECLAIM TARGET — regime change if breached' : 'FLIP ZONE — dealers change behavior here';
        setupColor = '#ffd166';
        buyOrSell = aboveSpot ? 'WATCH' : 'WATCH';
      }

      // Trade structure based on GEX regime
      const regime = gexData.regime || '';
      let structure = '';
      if (buyOrSell === 'SELL') {
        structure = regime === 'TRENDING' ?
          'Bear put spread (debit) — trending regime, buy premium' :
          'Sell call spread (credit) or buy puts — pinning regime';
      } else if (buyOrSell === 'BUY') {
        structure = regime === 'TRENDING' ?
          'Bull call spread (debit) — trending regime, buy premium' :
          'Sell put spread (credit) or buy calls — pinning regime';
      }

      zones.push({
        price: gex.price,
        aboveSpot,
        buyOrSell,
        strength,
        strengthColor,
        confluenceCount: confluences.length + 1, // +1 for GEX itself
        gexLabel: gex.label,
        confluences,
        setup,
        setupColor,
        structure,
        ptsFromSpot: Math.round(gex.price - spotPrice),
      });
    }
  });

  // Sort: above spot ascending, below spot descending
  zones.sort(function(a, b) {
    if (a.aboveSpot && !b.aboveSpot) return -1;
    if (!a.aboveSpot && b.aboveSpot) return 1;
    if (a.aboveSpot) return a.price - b.price;
    return b.price - a.price;
  });

  return zones;
}

async function runGEXScan(label) {
  if (gexRunning) { log('warn', 'GEX already running'); return; }
  if (!CONFIG.alpacaKey && !CONFIG.tradierToken) { log('warn', 'No API credentials set'); return; }
  gexRunning = true;
  label = label || new Date().toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour12: true });
  log('info', '== GEX scan starting (' + label + ') ==');
  try {
    const [spxSpot, spySpot] = await Promise.all([fetchSpot('SPX'), fetchSpot('SPY')]);
    log('info', 'Spots — SPX: ' + spxSpot + '  SPY: ' + spySpot);

    const spxContracts = spxSpot ? await fetchChainForGEX('SPX') : [];
    const spyContracts = spySpot ? await fetchChainForGEX('SPY') : [];

    const spxGEX = spxContracts.length ? calculateGEX(spxContracts, spxSpot) : null;
    const spyGEX = spyContracts.length ? calculateGEX(spyContracts, spySpot) : null;

    if (spxGEX) log('ok', 'SPX GEX: ' + spxGEX.netGEXBillions + 'B | flip: ' + spxGEX.flipPoint);
    if (spyGEX) log('ok', 'SPY GEX: ' + spyGEX.netGEXBillions + 'B | flip: ' + spyGEX.flipPoint);

    const combined = combineGEX(spxGEX, spyGEX);

    // Fetch market context regardless of GEX success (FOMC, VIX etc still useful)
    const mktCtx = await fetchMarketContext(spxSpot, spySpot);

    // Fetch fib grid and premarket levels (Alpaca-based, always available)
    const fibGrid = await fetchFibGrid(spxSpot || (spySpot * 10));
    if (fibGrid) log('info', 'Fib grid: swing ' + fibGrid.swing_low + '-' + fibGrid.swing_high + ' | ' + fibGrid.position);

    const pmLevels = spySpot ? await fetchPremarketHighLow('SPY') : null;
    if (pmLevels) log('info', 'PM levels: high=' + pmLevels.high + ' low=' + pmLevels.low);

    if (!combined) {
      log('warn', 'GEX combination failed — options data unavailable (Tradier down?). CTA and market context will still update.');
      // Save a minimal placeholder so the dashboard shows something
      if (!gexData) {
        gexData = {
          spotPrice: spxSpot || 0, regime: 'UNAVAILABLE', regimeColor: '#4a6070',
          regimeDesc: 'Options data unavailable — check Tradier token or try again later.',
          netGEXBillions: 0, flipPoint: null, topSupport: [], topResistance: [],
          topLevels: [], nearSpotStrikes: [], topControlBands: [], topNegBands: [],
          strikes: [], marketContext: mktCtx, fibGrid: fibGrid, pmLevels: pmLevels,
          confluenceZones: [],
          ts: new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true }),
          runLabel: label, error: 'Options chain fetch failed',
        };
        gexLastRun = new Date().toISOString();
      }
    } else {
      combined.marketContext = mktCtx;
      combined.fibGrid   = fibGrid;
      combined.pmLevels  = pmLevels;
      // Detect confluence zones now that we have GEX + fib + EM
      combined.confluenceZones = detectConfluenceZones(
        combined, fibGrid,
        mktCtx && mktCtx.expectedMoves ? mktCtx.expectedMoves : [],
        combined.spotPrice
      );
      if (combined.confluenceZones && combined.confluenceZones.length) {
        log('ok', 'Confluence zones found: ' + combined.confluenceZones.length);
      }
      // Build conviction signal combining GEX + CTA
      combined.conviction = buildConvictionSignal(combined, ctaState, combined.spotPrice);
      if (combined.conviction) {
        log('ok', 'Conviction: ' + combined.conviction.emoji + ' ' + combined.conviction.setup + ' (' + combined.conviction.conviction + '%) — ' + combined.conviction.tradeType);
      }
      combined.ts       = new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true });
      combined.runLabel = label;
      gexData    = combined;
      gexLastRun = new Date().toISOString();
      log('ok', '== GEX complete — ' + combined.regime + ' | flip: ' + combined.flipPoint + ' | net: ' + combined.netGEXBillions + 'B ==');
      await generateGEXRecap(combined);
    }

    // AI Recap (now includes market context)
    // Pushover — only if combined succeeded
    if (!combined) { log('info', 'Skipping Pushover — no GEX data'); return; }
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
  } catch(e) {
    log('err', 'runGEXScan: ' + e.message);
  } finally {
    gexRunning = false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ─── CTA POSITIONING MODULE ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
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
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close));
    trs.push(tr);
  }
  let sum = 0;
  for (let i = trs.length - period; i < trs.length; i++) sum += trs[i];
  return sum / period;
}

function ctaTanh(x) {
  if (x > 20) return 1; if (x < -20) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

function ctaClassifyPosition(p) {
  if (p === null || p === undefined) return 'unknown';
  if (p >= 0.75) return 'max long'; if (p >= 0.25) return 'long';
  if (p >= -0.25) return 'neutral'; if (p >= -0.75) return 'short';
  return 'max short';
}

function ctaClassifyComposite(c) {
  if (c === null) return 'unknown';
  if (c >= 75) return 'max long crowded'; if (c >= 25) return 'long';
  if (c >= -25) return 'neutral'; if (c >= -75) return 'short';
  return 'max short crowded';
}

function ctaInterpret(c) {
  if (c === null) return 'No data yet.';
  if (c >= 75) return 'CTAs are crowded long. Mechanical downside risk if shorter MAs break -- they will be forced sellers into weakness.';
  if (c >= 25) return 'Net long positioning. Trend-followers supportive, but watch for MA breaks that could flip flow.';
  if (c >= -25) return 'Neutral. Low mechanical flow risk in either direction. Discretionary flow dominates.';
  if (c >= -75) return 'Net short positioning. Trend-followers pressuring lower, but vulnerable to short-cover squeeze on upside breaks.';
  return 'CTAs are crowded short. Significant squeeze risk on any meaningful upside break of shorter MAs.';
}

async function fetchCTABars(symbol, days) {
  // Uses Alpaca for historical daily bars — Tradier /markets/history endpoint
  // is not available on all token tiers. Alpaca free IEX feed is sufficient.
  const alpacaKey    = (process.env.ALPACA_KEY    || process.env.APCA_API_KEY_ID     || '').trim();
  const alpacaSecret = (process.env.ALPACA_SECRET || process.env.APCA_API_SECRET_KEY || '').trim();
  if (!alpacaKey || !alpacaSecret) throw new Error('ALPACA_KEY / ALPACA_SECRET not set');

  const end = new Date();
  end.setMinutes(end.getMinutes() - 20); // slight backoff to avoid edge-of-data issues
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(days * 1.6));

  const url = 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(symbol) + '/bars' +
    '?start=' + encodeURIComponent(start.toISOString()) +
    '&end='   + encodeURIComponent(end.toISOString()) +
    '&timeframe=1Day' +
    '&limit=1000' +
    '&adjustment=raw' +
    '&feed=iex';

  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     alpacaKey,
      'APCA-API-SECRET-KEY': alpacaSecret,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(function() { return ''; });
    throw new Error('Alpaca ' + symbol + ' HTTP ' + res.status + ': ' + errText.slice(0, 120));
  }
  const json = await res.json();
  const bars = json && json.bars;
  if (!bars || !Array.isArray(bars) || bars.length === 0) throw new Error('No history for ' + symbol);

  // Alpaca bar shape: { t: ISO timestamp, o, h, l, c, v, n, vw }
  return bars.map(function(b) {
    return {
      date:   b.t ? b.t.slice(0, 10) : '',
      open:   parseFloat(b.o),
      high:   parseFloat(b.h),
      low:    parseFloat(b.l),
      close:  parseFloat(b.c),
      volume: parseInt(b.v) || 0,
    };
  }).filter(function(b) { return !isNaN(b.close); });
}

function ctaCalculatePositioning(bars) {
  if (!bars || bars.length < 201) return { position: null, error: 'insufficient_history' };
  const closes = bars.map(function(b) { return b.close; });
  const currentPrice = closes[closes.length - 1];
  const atr20 = ctaATR(bars, 20);
  if (!atr20 || atr20 === 0) return { position: null, error: 'invalid_atr' };
  const momentum = {};
  let rawSignal = 0;
  for (const lb of CTA_LOOKBACKS) {
    const ma = ctaSMA(closes, lb.days);
    if (!ma) continue;
    const mom = (currentPrice - ma) / atr20;
    momentum[lb.days] = { ma, momentum: mom, pctFromMA: ((currentPrice - ma) / ma) * 100 };
    rawSignal += lb.weight * mom;
  }
  const position = ctaTanh(rawSignal / 3);
  return { position, positionPct: position * 100, momentum, currentPrice, atr20 };
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
      lookback: lb.days, level: Math.round(ma * 100) / 100,
      distance: Math.round(distance * 100) / 100,
      distancePct: Math.round(distancePct * 100) / 100,
      direction: currentPrice > ma ? 'sell_trigger' : 'buy_trigger',
      estimatedFlowB: Math.round(equityAUM * flowFraction * 10) / 10,
    });
  }
  return triggers.sort(function(a, b) { return Math.abs(a.distancePct) - Math.abs(b.distancePct); });
}

async function refreshCTA() {
  if (ctaRunning) { log('warn', 'CTA refresh already running'); return ctaState; }
  ctaRunning = true;
  log('info', '== CTA refresh starting ==');
  const errors = [], assets = [];
  let weightedPosition = 0, totalWeight = 0, spyTriggers = [];
  try {
    for (const asset of CTA_UNIVERSE) {
      try {
        const bars = await fetchCTABars(asset.symbol, 250);
        const pos = ctaCalculatePositioning(bars);
        if (pos.position === null) { errors.push(asset.symbol + ': ' + pos.error); continue; }
        assets.push({
          symbol: asset.symbol, name: asset.name, assetClass: asset.assetClass,
          weight: asset.weight, position: pos.position,
          positionPct: Math.round(pos.positionPct * 10) / 10,
          currentPrice: pos.currentPrice, momentum: pos.momentum,
          state: ctaClassifyPosition(pos.position),
        });
        weightedPosition += pos.position * asset.weight;
        totalWeight += asset.weight;
        if (asset.symbol === 'SPY') spyTriggers = ctaCalculateTriggers(bars, pos.currentPrice);
        await new Promise(function(r) { setTimeout(r, 250); });
      } catch(e) { errors.push(asset.symbol + ': ' + e.message); log('warn', 'CTA ' + asset.symbol + ': ' + e.message); }
    }
    const composite = totalWeight > 0 ? Math.round((weightedPosition / totalWeight) * 100 * 10) / 10 : null;
    const now = Date.now();
    let delta1d = null, delta1w = null;
    if (composite !== null) {
      const oneDayAgo  = ctaHistoricalScores.find(function(s) { return now - s.timestamp >= 23*3600000 && now - s.timestamp <= 25*3600000; });
      const oneWeekAgo = ctaHistoricalScores.find(function(s) { return now - s.timestamp >= 6.5*86400000 && now - s.timestamp <= 7.5*86400000; });
      if (oneDayAgo)  delta1d = Math.round((composite - oneDayAgo.composite) * 10) / 10;
      if (oneWeekAgo) delta1w = Math.round((composite - oneWeekAgo.composite) * 10) / 10;
      ctaHistoricalScores.push({ timestamp: now, composite });
      if (ctaHistoricalScores.length > 800) ctaHistoricalScores.shift();
    }
    ctaState = {
      timestamp: new Date().toISOString(),
      ts: new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true }),
      composite, compositeState: ctaClassifyComposite(composite),
      compositeDelta1d: delta1d, compositeDelta1w: delta1w,
      assets, triggers: spyTriggers,
      universe: CTA_UNIVERSE.length, universeFetched: assets.length,
      errors, interpretation: ctaInterpret(composite),
    };
    log('ok', '== CTA complete -- score: ' + composite + ' (' + ctaClassifyComposite(composite) + ') | ' + assets.length + '/' + CTA_UNIVERSE.length + ' assets ==');
  } catch(e) { log('err', 'CTA refresh failed: ' + e.message); } finally { ctaRunning = false; }
  return ctaState;
}

function startCTAPolling() {
  setTimeout(function() { refreshCTA(); }, 10000);
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
    return `<div class="card">
  <div class="card-head">
    <span class="card-title">&#128202; CTA Positioning Monitor</span>
    <span style="font-size:11px;color:#4a6070">Initializing -- refreshes every 30 min</span>
  </div>
  <div style="padding:60px;text-align:center;color:#4a6070">
    <div style="font-size:14px;margin-bottom:12px">CTA data loading...</div>
    <div style="font-size:12px">Trend-follower flow estimates across 10 asset classes</div>
    <div style="margin-top:20px"><button class="btn bp" onclick="refreshCTA(this)">&#9654; Refresh Now</button></div>
  </div>
</div>`;
  }
  let compColor = '#ffd166';
  if (d.composite >= 25) compColor = '#39ff14';
  else if (d.composite <= -25) compColor = '#ff2d55';
  if (Math.abs(d.composite) >= 75) compColor = '#ff6b35';
  const barFill = d.composite !== null ? Math.min(Math.abs(d.composite), 100) / 2 : 0;
  const barSide = d.composite >= 0 ? 'left:50%' : 'right:50%';

  const triggerRows = (d.triggers || []).map(function(t) {
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

  const assetRows = (d.assets || []).map(function(a) {
    let posCol = '#ffd166';
    if (a.positionPct >= 25) posCol = '#39ff14';
    else if (a.positionPct <= -25) posCol = '#ff2d55';
    if (Math.abs(a.positionPct) >= 75) posCol = '#ff6b35';
    const m20  = a.momentum && a.momentum[20]  ? a.momentum[20].pctFromMA  : null;
    const m50  = a.momentum && a.momentum[50]  ? a.momentum[50].pctFromMA  : null;
    const m200 = a.momentum && a.momentum[200] ? a.momentum[200].pctFromMA : null;
    const colorFor = function(v) { if (v === null || v === undefined) return '#4a6070'; if (v > 1) return '#39ff14'; if (v < -1) return '#ff2d55'; return '#ffd166'; };
    const fmtPct  = function(v) { return v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; };
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

  const errorBox = (d.errors && d.errors.length) ? `<div style="margin:0 20px 16px 20px;padding:10px 14px;background:rgba(255,45,85,0.08);border-left:3px solid #ff2d55;font-size:11px;color:#ff6b35;font-family:'Space Mono',monospace">${d.errors.map(function(e) { return '· ' + e; }).join('<br>')}</div>` : '';

  return `<div class="card">
  <div class="card-head">
    <span class="card-title">&#128202; CTA Positioning -- Trend-Follower Flow</span>
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
        <div class="mono" style="font-size:22px;font-weight:700;color:#d8eaf5">${d.compositeDelta1d !== null ? (d.compositeDelta1d > 0 ? '+' : '') + d.compositeDelta1d : '&mdash;'}</div>
      </div>
      <div>
        <div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:4px">1W &Delta;</div>
        <div class="mono" style="font-size:22px;font-weight:700;color:#d8eaf5">${d.compositeDelta1w !== null ? (d.compositeDelta1w > 0 ? '+' : '') + d.compositeDelta1w : '&mdash;'}</div>
      </div>
      <div style="margin-left:auto"><button class="btn bs" onclick="refreshCTA(this)">&#8635; Refresh CTA</button></div>
    </div>
    <div style="position:relative;height:24px;background:#070a0f;border-radius:4px;overflow:hidden;margin-bottom:14px">
      <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#1a2535"></div>
      <div style="position:absolute;top:0;bottom:0;width:${barFill}%;${barSide};background:${compColor};opacity:0.85;border-radius:3px"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:16px">
      <span>MAX SHORT -100</span><span>NEUTRAL 0</span><span>+100 MAX LONG</span>
    </div>
    <div style="padding:12px 16px;background:#111820;border-left:3px solid ${compColor};border-radius:0 6px 6px 0;font-size:13px;color:#8aa0b0">${d.interpretation}</div>
  </div>
</div>
<div class="card">
  <div class="card-head">
    <span class="card-title">&#127919; SPY Trigger Ladder -- Forced Flow Levels</span>
    <span style="font-size:11px;color:#4a6070">Sorted by proximity to current price</span>
  </div>
  <div>${triggerRows || '<div style="padding:30px;text-align:center;color:#4a6070;font-size:12px">No trigger data</div>'}</div>
</div>
<div class="card">
  <div class="card-head">
    <span class="card-title">&#128200; Per-Asset CTA Positioning</span>
    <span style="font-size:11px;color:#4a6070">Vol-normalized momentum across 20/50/100/200 day windows</span>
  </div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="color:#4a6070;font-size:10px;letter-spacing:1px;border-bottom:1px solid #1a2535">
        <td style="padding:8px 16px">SYMBOL</td><td style="padding:8px 16px">NAME</td>
        <td style="padding:8px 16px">CLASS</td><td style="padding:8px 16px;text-align:right">POSITION</td>
        <td style="padding:8px 16px;text-align:right">STATE</td><td style="padding:8px 16px;text-align:right">vs 20D</td>
        <td style="padding:8px 16px;text-align:right">vs 50D</td><td style="padding:8px 16px;text-align:right">vs 200D</td>
      </tr>
      ${assetRows}
    </table>
  </div>
  ${errorBox}
</div>`;
}


// ─── TICKER GEX SCANNER ──────────────────────────────────────────────────────
let tickerCache = {}; // { SYMBOL: { data, ts } }


// ─── EARNINGS PROXIMITY CHECK (Alpaca) ───────────────────────────────────────
async function fetchEarningsDate(symbol) {
  try {
    // Alpaca corporate actions / announcements endpoint
    const url = 'https://data.alpaca.markets/v1beta1/corporate-actions/announcements' +
      '?ca_types=Dividend&symbols=' + encodeURIComponent(symbol) +
      '&since=' + new Date().toISOString().slice(0,10);
    // Note: Alpaca doesn't have earnings dates directly — use Tradier options chain
    // to detect earnings proximity via IV skew. Alternatively use a known proxy:
    // if the nearest expiry IV is dramatically higher than next expiry, earnings are near.

    if (!CONFIG.tradierToken) return null;

    // Get two expiry chains and compare IV levels
    const expRes = await fetch(
      'https://api.tradier.com/v1/markets/options/expirations?symbol=' + symbol + '&includeAllRoots=true',
      { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
    );
    if (!expRes.ok) return null;
    const expJson = await expRes.json();
    const exps = expJson.expirations && expJson.expirations.date;
    if (!exps) return null;
    const expList = Array.isArray(exps) ? exps : [exps];
    if (expList.length < 2) return null;

    // Fetch ATM straddle for first two expiries
    const spot = null; // already have it in caller
    const ivData = [];
    for (const exp of expList.slice(0, 2)) {
      try {
        const chainRes = await fetch(
          'https://api.tradier.com/v1/markets/options/chains?symbol=' + symbol + '&expiration=' + exp + '&greeks=false',
          { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
        );
        if (!chainRes.ok) continue;
        const chain = await chainRes.json();
        const opts = (chain.options && chain.options.option) || [];
        // Get IV from options - use mid of all IVs as proxy
        const ivs = opts.filter(function(o) { return o.greeks && o.greeks.mid_iv && o.greeks.mid_iv > 0; })
                       .map(function(o) { return o.greeks.mid_iv; });
        if (ivs.length) {
          const avgIV = ivs.reduce(function(a,b) { return a+b; }, 0) / ivs.length;
          const today = new Date(); today.setHours(0,0,0,0);
          const expDate = new Date(exp + 'T00:00:00');
          const dte = Math.round((expDate - today) / (1000*60*60*24));
          ivData.push({ exp, dte, avgIV });
        }
        await new Promise(function(r) { setTimeout(r, 200); });
      } catch(e) { /* skip */ }
    }

    if (ivData.length < 2) return null;

    // Earnings signal: if near-term IV is >40% higher than next expiry IV (normalized for time)
    const near = ivData[0];
    const next = ivData[1];
    const ivRatio = near.avgIV / (next.avgIV || 1);
    const earningsSoon = ivRatio > 1.35 && near.dte <= 14;

    return {
      nearExpiry: near.exp,
      nearDTE: near.dte,
      nearIV: Math.round(near.avgIV * 100),
      nextExpiry: next.exp,
      nextIV: Math.round(next.avgIV * 100),
      ivRatio: Math.round(ivRatio * 100) / 100,
      earningsSoon,
      warning: earningsSoon ?
        'EARNINGS LIKELY WITHIN ' + near.dte + ' DAYS — IV elevated ' + Math.round((ivRatio-1)*100) + '% above next expiry. GEX less reliable. Avoid selling premium.' :
        null,
    };
  } catch(e) {
    log('warn', 'fetchEarningsDate ' + symbol + ': ' + e.message);
    return null;
  }
}

async function scanTickerGEX(symbol) {
  symbol = symbol.toUpperCase().trim();
  if (!symbol || symbol.length > 6) throw new Error('Invalid symbol');

  // Check cache — reuse if less than 15 min old
  const cached = tickerCache[symbol];
  if (cached && (Date.now() - cached.ts) < 15 * 60 * 1000) {
    log('info', 'Ticker cache hit: ' + symbol);
    return cached.data;
  }

  log('info', '== Ticker GEX scan: ' + symbol + ' ==');

  // 1. Get spot price
  const spotRes = await fetch('https://api.tradier.com/v1/markets/quotes?symbols=' + symbol,
    { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } });
  if (!spotRes.ok) throw new Error('Quote fetch failed: HTTP ' + spotRes.status);
  const spotJson = await spotRes.json();
  const q = spotJson.quotes && spotJson.quotes.quote;
  const spotPrice = q && q.last ? parseFloat(q.last) : null;
  if (!spotPrice) throw new Error('No price data for ' + symbol);

  // 2. Get expirations
  const expRes = await fetch(
    'https://api.tradier.com/v1/markets/options/expirations?symbol=' + symbol + '&includeAllRoots=true',
    { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
  );
  if (!expRes.ok) throw new Error('Expirations failed: HTTP ' + expRes.status);
  const expJson = await expRes.json();
  const expirations = expJson.expirations && expJson.expirations.date;
  if (!expirations) throw new Error('No options data for ' + symbol + ' — may not be optionable');

  const today  = new Date(); today.setHours(0,0,0,0);
  const cutoff = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  const expList = (Array.isArray(expirations) ? expirations : [expirations])
    .filter(function(e) { const d = new Date(e + 'T00:00:00'); return d >= today && d <= cutoff; })
    .slice(0, 4); // fewer expirations for speed

  log('info', symbol + ' scanning ' + expList.length + ' expirations at $' + spotPrice);

  // 3. Fetch chains
  const contracts = [];
  for (const exp of expList) {
    try {
      const chainRes = await fetch(
        'https://api.tradier.com/v1/markets/options/chains?symbol=' + symbol + '&expiration=' + exp + '&greeks=true',
        { headers: { 'Authorization': 'Bearer ' + CONFIG.tradierToken, 'Accept': 'application/json' } }
      );
      if (!chainRes.ok) continue;
      const chainJson = await chainRes.json();
      const opts = chainJson.options && chainJson.options.option;
      if (opts && opts.length) contracts.push(...opts);
      await new Promise(function(r) { setTimeout(r, 300); });
    } catch(e) { log('warn', symbol + ' chain ' + exp + ': ' + e.message); }
  }
  if (!contracts.length) throw new Error('No contracts fetched for ' + symbol);

  // 4. Calculate GEX
  const gex = calculateGEX(contracts, spotPrice);
  if (!gex) throw new Error('GEX calculation failed for ' + symbol);

  // 5. Call selling score (0-100)
  // High score = good environment for selling calls
  // Based on: positive GEX (+), low negative GEX magnitude, resistance above spot
  let callScore = 50;
  if (gex.netGEXBillions > 2)       callScore = 95; // STRONG PIN — ideal
  else if (gex.netGEXBillions > 0)   callScore = 75; // MILD PIN — good
  else if (gex.netGEXBillions > -1)  callScore = 45; // MILD TREND — marginal
  else if (gex.netGEXBillions > -3)  callScore = 25; // TRENDING — avoid
  else                                callScore = 10; // STRONG TREND — do not sell calls

  // Bonus: if nearest resistance is close overhead (natural cap)
  const nearestResist = gex.topResistance && gex.topResistance[0];
  if (nearestResist) {
    const pctAway = (nearestResist.strike - spotPrice) / spotPrice * 100;
    if (pctAway < 1.5) callScore = Math.min(callScore + 10, 100); // tight cap overhead
    if (pctAway > 5)   callScore = Math.max(callScore - 10, 0);   // resistance far away
  }

  // 6. Build recommended strikes (top resistance levels = best call strikes to sell)
  const callStrikes = (gex.topResistance || []).slice(0, 3).map(function(s) {
    const pctAway = ((s.strike - spotPrice) / spotPrice * 100).toFixed(1);
    const gexM = Math.round(s.netGEX / 1e6);
    return {
      strike: s.strike,
      pctAway: parseFloat(pctAway),
      gexM,
      recommendation: pctAway < 1 ? 'AT THE WALL — aggressive' :
                      pctAway < 2 ? 'NEAR THE WALL — preferred' :
                      pctAway < 4 ? 'SAFE DISTANCE — conservative' : 'FAR OTM — low premium',
    };
  });

  // 6b. Buy premium score (inverse of call selling — trending = buy premium)
  let buyScore = 100 - callScore; // base inverse
  // Fine-tune: TRENDING with strong momentum = best buy environment
  if (gex.netGEXBillions < -3)      buyScore = 95;
  else if (gex.netGEXBillions < -1) buyScore = 75;
  else if (gex.netGEXBillions < 0)  buyScore = 55;
  else if (gex.netGEXBillions < 2)  buyScore = 30;
  else                               buyScore = 10; // STRONG PIN = bad for buying premium

  const buyScoreLabel = buyScore >= 80 ? 'EXCELLENT — buy calls/puts with momentum' :
                        buyScore >= 60 ? 'GOOD — debit spreads favored' :
                        buyScore >= 40 ? 'MARGINAL — small size only' :
                        buyScore >= 20 ? 'POOR — pinning regime, premium decays fast' :
                                         'DO NOT BUY — dealers pinning, theta crush';
  const buyScoreColor = buyScore >= 80 ? '#39ff14' :
                        buyScore >= 60 ? '#ffd166' :
                        buyScore >= 40 ? '#ff6b35' : '#ff2d55';

  // Best levels to buy calls at (support levels = dip-buy entries in trending regime)
  const callBuyLevels = (gex.topSupport || []).slice(0, 3).map(function(s) {
    const pctAway = ((s.strike - spotPrice) / spotPrice * 100).toFixed(1);
    return {
      strike: s.strike,
      pctAway: parseFloat(pctAway),
      gexM: Math.abs(Math.round(s.netGEX / 1e6)),
      recommendation: Math.abs(parseFloat(pctAway)) < 1 ? 'AT SUPPORT — aggressive entry' :
                      Math.abs(parseFloat(pctAway)) < 3 ? 'NEAR SUPPORT — preferred entry' :
                                                           'DEEP SUPPORT — conservative entry',
    };
  });

  // 7. Score labels
  const scoreLabel = callScore >= 80 ? 'EXCELLENT — ideal for selling calls' :
                     callScore >= 60 ? 'GOOD — favorable for premium selling' :
                     callScore >= 40 ? 'MARGINAL — proceed with caution' :
                     callScore >= 20 ? 'POOR — trending regime, avoid selling calls' :
                                       'DO NOT SELL — dealers amplifying moves';
  const scoreColor = callScore >= 80 ? '#39ff14' :
                     callScore >= 60 ? '#ffd166' :
                     callScore >= 40 ? '#ff6b35' : '#ff2d55';

  // Earnings proximity check (runs in parallel with conviction)
  const earningsData = await fetchEarningsDate(symbol).catch(function() { return null; });
  if (earningsData && earningsData.earningsSoon) {
    log('warn', symbol + ' EARNINGS SOON — IV ratio: ' + earningsData.ivRatio + ' | DTE: ' + earningsData.nearDTE);
  }

  // Build ticker-specific conviction — pass ctaState directly so CTA composite is always current
  const tickerConviction = buildTickerConviction(gex, ctaState);

  const result = {
    symbol,
    spotPrice,
    ts: new Date().toLocaleString('en-US', { timeZone: 'America/Denver', hour12: true }),
    regime: gex.regime,
    regimeColor: gex.regimeColor,
    regimeDesc: gex.regimeDesc,
    netGEXBillions: gex.netGEXBillions,
    flipPoint: gex.flipPoint,
    callScore,
    scoreLabel,
    scoreColor,
    buyScore,
    buyScoreLabel,
    buyScoreColor,
    callStrikes,
    callBuyLevels,
    conviction: tickerConviction,
    earnings: earningsData,
    topResistance: gex.topResistance,
    topSupport: gex.topSupport,
    topLevels: gex.topLevels,
    contractsUsed: gex.contractsUsed,
  };

  // Cache it
  tickerCache[symbol] = { data: result, ts: Date.now() };
  log('ok', symbol + ' GEX done — score: ' + callScore + ' | regime: ' + gex.regime + ' | flip: ' + gex.flipPoint);
  return result;
}


// ─── CONVICTION SIGNAL ENGINE ─────────────────────────────────────────────────
// Cross-references GEX regime + CTA positioning + price vs flip point
// Returns a structured conviction signal with trade instruction

function buildConvictionSignal(gexData, ctaData, spotPrice) {
  if (!gexData || !spotPrice) return null;

  const netGEX      = gexData.netGEXBillions || 0;
  const flipPoint   = gexData.flipPoint || null;
  const regime      = gexData.regime || 'UNKNOWN';
  const composite   = ctaData && ctaData.composite !== null ? ctaData.composite : null;
  const aboveFlip   = flipPoint ? spotPrice > flipPoint : null;

  // ── Step 1: GEX signal ──────────────────────────────────────────────────────
  let gexSignal = 'NEUTRAL';
  let gexStrength = 0; // -3 to +3
  if      (netGEX > 2)   { gexSignal = 'PIN';        gexStrength = 3;  }
  else if (netGEX > 0)   { gexSignal = 'MILD_PIN';   gexStrength = 1;  }
  else if (netGEX > -2)  { gexSignal = 'MILD_TREND'; gexStrength = -1; }
  else                   { gexSignal = 'TREND';       gexStrength = -3; }

  // ── Step 2: CTA signal ──────────────────────────────────────────────────────
  let ctaSignal = 'NEUTRAL';
  let ctaStrength = 0; // -3 to +3
  if (composite !== null) {
    if      (composite >= 60)  { ctaSignal = 'CROWDED_LONG';  ctaStrength = 3;  }
    else if (composite >= 25)  { ctaSignal = 'LONG';          ctaStrength = 2;  }
    else if (composite >= -25) { ctaSignal = 'NEUTRAL';       ctaStrength = 0;  }
    else if (composite >= -60) { ctaSignal = 'SHORT';         ctaStrength = -2; }
    else                       { ctaSignal = 'CROWDED_SHORT'; ctaStrength = -3; }
  }

  // ── Step 3: Flip point context ──────────────────────────────────────────────
  let flipContext = 'UNKNOWN';
  let flipStrength = 0;
  if (aboveFlip === true)  { flipContext = 'ABOVE_FLIP'; flipStrength = 1;  }
  if (aboveFlip === false) { flipContext = 'BELOW_FLIP'; flipStrength = -1; }

  // ── Step 4: Combined conviction ─────────────────────────────────────────────
  // Add up all signals. Positive = bullish bias, negative = bearish bias
  const bullScore = ctaStrength + flipStrength;
  const isNegGEX  = gexStrength < 0;
  const isPosGEX  = gexStrength > 0;

  let setup = 'NEUTRAL';
  let conviction = 0; // 0-100
  let direction = 'NEUTRAL';
  let tradeType = '';
  let structure = '';
  let entry = '';
  let target = '';
  let stop = '';
  let color = '#ffd166';
  let emoji = '⚪';

  // ── The four high-conviction combos ────────────────────────────────────────
  if (isNegGEX && bullScore >= 2) {
    // EXPLOSIVE RALLY: negative GEX + CTA long + above flip
    setup = 'EXPLOSIVE RALLY';
    direction = 'BULLISH';
    conviction = Math.min(50 + Math.abs(netGEX) * 5 + bullScore * 10, 99);
    tradeType = 'BUY CALLS';
    const nearResist = gexData.topResistance && gexData.topResistance[0];
    const nextResist = gexData.topResistance && gexData.topResistance[1];
    entry = nearResist ? 'Buy calls at ' + spotPrice + ' — momentum entry' : 'Buy calls at market';
    target = nextResist ? 'Target: ' + nextResist.strike + ' (next GEX resistance)' : 'Target: next GEX resistance';
    stop = flipPoint ? 'Stop: close below ' + flipPoint + ' (flip point)' : 'Stop: 1% below entry';
    structure = 'Debit call spread or ATM long call — debit only in trending regime';
    color = '#39ff14';
    emoji = '🚀';
  }
  else if (isNegGEX && bullScore <= -2) {
    // ACCELERATING SELLOFF: negative GEX + CTA short + below flip
    setup = 'ACCELERATING SELLOFF';
    direction = 'BEARISH';
    conviction = Math.min(50 + Math.abs(netGEX) * 5 + Math.abs(bullScore) * 10, 99);
    tradeType = 'BUY PUTS';
    const nearSupport = gexData.topSupport && gexData.topSupport[0];
    const nextSupport = gexData.topSupport && gexData.topSupport[1];
    entry = 'Buy puts at ' + spotPrice + ' — breakdown entry';
    target = nextSupport ? 'Target: ' + nextSupport.strike + ' (next GEX support)' : 'Target: next GEX support';
    stop = flipPoint ? 'Stop: close above ' + flipPoint + ' (flip point)' : 'Stop: 1% above entry';
    structure = 'Debit put spread or ATM long put — debit only in trending regime';
    color = '#ff2d55';
    emoji = '📉';
  }
  else if (isPosGEX && bullScore >= 1) {
    // SLOW GRIND UP: positive GEX + CTA long — sell puts or call spreads
    setup = 'GRIND HIGHER / PIN';
    direction = 'MILD BULLISH';
    conviction = Math.min(55 + gexStrength * 12 + bullScore * 8, 95);
    tradeType = 'SELL CALLS / SELL PUT SPREAD';
    const nearResist = gexData.topResistance && gexData.topResistance[0];
    entry = nearResist ? 'Sell calls at ' + nearResist.strike + ' (GEX resistance)' : 'Sell OTM calls at nearest resistance';
    target = 'Collect full premium — expect pin between GEX levels';
    stop = flipPoint ? 'Stop: close below ' + flipPoint + ' (regime flip)' : 'Stop: break below nearest GEX support';
    structure = 'Credit call spread above resistance OR sell put spread at support';
    color = '#ffd166';
    emoji = '📌';
  }
  else if (isPosGEX && bullScore <= -1) {
    // FADE THE RIP: positive GEX + CTA short
    setup = 'FADE THE RIP';
    direction = 'MILD BEARISH';
    conviction = Math.min(55 + gexStrength * 12 + Math.abs(bullScore) * 8, 95);
    tradeType = 'SELL CALLS';
    const nearResistFade = gexData.topResistance && gexData.topResistance[0];
    entry = nearResistFade ? 'Sell calls at ' + nearResistFade.strike + ' — GEX wall overhead' : 'Sell OTM calls at resistance';
    target = 'Collect full premium — dealers suppress move';
    stop = flipPoint ? 'Stop: close above ' + flipPoint + ' (regime flip)' : 'Stop: break above nearest resistance';
    structure = 'Credit call spread — pinning regime, CTA also short, double pressure on upside';
    color = '#ff6b35';
    emoji = '🎯';
  }
  else if (isPosGEX) {
    // PREMIUM SELLING: positive GEX + CTA neutral
    // GEX is PRIMARY signal for premium selling — CTA neutral is perfectly fine
    // Dealers are pinning price regardless of CTA direction
    setup = 'PREMIUM SELLING';
    direction = 'NEUTRAL / PIN';
    conviction = Math.min(50 + gexStrength * 15, 90);
    tradeType = 'SELL CALLS / SELL PUTS';
    const nearResistPS = gexData.topResistance && gexData.topResistance[0];
    const nearSupportPS = gexData.topSupport && gexData.topSupport[0];
    entry = nearResistPS
      ? 'Sell calls at ' + nearResistPS.strike + ' (GEX resistance) or sell puts at ' + (nearSupportPS ? nearSupportPS.strike : 'GEX support')
      : 'Sell at nearest GEX resistance (calls) or support (puts)';
    target = 'Collect full premium — pinning regime, theta decay works for you';
    stop = flipPoint ? 'Stop: regime flip at ' + flipPoint + ' — close if breached' : 'Stop: regime changes to TRENDING';
    structure = 'Credit call spread above GEX resistance OR cash-secured put at GEX support. CTA neutral = no momentum to fight you.';
    color = '#39ff14';
    emoji = '💰';
  }
  else {
    // Mixed signals — describe the specific conflict
    setup = 'MIXED SIGNALS';
    direction = 'NEUTRAL';
    conviction = 20;
    tradeType = 'STAND ASIDE';
    var gexDesc  = gexStrength > 0 ? 'GEX pinning' : gexStrength < 0 ? 'GEX trending' : 'GEX neutral';
    var ctaDesc  = ctaStrength > 0 ? 'CTA long' : ctaStrength < 0 ? 'CTA short' : 'CTA neutral';
    var flipDesc = flipContext === 'ABOVE_FLIP' ? 'above flip' : flipContext === 'BELOW_FLIP' ? 'below flip' : 'flip N/A';
    entry     = gexDesc + ' but ' + ctaDesc + ' — no directional alignment';
    target    = 'Wait for GEX + CTA to agree before entering';
    stop      = 'N/A — no position';
    structure = 'Stand aside. ' + gexDesc + ', ' + ctaDesc + ', price ' + flipDesc + '. Enter only when all three align.';
    color = '#4a6070';
    emoji = '⚠';
  }

  // Double-confirmed bonus: when GEX level and CTA trigger are at same price
  let doubleConfirmed = false;
  if (ctaData && ctaData.triggers && gexData.topResistance) {
    const ctaTriggerPrices = (ctaData.triggers || []).map(function(t) { return t.level * 10; }); // SPY to SPX
    const gexPrices = (gexData.topResistance || []).concat(gexData.topSupport || []).map(function(s) { return s.strike; });
    for (var i = 0; i < ctaTriggerPrices.length; i++) {
      for (var j = 0; j < gexPrices.length; j++) {
        if (Math.abs(ctaTriggerPrices[i] - gexPrices[j]) <= 20) {
          doubleConfirmed = true;
          break;
        }
      }
    }
  }
  // Double confirmed is only meaningful when we have a real setup
  // Suppress it on MIXED SIGNALS — contradictory messaging
  if (setup === 'MIXED SIGNALS') doubleConfirmed = false;
  if (doubleConfirmed) conviction = Math.min(conviction + 10, 99);

  return {
    setup, direction, conviction, tradeType, color, emoji,
    entry, target, stop, structure, doubleConfirmed,
    gexSignal, gexStrength, ctaSignal, ctaStrength,
    flipContext, aboveFlip, composite, netGEX, flipPoint,
    regime, spotPrice,
  };
}

// Ticker-specific conviction — GEX + SPX CTA as market environment proxy
function buildTickerConviction(tickerGEX, ctaState) {
  if (!tickerGEX) return null;

  const netGEX    = tickerGEX.netGEXBillions || 0;
  const flipPoint = tickerGEX.flipPoint || null;
  const spot      = tickerGEX.spotPrice;
  const aboveFlip = flipPoint ? spot > flipPoint : null;

  // CTA composite from live ctaState — SPX CTA is the best proxy for
  // individual stock institutional trend-following flow direction
  const composite = ctaState && ctaState.composite !== null ? ctaState.composite : null;
  let ctaStrength = 0;
  if (composite !== null) {
    if      (composite >= 60)  ctaStrength = 3;
    else if (composite >= 25)  ctaStrength = 2;
    else if (composite >= -25) ctaStrength = 0;
    else if (composite >= -60) ctaStrength = -2;
    else                       ctaStrength = -3;
  }
  const ctaLabel = composite !== null ?
    (composite >= 25 ? 'LONG (' + composite + ')' :
     composite <= -25 ? 'SHORT (' + composite + ')' :
     'NEUTRAL (' + composite + ')') : 'N/A';

  const bullScore = ctaStrength + (aboveFlip === true ? 1 : aboveFlip === false ? -1 : 0);

  let setup, direction, conviction, tradeType, entry, target, stop, structure, color, emoji;

  const isNegGEX = netGEX < 0;
  const isPosGEX = netGEX > 0;

  if (isNegGEX && bullScore >= 1) {
    setup = 'BUY CALLS'; direction = 'BULLISH';
    conviction = Math.min(45 + Math.abs(netGEX) * 8 + bullScore * 8, 95);
    tradeType = 'LONG CALL / DEBIT CALL SPREAD';
    const r = tickerGEX.topResistance && tickerGEX.topResistance[0];
    entry = 'Enter at $' + spot + ' with momentum';
    target = r ? 'Target: $' + r.strike + ' (GEX resistance)' : 'Target: next GEX resistance';
    stop = flipPoint ? 'Stop: close below $' + flipPoint : 'Stop: -2% from entry';
    structure = 'Debit call spread — buy ATM, sell at nearest resistance';
    color = '#39ff14'; emoji = '🚀';
  } else if (isNegGEX && bullScore <= -1) {
    setup = 'BUY PUTS'; direction = 'BEARISH';
    conviction = Math.min(45 + Math.abs(netGEX) * 8 + Math.abs(bullScore) * 8, 95);
    tradeType = 'LONG PUT / DEBIT PUT SPREAD';
    const s = tickerGEX.topSupport && tickerGEX.topSupport[0];
    entry = 'Enter at $' + spot + ' on breakdown';
    target = s ? 'Target: $' + s.strike + ' (GEX support)' : 'Target: next GEX support';
    stop = flipPoint ? 'Stop: close above $' + flipPoint : 'Stop: +2% from entry';
    structure = 'Debit put spread — buy ATM, sell at nearest support';
    color = '#ff2d55'; emoji = '📉';
  } else if (isPosGEX) {
    setup = 'SELL CALLS'; direction = 'NEUTRAL/BEARISH';
    conviction = Math.min(40 + netGEX * 8, 85);
    tradeType = 'CREDIT CALL SPREAD';
    const r = tickerGEX.topResistance && tickerGEX.topResistance[0];
    entry = r ? 'Sell calls at $' + r.strike + ' (GEX resistance wall)' : 'Sell OTM calls at resistance';
    target = 'Collect full premium — pin expected';
    stop = flipPoint ? 'Stop: close above $' + flipPoint : 'Stop: break above resistance';
    structure = 'Credit call spread at GEX resistance — theta works for you';
    color = '#ffd166'; emoji = '📌';
  } else {
    setup = 'NEUTRAL'; direction = 'MIXED';
    conviction = 20; tradeType = 'STAND ASIDE';
    entry = 'No clear signal'; target = 'Wait'; stop = 'N/A';
    structure = 'Mixed GEX signals — no trade';
    color = '#4a6070'; emoji = '⚪';
  }

  return { setup, direction, conviction, tradeType, entry, target, stop, structure, color, emoji, netGEX, flipPoint, aboveFlip, spot, ctaLabel, ctaStrength, composite };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function startScheduler() {
  // 8:00am MST = 15:00 UTC (MDT)
  cron.schedule('0 15 * * 1-5', function() { runGEXScan('8:00am MST'); });
  // 9:30am MST = 16:30 UTC
  cron.schedule('30 16 * * 1-5', function() { runGEXScan('9:30am MST'); });
  log('info', 'GEX scheduler started — 8:00am + 9:30am MST weekdays');
}

// ─── HTML DASHBOARD ───────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderHTML() {
  const d = gexData;
  const logHTML = [...logLines].reverse().slice(0, 60).map(function(l) {
    const c = { ok: '#39ff14', warn: '#ff6b35', err: '#ff2d55', info: '#4a6272' }[l.type] || '#4a6272';
    return '<div style="color:' + c + '">[' + l.time.slice(11,19) + '] ' + esc(l.msg) + '</div>';
  }).join('');

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

${(d.marketContext && d.marketContext.fomcToday) ? `
<!-- FOMC BANNER -->
<div style="margin-bottom:16px;padding:14px 20px;background:rgba(255,107,53,0.12);border:1px solid rgba(255,107,53,0.4);border-radius:10px;display:flex;align-items:center;gap:14px">
  <div style="font-size:24px">🏛️</div>
  <div>
    <div style="font-size:12px;font-weight:700;color:#ff6b35;letter-spacing:2px;margin-bottom:4px">FOMC DAY</div>
    <div style="font-size:12px;color:#d8eaf5">Fed decision expected ~14:00 ET. No new positions 13:30–14:00 ET. Debit spreads only. Expect pre-announcement compression → violent post-release expansion.</div>
  </div>
</div>
` : (d.marketContext && d.marketContext.fomcTomorrow) ? `
<div style="margin-bottom:16px;padding:12px 20px;background:rgba(255,209,102,0.08);border:1px solid rgba(255,209,102,0.3);border-radius:10px">
  <span style="font-size:11px;font-weight:700;color:#ffd166;letter-spacing:2px">⚠ FOMC TOMORROW</span>
  <span style="font-size:11px;color:#8aa0b0;margin-left:10px">IV may be elevated today. Size down.</span>
</div>
` : ''}

${d.marketContext ? `
<!-- MARKET CONTEXT ROW -->
<div class="card" style="margin-bottom:16px">
  <div class="card-head"><span class="card-title">&#127973; Market Context — VIX · P/C · Expected Move</span></div>
  <div style="padding:16px 20px;display:flex;flex-wrap:wrap;gap:12px">

    ${d.marketContext.vix != null ? `
    <div style="flex:1;min-width:130px;padding:12px 14px;background:#111820;border-radius:8px;border-left:3px solid ${d.marketContext.vix >= 25 ? '#ff2d55' : d.marketContext.vix >= 20 ? '#ff6b35' : '#39ff14'}">
      <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">VIX</div>
      <div class="mono" style="font-size:26px;font-weight:700;color:${d.marketContext.vix >= 25 ? '#ff2d55' : d.marketContext.vix >= 20 ? '#ff6b35' : '#39ff14'}">${d.marketContext.vix}</div>
      <div style="font-size:10px;color:#4a6070;margin-top:3px">${d.marketContext.vixRegime}${d.marketContext.vixChange != null ? ' · ' + (d.marketContext.vixChange >= 0 ? '+' : '') + d.marketContext.vixChange + '%' : ''}</div>
    </div>
    ` : ''}

    ${d.marketContext.pcRatio != null ? `
    <div style="flex:1;min-width:160px;padding:12px 14px;background:#111820;border-radius:8px;border-left:3px solid ${d.marketContext.pcRatio > 1.2 ? '#39ff14' : d.marketContext.pcRatio < 0.7 ? '#ff2d55' : '#ffd166'}">
      <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">PUT / CALL RATIO</div>
      <div class="mono" style="font-size:26px;font-weight:700;color:${d.marketContext.pcRatio > 1.2 ? '#39ff14' : d.marketContext.pcRatio < 0.7 ? '#ff2d55' : '#ffd166'}">${d.marketContext.pcRatio}</div>
      <div style="font-size:10px;color:#4a6070;margin-top:3px">${d.marketContext.pcSentiment}</div>
    </div>
    ` : ''}

    ${(d.marketContext.expectedMoves && d.marketContext.expectedMoves[0]) ? `
    <div style="flex:2;min-width:200px;padding:12px 14px;background:#111820;border-radius:8px;border-left:3px solid #00d4ff">
      <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:8px">EXPECTED MOVE (1σ ATM STRADDLE)</div>
      ${d.marketContext.expectedMoves.slice(0,3).map(function(em) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<span style="font-size:11px;color:#4a6070">' + em.expiry + ' (DTE ' + em.dte + ')</span>' +
          '<span class="mono" style="font-size:13px;font-weight:700;color:#00d4ff">±' + em.emPoints + ' pts</span>' +
          '<span style="font-size:11px;color:#8aa0b0">' + em.loTarget + ' — ' + em.hiTarget + '</span>' +
        '</div>';
      }).join('')}
    </div>
    ` : ''}

  </div>
</div>
` : ''}

${(d.conviction && d.conviction.setup !== 'NEUTRAL') ? `
<!-- CONVICTION SIGNAL -->
<div class="card" style="margin-bottom:16px;border-color:${d.conviction.color}40">
  <div class="card-head" style="background:${d.conviction.color}10">
    <span class="card-title" style="color:${d.conviction.color}">${d.conviction.emoji} CONVICTION SIGNAL — ${d.conviction.setup}</span>
    <span style="font-size:12px;font-weight:700;color:${d.conviction.color}">${d.conviction.conviction}% CONVICTION</span>
  </div>
  <div style="padding:18px 20px">
    <div style="height:8px;background:#070a0f;border-radius:4px;overflow:hidden;margin-bottom:16px">
      <div style="height:100%;width:${d.conviction.conviction}%;background:${d.conviction.color};border-radius:4px"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div style="padding:12px 14px;background:#111820;border-radius:8px;border-left:3px solid ${d.conviction.color}">
        <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">TRADE TYPE</div>
        <div style="font-size:14px;font-weight:700;color:${d.conviction.color}">${d.conviction.tradeType}</div>
      </div>
      <div style="padding:12px 14px;background:#111820;border-radius:8px;border-left:3px solid #1a2535">
        <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">SIGNALS ALIGNED</div>
        <div style="font-size:12px;color:#d8eaf5">GEX: ${d.conviction.gexSignal} &nbsp;&middot;&nbsp; CTA: ${d.conviction.ctaSignal}</div>
        <div style="font-size:11px;color:#4a6070;margin-top:2px">Flip: ${d.conviction.flipContext.replace('_', ' ')}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
      <div style="padding:10px 12px;background:#111820;border-radius:6px">
        <div style="font-size:9px;color:#4a6070;letter-spacing:1px;margin-bottom:4px">ENTRY</div>
        <div style="font-size:11px;color:#d8eaf5">${d.conviction.entry}</div>
      </div>
      <div style="padding:10px 12px;background:#111820;border-radius:6px">
        <div style="font-size:9px;color:#39ff14;letter-spacing:1px;margin-bottom:4px">TARGET</div>
        <div style="font-size:11px;color:#d8eaf5">${d.conviction.target}</div>
      </div>
      <div style="padding:10px 12px;background:#111820;border-radius:6px">
        <div style="font-size:9px;color:#ff2d55;letter-spacing:1px;margin-bottom:4px">STOP</div>
        <div style="font-size:11px;color:#d8eaf5">${d.conviction.stop}</div>
      </div>
    </div>
    <div style="padding:10px 14px;background:rgba(0,212,255,0.05);border-left:3px solid rgba(0,212,255,0.3);border-radius:0 6px 6px 0;font-size:12px;color:#00d4ff">
      &#9654; ${d.conviction.structure}
    </div>
    ${d.conviction.doubleConfirmed ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(255,107,53,0.1);border-radius:6px;font-size:11px;font-weight:700;color:#ff6b35;letter-spacing:1px">&#9889; DOUBLE CONFIRMED — GEX level aligns with CTA trigger. Highest conviction.</div>` : ''}
  </div>
</div>
` : ''}

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

${(d.fibGrid || d.pmLevels) ? `
<!-- FIB GRID + PREMARKET -->
<div class="card" style="margin-bottom:16px">
  <div class="card-head">
    <span class="card-title">&#128200; 5-Day Fib Grid &amp; Pre-Market Levels</span>
    <span style="font-size:11px;color:#4a6070">5-day swing retracements + SPY pre-market high/low</span>
  </div>
  <div style="padding:16px 20px">

    ${d.fibGrid ? `
    <!-- Fib position badge -->
    <div style="margin-bottom:16px;padding:10px 16px;background:#111820;border-radius:8px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:3px">PRICE POSITION</div>
        <div style="font-size:13px;font-weight:700;color:#ffd166">${d.fibGrid.position}</div>
      </div>
      <div>
        <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:3px">5D RANGE</div>
        <div class="mono" style="font-size:13px;color:#d8eaf5">${d.fibGrid.swing_low} — ${d.fibGrid.swing_high} <span style="color:#4a6070">(${d.fibGrid.range}pts)</span></div>
      </div>
      ${d.pmLevels ? `
      <div>
        <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:3px">PM HIGH / LOW</div>
        <div class="mono" style="font-size:13px"><span style="color:#39ff14">${d.pmLevels.high}</span> <span style="color:#4a6070">/</span> <span style="color:#ff2d55">${d.pmLevels.low}</span></div>
      </div>` : ''}
    </div>

    <!-- Fib level bars -->
    <div style="position:relative">
      ${(function() {
        const f = d.fibGrid;
        const spot = d.spotPrice;
        const levels = [
          { price: f.ext_1618, label: 'Ext 161.8%', color: '#ff6b35', bold: false },
          { price: f.ext_1272, label: 'Ext 127.2%', color: '#ff6b35', bold: false },
          { price: f.swing_high, label: '5D High (BSL)', color: '#39ff14', bold: true },
          { price: f.fib_236, label: '23.6%', color: '#39ff14', bold: false },
          { price: f.fib_382, label: '38.2%', color: '#ffd166', bold: false },
          { price: f.fib_500, label: '50% Equilibrium', color: '#ffd166', bold: true },
          { price: f.fib_618, label: '61.8% OTE', color: '#ff6b35', bold: true },
          { price: f.fib_786, label: '78.6%', color: '#ff2d55', bold: false },
          { price: f.swing_low, label: '5D Low (SSL)', color: '#ff2d55', bold: true },
        ].filter(function(l) { return l.price && Math.abs(l.price - spot) / spot < 0.06; });

        // Add PM levels
        if (d.pmLevels) {
          if (Math.abs(d.pmLevels.high - spot) / spot < 0.06) levels.push({ price: d.pmLevels.high, label: 'PM High', color: '#00d4ff', bold: true });
          if (Math.abs(d.pmLevels.low  - spot) / spot < 0.06) levels.push({ price: d.pmLevels.low,  label: 'PM Low',  color: '#00d4ff', bold: true });
        }

        levels.sort(function(a, b) { return b.price - a.price; });

        return levels.map(function(l) {
          const isSpot = Math.abs(l.price - spot) <= 8;
          const aboveSpot = l.price > spot;
          const pctAway = ((l.price - spot) / spot * 100).toFixed(1);
          return '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;padding:7px 10px;background:' +
            (isSpot ? 'rgba(0,212,255,0.08)' : 'transparent') +
            ';border-radius:6px;border-left:3px solid ' + l.color + '">' +
            '<div class="mono" style="width:60px;font-size:13px;font-weight:' + (l.bold ? '700' : '400') + ';color:' + l.color + '">' + l.price + '</div>' +
            '<div style="flex:1;font-size:11px;color:#8aa0b0">' + l.label + '</div>' +
            '<div class="mono" style="font-size:11px;color:#4a6070">' + (pctAway >= 0 ? '+' : '') + pctAway + '%</div>' +
            (isSpot ? '<div style="font-size:9px;font-weight:700;color:#00d4ff;letter-spacing:1px">◀ SPOT</div>' : '') +
          '</div>';
        }).join('');
      })()}
    </div>
    ` : ''}
  </div>
</div>
` : ''}

${(d.confluenceZones && d.confluenceZones.length) ? `
<!-- CONFLUENCE ZONES + TRADE SETUPS -->
<div class="card" style="margin-bottom:16px">
  <div class="card-head">
    <span class="card-title">&#9889; Confluence Zones — Trade Setups</span>
    <span style="font-size:11px;color:#4a6070">GEX + Fib + Expected Move stacking within 15pts</span>
  </div>
  <div style="padding:16px 20px">
    <div style="font-size:11px;color:#4a6070;margin-bottom:14px;line-height:1.7">
      A confluence zone is where a GEX level aligns with a Fibonacci retracement AND/OR an expected move boundary within 15 SPX points.
      More confluences = higher conviction. Always trade WITH the GEX regime.
    </div>
    ${(d.confluenceZones || []).map(function(z) {
      const distStr = (z.ptsFromSpot > 0 ? '+' : '') + z.ptsFromSpot + ' pts from spot';
      return '<div style="margin-bottom:14px;padding:14px 16px;background:#111820;border-radius:8px;border-left:4px solid ' + z.strengthColor + '">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">' +
          '<div style="display:flex;align-items:center;gap:12px">' +
            '<div class="mono" style="font-size:24px;font-weight:700;color:' + z.setupColor + '">' + z.price + '</div>' +
            '<div>' +
              '<div style="font-size:10px;font-weight:700;color:' + z.strengthColor + ';letter-spacing:1px">' + z.strength + ' (' + z.confluenceCount + ' signals)</div>' +
              '<div style="font-size:10px;color:#4a6070">' + distStr + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="padding:5px 12px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:1px;background:' +
            (z.buyOrSell === 'BUY' ? 'rgba(57,255,20,0.15);color:#39ff14' :
             z.buyOrSell === 'SELL' ? 'rgba(255,45,85,0.15);color:#ff2d55' :
             'rgba(255,209,102,0.15);color:#ffd166') + '">' + (z.buyOrSell || 'WATCH') + '</div>' +
        '</div>' +
        '<div style="font-size:12px;font-weight:600;color:' + z.setupColor + ';margin-bottom:8px">' + z.setup + '</div>' +
        '<div style="font-size:11px;color:#4a6070;margin-bottom:6px">Confluences: ' + [z.gexLabel].concat(z.confluences).join(' · ') + '</div>' +
        (z.structure ? '<div style="font-size:11px;color:#00d4ff;padding:6px 10px;background:rgba(0,212,255,0.06);border-radius:4px">&#9654; ' + z.structure + '</div>' : '') +
      '</div>';
    }).join('')}
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

<!-- TICKER GEX SCANNER -->
<div class="card" style="margin-bottom:16px">
  <div class="card-head">
    <span class="card-title">&#128269; Ticker GEX Scanner — Call Selling Analyzer</span>
    <span style="font-size:11px;color:#4a6070">Scan any optionable stock for GEX regime + best call strikes to sell</span>
  </div>
  <div style="padding:16px 20px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
    <div>
      <div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:6px">TICKER SYMBOL</div>
      <input type="text" id="ticker-input" placeholder="AAPL, TSLA, NVDA..." maxlength="6"
        style="background:#111820;border:1px solid #1a2535;color:#d8eaf5;padding:9px 13px;font-family:'Space Mono',monospace;font-size:16px;font-weight:700;width:180px;border-radius:6px;outline:none;text-transform:uppercase"
        onkeydown="if(event.key==='Enter')scanTicker()"
        oninput="this.value=this.value.toUpperCase()">
    </div>
    <button class="btn bp" onclick="scanTicker()" style="margin-bottom:1px">&#9654; Scan GEX</button>
    <span id="ticker-msg" style="font-size:12px;color:#4a6070"></span>
  </div>
  <div id="ticker-result"></div>
</div>

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
  })
  .catch(function(e) { msg.textContent = 'Failed: ' + e.message; msg.style.color='#ff2d55'; });
}
function clearPM() {
  document.getElementById('pm-price').value = '';
  document.getElementById('pm-result').innerHTML = '';
  document.getElementById('pm-msg').textContent = '';
}
function triggerScan(btn) {
  btn.disabled = true; btn.textContent = 'Scanning...';
  fetch('/api/scan', { method: 'POST' }).then(function() {
    var secs = 120;
    var iv = setInterval(function() {
      secs--;
      btn.textContent = 'Scanning... ' + secs + 's';
      if (secs <= 0) { clearInterval(iv); location.reload(); }
    }, 1000);
    setTimeout(function() { clearInterval(iv); location.reload(); }, 120000);
  }).catch(function() { btn.disabled = false; btn.textContent = '&#9654; Run Now'; });
}
function testPush(btn) {
  btn.disabled = true; btn.textContent = 'Sending...';
  fetch('/api/test-push', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
    btn.textContent = d.status === 1 ? 'Sent!' : 'Failed';
    setTimeout(function() { btn.disabled = false; btn.textContent = '&#128276; Test Alert'; }, 3000);
  }).catch(function() { btn.disabled = false; btn.textContent = '&#128276; Test Alert'; });
}
function scanTicker(btn) {
  var sym = document.getElementById('ticker-input').value.trim().toUpperCase();
  var msg = document.getElementById('ticker-msg');
  var res = document.getElementById('ticker-result');
  if (!sym || sym.length > 6) { msg.textContent = 'Enter a valid ticker'; msg.style.color='#ff2d55'; return; }
  msg.textContent = 'Scanning ' + sym + '...'; msg.style.color = '#00d4ff';
  res.innerHTML = '';
  fetch('/api/ticker/' + sym, { method: 'POST' })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.error) { msg.textContent = 'Error: ' + d.error; msg.style.color='#ff2d55'; return; }
    msg.textContent = 'Done — ' + d.ts; msg.style.color = '#39ff14';

    // Score gauge
    var scoreFill = Math.min(d.callScore, 100);
    var scoreCol  = d.scoreColor || '#ffd166';

    // Strike rows
    var strikeRows = (d.callStrikes || []).map(function(s) {
      var recCol = s.pctAway < 2 ? '#ffd166' : '#8aa0b0';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #0d1f2d">' +
        '<div>' +
          '<div class="mono" style="font-size:18px;font-weight:700;color:#39ff14">$' + s.strike + '</div>' +
          '<div style="font-size:10px;color:#4a6070">+' + s.pctAway + '% from spot · GEX: +$' + s.gexM + 'M</div>' +
        '</div>' +
        '<div style="font-size:10px;color:' + recCol + ';text-align:right;letter-spacing:1px">' + s.recommendation + '</div>' +
      '</div>';
    }).join('');

    // Support rows (put side — for reference)
    var supportRows = (d.topSupport || []).slice(0,3).map(function(s) {
      var pct = ((s.strike - d.spotPrice) / d.spotPrice * 100).toFixed(1);
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0d1f2d">' +
        '<div class="mono" style="font-size:15px;font-weight:700;color:#ff2d55">$' + s.strike + '</div>' +
        '<div style="font-size:10px;color:#4a6070">' + pct + '% · $' + Math.abs(Math.round(s.netGEX/1e6)) + 'M GEX</div>' +
      '</div>';
    }).join('');

    res.innerHTML =
      '<div style="padding:16px 20px;border-top:1px solid #1a2535">' +

        // Header row
        '<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-bottom:20px">' +
          '<div>' +
            '<div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:3px">SYMBOL</div>' +
            '<div class="mono" style="font-size:32px;font-weight:700;color:#00d4ff">' + d.symbol + '</div>' +
            '<div style="font-size:12px;color:#4a6070">$' + d.spotPrice + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:3px">REGIME</div>' +
            '<div class="mono" style="font-size:18px;font-weight:700;color:' + d.regimeColor + '">' + d.regime + '</div>' +
            '<div style="font-size:11px;color:#8aa0b0">' + (d.netGEXBillions >= 0 ? '+' : '') + d.netGEXBillions + 'B net GEX</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:11px;color:#4a6070;letter-spacing:2px;margin-bottom:3px">GEX FLIP</div>' +
            '<div class="mono" style="font-size:18px;font-weight:700;color:#ffd166">' + (d.flipPoint || 'N/A') + '</div>' +
            '<div style="font-size:11px;color:#4a6070">regime change level</div>' +
          '</div>' +
        '</div>' +

        // Earnings warning — show first if earnings are near
        (d.earnings && d.earnings.earningsSoon ? (
          '<div style="margin-bottom:14px;padding:12px 14px;background:rgba(255,107,53,0.12);border:1px solid rgba(255,107,53,0.4);border-radius:8px">' +
            '<div style="font-size:11px;font-weight:700;color:#ff6b35;letter-spacing:1px;margin-bottom:4px">&#9888; EARNINGS WARNING</div>' +
            '<div style="font-size:11px;color:#d8eaf5">' + d.earnings.warning + '</div>' +
            '<div style="font-size:10px;color:#4a6070;margin-top:6px">' +
              'Near IV: ' + d.earnings.nearIV + '% (' + d.earnings.nearExpiry + ', DTE ' + d.earnings.nearDTE + ') &nbsp;·&nbsp; ' +
              'Next IV: ' + d.earnings.nextIV + '% (' + d.earnings.nextExpiry + ') &nbsp;·&nbsp; ' +
              'IV ratio: ' + d.earnings.ivRatio + 'x' +
            '</div>' +
          '</div>'
        ) : '') +

        // Conviction signal block
        (d.conviction && d.conviction.setup !== 'NEUTRAL' ? (
          '<div style="margin-bottom:16px;padding:14px 16px;background:' + d.conviction.color + '10;border-radius:8px;border:1px solid ' + d.conviction.color + '40">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
              '<div style="font-size:13px;font-weight:700;color:' + d.conviction.color + '">' + d.conviction.emoji + ' ' + d.conviction.setup + '</div>' +
              '<div style="font-size:12px;font-weight:700;color:' + d.conviction.color + '">' + d.conviction.conviction + '% CONVICTION</div>' +
            '</div>' +
            '<div style="height:6px;background:#070a0f;border-radius:3px;overflow:hidden;margin-bottom:12px">' +
              '<div style="height:100%;width:' + d.conviction.conviction + '%;background:' + d.conviction.color + ';border-radius:3px"></div>' +
            '</div>' +
            // CTA context row
            '<div style="display:flex;gap:16px;margin-bottom:10px;padding:8px 10px;background:#0c1118;border-radius:6px">' +
              '<div>' +
                '<div style="font-size:9px;color:#4a6070;letter-spacing:1px;margin-bottom:2px">SPX CTA</div>' +
                '<div style="font-size:11px;font-weight:700;color:' +
                  (d.conviction.ctaStrength > 0 ? '#39ff14' : d.conviction.ctaStrength < 0 ? '#ff2d55' : '#ffd166') + '">' +
                  (d.conviction.ctaLabel || 'N/A') +
                '</div>' +
              '</div>' +
              '<div>' +
                '<div style="font-size:9px;color:#4a6070;letter-spacing:1px;margin-bottom:2px">TICKER GEX</div>' +
                '<div style="font-size:11px;font-weight:700;color:' + d.regimeColor + '">' + d.regime + ' (' + (d.netGEXBillions >= 0 ? '+' : '') + d.netGEXBillions + 'B)</div>' +
              '</div>' +
              '<div>' +
                '<div style="font-size:9px;color:#4a6070;letter-spacing:1px;margin-bottom:2px">VS FLIP</div>' +
                '<div style="font-size:11px;font-weight:700;color:#ffd166">' + (d.conviction.aboveFlip === true ? 'ABOVE' : d.conviction.aboveFlip === false ? 'BELOW' : 'N/A') + ' $' + (d.flipPoint || 'N/A') + '</div>' +
              '</div>' +
            '</div>' +
            '<div style="font-size:12px;font-weight:700;color:' + d.conviction.color + ';margin-bottom:8px">' + d.conviction.tradeType + '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">' +
              '<div style="padding:8px;background:#111820;border-radius:6px">' +
                '<div style="font-size:9px;color:#4a6070;margin-bottom:3px">ENTRY</div>' +
                '<div style="font-size:10px;color:#d8eaf5">' + d.conviction.entry + '</div>' +
              '</div>' +
              '<div style="padding:8px;background:#111820;border-radius:6px">' +
                '<div style="font-size:9px;color:#39ff14;margin-bottom:3px">TARGET</div>' +
                '<div style="font-size:10px;color:#d8eaf5">' + d.conviction.target + '</div>' +
              '</div>' +
              '<div style="padding:8px;background:#111820;border-radius:6px">' +
                '<div style="font-size:9px;color:#ff2d55;margin-bottom:3px">STOP</div>' +
                '<div style="font-size:10px;color:#d8eaf5">' + d.conviction.stop + '</div>' +
              '</div>' +
            '</div>' +
            '<div style="font-size:10px;color:#00d4ff;padding:6px 10px;background:rgba(0,212,255,0.05);border-radius:4px">' +
              '&#9654; ' + d.conviction.structure +
            '</div>' +
          '</div>'
        ) : '') +

        // Dual score cards
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">' +

          // SELL calls score
          '<div style="padding:14px 16px;background:#111820;border-radius:8px;border-left:4px solid ' + scoreCol + '">' +
            '<div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:6px">SELL CALLS SCORE</div>' +
            '<div class="mono" style="font-size:32px;font-weight:700;color:' + scoreCol + '">' + d.callScore + '<span style="font-size:14px;color:#4a6070">/100</span></div>' +
            '<div style="height:6px;background:#070a0f;border-radius:3px;overflow:hidden;margin:8px 0">' +
              '<div style="height:100%;width:' + scoreFill + '%;background:' + scoreCol + ';border-radius:3px"></div>' +
            '</div>' +
            '<div style="font-size:10px;font-weight:600;color:' + scoreCol + ';line-height:1.5">' + d.scoreLabel + '</div>' +
          '</div>' +

          // BUY calls score
          '<div style="padding:14px 16px;background:#111820;border-radius:8px;border-left:4px solid ' + (d.buyScoreColor || '#ffd166') + '">' +
            '<div style="font-size:10px;color:#4a6070;letter-spacing:1px;margin-bottom:6px">BUY PREMIUM SCORE</div>' +
            '<div class="mono" style="font-size:32px;font-weight:700;color:' + (d.buyScoreColor || '#ffd166') + '">' + (d.buyScore || 0) + '<span style="font-size:14px;color:#4a6070">/100</span></div>' +
            '<div style="height:6px;background:#070a0f;border-radius:3px;overflow:hidden;margin:8px 0">' +
              '<div style="height:100%;width:' + Math.min(d.buyScore || 0, 100) + '%;background:' + (d.buyScoreColor || '#ffd166') + ';border-radius:3px"></div>' +
            '</div>' +
            '<div style="font-size:10px;font-weight:600;color:' + (d.buyScoreColor || '#ffd166') + ';line-height:1.5">' + (d.buyScoreLabel || '') + '</div>' +
          '</div>' +

        '</div>' +

        // Regime description
        '<div style="margin-bottom:16px;padding:10px 14px;background:#111820;border-left:3px solid ' + d.regimeColor + ';border-radius:0 6px 6px 0;font-size:12px;color:#8aa0b0">' +
          d.regimeDesc +
        '</div>' +

        // Three columns: sell strikes | buy levels | support
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">' +

          // Sell call strikes
          '<div>' +
            '<div style="font-size:10px;color:#ff2d55;letter-spacing:1px;margin-bottom:10px">&#9660; SELL CALL STRIKES</div>' +
            (strikeRows || '<div style="color:#4a6070;font-size:11px">No resistance found</div>') +
          '</div>' +

          // Buy call levels (support = dip entry for longs)
          '<div>' +
            '<div style="font-size:10px;color:#39ff14;letter-spacing:1px;margin-bottom:10px">&#9650; BUY CALL ENTRIES</div>' +
            (function() {
              return (d.callBuyLevels || []).map(function(s) {
                var recCol = Math.abs(s.pctAway) < 2 ? '#ffd166' : '#8aa0b0';
                return '<div style="padding:10px 0;border-bottom:1px solid #0d1f2d">' +
                  '<div class="mono" style="font-size:16px;font-weight:700;color:#39ff14">$' + s.strike + '</div>' +
                  '<div style="font-size:10px;color:#4a6070">' + s.pctAway + '% · $' + s.gexM + 'M GEX</div>' +
                  '<div style="font-size:9px;color:' + recCol + ';margin-top:2px">' + s.recommendation + '</div>' +
                '</div>';
              }).join('') || '<div style="color:#4a6070;font-size:11px">No support found</div>';
            })() +
          '</div>' +

          // Flip point context
          '<div>' +
            '<div style="font-size:10px;color:#ffd166;letter-spacing:1px;margin-bottom:10px">&#9646; KEY LEVELS</div>' +
            '<div style="padding:10px 0;border-bottom:1px solid #0d1f2d">' +
              '<div style="font-size:10px;color:#4a6070;margin-bottom:2px">GEX FLIP</div>' +
              '<div class="mono" style="font-size:16px;font-weight:700;color:#ffd166">' + (d.flipPoint || 'N/A') + '</div>' +
              '<div style="font-size:9px;color:#4a6070">regime change level</div>' +
            '</div>' +
            '<div style="padding:10px 0;border-bottom:1px solid #0d1f2d">' +
              '<div style="font-size:10px;color:#4a6070;margin-bottom:2px">NET GEX</div>' +
              '<div class="mono" style="font-size:16px;font-weight:700;color:' + d.regimeColor + '">' + (d.netGEXBillions >= 0 ? '+' : '') + d.netGEXBillions + 'B</div>' +
            '</div>' +
            '<div style="padding:10px 0">' +
              '<div style="font-size:10px;color:#4a6070;margin-bottom:2px">CONTRACTS</div>' +
              '<div class="mono" style="font-size:13px;color:#8aa0b0">' + (d.contractsUsed || 0) + ' used</div>' +
            '</div>' +
          '</div>' +

        '</div>' +

        // Trade rules — both playbooks
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<div style="padding:10px 12px;background:rgba(255,45,85,0.06);border-left:3px solid rgba(255,45,85,0.4);border-radius:0 6px 6px 0;font-size:10px;color:#8aa0b0;line-height:1.8">' +
            '<div style="color:#ff2d55;font-weight:700;margin-bottom:4px">SELL CALLS RULES</div>' +
            'Best in STRONG PIN / MILD PIN<br>' +
            'Sell AT GEX resistance strike<br>' +
            'Stop: close above flip point<br>' +
            'Structure: credit spread or naked (if approved)' +
          '</div>' +
          '<div style="padding:10px 12px;background:rgba(57,255,20,0.06);border-left:3px solid rgba(57,255,20,0.4);border-radius:0 6px 6px 0;font-size:10px;color:#8aa0b0;line-height:1.8">' +
            '<div style="color:#39ff14;font-weight:700;margin-bottom:4px">BUY CALLS RULES</div>' +
            'Best in TRENDING (negative GEX)<br>' +
            'Buy at GEX support / dip entry<br>' +
            'Target: next GEX resistance above<br>' +
            'Structure: debit spread or long call' +
          '</div>' +
        '</div>' +

      '</div>';
  })
  .catch(function(e) { msg.textContent = 'Failed: ' + e.message; msg.style.color='#ff2d55'; });
}

function refreshCTA(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
  fetch('/api/cta/refresh', { method: 'POST' }).then(function() {
    var secs = 30;
    var iv = setInterval(function() {
      secs--;
      if (btn) btn.textContent = 'Refreshing... ' + secs + 's';
      if (secs <= 0) { clearInterval(iv); location.reload(); }
    }, 1000);
    setTimeout(function() { clearInterval(iv); location.reload(); }, 30000);
  }).catch(function() { if (btn) { btn.disabled = false; btn.textContent = '\u21BB Refresh CTA'; } });
}
// Auto-refresh every 5 min
setTimeout(function() { location.reload(); }, 300000);
</script>
</body></html>`;
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
http.createServer(async function(req, res) {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/cta') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(ctaState || { loading: true, running: ctaRunning }));
    return;
  }
  if (req.method === 'POST' && url === '/api/cta/refresh') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running: ctaRunning }));
    if (!ctaRunning) refreshCTA();
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/ticker/')) {
    const symbol = url.replace('/api/ticker/', '').toUpperCase().trim();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    try {
      const result = await scanTickerGEX(symbol);
      res.end(JSON.stringify(result));
    } catch(e) {
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/scan') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    if (!gexRunning) runGEXScan('Manual');
    return;
  }
  if (req.method === 'GET' && url === '/api/gex') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(gexData || { loading: true }));
    return;
  }
  if (req.method === 'POST' && url === '/api/recalc') {
    let body = '';
    req.on('data', function(d) { body += d; });
    req.on('end', async function() {
      try {
        const { spotPrice } = JSON.parse(body);
        const spot = parseFloat(spotPrice);
        if (!spot || isNaN(spot) || spot < 1000 || spot > 20000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid spot price' }));
          return;
        }
        if (!gexData || !gexData.spxGEX || !gexData.spyGEX) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No GEX data yet — run a scan first' }));
          return;
        }
        log('info', 'Pre-market recalc at spot: ' + spot);

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
  }

  if (req.method === 'POST' && url === '/api/test-push') {
    const result = await sendPushover('GEX Test', 'Pushover working for GEX Scanner!', 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderHTML());

}).listen(PORT, '0.0.0.0', function() {
  log('info', 'GEX Scanner running on port ' + PORT);
});

// ─── START ────────────────────────────────────────────────────────────────────
log('info', 'GEX Scanner starting...');
log('info', 'Tradier: ' + (CONFIG.tradierToken ? CONFIG.tradierToken.slice(0,8)+'...' : 'NOT SET'));
log('info', 'Alpaca:  ' + (CONFIG.alpacaKey ? CONFIG.alpacaKey.slice(0,8)+'...' : 'NOT SET'));
log('info', 'Pushover: ' + (CONFIG.pushoverUser ? 'OK' : 'NOT SET'));
startScheduler();
// Run scan 5s after startup
setTimeout(function() { runGEXScan('Startup'); }, 5000);
// Start CTA polling 10s after startup
startCTAPolling();
