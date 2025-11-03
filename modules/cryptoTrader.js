// modules/cryptoTrader.js (IMPROVED FINAL)
// npm i axios ws dotenv
require('dotenv').config();
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// --- CONFIG ---
const DELTA_API_URL = "https://api.delta.exchange";
const DELTA_WS_URL  = "wss://socket.delta.exchange";

const FUTURES_SYMBOL = "BTCUSD";
const HIST_SYMBOL    = "BTCUSD";

const TREND_EMA_SHORT = 20;
const TREND_EMA_LONG  = 50;

const ATR_PERIOD      = 14;
const ATR_EMA_PERIOD  = 20;

const TREND_UPDATE_INTERVAL = 60 * 1000;
const LOOKBACK_PERIOD_MS    = 3 * 60 * 1000;

const LOG_FILE = path.join(__dirname, '..', 'crypto_signals.log');

// --- STATE ---
let socketIO;
const latestDataStore = {};
const periodicSnapshotStore = {};
const persistenceWindow = []; // last deltas for persistence
let currentAtrValue = 0;
let currentAtrEma = 0;

// Cache last EMA values for UI
const emaCache = {
  '1 Hour': { ema20: null, ema50: null },
  '15 Min': { ema20: null, ema50: null },
  '5 Min':  { ema20: null, ema50: null }
};

