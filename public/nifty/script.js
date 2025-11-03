// public/crypto/script.js
const socket = io();
const optionData = {}; // Faking CE/PE
let currentATM = null; // Will show price
let currentAtr = 0;
const ATR_THRESHOLD = 50; // $50 for BTC (aap ise adjust kar sakte hain)

// --- DOM Elements ---
const atmEl = document.getElementById('atm');
const spotEl = document.getElementById('spot-ltp');
const atrValueEl = document.getElementById('atr-value');

// Trend Box Elements
const trend1hEl = document.getElementById('trend-1-hour');
const trend15mEl = document.getElementById('trend-15-min');
const trend5mEl = document.getElementById('trend-5-min');

// Matrix Elements
const matrixTrend1hEl = document.getElementById('matrix-trend-1h');
const matrixTrend15mEl = document.getElementById('matrix-trend-15m');
const matrixOiSignalEl = document.getElementById('matrix-oi-signal');
const matrixVolConfirmEl = document.getElementById('matrix-vol-confirm');
const matrixTimeFilterEl = document.getElementById('matrix-time-filter');
const matrixAtrFilterEl = document.getElementById('matrix-atr-filter');
const matrixScoreEl = document.getElementById('matrix-score');
const masterSignalEl = document.getElementById('master-signal');

// --- Global State ---
let marketTrend = {};
let latestAtmOiSignal = { ce: 'WAITING...', pe: 'WAITING...', volConfCE: false, volConfPE: false };
let calculationTimeout;

// ----- NAYA STATEFUL LOGIC -----
// Yeh 'NEUTRAL', 'BUY LONG', ya 'SELL SHORT' ho sakta hai
let currentMasterSignal = 'NEUTRAL'; 
// ----- END NAYA -----

