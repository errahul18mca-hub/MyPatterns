// public/crypto/script.js (UI-Enhanced Version)
(function () {
  'use strict';
  const socket = io();
  const DEBUG = false;

  const $ = id => document.getElementById(id);
  const safeText = (el, txt) => { if (el) el.textContent = (txt == null ? '-' : txt); };

  // ---- DOM Elements ----
  const liveDot = $('live-dot');
  const atmEl = $('atm');
  const spotEl = $('spot-ltp');

  const trend1h = $('trend-1-hour');
  const trend15 = $('trend-15-min');
  const trend5 = $('trend-5-min');

  const ema20_1h = $('ema20-1h'), ema50_1h = $('ema50-1h');
  const ema20_15 = $('ema20-15m'), ema50_15 = $('ema50-15m');
  const ema20_5 = $('ema20-5m'), ema50_5 = $('ema50-5m');

  const uiMainTrend = $('main-trend');
  const uiRsi15 = $('ui-rsi-15m');
  const uiDiv15 = $('ui-div-15m');
  const uiAtr15 = $('ui-atr-15m');
  const uiMainSignal = $('ui-main-signal');

  const uiScalpTrend5 = $('ui-trend-5m');
  const uiRsi5 = $('ui-rsi-5m');
  const uiDiv5 = $('ui-div-5m');
  const uiAtr5 = $('ui-atr-5m');
  const uiScalpSignal = $('ui-scalp-signal');

  // ---- Helpers ----
  function setChip(el, label) {
    if (!el) return;
    const t = (label || 'NEUTRAL').toString().toUpperCase();
    el.textContent = t;
    el.className = 'chip ' + (
      t.includes('BULL') ? 'bullish' :
      t.includes('BEAR') ? 'bearish' : 'neutral'
    );
  }

  function setMaster(el, text) {
    if (!el) return;
    const t = (text || 'WAITING...').toString();
    el.textContent = t;
    const lc = t.toLowerCase();
    el.className =
      lc.includes('long') || lc.includes('buy') ? 'master-signal buy' :
      lc.includes('short') || lc.includes('sell') ? 'master-signal sell' :
      'master-signal neutral';
  }

  function flashUpdate(el) {
    if (!el) return;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 600);
  }

  // ---- SOCKET EVENTS ----
  socket.on('connect', () => {
    if (liveDot) liveDot.className = 'live ok';
    if (DEBUG) console.log('Socket connected');
  });

  socket.on('disconnect', () => {
    if (liveDot) liveDot.className = 'live';
    if (DEBUG) console.log('Socket disconnected');
  });

  socket.on('cryptoSpot', ({ symbol, ltp } = {}) => {
    safeText(spotEl, symbol || '-');
    safeText(atmEl, Number(ltp ?? 0).toLocaleString());
  });

  socket.on('cryptoAtm', ({ atm } = {}) => {
    safeText(atmEl, atm == null ? '-' : Number(atm).toLocaleString());
  });

  socket.on('cryptoMarketTrend', (trends = {}) => {
    setChip(trend1h, trends['1 Hour']);
    setChip(trend15, trends['15 Min']);
    setChip(trend5, trends['5 Min']);

    safeText(uiMainTrend, trends['15 Min'] || '-');
    safeText(uiScalpTrend5, trends['5 Min'] || '-');
  });

  socket.on('cryptoEmaUpdate', ({ timeframe, ema20, ema50 } = {}) => {
    if (!timeframe) return;
    if (/1\s*h/i.test(timeframe)) {
      safeText(ema20_1h, ema20 ?? '-'); safeText(ema50_1h, ema50 ?? '-');
      flashUpdate(ema20_1h);
    } else if (/15/.test(timeframe)) {
      safeText(ema20_15, ema20 ?? '-'); safeText(ema50_15, ema50 ?? '-');
      flashUpdate(ema20_15);
    } else if (/5/.test(timeframe)) {
      safeText(ema20_5, ema20 ?? '-'); safeText(ema50_5, ema50 ?? '-');
      flashUpdate(ema20_5);
    }
  });

  socket.on('cryptoRsiUpdate', ({ timeframe, rsi } = {}) => {
    const val = (rsi == null ? '-' : Number(rsi).toFixed(2));
    if (/15/.test(String(timeframe))) safeText(uiRsi15, val);
    if (/5/.test(String(timeframe))) safeText(uiRsi5, val);
  });



  socket.on('cryptoAtrUpdate', ({ value, timeframe } = {}) => {
    const val = (value == null ? '-' : Number(value).toFixed(2));
    if (/15/.test(String(timeframe))) safeText(uiAtr15, val);
    if (/5/.test(String(timeframe))) safeText(uiAtr5, val);
  });

  socket.on('cryptoMainSignal', ({ signal, reason } = {}) => {
    setMaster(uiMainSignal, reason ? `${signal} (${reason})` : signal);
    //flashUpdate(uiMainSignal);
  });

  socket.on('cryptoScalpSignal', ({ signal, reason } = {}) => {
    setMaster(uiScalpSignal, reason ? `${signal} (${reason})` : signal);
    //flashUpdate(uiScalpSignal);
  });

  socket.on('cryptoConfig', cfg => {
    if (DEBUG) console.log('Config received', cfg);
  });

  // ---- Initial Defaults ----
  setChip(trend1h, 'NEUTRAL');
  setChip(trend15, 'NEUTRAL');
  setChip(trend5, 'NEUTRAL');
  setMaster(uiMainSignal, 'WAITING...');
  setMaster(uiScalpSignal, 'WAITING...');
})();
