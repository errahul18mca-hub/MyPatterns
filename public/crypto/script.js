// public/crypto/script.js
(function () {
  'use strict';
  const socket = io();
  const DEBUG = false;

  // small helpers
  const $ = id => document.getElementById(id);
  const safeText = (el, txt) => { if (!el) return; el.textContent = (txt == null ? '-' : txt); };
  const fmt = v => (v == null || Number.isNaN(Number(v))) ? '-' : Number(v).toLocaleString();

  // UI helpers (chips and master signal)
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
  // blink effect disable kar diya
  return; // kuch nahi karega
}

  // Bind generic events for a symbol to a set of element IDs (prefix used for ETH)
  function bindSymbol(prefix, symbol) {
    // element ids for this symbol
    const ids = {
      spot: prefix + (prefix === '' ? 'spot-ltp' : 'spot-ltp'), // BTC uses "spot-ltp", ETH uses "eth-spot-ltp"
      atm: prefix + (prefix === '' ? 'atm' : 'atm'),            // BTC "atm", ETH "eth-atm"
      trend1h: prefix + (prefix === '' ? 'trend-1-hour' : 'trend-1-hour'),
      trend15: prefix + (prefix === '' ? 'trend-15-min' : 'trend-15-min'),
      trend5: prefix + (prefix === '' ? 'trend-5-min' : 'trend-5-min'),

      ema20_1h: prefix + (prefix === '' ? 'ema20-1h' : 'ema20-1h'),
      ema50_1h: prefix + (prefix === '' ? 'ema50-1h' : 'ema50-1h'),

      ema20_15: prefix + (prefix === '' ? 'ema20-15m' : 'ema20-15m'),
      ema50_15: prefix + (prefix === '' ? 'ema50-15m' : 'ema50-15m'),

      ema20_5: prefix + (prefix === '' ? 'ema20-5m' : 'ema20-5m'),
      ema50_5: prefix + (prefix === '' ? 'ema50-5m' : 'ema50-5m'),

      mainTrend: prefix + (prefix === '' ? 'main-trend' : 'main-trend'),
      rsi15: prefix + (prefix === '' ? 'ui-rsi-15m' : 'ui-rsi-15m'),
      atr15: prefix + (prefix === '' ? 'ui-atr-15m' : 'ui-atr-15m'),
      mainSignal: prefix + (prefix === '' ? 'ui-main-signal' : 'ui-main-signal'),

      scalpTrend5: prefix + (prefix === '' ? 'ui-trend-5m' : 'ui-trend-5m'),
      rsi5: prefix + (prefix === '' ? 'ui-rsi-5m' : 'ui-rsi-5m'),
      atr5: prefix + (prefix === '' ? 'ui-atr-5m' : 'ui-atr-5m'),
      scalpSignal: prefix + (prefix === '' ? 'ui-scalp-signal' : 'ui-scalp-signal'),
    };

    // Resolve elements
    const el = {};
    Object.keys(ids).forEach(k => el[k] = $(ids[k]));

    // SOCKET: spot (LTP)
    socket.on(`cryptoSpot_${symbol}`, ({ ltp } = {}) => {
      // for BTC we display symbol text in spot-ltp; for ETH we use eth-spot-ltp
      if (el.spot) {
        // show symbol name (server sends symbol in payload in some cases; but keep symbol param)
        el.spot.textContent = symbol;
      }
      if (el.atm) safeText(el.atm, fmt(ltp));
      flashUpdate(el.atm);
      if (DEBUG) console.log(symbol, 'LTP ->', ltp);
    });

    // SOCKET: atm update (rounded)
    socket.on(`cryptoAtm_${symbol}`, ({ atm } = {}) => {
      if (el.atm) safeText(el.atm, fmt(atm));
      flashUpdate(el.atm);
    });

    // SOCKET: market trend (1h/15m/5m)
    socket.on(`cryptoMarketTrend_${symbol}`, (trends = {}) => {
      if (el.trend1h) setChip(el.trend1h, trends['1 Hour']);
      if (el.trend15) setChip(el.trend15, trends['15 Min']);
      if (el.trend5) setChip(el.trend5, trends['5 Min']);

      if (el.mainTrend) safeText(el.mainTrend, trends['15 Min'] || '-');
      if (el.scalpTrend5) safeText(el.scalpTrend5, trends['5 Min'] || '-');
    });

    // SOCKET: EMA updates
    socket.on(`cryptoEmaUpdate_${symbol}`, ({ timeframe, ema20, ema50 } = {}) => {
      if (!timeframe) return;
      const tf = String(timeframe).toLowerCase();
      if (/1\s*h/i.test(timeframe)) {
        if (el.ema20_1h) safeText(el.ema20_1h, ema20 == null ? '-' : Number(ema20).toFixed(2));
        if (el.ema50_1h) safeText(el.ema50_1h, ema50 == null ? '-' : Number(ema50).toFixed(2));
        flashUpdate(el.ema20_1h);
      } else if (/15/.test(tf)) {
        if (el.ema20_15) safeText(el.ema20_15, ema20 == null ? '-' : Number(ema20).toFixed(2));
        if (el.ema50_15) safeText(el.ema50_15, ema50 == null ? '-' : Number(ema50).toFixed(2));
        flashUpdate(el.ema20_15);
      } else if (/5/.test(tf)) {
        if (el.ema20_5) safeText(el.ema20_5, ema20 == null ? '-' : Number(ema20).toFixed(2));
        if (el.ema50_5) safeText(el.ema50_5, ema50 == null ? '-' : Number(ema50).toFixed(2));
        flashUpdate(el.ema20_5);
      }
    });

    // SOCKET: RSI updates
    socket.on(`cryptoRsiUpdate_${symbol}`, ({ timeframe, rsi } = {}) => {
      const val = (rsi == null ? '-' : Number(rsi).toFixed(2));
      if (/15/.test(String(timeframe)) && el.rsi15) safeText(el.rsi15, val);
      if (/5/.test(String(timeframe)) && el.rsi5) safeText(el.rsi5, val);
    });

    // SOCKET: ATR updates
    socket.on(`cryptoAtrUpdate_${symbol}`, ({ value, timeframe } = {}) => {
      const val = (value == null ? '-' : Number(value).toFixed(2));
      if (/15/.test(String(timeframe)) && el.atr15) safeText(el.atr15, val);
      if (/5/.test(String(timeframe)) && el.atr5) safeText(el.atr5, val);
    });

    // SOCKET: main strategy signal
    socket.on(`cryptoMainSignal_${symbol}`, ({ signal, reason } = {}) => {
      const txt = reason ? `${signal} (${reason})` : (signal || 'WAITING...');
      if (el.mainSignal) setMaster(el.mainSignal, txt);
      flashUpdate(el.mainSignal);
    });

    // SOCKET: scalp strategy signal
    socket.on(`cryptoScalpSignal_${symbol}`, ({ signal, reason } = {}) => {
      const txt = reason ? `${signal} (${reason})` : (signal || 'WAITING...');
      if (el.scalpSignal) setMaster(el.scalpSignal, txt);
      flashUpdate(el.scalpSignal);
    });

    // connect/disconnect visuals (only change top-level live-dot for BTC panel)
    if (prefix === '') {
      socket.on('connect', () => {
        const ld = $('live-dot');
        if (ld) ld.className = 'live ok';
        if (DEBUG) console.log('socket connected');
      });
      socket.on('disconnect', () => {
        const ld = $('live-dot');
        if (ld) ld.className = 'live';
        if (DEBUG) console.log('socket disconnected');
      });
    }

    // set initial safe defaults
    setChip(el.trend1h, 'NEUTRAL');
    setChip(el.trend15, 'NEUTRAL');
    setChip(el.trend5, 'NEUTRAL');
    setMaster(el.mainSignal, 'WAITING...');
    setMaster(el.scalpSignal, 'WAITING...');
  }

  // Initialize bindings for BTC and ETH
  // Note: HTML uses "spot-ltp" and "atm" for BTC; ETH element ids use the "eth-" prefix.
  bindSymbol('', 'BTCUSD');        // BTC uses IDs without prefix
  bindSymbol('eth-', 'ETHUSD');    // ETH uses IDs prefixed with "eth-"

  // Debug helper to log incoming events (optional)
  if (DEBUG) {
    const evs = [
      'cryptoSpot_BTCUSD','cryptoAtm_BTCUSD','cryptoMarketTrend_BTCUSD','cryptoEmaUpdate_BTCUSD','cryptoRsiUpdate_BTCUSD','cryptoAtrUpdate_BTCUSD','cryptoMainSignal_BTCUSD','cryptoScalpSignal_BTCUSD',
      'cryptoSpot_ETHUSD','cryptoAtm_ETHUSD','cryptoMarketTrend_ETHUSD','cryptoEmaUpdate_ETHUSD','cryptoRsiUpdate_ETHUSD','cryptoAtrUpdate_ETHUSD','cryptoMainSignal_ETHUSD','cryptoScalpSignal_ETHUSD'
    ];
    evs.forEach(e => socket.on(e, data => console.log('[SOCKET]', e, data)));
  }
})();