// =================================================================
// --- HELPER FUNCTIONS ---
// =================================================================
const formatNum = (val) => (val !== undefined && val !== null ? parseFloat(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-');

function updateMatrixItem(element, text, type) {
    if (!element) return;
    element.textContent = text;
    element.classList.remove('bullish', 'bearish', 'neutral', 'active', 'inactive', 'yes', 'no');
    if (type === 'trend') element.classList.add(text.toLowerCase());
    else if (type === 'filter') element.classList.add(text === 'ACTIVE' ? 'active' : 'inactive');
    else if (type === 'vol') element.classList.add(text === 'YES' ? 'yes' : 'no');
    else element.classList.add('neutral');
}

function setMasterSignal(text, cssClass) { 
    // Is function ko ab hum sirf UI update ke liye istemaal karenge
    masterSignalEl.textContent = text; 
    masterSignalEl.className = `master-signal-box ${cssClass}`; 
}

// =================================================================
// --- MASTER SIGNAL CALCULATION (Naya Stateful Logic) ---
// =================================================================
function calculateMasterSignal() {
    let score = 0;
    
    // --- 1. Get Current State ---
    const trend1h = marketTrend['1 Hour'] || 'NEUTRAL';
    const trend15m = marketTrend['15 Min'] || 'NEUTRAL';
    const trend5m = marketTrend['5 Min'] || 'NEUTRAL';
    const isAtrOk = currentAtr > ATR_THRESHOLD;
    
    // --- 2. Calculate OI Score ---
    let oiScore = 0;
    let combinedOiSignal = 'NEUTRAL';
    let volConfirmed = false;
    
    // Check Bullish OI
    if (latestAtmOiSignal.ce === 'LONG BUILDUP' || latestAtmOiSignal.ce === 'SHORT COVERING') {
        oiScore = 1;
        combinedOiSignal = latestAtmOiSignal.ce;
        volConfirmed = latestAtmOiSignal.volConfCE;
    }
    // Check Bearish OI (agar bullish nahin hai toh)
    else if (latestAtmOiSignal.pe === 'LONG BUILDUP' || latestAtmOiSignal.pe === 'SHORT COVERING') {
         oiScore = -1;
         combinedOiSignal = latestAtmOiSignal.pe;
         volConfirmed = latestAtmOiSignal.volConfPE;
    }

    // --- 3. Calculate Volume Score ---
    let volScore = 0;
    if (oiScore !== 0) { 
        if ((combinedOiSignal === 'LONG BUILDUP' || combinedOiSignal === 'SHORT BUILDUP') && volConfirmed) { 
            volScore = (oiScore > 0) ? 1 : -1; 
        } 
    }
    
    // --- 4. Update Matrix UI (Yeh hamesha update hoga) ---
    updateMatrixItem(matrixTrend1hEl, trend1h, 'trend');
    updateMatrixItem(matrixTrend15mEl, trend15m, 'trend');
    updateMatrixItem(matrixAtrFilterEl, isAtrOk ? 'ACTIVE' : 'INACTIVE', 'filter');
    updateMatrixItem(matrixOiSignalEl, combinedOiSignal === 'NEUTRAL' ? '--' : combinedOiSignal, combinedOiSignal === 'NEUTRAL' ? 'neutral' : (oiScore > 0 ? 'bullish' : 'bearish'));
    updateMatrixItem(matrixVolConfirmEl, oiScore === 0 ? '--' : (volConfirmed ? 'YES' : 'NO'), 'vol');
    
    // Time filter (Crypto 24/7)
    updateMatrixItem(matrixTimeFilterEl, 'ACTIVE', 'filter');
    
    
    // --- 5. STATEFUL LOGIC (Entry aur Exit) ---

    // A. Check EXIT Conditions (Agar hum pehle se trade mein hain)
    if (currentMasterSignal === 'BUY LONG') {
        if (trend5m === 'BEARISH') {
            // Exit Signal! 5-min trend toot gaya
            currentMasterSignal = 'NEUTRAL';
            setMasterSignal('EXIT LONG (5m Flip)', 'signal-neutral');
        } else {
            // No exit, hold
            setMasterSignal('BUY LONG (Active)', 'signal-bullish');
        }
        matrixScoreEl.textContent = 'Active';
        return; // Exit check ke baad aage check nahin karna
    }
    
    if (currentMasterSignal === 'SELL SHORT') {
        if (trend5m === 'BULLISH') {
            // Exit Signal! 5-min trend toot gaya
            currentMasterSignal = 'NEUTRAL';
            setMasterSignal('EXIT SHORT (5m Flip)', 'signal-neutral');
        } else {
            // No exit, hold
            setMasterSignal('SELL SHORT (Active)', 'signal-bearish');
        }
        matrixScoreEl.textContent = 'Active';
        return; // Exit check ke baad aage check nahin karna
    }

    // B. Check FILTER Conditions (Agar hum trade mein nahin hain)
    if (!isAtrOk) {
       setMasterSignal('LOW VOLATILITY (ATR)', 'signal-neutral');
       matrixScoreEl.textContent = 'N/A';
       return;
    }

    // C. Check ENTRY Conditions (Agar hum trade mein nahin hain)
    let finalScore = 0;
    let trendScore = 0;
    
    if (trend1h === 'BULLISH' && trend15m === 'BULLISH') trendScore = 1;
    else if (trend1h === 'BEARISH' && trend15m === 'BEARISH') trendScore = -1;
    else { 
        setMasterSignal('MIXED TREND (1H vs 15M)', 'signal-neutral'); 
        matrixScoreEl.textContent = '0'; 
        return; 
    }
    
    finalScore = trendScore + oiScore + volScore;
    matrixScoreEl.textContent = finalScore;

    if (finalScore >= 2) {
        currentMasterSignal = 'BUY LONG'; // Signal ko Latch (Lock) kar diya
        setMasterSignal('BUY LONG', 'signal-bullish');
    } else if (finalScore <= -2) {
        currentMasterSignal = 'SELL SHORT'; // Signal ko Latch (Lock) kar diya
        setMasterSignal('SELL SHORT', 'signal-bearish');
    } else {
        currentMasterSignal = 'NEUTRAL';
        setMasterSignal('NEUTRAL', 'signal-neutral');
    }
}

function debounceMasterSignalCalc() { 
    clearTimeout(calculationTimeout); 
    calculationTimeout = setTimeout(calculateMasterSignal, 500); 
}

// --- Socket.IO Event Listeners ---
socket.on('connect', () => { console.log('🔗 [CRYPTO] Connected to Server'); });
socket.on('disconnect', () => { console.log('🔌 [CRYPTO] Disconnected'); });

socket.on('cryptoSpot', ({ symbol, ltp }) => {
    spotEl.textContent = symbol;
    atmEl.textContent = formatNum(ltp);
});

socket.on('cryptoAtm', ({ atm }) => {
    atmEl.textContent = formatNum(atm);
});

socket.on('cryptoAtrUpdate', ({ value }) => {
    currentAtr = parseFloat(value);
    atrValueEl.textContent = value;
    if (currentAtr > ATR_THRESHOLD) { 
        atrValueEl.className = 'atr-good'; 
    } else { 
        atrValueEl.className = 'atr-bad'; 
    }
    debounceMasterSignalCalc();
});

socket.on('cryptoMarketTrend', (trends) => {
    marketTrend = trends;
    console.log("📈 [CRYPTO] Received Trends:", trends);
    
    // Trend box (main UI)
    updateMatrixItem(trend1hEl, trends['1 Hour'] || 'NEUTRAL', 'trend');
    updateMatrixItem(trend15mEl, trends['15 Min'] || 'NEUTRAL', 'trend');
    updateMatrixItem(trend5mEl, trends['5 Min'] || 'NEUTRAL', 'trend');

    // Matrix box (ab yeh redundant hai, lekin rakha hai)
    updateMatrixItem(matrixTrend1hEl, trends['1 Hour'] || 'NEUTRAL', 'trend');
    updateMatrixItem(matrixTrend15mEl, trends['15 Min'] || 'NEUTRAL', 'trend');
    
    // Master signal ko hamesha update karo jab trend badle
    debounceMasterSignalCalc();
});

socket.on('cryptoOptionChain', (data) => {
    if (data.symbol === 'BTC_CE') {
        latestAtmOiSignal.ce = data.signal;
        latestAtmOiSignal.volConfCE = data.volConfirmed;
    } else if (data.symbol === 'BTC_PE') {
        latestAtmOiSignal.pe = data.signal;
        latestAtmOiSignal.volConfPE = data.volConfirmed;
    }
    // Master signal ko recalculate karo
    debounceMasterSignalCalc();
});