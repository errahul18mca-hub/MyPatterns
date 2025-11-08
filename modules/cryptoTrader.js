// modules/cryptoTrader.js
require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// --- CONFIG (single place to manage thresholds/periods) ---
const CONFIG = {
  DELTA_API_URL:     process.env.DELTA_API_URL || "https://api.delta.exchange",
  DELTA_WS_URL:      process.env.DELTA_WS_URL || "wss://socket.delta.exchange",
  FUTURES_SYMBOL:    process.env.FUTURES_SYMBOL || "BTCUSD",
  HIST_SYMBOL:       process.env.HIST_SYMBOL || "BTCUSD",

  TREND_EMA_SHORT:   20,
  TREND_EMA_LONG:    50,

  ATR_PERIOD:        14,
  RSI_PERIOD:        14,
  RSI: { upper: 65, lower: 35 }, // change here once to affect everything

  TREND_UPDATE_INTERVAL: 15 * 1000, // 1 min
  DEBUG: false
};

let socketIO;
const emaCache = { '1 Hour': {ema20:null,ema50:null}, '15 Min': {ema20:null,ema50:null}, '5 Min': {ema20:null,ema50:null} };
const latestDataStore = {};
const LOG_FILE = path.join(__dirname, '..', 'crypto_signals.log');
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "timestamp,mainSignal,scalpSignal,reason\n");

// ---------- helpers ----------
function calculateEMAArray(closes, period) {
  if (!Array.isArray(closes)) return { emaArray: [], last: null };
  const series = closes.filter(c => Number.isFinite(c));
  if (series.length < period) return { emaArray: [], last: null };
  const k = 2 / (period + 1);
  let ema = series.slice(0, period).reduce((a,b)=>a+b,0)/period;
  const arr = Array(period-1).fill(null).concat([ema]);
  for (let i = period; i < series.length; i++) {
    ema = series[i] * k + ema * (1 - k);
    arr.push(ema);
  }
  return { emaArray: arr, last: arr[arr.length-1] };
}
function latestEMA(closes, period) { return calculateEMAArray(closes, period).last; }

function calculateATR(data, period) {
  if (!Array.isArray(data) || data.length < period + 1) return NaN;
  const tr = [];
  for (let i = 1; i < data.length; i++) {
    const high = data[i].high, low = data[i].low, prevClose = data[i-1].close;
    if (![high,low,prevClose].every(Number.isFinite)) continue;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (tr.length < period) return NaN;
  let atr = tr.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period-1) + tr[i]) / period;
  return atr;
}

function rsiFromCloses(closes, period=14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return NaN;
  const deltas = [];
  for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i-1]);
  let up=0, down=0;
  for (let i=0;i<period;i++){ const d=deltas[i]; if (d>0) up+=d; else down+=Math.abs(d); }
  up/=period; down/=period;
  let rs = up / (down || 1e-10);
  let rsi = 100 - (100 / (1 + rs));
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i];
    const gain = d>0?d:0;
    const loss = d<0?Math.abs(d):0;
    up = (up * (period - 1) + gain) / period;
    down = (down * (period - 1) + loss) / period;
    rs = up / (down || 1e-10);
    rsi = 100 - (100 / (1 + rs));
  }
  return rsi;
}

// divergence detection (RSI series required) future we will right
//

// get historical (Delta API)
async function getHistorical(interval, days) {
  const map = { "60min": "1h", "15min": "15m", "5min": "5m" };
  const res = map[interval] || interval;
  const now = Math.floor(Date.now()/1000);
  const start = now - Math.floor(days * 86400);
  const url = `${CONFIG.DELTA_API_URL}/v2/history/candles?symbol=${CONFIG.HIST_SYMBOL}&resolution=${res}&start=${start}&end=${now}`;
  try {
    const { data } = await axios.get(url);
    const raw = Array.isArray(data?.result) ? data.result : [];
    return raw.map(d => ({
      time: Number(d.time),
      open: Number(d.open),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      volume: Number(d.volume || 0)
    })).filter(x => Number.isFinite(x.time) && Number.isFinite(x.close)).sort((a,b)=>a.time-b.time);
  } catch (e) {
    if (CONFIG.DEBUG) console.error('getHistorical error', e.message);
    return [];
  }
}

