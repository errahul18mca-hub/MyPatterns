// modules/niftyTrader.js
require('dotenv').config();
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { rtConnect, rtSubscribe, rtFeed, rtUnsubscribe } = require('truedata-nodejs');

// --- CONFIGURATION ---
const USER = process.env.USER;
const PASSWORD = process.env.PASSWORD;
const TD_PORT = parseInt(process.env.TRUEDATA_PORT || '8086', 10);
const EXPIRY = '251104'; // Format: YYMMDD (Tuesday, Nov 4, 2025)
const SPOT_SYMBOL = 'NIFTY 50';
const STRIKE_STEP = 50;
const RADIUS = 2;
const LOOKBACK_PERIOD_MS = 5 * 60 * 1000;
const AUTH_URL = "https://auth.truedata.in/token";
const HISTORY_URL = "https://history.truedata.in/getbars";
const HIST_SYMBOL = "NIFTY 50";
const TREND_EMA_SHORT = 20;
const TREND_EMA_LONG = 50;
const ATR_PERIOD = 14;
const TREND_UPDATE_INTERVAL = 1 * 60 * 1000;
const LOG_FILE = path.join(__dirname, '..', 'nifty_signals.log'); // Log file root mein

// --- STATE ---
let socketIO; // IO object yahaan store hoga
let currentSubscribed = new Set();
let lastATM = null;
const latestDataStore = {};
const periodicSnapshotStore = {};
let bearerToken = null;
let currentAtrValue = 0;

