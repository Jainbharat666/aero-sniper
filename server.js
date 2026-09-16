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
import { startTelegramBotPolling } from './backend/telegramBot.js';
import { sseClients } from './backend/state.js';

dotenv.config();

// Start RFC 5905 UDP NTP auto-sync with Cloudflare Stratum 1 atomic clocks
startAutoSync(30000);

// Initialize 24/7 Telegram Remote Controller & Alert Polling Daemon
startTelegramBotPolling();

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
    if (filePath.endsWith('.html') || filePath.includes('favicon') || filePath.includes('logo')) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.svg') || filePath.endsWith('.png')) {
      res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
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
    console.log(` ⚡ 24/7 Keep-Alive Ping Engine ACTIVE`);
    console.log(`======================================================\n`);

    // 🛡️ 24/7 MEMORY FOOTPRINT GUARD & AUTOMATED CACHE PRUNER (Protects 512MB RAM Ceiling)
    setInterval(() => {
      try {
        const mem = process.memoryUsage();
        const rssMb = Math.round(mem.rss / 1024 / 1024);
        const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);

        // Prune stale or closed SSE socket descriptors
        if (sseClients && sseClients.size > 0) {
          for (const client of Array.from(sseClients)) {
            if (!client.res || client.res.writableEnded || client.res.destroyed || client.res.closed) {
              sseClients.delete(client);
            }
          }
        }

        // Proactive garbage collection trigger if near threshold
        if (global.gc && rssMb > 180) {
          global.gc();
        }
      } catch (e) {}
    }, 2 * 60 * 1000); // Check every 2 minutes

    // 🛡️ 24/7 RENDER KEEP-ALIVE HEARTBEAT LOOP (Prevents Free-Tier Inactivity Sleep)
    const renderHost = process.env.RENDER_EXTERNAL_URL || 'https://aero-sniper.onrender.com';
    setInterval(async () => {
      try {
        const res = await fetch(`${renderHost}/api/snipe/telemetry`);
        const data = await res.json();
        console.log(`[KEEP-ALIVE] 💓 Heartbeat sent to ${renderHost} (Active Engines: ${data.activeEnginesCount || 0})`);
      } catch (e) {
        console.warn(`[KEEP-ALIVE] Ping error: ${e.message}`);
      }
    }, 7 * 60 * 1000); // Ping every 7 minutes
  });
}

export default app;