// ====================== TIME UTILS ======================
function toIST(epochSec) {
  if (!epochSec) return "N/A";
  return new Date(epochSec * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// ====================== EMA FUNCTIONS ======================
function calculateEMAArray(closes, period) {
  if (!Array.isArray(closes)) return { emaArray: [], last: null };
  const series = closes.filter(c => typeof c === 'number' && isFinite(c));
  if (series.length < period) return { emaArray: [], last: null };
  const k = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += series[i];
  sma /= period;
  const emaArray = new Array(series.length).fill(null);
  emaArray[period - 1] = sma;
  for (let i = period; i < series.length; i++) {
    emaArray[i] = series[i] * k + emaArray[i - 1] * (1 - k);
  }
  return { emaArray, last: emaArray[emaArray.length - 1] };
}
function latestEMA(closes, period) {
  const { last } = calculateEMAArray(closes, period);
  return last;
}

// ====================== ATR FUNCTIONS ======================
function calculateTrueRange(curr, prev) {
  if (!curr || !prev) return 0;
  const high = curr.high, low = curr.low, prevClose = prev.close;
  if ([high, low, prevClose].some(v => typeof v !== 'number' || !isFinite(v))) return 0;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}
function calculateATR(data, period) {
  if (!Array.isArray(data) || data.length < period + 1) return { lastAtr: NaN, atrArray: [] };
  const trArr = [];
  for (let i = 1; i < data.length; i++) {
    const tr = calculateTrueRange(data[i], data[i - 1]);
    if (tr > 0 && isFinite(tr)) trArr.push(tr);
  }
  if (trArr.length < period) return { lastAtr: NaN, atrArray: [] };
  let atr = trArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrValues = [atr];
  for (let i = period; i < trArr.length; i++) {
    atr = (atr * (period - 1) + trArr[i]) / period;
    atrValues.push(atr);
  }
  return { lastAtr: atrValues[atrValues.length - 1], atrArray: atrValues };
}

// ====================== TREND CALCULATION ======================
function calculateTrend(inputData, tfLabel) {
  if (!Array.isArray(inputData)) return "NEUTRAL";
  const data = inputData
    .filter(d =>
      d && typeof d.time === 'number' && isFinite(d.time) &&
      typeof d.close === 'number' && isFinite(d.close)
    )
    .sort((a, b) => a.time - b.time)
    .filter((d, i, arr) => i === 0 || d.time !== arr[i - 1].time);

  if (data.length < TREND_EMA_LONG) {
    console.warn(`[CRYPTO] Not enough data (${data.length}) for ${tfLabel}`);
    return "NEUTRAL";
  }

  const closes = data.map(d => d.close);
  const ema20 = latestEMA(closes, TREND_EMA_SHORT);
  const ema50 = latestEMA(closes, TREND_EMA_LONG);
  const ltp   = closes[closes.length - 1];

  if (![ema20, ema50, ltp].every(v => typeof v === 'number' && isFinite(v))) {
    console.warn(`[CRYPTO] EMA calculation failed for ${tfLabel}`);
    return "NEUTRAL";
  }

  emaCache[tfLabel] = { ema20, ema50 };
  if (socketIO) {
    socketIO.emit('cryptoEmaUpdate', {
      timeframe: tfLabel,
      ema20: Number(ema20.toFixed(2)),
      ema50: Number(ema50.toFixed(2))
    });
  }

  let trend = "NEUTRAL";
  if (ltp > ema20 && ema20 > ema50) trend = "BULLISH";
  else if (ltp < ema20 && ema20 < ema50) trend = "BEARISH";

  const lastCandleTime = data[data.length - 1]?.time;
  console.log(`\n📊 [TREND DEBUG - ${tfLabel}]`);
  console.log(`🕒 Close Time (IST): ${toIST(lastCandleTime)}`);
  console.log(`💰 LTP: ${ltp.toFixed(2)} | 20EMA: ${ema20.toFixed(2)} | 50EMA: ${ema50.toFixed(2)}`);
  console.log(`📊 Trend: ${trend}`);
  return trend;
}

// ====================== HISTORICAL DATA FETCH ======================
async function getHistorical(interval, days) {
  const map = { "60min": "1h", "15min": "15m", "5min": "5m" };
  const resolution = map[interval];
  const nowUTCms   = Date.now();
  const startUTCms = nowUTCms - (days * 24 * 60 * 60 * 1000);
  const end   = Math.floor(nowUTCms / 1000);
  const start = Math.floor(startUTCms / 1000);
  console.log(`🕒 [TIME DEBUG - ${interval}] start=${start} end=${end}`);
  const url = `${DELTA_API_URL}/v2/history/candles?symbol=${HIST_SYMBOL}&resolution=${resolution}&start=${start}&end=${end}`;
  try {
    const { data } = await axios.get(url);
    const raw = Array.isArray(data?.result) ? data.result : [];
    const cleanedData = raw
      .map(d => ({
        time: Number(d.time),
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        volume: Number(d.volume)
      }))
      .filter(d =>
        [d.time, d.open, d.high, d.low, d.close].every(v => typeof v === 'number' && isFinite(v))
      )
      .sort((a, b) => a.time - b.time)
      .filter((d, i, arr) => i === 0 || d.time !== arr[i - 1].time);
    console.log(`📊 [CRYPTO] Fetched ${cleanedData.length} bars for ${interval}`);
    return cleanedData;
  } catch (err) {
    console.error(`❌ [CRYPTO] Error fetching ${interval}:`, err.message);
    return [];
  }
}

// =================================================================
// --- ADAPTIVE SIGNAL LOGIC ---
// =================================================================
function getAdaptiveThresholds() {
  const priceGateBase = 0.04; // %
  const oiGateBase    = 0.05; // %
  const last = latestDataStore[FUTURES_SYMBOL];
  let atrPercent = null;
  if (last && typeof last.LTP === 'number' && currentAtrValue > 0) {
    atrPercent = (currentAtrValue / last.LTP) * 100;
  }
  if (atrPercent != null && isFinite(atrPercent)) {
    const volFactor = Math.min(Math.max(atrPercent / 0.5, 0.6), 1.4);
    return {
      priceGate: Math.max(0.025, priceGateBase * (1.0 / volFactor)),
      oiGate:    Math.max(0.03,   oiGateBase    * (1.0 / volFactor))
    };
  }
  return { priceGate: priceGateBase, oiGate: oiGateBase };
}

function passesPersistence(direction) {
  if (persistenceWindow.length < 2) return false;
  const lastTwo = persistenceWindow.slice(-2);
  return lastTwo.some(d => d.direction === direction); // 1/2 snapshots
}

function getSignal({ oiChangePct, priceChangePct, volumeIncreased }) {
  const { priceGate, oiGate } = getAdaptiveThresholds();
  const priceUp   = priceChangePct >  priceGate;
  const priceDown = priceChangePct < -priceGate;
  const oiUp      = oiChangePct    >  oiGate;
  const oiDown    = oiChangePct    < -oiGate;

  if (priceUp && oiUp)    return volumeIncreased ? "LONG BUILDUP" : "IGNORE";
  if (priceUp && oiDown)  return "SHORT COVERING";
  if (priceDown && oiUp)  return volumeIncreased ? "SHORT BUILDUP" : "IGNORE";
  if (priceDown && oiDown) return "LONG UNWINDING";
  return "IGNORE";
}

// Short structure check: 5m close < EMA20 ≤ EMA50
function shortStructureOkay() {
  const v = emaCache['5 Min'];
  if (!v || v.ema20 == null || v.ema50 == null) return false;
  const last = latestDataStore[FUTURES_SYMBOL];
  if (!last || typeof last.LTP !== 'number') return false;
  return (last.LTP < v.ema20) && (v.ema20 <= v.ema50);
}

// =================================================================
// --- LIVE FUTURES LOGIC ---
// =================================================================
function processFuturesData(data) {
  const symbol = data.symbol;
  if (symbol !== FUTURES_SYMBOL) return;

  const prev = latestDataStore[symbol] || {};
  const currentData = {
    symbol: symbol,
    LTP: parseFloat(data.ltp) || prev.LTP,
    OI: parseFloat(data.oi) || prev.OI,
    Volume: parseFloat(data.volume) || prev.Volume
  };
  latestDataStore[symbol] = currentData;

  if (socketIO) {
    socketIO.emit('cryptoSpot', { symbol: symbol, ltp: currentData.LTP });
    socketIO.emit('cryptoLiveSummary', { oi: currentData.OI, volume: currentData.Volume });
  }

  const snap = periodicSnapshotStore[symbol];
  if (snap &&
      typeof currentData.LTP === 'number' &&
      typeof currentData.OI === 'number' &&
      typeof currentData.Volume === 'number') {
    let oiChangePct_3m = 0, priceChangePct_3m = 0, volChangeAbs_3m = 0, volConfirmed = false;
    if (snap.OI && snap.OI > 0) oiChangePct_3m = ((currentData.OI - snap.OI) / snap.OI) * 100;
    if (snap.LTP && snap.LTP > 0) priceChangePct_3m = ((currentData.LTP - snap.LTP) / snap.LTP) * 100;
    if (snap.Volume && snap.Volume >= 0) {
      volChangeAbs_3m = currentData.Volume - snap.Volume;
      volConfirmed = currentData.Volume >= snap.Volume; // flat or up is acceptable
    }

    // persistence window (bearish directions)
    let dir = null;
    if (priceChangePct_3m < 0 && oiChangePct_3m > 0) dir = 'SHORT_BUILDUP';
    else if (priceChangePct_3m < 0 && oiChangePct_3m < 0) dir = 'LONG_UNWINDING';
    if (dir) {
      persistenceWindow.push({ t: Date.now(), direction: dir });
      if (persistenceWindow.length > 6) persistenceWindow.shift();
    }

    if (socketIO) {
      socketIO.emit('cryptoDelta3m', {
        oiChangePct: Number(oiChangePct_3m.toFixed(2)),
        priceChangePct: Number(priceChangePct_3m.toFixed(2)),
        volumeChange: volChangeAbs_3m
      });
    }

    let signal = getSignal({
      oiChangePct: oiChangePct_3m,
      priceChangePct: priceChangePct_3m,
      volumeIncreased: volConfirmed
    });

    // Structure + persistence gating for shorts
    if (signal === "SHORT BUILDUP" || signal === "LONG UNWINDING") {
      const persistOk = passesPersistence(signal.replace(' ', '_').toUpperCase());
      const structureOk = shortStructureOkay();
      if (!(persistOk && structureOk)) {
        signal = "IGNORE";
      }
    }

    let oiDataCE = { symbol: 'BTC_CE', signal: 'IGNORE', volConfirmed: false };
    let oiDataPE = { symbol: 'BTC_PE', signal: 'IGNORE', volConfirmed: false };

    if (signal === "LONG BUILDUP" || signal === "SHORT COVERING") {
      oiDataCE = {
        symbol: 'BTC_CE',
        LTP: currentData.LTP, OI: currentData.OI, signal,
        oiChange: Number(oiChangePct_3m.toFixed(2)),
        priceChange: Number(priceChangePct_3m.toFixed(2)),
        volConfirmed: volConfirmed
      };
    } else if (signal === "SHORT BUILDUP" || signal === "LONG UNWINDING") {
      oiDataPE = {
        symbol: 'BTC_PE',
        LTP: currentData.LTP, OI: currentData.OI, signal,
        oiChange: Number(oiChangePct_3m.toFixed(2)),
        priceChange: Number(priceChangePct_3m.toFixed(2)),
        volConfirmed: volConfirmed
      };
    }

    if (socketIO) {
      socketIO.emit('cryptoOptionChain', oiDataCE);
      socketIO.emit('cryptoOptionChain', oiDataPE);
      socketIO.emit('cryptoAtm', { atm: Math.round(currentData.LTP) });
    }
  }
}

// ====================== LOGGING ======================
function logSignal(timestamp, trend5m, trend15m, oiSignalCE, oiSignalPE, volConfCE, volConfPE, finalSuggestion, entryPrice, exitPrice = null) {
  const line = `${new Date(timestamp).toISOString()},${trend5m},${trend15m},${oiSignalCE},${oiSignalPE},${volConfCE},${volConfPE},${finalSuggestion},${entryPrice ?? ''},${exitPrice ?? ''}\n`;
  fs.appendFile(LOG_FILE, line, err => {
    if (err) console.error("❌ [CRYPTO] Log write error:", err.message);
  });
}
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, "timestamp,trend5m,trend15m,oiSignalCE,oiSignalPE,volConfCE,volConfPE,finalSuggestion,entryPrice,exitPrice\n");
}