// =================================================================
// --- HISTORICAL/TREND FUNCTIONS ---
// =================================================================
async function fetchBearerToken() {
  try {
    console.log("⏳ [NIFTY] Fetching Bearer Token...");
    const response = await axios.post(AUTH_URL, new URLSearchParams({'username': USER,'password': PASSWORD,'grant_type': 'password'}), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    bearerToken = response.data.access_token;
    console.log("✅ [NIFTY] Bearer Token fetched!");
  } catch (error) {
    console.error("❌ [NIFTY] Error fetching Bearer Token:", error.response?.data || error.message);
    bearerToken = null;
  }
}
function formatTrueDataDate(date, isStartTime = true) { const year = date.getFullYear().toString().slice(-2); const month = (date.getMonth() + 1).toString().padStart(2, '0'); const day = date.getDate().toString().padStart(2, '0'); const time = isStartTime ? 'T09:00:00' : 'T15:30:00'; return `${year}${month}${day}${time}`; }
async function getHistoricalData(interval, days = 7) { if (!bearerToken) { console.error(`❌ [NIFTY] Cannot fetch data: Token is missing.`); return []; } try { let toDate = new Date(); if (toDate.getDay() === 0) toDate.setDate(toDate.getDate() - 2); else if (toDate.getDay() === 6) toDate.setDate(toDate.getDate() - 1); toDate.setHours(15, 30, 0, 0); const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000); const toDateStr = formatTrueDataDate(toDate, false); const fromDateStr = formatTrueDataDate(fromDate, true); const encodedSymbol = encodeURIComponent(HIST_SYMBOL); const params = `?symbol=${encodedSymbol}&interval=${interval}&from=${fromDateStr}&to=${toDateStr}&response=csv`; const url = HISTORY_URL + params; console.log(`⏳ [NIFTY] Fetching Historical: ${interval}`); const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${bearerToken}` } }); const lines = response.data.trim().split('\n'); if (lines.length <= 1) { console.warn(`📉 [NIFTY] No data for ${interval}`); return []; } const headers = lines[0].split(','); const data = lines.slice(1).map(line => { const values = line.split(','); let obj = {}; headers.forEach((header, i) => { const key = header.trim(); const value = values[i]?.trim(); obj[key] = (value && !isNaN(value)) ? parseFloat(value) : value; }); return obj.hasOwnProperty('close') ? obj : null; }).filter(row => row); console.log(`📊 [NIFTY] Fetched ${data.length} bars for ${interval}`); return data; } catch (error) { console.error(`❌ [NIFTY] Error fetching/parsing for ${interval}:`, error.message); if (error.response?.status === 404) console.error(">>> [NIFTY] API 404. Check URL/Symbol/Interval/Date."); return []; } }
function calculateEMA(data, period) { if (!Array.isArray(data)) return null; const closes = data.map(d => d.close).filter(c => typeof c === 'number'); if (closes.length < period) return null; const initialData = closes.slice(0, period); const initialSum = initialData.reduce((acc, val) => acc + val, 0); let previousEMA = initialSum / period; const multiplier = 2 / (period + 1); for (let i = period; i < closes.length; i++) { previousEMA = (closes[i] - previousEMA) * multiplier + previousEMA; } return previousEMA; }
function calculateTrend(data) { const requiredDataPoints = TREND_EMA_LONG; if (!Array.isArray(data) || data.length < requiredDataPoints || !data[data.length - 1]?.close) return 'NEUTRAL'; const ltp = data[data.length - 1].close; const emaShort = calculateEMA(data, TREND_EMA_SHORT); const emaLong = calculateEMA(data, TREND_EMA_LONG); if (emaShort === null || emaLong === null) return 'NEUTRAL'; if (ltp > emaShort && ltp > emaLong) return 'BULLISH'; if (ltp < emaShort && ltp < emaLong) return 'BEARISH'; return 'NEUTRAL'; }
function calculateTrueRange(candle, prevCandle) { const high = candle.high; const low = candle.low; const prevClose = prevCandle.close; return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)); }
function calculateATR(data, period) { if (!Array.isArray(data) || data.length < period + 1) return 0; let trueRanges = []; for (let i = 1; i < data.length; i++) { if (data[i] && data[i-1] && typeof data[i].high === 'number' && typeof data[i].low === 'number' && typeof data[i-1].close === 'number') { trueRanges.push(calculateTrueRange(data[i], data[i-1])); } else { console.warn("[NIFTY] Skipping invalid data point for TR calculation."); } } if (trueRanges.length < period) return 0; const firstATRData = trueRanges.slice(0, period); let atr = firstATRData.reduce((sum, tr) => sum + tr, 0) / period; for (let i = period; i < trueRanges.length; i++) { atr = (atr * (period - 1) + trueRanges[i]) / period; } return atr; }
async function updateTrendsAndAtr() { console.log("⏳ [NIFTY] Updating trends (EMA 20/50) and ATR(14)..."); const timeframes = { '1 Hour': { interval: '60min', days: 25 }, '15 Min': { interval: '15min', days: 10 }, '5 Min': { interval: '5min', days: 5 } }; let trendResults = {}; for (const [key, config] of Object.entries(timeframes)) { const data = await getHistoricalData(config.interval, config.days); trendResults[key] = calculateTrend(data); if (config.interval === '5min') { currentAtrValue = calculateATR(data, ATR_PERIOD); console.log(`📊 [NIFTY] Calculated 5min ATR(${ATR_PERIOD}): ${currentAtrValue.toFixed(2)}`); socketIO.emit('niftyAtrUpdate', { value: currentAtrValue.toFixed(2) }); } } socketIO.emit('niftyMarketTrend', trendResults); console.log("📈 [NIFTY] Trends updated:", trendResults); }

// =================================================================
// --- LIVE OI LOGIC ---
// =================================================================
function generateOptionSymbols(atm) { const symbols = []; for (let i = -RADIUS; i <= RADIUS; i++) { const strike = atm + i * STRIKE_STEP; if (strike <= 0) continue; symbols.push(`NIFTY${EXPIRY}${strike}CE`); symbols.push(`NIFTY${EXPIRY}${strike}PE`); } return symbols; }
function getSignal({ oiChangePct, priceChangePct, strike, atm, volumeIncreased }) { const nearATM = Math.abs(strike - atm) <= STRIKE_STEP * 2; if (!nearATM) return "IGNORE"; const priceUp = priceChangePct > 0.15; const priceDown = priceChangePct < -0.15; const oiUp = oiChangePct > 0.75; const oiDown = oiChangePct < -0.75; const volConfirm = volumeIncreased; if (priceUp && oiUp) return volConfirm ? "LONG BUILDUP" : "IGNORE"; if (priceUp && oiDown) return "SHORT COVERING"; if (priceDown && oiUp) return volConfirm ? "SHORT BUILDUP" : "IGNORE"; if (priceDown && oiDown) return "LONG UNWINDING"; return "IGNORE"; }
function subscribeForATM(atm) { const symbols = generateOptionSymbols(atm); const newSet = new Set(symbols); const toUnsub = Array.from(currentSubscribed).filter(s => !newSet.has(s)); const toSub = symbols.filter(s => !currentSubscribed.has(s)); if (toUnsub.length > 0) rtUnsubscribe(toUnsub); if (toSub.length > 0) rtSubscribe(toSub); currentSubscribed = newSet; console.log('📊 [NIFTY] Total subscribed options:', currentSubscribed.size); }
function processSpotData(data) { if (data.Symbol) latestDataStore[data.Symbol] = data; if (data.Symbol === SPOT_SYMBOL && typeof data.LTP === 'number') { const atm = Math.round(data.LTP / STRIKE_STEP) * STRIKE_STEP; if (atm !== lastATM && atm > 0) { lastATM = atm; console.log(`💡 [NIFTY] New ATM detected: ${atm}`); subscribeForATM(atm); socketIO.emit('niftyAtm', { atm }); } socketIO.emit('niftySpot', { symbol: data.Symbol, ltp: data.LTP }); return true; } return false; }
function processOptionData(tickData) { if (!tickData || !tickData.Symbol) return; const symbol = tickData.Symbol; const prev = latestDataStore[symbol] || {}; const currentData = { symbol: symbol, LTP: (tickData.LTP !== undefined) ? tickData.LTP : prev.LTP, OI: (tickData.OI !== undefined) ? tickData.OI : prev.OI, Volume: (tickData.Volume !== undefined) ? tickData.Volume : prev.Volume, timestamp: tickData.Timestamp || Date.now(), OI_Change_Percentage: (tickData.OI_Change_Percentage !== undefined) ? tickData.OI_Change_Percentage : prev.OI_Change_Percentage, Price_Change_Percentage: (tickData.Price_Change_Percentage !== undefined) ? tickData.Price_Change_Percentage : prev.Price_Change_Percentage }; latestDataStore[symbol] = currentData; let signalToSend = "WAITING..."; let volConfirmed = false; if (typeof currentData.LTP === 'number') { socketIO.emit('niftyOptionChain', { symbol: currentData.symbol, LTP: currentData.LTP, OI: currentData.OI, signal: signalToSend, oiChange: currentData.OI_Change_Percentage || 0, priceChange: currentData.Price_Change_Percentage || 0, volConfirmed: volConfirmed }); } else { return; } const snapshotData = periodicSnapshotStore[symbol]; if (snapshotData && typeof currentData.OI === 'number') { let oiChangePct_5min = 0; let priceChangePct_5min = 0; if (snapshotData.OI > 0) oiChangePct_5min = ((currentData.OI - snapshotData.OI) / snapshotData.OI) * 100; if (snapshotData.LTP > 0) priceChangePct_5min = ((currentData.LTP - snapshotData.LTP) / snapshotData.LTP) * 100; if (snapshotData.Volume > 0 && currentData.Volume > snapshotData.Volume) { volConfirmed = true; } const strikeMatch = symbol.match(/NIFTY\d{6}(\d+)(CE|PE)$/); const strike = strikeMatch ? parseInt(strikeMatch[1], 10) : lastATM; signalToSend = getSignal({ oiChangePct: oiChangePct_5min, priceChangePct: priceChangePct_5min, strike, atm: lastATM, volumeIncreased: volConfirmed }); socketIO.emit('niftyOptionChain', { symbol: currentData.symbol, LTP: currentData.LTP, OI: currentData.OI, signal: signalToSend, oiChange: currentData.OI_Change_Percentage || 0, priceChange: currentData.Price_Change_Percentage || 0, volConfirmed: volConfirmed }); } }

// =================================================================
// --- BACKTEST LOGGER ---
// =================================================================
function logSignal(timestamp, trend5m, trend15m, oiSignalCE, oiSignalPE, volConfCE, volConfPE, finalSuggestion, entryPrice, exitPrice = null) { const logEntry = `${timestamp}, ${trend5m}, ${trend15m}, ${oiSignalCE}, ${oiSignalPE}, ${volConfCE}, ${volConfPE}, ${finalSuggestion}, ${entryPrice}, ${exitPrice}\n`; fs.appendFile(LOG_FILE, logEntry, (err) => { if (err) console.error("❌ [NIFTY] Error writing to log file:", err); }); }
if (!fs.existsSync(LOG_FILE)) { const headers = "Timestamp, Trend5m, Trend15m, SignalCE_ATM, SignalPE_ATM, VolConfCE, VolConfPE, FinalSuggestion, EntryPrice, ExitPrice\n"; fs.writeFileSync(LOG_FILE, headers); }

// =================================================================
// --- INIT FUNCTION ---
// =================================================================
function init(io) {
    socketIO = io; // Save the global io object

    // --- SERVICE START ---
    fetchBearerToken().then(() => {
        setTimeout(() => {
            updateTrendsAndAtr();
            setInterval(updateTrendsAndAtr, TREND_UPDATE_INTERVAL);
        }, 5000); // 5 sec delay
    });

    setInterval(() => {
        console.log(`--- 📸 [NIFTY] Saving 5-minute snapshot ---`);
        for (const symbol in latestDataStore) {
            periodicSnapshotStore[symbol] = { ...latestDataStore[symbol] };
        }
    }, LOOKBACK_PERIOD_MS);

    // --- TRUEDATA CONNECTION ---
    rtConnect(USER, PASSWORD, [SPOT_SYMBOL], TD_PORT);
    rtFeed.on('connect', () => console.log('✅ [NIFTY] Connected to TrueData Live Feed!'));
    rtFeed.on('error', (err) => console.error('❌ [NIFTY] Live Feed Error:', err));
    rtFeed.on('disconnect', () => console.warn('⚠️ [NIFTY] Disconnected from Live Feed!'));
    rtFeed.on('data', (data) => { if (data.msg === 'h') { /* Heartbeat */ } if (data.success === false) console.error('❌ [NIFTY] SUBSCRIPTION ERROR:', data.message); if (data.success === true && data.symbolsadded > 0) console.log(`✅ [NIFTY] Successfully subscribed to ${data.symbolsadded} symbols.`); });
    rtFeed.on('touchline', (data) => { const isSpot = processSpotData(data); if (!isSpot && currentSubscribed.has(data.Symbol)) processOptionData(data); });
    rtFeed.on('tick', (tick) => { const isSpot = processSpotData(tick); if (!isSpot && currentSubscribed.has(tick.Symbol)) processOptionData(tick); });
    
    console.log("Nifty Trader Module Initialized.");
}

module.exports = { init };