// calculate trend + emit EMA
function calculateTrend(data, label) {
  if (!Array.isArray(data) || data.length < CONFIG.TREND_EMA_LONG) return 'NEUTRAL';
  const closes = data.map(d=>d.close);
  const ema20 = latestEMA(closes, CONFIG.TREND_EMA_SHORT);
  const ema50 = latestEMA(closes, CONFIG.TREND_EMA_LONG);
  const ltp = closes[closes.length - 1];
  if (![ema20, ema50, ltp].every(Number.isFinite)) return 'NEUTRAL';
  emaCache[label] = { ema20, ema50 };
  socketIO?.emit('cryptoEmaUpdate', { timeframe: label, ema20: Number(ema20.toFixed(2)), ema50: Number(ema50.toFixed(2)) });
  if (ltp > ema20 && ema20 > ema50) return 'BULLISH';
  if (ltp < ema20 && ema20 < ema50) return 'BEARISH';
  return 'NEUTRAL';
}

// decide signals (backend authoritative)
function decideMainSignal({ trend15, rsi15, atr15 }) {
  const lastPrice = latestDataStore[CONFIG.FUTURES_SYMBOL]?.LTP || 1;
  const atrPct = isFinite(atr15) && lastPrice>0 ? (atr15/lastPrice)*100 : 0;
  const minAtrPct = 0.03; // tuneable
  if (!trend15 || trend15 === 'NEUTRAL') return { signal: 'NO TRADE', reason: 'trend-neutral' };
  if (atrPct < minAtrPct) return { signal: 'NO TRADE', reason: 'low-vol' };
  const { upper, lower } = CONFIG.RSI;
  if (trend15 === 'BEARISH') {
    if (!isFinite(rsi15)) return { signal: 'NO TRADE', reason: 'rsi-missing' };
    if (rsi15 >= upper ) return { signal: 'SHORT', reason: `rsi=${rsi15.toFixed(2)}` };
    return { signal: 'NO TRADE', reason: 'rsi-not-in-zone' };
  }
  if (trend15 === 'BULLISH') {
    if (!isFinite(rsi15)) return { signal: 'NO TRADE', reason: 'rsi-missing' };
    if (rsi15 <= lower ) return { signal: 'LONG', reason: `rsi=${rsi15.toFixed(2)}` };
    return { signal: 'NO TRADE', reason: 'rsi-not-in-zone' };
  }
  return { signal: 'NO TRADE', reason: 'fallback' };
}

function decideScalpSignal({ trend5, rsi5, atr5 }) {
  const lastPrice = latestDataStore[CONFIG.FUTURES_SYMBOL]?.LTP || 1;
  const atrPct = isFinite(atr5) && lastPrice>0 ? (atr5/lastPrice)*100 : 0;
  const minAtrPct = 0.02;
  if (!trend5 || trend5 === 'NEUTRAL') return { signal: 'SCALP NO TRADE', reason: 'trend-neutral' };
  if (atrPct < minAtrPct) return { signal: 'SCALP NO TRADE', reason: 'low-vol' };
  const { upper, lower } = CONFIG.RSI;
  if (trend5 === 'BEARISH') {
    if (!isFinite(rsi5)) return { signal: 'SCALP NO TRADE', reason: 'rsi-missing' };
    if (rsi5 >= upper ) return { signal: 'SCALP SHORT', reason: `rsi=${rsi5.toFixed(2)}` };
    return { signal: 'SCALP NO TRADE', reason: 'rsi-not-in-zone' };
  }
  if (trend5 === 'BULLISH') {
    if (!isFinite(rsi5)) return { signal: 'SCALP NO TRADE', reason: 'rsi-missing' };
    if (rsi5 <= lower ) return { signal: 'SCALP LONG', reason: `rsi=${rsi5.toFixed(2)}` };
    return { signal: 'SCALP NO TRADE', reason: 'rsi-not-in-zone' };
  }
  return { signal: 'SCALP NO TRADE', reason: 'fallback' };
}

