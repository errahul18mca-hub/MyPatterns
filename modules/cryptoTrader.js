// modules/cryptoTrader.js (BTC + ETH dual support)
require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// --- CONFIG ---
const CONFIG = {
  DELTA_API_URL: process.env.DELTA_API_URL || "https://api.delta.exchange",
  DELTA_WS_URL: process.env.DELTA_WS_URL || "wss://socket.delta.exchange",
  SYMBOLS: ["BTCUSD", "ETHUSD"],   // ✅ both assets
  TREND_EMA_SHORT: 20,
  TREND_EMA_LONG: 50,
  TREND_EMA_SUPERLONG: 200,   // ✅ Add this line
  ATR_PERIOD: 14,
  RSI_PERIOD: 14,
  RSI: { upper: 60, lower: 40 },
  TREND_UPDATE_INTERVAL: 15 * 1000,
  DEBUG: false
};

// runtime storage
let socketIO;
const emaCache = {};
const latestDataStore = {};
const LOG_FILE = path.join(__dirname, '..', 'crypto_signals.log');
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "timestamp,symbol,mainSignal,scalpSignal,reason\n");

// ---------- helpers ----------
function calculateEMAArray(closes, period) {
  const series = closes.filter(c => Number.isFinite(c));
  if (series.length < period) return { emaArray: [], last: null };
  const k = 2 / (period + 1);
  let ema = series.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const arr = Array(period - 1).fill(null).concat([ema]);
  for (let i = period; i < series.length; i++) {
    ema = series[i] * k + ema * (1 - k);
    arr.push(ema);
  }
  return { emaArray: arr, last: arr[arr.length - 1] };
}
const latestEMA = (closes, period) => calculateEMAArray(closes, period).last;

