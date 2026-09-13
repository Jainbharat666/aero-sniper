import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import { startAutoSync } from './src/timeSync.js';

// Route Modules (AeroMint Modular Architecture)
import authRouter from './backend/routes/auth.js';
import adminRouter from './backend/routes/admin.js';
import rpcRouter from './backend/routes/rpc.js';
import keysRouter from './backend/routes/keys.js';
import walletRouter from './backend/routes/wallet.js';
import scanRouter from './backend/routes/scan.js';
import rarityRouter from './backend/routes/rarity.js';
import streamRouter from './backend/routes/stream.js';
import sniperRouter from './backend/routes/sniper.js';

dotenv.config();

// Start RFC 5905 UDP NTP auto-sync with Cloudflare Stratum 1 atomic clocks
startAutoSync(30000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Restricted CORS: Protect against malicious 3rd-party cross-site requests
const ALLOWED_ORIGINS = [
  'https://aero-sniper.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : [])
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (/^https:\/\/aero-sniper.*\.vercel\.app$/.test(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-session-token', 'x-app-id']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Root diagnostic API
app.get('/api', (req, res) => {
  res.json({
    status: 'online',
    service: 'Aero-Sniper V2 Modular API',
    architecture: 'AeroMint-Style Route Modularization',
    url: req.url
  });
});

// Mount Modular Routes
app.use('/api', authRouter);
app.use('/api', adminRouter);
app.use('/api', rpcRouter);
app.use('/api', keysRouter);
app.use('/api', walletRouter);
app.use('/api', scanRouter);
app.use('/api', rarityRouter);
app.use('/api', streamRouter);
app.use('/api', sniperRouter);

// Fail-safe Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Sniper Global Error]:', err.message || err);
  if (res.headersSent) return next(err);
  return res.status(err.status || 500).json({
    success: false,
    error: err.message || 'An internal server error occurred.'
  });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(` ⚡ AERO-SNIPER V2: ULTRA LOW-LATENCY MODULAR ENGINE`);
    console.log(` 👉 http://localhost:${PORT}`);
    console.log(` ⚡ 6-Key OpenSea Laser Grid (Role-Specialized) ACTIVE`);
    console.log(` ⚡ AeroMint-Style Modular Architecture ACTIVE`);
    console.log(` ⚡ Multi-RPC Simultaneous Mempool Blast ACTIVE`);
    console.log(`======================================================\n`);
  });
}

export default app;