// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// --- Modules ---
const niftyTrader = require('./modules/niftyTrader');
const cryptoTrader = require('./modules/cryptoTrader');

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 8080;

// --- Static Files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ---
// Default route Nifty dashboard ko kholta hai
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/nifty', 'index.html'));
});

// Nifty route
app.get('/nifty', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/nifty', 'index.html'));
});

// Crypto route
app.get('/crypto', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/crypto', 'index.html'));
});

// --- Initialize Modules ---
// Dono modules ko 'io' object paas karo
//niftyTrader.init(io);
cryptoTrader.init(io);

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`🚀 Main Server running at http://localhost:${PORT}`);
    console.log(`➡️ Nifty Dashboard: http://localhost:${PORT}/nifty`);
    console.log(`➡️ Crypto Dashboard: http://localhost:${PORT}/crypto`);
});