// ====================== SCHEDULE ======================
async function updateTrendsAndAtr() {
  console.log("\n🚀 [CRYPTO] Updating trends (EMA20/50) + ATR14 ...");
  const configs = {
    "1 Hour": { interval: "60min", days: 7 },
    "15 Min": { interval: "15min", days: 3 },
    "5 Min":  { interval: "5min",  days: 2 }
  };
  const trends = {};
  let atrValue = 0, atrEma = 0;

  for (const [label, cfg] of Object.entries(configs)) {
    const data = await getHistorical(cfg.interval, cfg.days);
    if (data.length === 0) continue;
    const trend = calculateTrend(data, label);
    trends[label] = trend;

    if (cfg.interval === "15min") {
      const atrData = calculateATR(data, ATR_PERIOD);
      if (
        atrData &&
        typeof atrData.lastAtr === 'number' && isFinite(atrData.lastAtr) &&
        Array.isArray(atrData.atrArray) && atrData.atrArray.length >= ATR_EMA_PERIOD
      ) {
        atrValue = atrData.lastAtr;
        atrEma = latestEMA(atrData.atrArray, ATR_EMA_PERIOD);
        currentAtrValue = atrValue;
        currentAtrEma   = atrEma;
        if (socketIO) socketIO.emit('cryptoAtrUpdate', {
          value: Number(atrValue.toFixed(2)),
          ema: Number(atrEma.toFixed(2))
        });
      }
    }
  }

  if (socketIO) {
    socketIO.emit('cryptoMarketTrend', trends);
    for (const [tf, vals] of Object.entries(emaCache)) {
      if (vals.ema20 != null && vals.ema50 != null) {
        socketIO.emit('cryptoEmaUpdate', {
          timeframe: tf,
          ema20: Number(vals.ema20.toFixed(2)),
          ema50: Number(vals.ema50.toFixed(2))
        });
      }
    }
  }
  console.log("\n📈 [CRYPTO] Trends updated:", trends);
}