// main update flow
async function updateTrendsAndIndicators() {
  try {
    const [h1, m15, m5] = await Promise.all([
      getHistorical('60min', 7),
      getHistorical('15min', 3),
      getHistorical('5min', 2)
    ]);

    // --- Calculate and emit EMA trends ---
    const trend1h = h1.length ? calculateTrend(h1, '1 Hour') : 'NEUTRAL';
    const trend15 = m15.length ? calculateTrend(m15, '15 Min') : 'NEUTRAL';
    const trend5  = m5.length ? calculateTrend(m5, '5 Min')  : 'NEUTRAL';

    socketIO.emit('cryptoMarketTrend', {
      '1 Hour': trend1h,
      '15 Min': trend15,
      '5 Min' : trend5
    });

    // --- 15-Minute Frame Indicators ---
    if (m15.length) {
      const atr15 = calculateATR(m15, CONFIG.ATR_PERIOD);
      socketIO.emit('cryptoAtrUpdate', {
        value: Number(isFinite(atr15) ? atr15.toFixed(6) : NaN),
        timeframe: '15min'
      });

      const closes15 = m15.map(d => d.close);
      const rsi15 = rsiFromCloses(closes15, CONFIG.RSI_PERIOD);
      socketIO.emit('cryptoRsiUpdate', {
        timeframe: '15min',
        rsi: Number(isFinite(rsi15) ? rsi15.toFixed(2) : NaN)
      });

      const mainDecision = decideMainSignal({
        trend15,
        rsi15,
        atr15
      });

      socketIO.emit('cryptoMainSignal', mainDecision);
    }

    // --- 5-Minute Frame Indicators ---
    if (m5.length) {
      const atr5 = calculateATR(m5, CONFIG.ATR_PERIOD);
      socketIO.emit('cryptoAtrUpdate', {
        value: Number(isFinite(atr5) ? atr5.toFixed(6) : NaN),
        timeframe: '5min'
      });

      const closes5 = m5.map(d => d.close);
      const rsi5 = rsiFromCloses(closes5, CONFIG.RSI_PERIOD);
      socketIO.emit('cryptoRsiUpdate', {
        timeframe: '5min',
        rsi: Number(isFinite(rsi5) ? rsi5.toFixed(2) : NaN)
      });

      const scalpDecision = decideScalpSignal({
        trend5,
        rsi5,
        atr5
      });

      socketIO.emit('cryptoScalpSignal', scalpDecision);
    }

    if (CONFIG.DEBUG) {
      console.log('Indicators updated:', { trend1h, trend15, trend5 });
    }

  } catch (err) {
    console.error('updateTrendsAndIndicators error:', err.message);
  }
}

// WS to get LTP quickly
function connectWebSocket() {
  try {
    const ws = new WebSocket(CONFIG.DELTA_WS_URL);
    ws.on('open', ()=> {
      ws.send(JSON.stringify({ type: "subscribe", payload: { channels: [{ name: "v2/ticker", symbols: [CONFIG.FUTURES_SYMBOL] }] } }));
    });
    ws.on('message', msg => {
      try {
        const d = JSON.parse(msg);
        if (d.type === 'v2/ticker' && d.symbol === CONFIG.FUTURES_SYMBOL) {
          const ltp = Number(d.close ?? d.last ?? d.price);
          latestDataStore[CONFIG.FUTURES_SYMBOL] = { LTP: ltp };
          socketIO.emit('cryptoSpot', { symbol: CONFIG.FUTURES_SYMBOL, ltp });
          socketIO.emit('cryptoAtm', { atm: Math.round(ltp || 0) });
        }
        if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (e) {
        if (CONFIG.DEBUG) console.error('ws parse error', e.message);
      }
    });
    ws.on('error', () => setTimeout(connectWebSocket, 3000));
    ws.on('close', () => setTimeout(connectWebSocket, 3000));
  } catch (e) {
    if (CONFIG.DEBUG) console.error('ws start error', e.message);
    setTimeout(connectWebSocket, 3000);
  }
}

function init(io) {
  socketIO = io;
  // Start initial run and schedule
  updateTrendsAndIndicators();
  setInterval(updateTrendsAndIndicators, CONFIG.TREND_UPDATE_INTERVAL);
  connectWebSocket();
  console.log('CryptoTrader initialized (backend authoritative signals)');
}

module.exports = { init, CONFIG };