function calculateATR(data, period) {
  if (data.length < period + 1) return NaN;
  const tr = [];
  for (let i = 1; i < data.length; i++) {
    const high = data[i].high, low = data[i].low, prevClose = data[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

function rsiFromCloses(closes, period = 14) {
  if (closes.length < period + 1) return NaN;
  const deltas = closes.map((v, i, a) => (i ? v - a[i - 1] : 0)).slice(1);
  let up = 0, down = 0;
  for (let i = 0; i < period; i++) { const d = deltas[i]; if (d > 0) up += d; else down += -d; }
  up /= period; down /= period;
  let rs = up / (down || 1e-10);
  let rsi = 100 - 100 / (1 + rs);
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    up = (up * (period - 1) + gain) / period;
    down = (down * (period - 1) + loss) / period;
    rs = up / (down || 1e-10);
    rsi = 100 - 100 / (1 + rs);
  }
  return rsi;
}

// --- API Fetch ---
async function getHistorical(symbol, interval, days) {
  const map = { "60min": "1h", "15min": "15m", "5min": "5m" };
  const res = map[interval] || interval;
  const now = Math.floor(Date.now() / 1000);
  const start = now - Math.floor(days * 86400);
  const url = `${CONFIG.DELTA_API_URL}/v2/history/candles?symbol=${symbol}&resolution=${res}&start=${start}&end=${now}`;
  try {
    const { data } = await axios.get(url);
    const arr = data?.result || [];
    return arr.map(d => ({
      time: +d.time,
      open: +d.open,
      high: +d.high,
      low: +d.low,
      close: +d.close,
      volume: +d.volume || 0
    })).filter(x => Number.isFinite(x.close)).sort((a, b) => a.time - b.time);
  } catch (e) {
    if (CONFIG.DEBUG) console.error(`getHistorical(${symbol})`, e.message);
    return [];
  }
}

// --- Indicator logic ---
function calculateTrend(symbol, data, label) {
  if (!data.length) return 'NEUTRAL';
  const closes = data.map(d => d.close);
  const ema20 = latestEMA(closes, CONFIG.TREND_EMA_SHORT);
  const ema50 = latestEMA(closes, CONFIG.TREND_EMA_LONG);
  const ema200 = latestEMA(closes, CONFIG.TREND_EMA_SUPERLONG);
  const ltp = closes.at(-1);

  // store all EMAs in cache
  emaCache[symbol] = emaCache[symbol] || {};
  emaCache[symbol][label] = { ema20, ema50, ema200 };

  // debug log (enable CONFIG.DEBUG to see)
  //if (CONFIG.DEBUG) {
   // console.log(`[TREND DEBUG] ${symbol} | ${label} | LTP: ${ltp?.toFixed(2)} | EMA20: ${ema20?.toFixed?.(2)} | EMA50: ${ema50?.toFixed?.(2)} | EMA200: ${ema200?.toFixed?.(2)}`);
  //}

  // emit only numeric values; send null when not available to avoid NaN
  socketIO.emit(`cryptoEmaUpdate_${symbol}`, {
    timeframe: label,
    ema20: Number.isFinite(ema20) ? +ema20.toFixed(2) : null,
    ema50: Number.isFinite(ema50) ? +ema50.toFixed(2) : null,
    ema200: Number.isFinite(ema200) ? +ema200.toFixed(2) : null
  });

  if (Number.isFinite(ltp) && Number.isFinite(ema20) && Number.isFinite(ema50)) {
    if (ltp > ema20 && ema20 > ema50) return 'BULLISH';
    if (ltp < ema20 && ema20 < ema50) return 'BEARISH';
  }
  return 'NEUTRAL';
}


function decideMainSignal(symbol, { trend15, rsi15, atr15 }) {
  const lastPrice = latestDataStore[symbol]?.LTP || 1;
  const emaData = emaCache[symbol]?.['15 Min'] || {};
  const { ema20, ema50 } = emaData;
  const atrPct = isFinite(atr15) && lastPrice > 0 ? (atr15 / lastPrice) * 100 : 0;
  const minAtrPct = 0.03;

  if (!ema20 || !ema50 || !isFinite(rsi15)) return { signal: 'NEUTRAL' };
  if (atrPct < minAtrPct) return { signal: 'NEUTRAL' };

  // 📈 LONG pullback: Uptrend + RSI 30–45
  if (ema20 > ema50 && rsi15 > 30 && rsi15 < 45) {
    return { signal: 'LONG', reason: `Uptrend pullback RSI=${rsi15.toFixed(2)}` };
  }

  // 📉 SHORT pullback: Downtrend + RSI 55–70
  if (ema20 < ema50 && rsi15 > 55 && rsi15 < 70) {
    return { signal: 'SHORT', reason: `Downtrend pullback RSI=${rsi15.toFixed(2)}` };
  }

  return { signal: 'NEUTRAL' };
}




function decideScalpSignal(symbol, { trend5, rsi5, atr5 }) {
  const lastPrice = latestDataStore[symbol]?.LTP || 1;
  const emaData = emaCache[symbol]?.['5 Min'] || {};
  const { ema20, ema50 } = emaData;
  const atrPct = isFinite(atr5) && lastPrice > 0 ? (atr5 / lastPrice) * 100 : 0;
  const minAtrPct = 0.02;

  if (!ema20 || !ema50 || !isFinite(rsi5)) return { signal: 'NEUTRAL' };
  if (atrPct < minAtrPct) return { signal: 'NEUTRAL' };

  // 📈 LONG pullback: Uptrend + RSI 30–45
  if (ema20 > ema50 && rsi5 > 30 && rsi5 < 45) {
    return { signal: 'LONG', reason: `Uptrend pullback RSI=${rsi5.toFixed(2)}` };
  }

  // 📉 SHORT pullback: Downtrend + RSI 55–70
  if (ema20 < ema50 && rsi5 > 55 && rsi5 < 70) {
    return { signal: 'SHORT', reason: `Downtrend pullback RSI=${rsi5.toFixed(2)}` };
  }

  return { signal: 'NEUTRAL' };
}



// --- Main updater ---
async function updateSymbol(symbol) {
  try {
    const hoursNeeded = CONFIG.TREND_EMA_SUPERLONG; // e.g. 200
    const daysForH1 = Math.max(7, Math.ceil(hoursNeeded / 24) + 1); // +1 for safety; min 7
    const [h1, m15, m5] = await Promise.all([
      getHistorical(symbol, '60min', daysForH1),
      getHistorical(symbol, '15min', 3),
      getHistorical(symbol, '5min', 2)
    ]);

    const trend1h = calculateTrend(symbol, h1, '1 Hour');
    const trend15 = calculateTrend(symbol, m15, '15 Min');
    const trend5 = calculateTrend(symbol, m5, '5 Min');

    socketIO.emit(`cryptoMarketTrend_${symbol}`, { '1 Hour': trend1h, '15 Min': trend15, '5 Min': trend5 });

    // 15min indicators
    const atr15 = calculateATR(m15, CONFIG.ATR_PERIOD);
    const rsi15 = rsiFromCloses(m15.map(d => d.close), CONFIG.RSI_PERIOD);
    socketIO.emit(`cryptoAtrUpdate_${symbol}`, { value: +atr15?.toFixed(6), timeframe: '15min' });
    socketIO.emit(`cryptoRsiUpdate_${symbol}`, { rsi: +rsi15?.toFixed(2), timeframe: '15min' });
    socketIO.emit(`cryptoMainSignal_${symbol}`, decideMainSignal(symbol, { trend15, rsi15, atr15 }));

    // 5min indicators
    const atr5 = calculateATR(m5, CONFIG.ATR_PERIOD);
    const rsi5 = rsiFromCloses(m5.map(d => d.close), CONFIG.RSI_PERIOD);
    socketIO.emit(`cryptoAtrUpdate_${symbol}`, { value: +atr5?.toFixed(6), timeframe: '5min' });
    socketIO.emit(`cryptoRsiUpdate_${symbol}`, { rsi: +rsi5?.toFixed(2), timeframe: '5min' });
    socketIO.emit(`cryptoScalpSignal_${symbol}`, decideScalpSignal(symbol, { trend5, rsi5, atr5 }));

    if (CONFIG.DEBUG) console.log(symbol, 'updated.');
  } catch (err) {
    console.error('updateSymbol', symbol, err.message);
  }
}

// --- LTP WebSocket ---
function connectWebSocket(symbol) {
  try {
    const ws = new WebSocket(CONFIG.DELTA_WS_URL);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        payload: { channels: [{ name: "v2/ticker", symbols: [symbol] }] }
      }));
    });
    ws.on('message', msg => {
      try {
        const d = JSON.parse(msg);
        if (d.type === 'v2/ticker' && d.symbol === symbol) {
          const ltp = +d.close || +d.last || +d.price;
          latestDataStore[symbol] = { LTP: ltp };
          socketIO.emit(`cryptoSpot_${symbol}`, { symbol, ltp });
          socketIO.emit(`cryptoAtm_${symbol}`, { atm: Math.round(ltp || 0) });
        }
        if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });
    ws.on('error', () => setTimeout(() => connectWebSocket(symbol), 3000));
    ws.on('close', () => setTimeout(() => connectWebSocket(symbol), 3000));
  } catch {
    setTimeout(() => connectWebSocket(symbol), 3000);
  }
}

// --- Init ---
function init(io) {
  socketIO = io;
  CONFIG.SYMBOLS.forEach(sym => {
    updateSymbol(sym);
    setInterval(() => updateSymbol(sym), CONFIG.TREND_UPDATE_INTERVAL);
    connectWebSocket(sym);
  });
  console.log('✅ Multi-crypto Trader running for symbols:', CONFIG.SYMBOLS.join(', '));
}

module.exports = { init, CONFIG };