// ====================== WS ======================
function connectWebSocket() {
  const ws = new WebSocket(DELTA_WS_URL);
  ws.on('open', () => {
    console.log('✅ [CRYPTO] Connected to Delta Exchange Live Feed!');
    const subscribeMessage = {
      type: "subscribe",
      payload: {
        channels: [
          { name: "v2/ticker", symbols: [FUTURES_SYMBOL] }
        ]
      }
    };
    ws.send(JSON.stringify(subscribeMessage));
    console.log(`📈 [CRYPTO] Subscribed to: ${FUTURES_SYMBOL}`);
  });
  ws.on('message', (buf) => {
    try {
      const message = JSON.parse(buf);
      if (message.type === 'v2/ticker' && message.symbol === FUTURES_SYMBOL) {
        processFuturesData({
          symbol: message.symbol,
          ltp: message.close,
          oi: message.oi,
          volume: message.volume
        });
      }
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error("❌ [CRYPTO] Error parsing WebSocket message:", e);
    }
  });
  ws.on('error', (err) => console.error('❌ [CRYPTO] Live Feed Error:', err));
  ws.on('close', () => {
    console.warn('⚠️ [CRYPTO] Disconnected from Live Feed! Retrying in 5 seconds...');
    setTimeout(connectWebSocket, 5000);
  });
}

// ====================== INIT ======================
function init(io) {
  socketIO = io;
  updateTrendsAndAtr();
  setInterval(updateTrendsAndAtr, TREND_UPDATE_INTERVAL);
  setInterval(() => {
    console.log(`--- 📸 [CRYPTO] Saving 3-minute snapshot ---`);
    for (const symbol in latestDataStore) {
      periodicSnapshotStore[symbol] = { ...latestDataStore[symbol] };
    }
  }, LOOKBACK_PERIOD_MS);
  connectWebSocket();
  console.log("Crypto Trader Module Initialized.");
}

module.exports = { init };
