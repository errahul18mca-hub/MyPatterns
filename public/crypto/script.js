// public/crypto/script.js

const socket = io();

// ---------- Formatting ----------
const formatNum = (val) =>
  val !== undefined && val !== null && !Number.isNaN(Number(val))
    ? parseFloat(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '-';

// ---------- Header DOM ----------
const atmEl = document.getElementById('atm');
const spotEl = document.getElementById('spot-ltp');
const atrValueEl = document.getElementById('atr-value');
const liveDot = document.getElementById('live-dot');

// 3m deltas
const deltaOi3mEl = document.getElementById('delta-oi-3m');
const deltaPrice3mEl = document.getElementById('delta-price-3m');
const deltaVol3mEl = document.getElementById('delta-vol-3m');

// ---------- Trend chips ----------
const trend1hChip = document.getElementById('trend-1-hour');
const trend15mChip = document.getElementById('trend-15-min');
const trend5mChip = document.getElementById('trend-5-min');

// EMA labels per TF
const ema20_1h = document.getElementById('ema20-1h');
const ema50_1h = document.getElementById('ema50-1h');
const ema20_15m = document.getElementById('ema20-15m');
const ema50_15m = document.getElementById('ema50-15m');
const ema20_5m = document.getElementById('ema20-5m');
const ema50_5m = document.getElementById('ema50-5m');

// ---------- Intraday elements ----------
const intradayTrend1hEl = document.getElementById('intraday-trend-1h');
const intradayTrend15mEl = document.getElementById('intraday-trend-15m');
const intradayOiSignalEl = document.getElementById('intraday-oi-signal');
const intradayAtrFilterEl = document.getElementById('intraday-atr-filter');
const intradayScoreEl = document.getElementById('intraday-score');
const intradayMasterSignalEl = document.getElementById('intraday-master-signal');

// ---------- Scalping elements ----------
const scalpTrend5mEl = document.getElementById('scalp-trend-5m');
const scalpOiSignalEl = document.getElementById('scalp-oi-signal');
const scalpVolConfirmEl = document.getElementById('scalp-vol-confirm');
const scalpAtrFilterEl = document.getElementById('scalp-atr-filter');
const scalpScoreEl = document.getElementById('scalp-score');
const scalpMasterSignalEl = document.getElementById('scalp-master-signal');

// ---------- State ----------
let marketTrend = {};
let latestOiSignal = { ce: 'WAITING...', pe: 'WAITING...', volConfCE: false, volConfPE: false };
let currentIntradaySignal = 'WAITING...';
let currentScalpSignal = 'WAITING...';
let currentAtr = 0;
const ATR_THRESHOLD = 50;
let calculationTimeout;

// ---------- UI helpers ----------
function updateMatrixItem(element, text, type) {
  if (!element) return;
  element.textContent = text;
  element.className = 'value';
  if (type === 'trend') element.classList.add(String(text).toLowerCase());
  else if (type === 'filter') element.classList.add(text === 'ACTIVE' ? 'active' : 'inactive');
  else if (type === 'vol') element.classList.add(text === 'YES' ? 'yes' : 'no');
  else element.classList.add('neutral');
}

function setMasterSignal(element, text, cssClass, stateVar) {
  if (!element) return;
  if (text === stateVar) return;
  if (element === intradayMasterSignalEl) currentIntradaySignal = text;
  if (element === scalpMasterSignalEl) currentScalpSignal = text;
  element.textContent = text;
  element.className = `master-signal-box ${cssClass}`;
}

function debounceMasterSignalCalc() {
  clearTimeout(calculationTimeout);
  calculationTimeout = setTimeout(runAllCalculations, 300);
}
function runAllCalculations() {
  calculateIntradaySignal();
  calculateScalpingSignal();
}
function setEmaUI(tf, e20, e50) {
  const e20Txt = (e20 ?? '-');
  const e50Txt = (e50 ?? '-');
  if (tf === '1 Hour')      { ema20_1h.textContent = e20Txt; ema50_1h.textContent = e50Txt; }
  else if (tf === '15 Min') { ema20_15m.textContent = e20Txt; ema50_15m.textContent = e50Txt; }
  else if (tf === '5 Min')  { ema20_5m.textContent = e20Txt; ema50_5m.textContent = e50Txt; }
}
function setTrendChip(el, text) {
  if (!el) return;
  el.textContent = text || '...';
  el.className = 'chip ' + (text ? String(text).toLowerCase() : 'neutral');
}

// ---------- Intraday logic ----------
function calculateIntradaySignal() {
  let score = 0;

  const isAtrOk = currentAtr > ATR_THRESHOLD;
  updateMatrixItem(intradayAtrFilterEl, isAtrOk ? 'ACTIVE' : 'INACTIVE', 'filter');
  if (!isAtrOk) {
    setMasterSignal(intradayMasterSignalEl, 'LOW VOLATILITY', 'signal-neutral', currentIntradaySignal);
    intradayScoreEl.textContent = 'N/A';
    return;
  }

  const trend1h = marketTrend['1 Hour'] || 'NEUTRAL';
  const trend15m = marketTrend['15 Min'] || 'NEUTRAL';
  updateMatrixItem(intradayTrend1hEl, trend1h, 'trend');
  updateMatrixItem(intradayTrend15mEl, trend15m, 'trend');

  let trendScore = 0;
  if (trend1h === 'BULLISH' && trend15m === 'BULLISH') trendScore = 1;
  else if (trend1h === 'BEARISH' && trend15m === 'BEARISH') trendScore = -1;
  else {
    setMasterSignal(intradayMasterSignalEl, 'MIXED TREND', 'signal-neutral', currentIntradaySignal);
    intradayScoreEl.textContent = '0';
    updateMatrixItem(intradayOiSignalEl, '--', 'neutral');
    return;
  }
  score += trendScore;

  let oiScore = 0;
  let combinedOiSignal = 'NEUTRAL';
  if (trendScore === 1) {
    if (latestOiSignal.ce === 'LONG BUILDUP' || latestOiSignal.ce === 'SHORT COVERING') {
      oiScore = 1; combinedOiSignal = latestOiSignal.ce;
    }
  } else if (trendScore === -1) {
    if (latestOiSignal.pe === 'LONG BUILDUP' || latestOiSignal.pe === 'SHORT COVERING') {
      oiScore = -1; combinedOiSignal = latestOiSignal.pe;
    }
  }
  score += oiScore;

  updateMatrixItem(
    intradayOiSignalEl,
    combinedOiSignal === 'NEUTRAL' ? '--' : combinedOiSignal,
    combinedOiSignal === 'NEUTRAL' ? 'neutral' : (oiScore > 0 ? 'bullish' : 'bearish')
  );

  intradayScoreEl.textContent = score;
  if (score >= 2) setMasterSignal(intradayMasterSignalEl, 'BUY LONG', 'signal-bullish', currentIntradaySignal);
  else if (score <= -2) setMasterSignal(intradayMasterSignalEl, 'SELL SHORT', 'signal-bearish', currentIntradaySignal);
  else setMasterSignal(intradayMasterSignalEl, 'NEUTRAL', 'signal-neutral', currentIntradaySignal);
}

// ---------- Scalping logic ----------
function calculateScalpingSignal() {
  let score = 0;

  const isAtrOk = currentAtr > ATR_THRESHOLD;
  updateMatrixItem(scalpAtrFilterEl, isAtrOk ? 'ACTIVE' : 'INACTIVE', 'filter');
  if (!isAtrOk) {
    setMasterSignal(scalpMasterSignalEl, 'LOW VOLATILITY', 'signal-neutral', currentScalpSignal);
    scalpScoreEl.textContent = 'N/A';
    return;
  }

  const trend5m = marketTrend['5 Min'] || 'NEUTRAL';
  updateMatrixItem(scalpTrend5mEl, trend5m, 'trend');

  let trendScore = 0;
  if (trend5m === 'BULLISH') trendScore = 1;
  else if (trend5m === 'BEARISH') trendScore = -1;
  else {
    setMasterSignal(scalpMasterSignalEl, 'NEUTRAL TREND', 'signal-neutral', currentScalpSignal);
    scalpScoreEl.textContent = '0';
    updateMatrixItem(scalpOiSignalEl, '--', 'neutral');
    updateMatrixItem(scalpVolConfirmEl, '--', 'neutral');
    return;
  }
  score += trendScore;

  let oiScore = 0;
  let combinedOiSignal = 'NEUTRAL';
  let volConfirmed = false;

  if (trendScore === 1) {
    if (latestOiSignal.ce === 'LONG BUILDUP' || latestOiSignal.ce === 'SHORT COVERING') {
      oiScore = 1; combinedOiSignal = latestOiSignal.ce; volConfirmed = latestOiSignal.volConfCE;
    }
  } else if (trendScore === -1) {
    if (latestOiSignal.pe === 'LONG BUILDUP' || latestOiSignal.pe === 'SHORT COVERING') {
      oiScore = -1; combinedOiSignal = latestOiSignal.pe; volConfirmed = latestOiSignal.volConfPE;
    }
  }
  score += oiScore;

  let volScore = 0;
  if (oiScore !== 0) {
    if ((combinedOiSignal === 'LONG BUILDUP' || combinedOiSignal === 'SHORT BUILDUP') && volConfirmed) {
      volScore = (oiScore > 0) ? 1 : -1;
    }
  }
  score += volScore;

  updateMatrixItem(
    scalpOiSignalEl,
    combinedOiSignal === 'NEUTRAL' ? '--' : combinedOiSignal,
    combinedOiSignal === 'NEUTRAL' ? 'neutral' : (oiScore > 0 ? 'bullish' : 'bearish')
  );
  updateMatrixItem(scalpVolConfirmEl, oiScore === 0 ? '--' : (volConfirmed ? 'YES' : 'NO'), 'vol');

  scalpScoreEl.textContent = score;
  if (score >= 2) setMasterSignal(scalpMasterSignalEl, 'SCALP LONG', 'signal-bullish', currentScalpSignal);
  else if (score <= -2) setMasterSignal(scalpMasterSignalEl, 'SCALP SHORT', 'signal-bearish', currentScalpSignal);
  else setMasterSignal(scalpMasterSignalEl, 'NEUTRAL', 'signal-neutral', currentScalpSignal);
}

// ---------- Socket status ----------
socket.on('connect', () => { if (liveDot) liveDot.className = 'live ok'; });
socket.on('disconnect', () => { if (liveDot) liveDot.className = 'live'; });
socket.io.on('error', () => { if (liveDot) liveDot.className = 'live err'; });

// ---------- Socket listeners ----------
socket.on('cryptoSpot', ({ symbol, ltp }) => {
  if (spotEl) spotEl.textContent = symbol;
  if (atmEl) atmEl.textContent = formatNum(ltp);
});
socket.on('cryptoAtm', ({ atm }) => {
  if (atmEl) atmEl.textContent = formatNum(atm);
});
socket.on('cryptoAtrUpdate', ({ value }) => {
  currentAtr = parseFloat(value);
  if (atrValueEl) {
    atrValueEl.textContent = formatNum(value);
    atrValueEl.className = currentAtr > ATR_THRESHOLD ? 'atr-good' : 'atr-bad';
  }
  debounceMasterSignalCalc();
});
socket.on('cryptoMarketTrend', (trends) => {
  marketTrend = trends || {};
  setTrendChip(trend1hChip, trends['1 Hour'] || 'NEUTRAL');
  setTrendChip(trend15mChip, trends['15 Min'] || 'NEUTRAL');
  setTrendChip(trend5mChip, trends['5 Min'] || 'NEUTRAL');
  updateMatrixItem(intradayTrend1hEl, trends['1 Hour'] || 'NEUTRAL', 'trend');
  updateMatrixItem(intradayTrend15mEl, trends['15 Min'] || 'NEUTRAL', 'trend');
  updateMatrixItem(scalpTrend5mEl, trends['5 Min'] || 'NEUTRAL', 'trend');
  debounceMasterSignalCalc();
});
socket.on('cryptoEmaUpdate', ({ timeframe, ema20, ema50 }) => {
  setEmaUI(timeframe, ema20, ema50);
});
socket.on('cryptoDelta3m', ({ oiChangePct, priceChangePct, volumeChange }) => {
  if (deltaOi3mEl) deltaOi3mEl.textContent = `${oiChangePct}% | Price ${priceChangePct}%`;
  if (deltaPrice3mEl) deltaPrice3mEl.textContent = `${priceChangePct}%`;
  if (deltaVol3mEl) deltaVol3mEl.textContent = `${Number(volumeChange).toLocaleString()}`;
});
socket.on('cryptoOptionChain', (data) => {
  if (!data || !data.symbol) return;
  if (data.symbol === 'BTC_CE') {
    latestOiSignal.ce = data.signal;
    latestOiSignal.volConfCE = !!data.volConfirmed;
  } else if (data.symbol === 'BTC_PE') {
    latestOiSignal.pe = data.signal;
    latestOiSignal.volConfPE = !!data.volConfirmed;
  }
  debounceMasterSignalCalc();
});

// ---------- Safe defaults ----------
setTrendChip(trend1hChip, 'NEUTRAL');
setTrendChip(trend15mChip, 'NEUTRAL');
setTrendChip(trend5mChip, 'NEUTRAL');
updateMatrixItem(intradayTrend1hEl, 'NEUTRAL', 'trend');
updateMatrixItem(intradayTrend15mEl, 'NEUTRAL', 'trend');
updateMatrixItem(scalpTrend5mEl, 'NEUTRAL', 'trend');
