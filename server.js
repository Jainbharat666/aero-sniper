import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import { config } from './src/config.js';
import { StreamListener } from './src/stream.js';
import { RarityEngine } from './src/rarity.js';
import { SeaportExecutor } from './src/executor.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Universal CORS: Allow localhost + any deployed web domain (Vercel, Netlify, Render, custom domain)
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-session-token', 'x-app-id']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api', (req, res) => {
  res.json({
    status: 'online',
    service: 'Aero-Sniper V2 API',
    url: req.url,
    originalUrl: req.originalUrl,
    matchedPath: req.headers['x-matched-path'],
    vercelMatchedPath: req.headers['x-vercel-matched-path'],
    allHeaders: req.headers
  });
});

app.get('/api/my-ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
  res.json({ ip });
});

// High-performance HTTP Keep-Alive Agent for OpenSea REST calls
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 60,
  maxFreeSockets: 20,
  timeout: 5000
});

const apiClient = axios.create({
  httpsAgent,
  timeout: 5000
});

// ─── SUPABASE POSTGRESQL CLOUD CONFIG (ISOLATED SNIPER V2 DATABASE) ─────────
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://fjxarhcisasyvomfgtxl.supabase.co').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_QkC4wXZTz_4m8P9zUuwDjg_mUZA1Vqa';

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
};

const OWNER_EMAIL = 'jainbharat666@gmail.com';

// Rate Limiter for Authentication and Sensitive Operations
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { success: false, error: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Password Hashing & Verification
const BCRYPT_ROUNDS = 10;
function hashPassword(pwd) {
  return bcrypt.hashSync(String(pwd), BCRYPT_ROUNDS);
}
function verifyPassword(pwd, hash) {
  if (hash && hash.startsWith('$2')) {
    return bcrypt.compareSync(String(pwd), hash);
  }
  const sha256 = crypto.createHash('sha256').update(String(pwd)).digest('hex');
  return sha256 === hash;
}

// ─── SUPABASE DATABASE DRIVER HELPERS (ISOLATED TO SNIPER_* TABLES) ─────────

async function dbGetUsers() {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_users?select=*&order=created_at.desc`, { headers: supabaseHeaders, timeout: 8000 });
    return res.data || [];
  } catch (e) {
    console.error('[Sniper DB - GetUsers]:', e.response?.data || e.message);
    return [];
  }
}

async function dbGetUserByEmail(email) {
  try {
    const clean = (email || '').trim().toLowerCase();
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_users?email=ilike.${encodeURIComponent(clean)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    console.error('[Sniper DB - GetUserByEmail]:', e.response?.data || e.message);
    return null;
  }
}

async function dbGetUserById(id) {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_users?id=eq.${encodeURIComponent(id)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    return null;
  }
}

async function dbUpsertUser(userObj) {
  try {
    const res = await axios.post(`${SUPABASE_URL}/rest/v1/sniper_users?on_conflict=id`, userObj, {
      headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
      timeout: 8000
    });
    return (res.data && res.data.length > 0) ? res.data[0] : userObj;
  } catch (e) {
    console.error('[Sniper DB - UpsertUser]:', e.response?.data || e.message);
    throw e;
  }
}

async function dbUpdateUser(userId, updates) {
  try {
    const res = await axios.patch(`${SUPABASE_URL}/rest/v1/sniper_users?id=eq.${encodeURIComponent(userId)}`, updates, {
      headers: supabaseHeaders,
      timeout: 8000
    });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    console.error('[Sniper DB - UpdateUser]:', e.response?.data || e.message);
    return null;
  }
}

async function dbDeleteUser(userId) {
  try {
    await axios.delete(`${SUPABASE_URL}/rest/v1/sniper_users?id=eq.${encodeURIComponent(userId)}`, { headers: supabaseHeaders, timeout: 8000 });
    return true;
  } catch (e) {
    console.error('[Sniper DB - DeleteUser]:', e.response?.data || e.message);
    return false;
  }
}

async function dbRecordUserSnipe(userIdOrEmail, count = 1) {
  try {
    let user = await dbGetUserById(userIdOrEmail);
    if (!user) user = await dbGetUserByEmail(userIdOrEmail);
    if (user) {
      const updatedTotal = (user.total_snipes || 0) + count;
      const updates = {
        total_snipes: updatedTotal,
        snipes_used: (user.snipes_used || 0) + count,
        last_active_at: new Date().toISOString()
      };
      if (user.snipes_remaining !== null && user.snipes_remaining !== undefined && user.snipes_remaining > 0) {
        updates.snipes_remaining = Math.max(0, user.snipes_remaining - count);
      }
      await dbUpdateUser(user.id, updates);
      console.log(`🎯 [SNIPER DB] Snipe recorded for ${user.email}! New Total: ${updatedTotal}`);
      return updatedTotal;
    }
  } catch (e) {
    console.error('[Sniper DB - RecordSnipe Error]:', e.message);
  }
  return null;
}

async function dbGetInvites() {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_invites?select=*&order=created_at.desc`, { headers: supabaseHeaders, timeout: 8000 });
    return res.data || [];
  } catch (e) {
    console.error('[Sniper DB - GetInvites]:', e.response?.data || e.message);
    return [];
  }
}

async function dbGetInviteByCode(code) {
  try {
    const clean = (code || '').trim().toUpperCase();
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_invites?invite_code=ilike.${encodeURIComponent(clean)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    console.error('[Sniper DB - GetInviteByCode]:', e.response?.data || e.message);
    return null;
  }
}

async function dbUpsertInvite(inviteObj) {
  try {
    const res = await axios.post(`${SUPABASE_URL}/rest/v1/sniper_invites?on_conflict=invite_code`, inviteObj, {
      headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
      timeout: 8000
    });
    return (res.data && res.data.length > 0) ? res.data[0] : inviteObj;
  } catch (e) {
    console.error('[Sniper DB - UpsertInvite]:', e.response?.data || e.message);
    throw e;
  }
}

async function dbUpdateInvite(inviteIdOrCode, updates) {
  try {
    const val = String(inviteIdOrCode || '').trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    const filter = isUuid ? `id=eq.${encodeURIComponent(val)}` : `invite_code=ilike.${encodeURIComponent(val)}`;
    const res = await axios.patch(
      `${SUPABASE_URL}/rest/v1/sniper_invites?${filter}`,
      updates,
      { headers: supabaseHeaders, timeout: 8000 }
    );
    return (res.data && res.data.length > 0) ? res.data[0] : updates;
  } catch (e) {
    console.error('[Sniper DB - UpdateInvite]:', e.response?.data || e.message);
    return null;
  }
}

async function dbDeleteInvite(inviteIdOrCode) {
  try {
    const val = String(inviteIdOrCode || '').trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    const filter = isUuid ? `id=eq.${encodeURIComponent(val)}` : `invite_code=ilike.${encodeURIComponent(val)}`;
    await axios.delete(
      `${SUPABASE_URL}/rest/v1/sniper_invites?${filter}`,
      { headers: supabaseHeaders, timeout: 8000 }
    );
    return true;
  } catch (e) {
    console.error('[Sniper DB - DeleteInvite]:', e.response?.data || e.message);
    return false;
  }
}

async function dbGetUserConfig(userId) {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?user_id=eq.${encodeURIComponent(userId)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0]?.config : null;
  } catch (e) {
    return null;
  }
}

async function dbSaveUserConfig(userId, newConfig) {
  try {
    const existing = await dbGetUserConfig(userId);
    if (existing !== null && existing !== undefined) {
      const merged = { ...existing, ...newConfig };

      const existingWallets = existing.walletFleet || existing.wallets;
      const incomingWallets = newConfig.walletFleet !== undefined ? newConfig.walletFleet : newConfig.wallets;

      // 🛡️ WALLET PRESERVATION SAFEGUARD:
      // If existing config has wallets, and incoming is empty [] without explicit_wipe, PRESERVE them!
      if (
        Array.isArray(existingWallets) && existingWallets.length > 0 &&
        Array.isArray(incomingWallets) && incomingWallets.length === 0 &&
        !newConfig.explicit_wipe
      ) {
        merged.walletFleet = existingWallets;
        merged.wallets = existingWallets;
        if (existing.masterWalletIndex !== undefined && merged.masterWalletIndex === null) {
          merged.masterWalletIndex = existing.masterWalletIndex;
        }
      }

      // Keep both walletFleet and wallets identical for 100% cross-compatibility
      if (merged.walletFleet && !merged.wallets) merged.wallets = merged.walletFleet;
      if (merged.wallets && !merged.walletFleet) merged.walletFleet = merged.wallets;

      // Also preserve custom_rpcs if incoming is empty without explicit_wipe
      if (
        Array.isArray(existing.custom_rpcs) && existing.custom_rpcs.length > 0 &&
        Array.isArray(newConfig.custom_rpcs) && newConfig.custom_rpcs.length === 0 &&
        !newConfig.explicit_wipe
      ) {
        merged.custom_rpcs = existing.custom_rpcs;
      }

      await axios.patch(`${SUPABASE_URL}/rest/v1/sniper_user_configs?user_id=eq.${encodeURIComponent(userId)}`, {
        config: merged,
        updated_at: new Date().toISOString()
      }, { headers: supabaseHeaders, timeout: 8000 });
      return merged;
    } else {
      const merged = { ...newConfig };
      if (merged.walletFleet && !merged.wallets) merged.wallets = merged.walletFleet;
      if (merged.wallets && !merged.walletFleet) merged.walletFleet = merged.wallets;
      await axios.post(`${SUPABASE_URL}/rest/v1/sniper_user_configs?on_conflict=user_id`, {
        user_id: userId,
        config: merged,
        updated_at: new Date().toISOString()
      }, {
        headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
        timeout: 8000
      });
      return merged;
    }
  } catch (e) {
    console.error('[Sniper DB - SaveUserConfig]:', e.response?.data || e.message);
    return null;
  }
}

async function dbDeleteUserConfig(userId) {
  try {
    await axios.delete(`${SUPABASE_URL}/rest/v1/sniper_user_configs?user_id=eq.${encodeURIComponent(userId)}`, { headers: supabaseHeaders, timeout: 8000 });
    return true;
  } catch (e) {
    return false;
  }
}

// ─── ADMIN AUTHENTICATION MIDDLEWARE ─────────────────────────────────────────
async function adminAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required. Missing session token.' });
    }
    const sessionToken = authHeader.split('Bearer ')[1].trim();
    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Empty session token.' });
    }

    // 1. Look up session token in sniper_user_configs
    try {
      const configRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>session_token=eq.${encodeURIComponent(sessionToken)}`, {
        headers: supabaseHeaders,
        timeout: 4000
      });
      const configs = configRes.data;
      if (configs && configs.length > 0) {
        const userId = configs[0].user_id;
        const user = await dbGetUserById(userId);
        if (user && (user.email?.toLowerCase() === OWNER_EMAIL || user.role === 'admin')) {
          req.authenticatedUser = user;
          return next();
        }
      }
    } catch (dbErr) {}

    return res.status(403).json({ success: false, error: 'Admin access required.' });
  } catch (err) {
    console.error('[Sniper Admin Auth Error]:', err.message);
    return res.status(500).json({ success: false, error: 'Authentication check failed.' });
  }
}

// ─── USER AUTHENTICATION MIDDLEWARE (FOR PROTECTED VIP ROUTES) ─────────────────
async function userAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required. Missing session token.' });
    }
    const sessionToken = authHeader.split('Bearer ')[1].trim();
    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Empty session token.' });
    }

    try {
      const configRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>session_token=eq.${encodeURIComponent(sessionToken)}`, {
        headers: supabaseHeaders,
        timeout: 4000
      });
      const configs = configRes.data;
      if (configs && configs.length > 0) {
        const userId = configs[0].user_id;
        const user = await dbGetUserById(userId);
        if (user && !user.is_banned) {
          req.authenticatedUser = user;
          return next();
        }
      }
    } catch (dbErr) {}

    return res.status(401).json({ success: false, error: 'Invalid or expired session token. Please log in.' });
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Authentication verification failed.' });
  }
}

// Cache for sub-millisecond responses
let cachedEthPrice = 2500.00;
let cachedTelemetry = {
  network: 'Robinhood Chain',
  chainId: 4663,
  blockNumber: 44735000,
  baseFeeGwei: 0.040,
  priorityFeeGwei: 0.004,
  stdGasGwei: 0.046,
  turboGasGwei: 0.053,
  latencyMs: 16,
  timestamp: Date.now()
};

// ─── 6 OPENSEA API KEYS ROLE & HEALTH TRACKING ────────────────────────────
const openseaKeyStats = {
  '5f32ee9b98e84ea184a514f975ad4f3f': { label: 'Key #1: WebSocket Stream (Dedicated)', role: 'stream', count: 0, lastPingMs: 82, status: '200 OK' },
  '840e6b17791d415db3c98657fbc71979': { label: 'Key #2: Seaport Fulfillment Data', role: 'fulfillment', count: 0, lastPingMs: 95, status: '200 OK' },
  '411d0cfd7b294d71a71dc852999dcbfc': { label: 'Key #3: Rarity & Traits Ingestion', role: 'rarity', count: 0, lastPingMs: 98, status: '200 OK' },
  'a88ffbf11b864b8398af8b2c5e3921fa': { label: 'Key #4: Floor & Live Order Poller', role: 'floor', count: 0, lastPingMs: 91, status: '200 OK' },
  '4793b5e5637a4a3fa75e81c828970113': { label: 'Key #5: Rapid Collection Scanner', role: 'scanner', count: 0, lastPingMs: 104, status: '200 OK' },
  '7f2b82423f01405eac037f4b1a661027': { label: 'Key #6: High-Traffic Backup Relay', role: 'backup', count: 0, lastPingMs: 110, status: '200 OK' }
};

function trackKeyUse(key, latency = 0, status = '200 OK') {
  if (!openseaKeyStats[key]) {
    openseaKeyStats[key] = { label: `Key (Custom)`, role: 'extra', count: 0, lastPingMs: latency || 100, status };
  }
  openseaKeyStats[key].count++;
  if (latency > 0) openseaKeyStats[key].lastPingMs = latency;
  openseaKeyStats[key].status = status;
}

// ─── INITIALIZE PRODUCTION ENGINES ──────────────────────────────────────────
const streamListener = new StreamListener(config.opensea.streamKey);
const rarityEngine = new RarityEngine();
const seaportExecutor = new SeaportExecutor('robinhood');
const sseClients = new Set();

// High-Frequency In-Memory Sniper State
let activeCollectionStats = null; // Tracks { slug, name, totalSupply, listedCount, floorEth }
let activeListedTokenIds = new Set(); // Stores actual listed token IDs to prevent bid cancellations from draining count

let activeSniperEngine = {
  isArmed: false,
  armedTimestamp: 0,
  slug: '',
  triggerMode: 'both', // 'floor', 'rarity', 'both'
  maxFloorEth: 0,
  maxRareRank: 0,
  maxRareEth: 0,
  gasSpeed: 'turbo',
  buyerPrivateKey: '',
  buyerAddress: '',
  buyerName: 'Worker',
  walletSigner: null,
  snipedTokenIds: new Set(),
  invalidOrderHashes: new Set(),
  pendingSnipes: new Set()
};

// 🛡️ AUDIT FIX C-2: Per-wallet atomic nonce manager (prevents concurrent nonce collisions)
const walletNonceMap = new Map(); // address -> next nonce (atomic increment)

async function getNextNonce(provider, address) {
  if (!walletNonceMap.has(address)) {
    const onChainNonce = await provider.getTransactionCount(address, 'pending');
    walletNonceMap.set(address, onChainNonce);
  }
  const nonce = walletNonceMap.get(address);
  walletNonceMap.set(address, nonce + 1);
  return nonce;
}

async function initStream() {
  try {
    await streamListener.connect();
  } catch (err) {
    console.error('⚠ Stream connect error:', err.message);
  }
}
if (!process.env.VERCEL) {
  initStream();
}

function broadcastToClients(payload) {
  if (!payload) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    if (!payload.slug || !client.slug || client.slug.toLowerCase() === payload.slug.toLowerCase() || client.slug === '*') {
      try {
        client.res.write(msg);
      } catch (e) {
        // 🛡️ AUDIT FIX L-7: Remove zombie SSE clients on write failure
        sseClients.delete(client);
      }
    }
  });
}

function broadcastSnipeLog(msg) {
  console.log(msg);
  broadcastToClients({
    type: 'snipe_log',
    message: msg,
    timestamp: Date.now()
  });
}

/**
 * 🏪 UNIVERSAL RULEBOOK: High-Speed Seaport Fulfillment via 24/7 Rotating API Shop
 * Never locked to a single key. Rotates dynamically across all 6 OpenSea API Keys.
 * If a key returns 429, marks it in 3s cooldown and immediately retries on the next healthy key (<5ms).
 * If OpenSea confirms order is dead/cancelled/expired/invalid, stops immediately and reports isDeadOrder.
 */
async function fetchSeaportFulfillmentWithShop(orderHash, chain, buyerAddress, tokenId) {
  const candidateKeys = config.opensea.getCandidateKeys();
  let lastErr = null;

  for (let i = 0; i < Math.min(candidateKeys.length, 5); i++) {
    const apiKey = candidateKeys[i];
    const t0 = Date.now();
    try {
      const res = await apiClient.post(`${config.opensea.restApiBase}/listings/fulfillment_data`, {
        listing: {
          hash: orderHash,
          chain: chain || 'robinhood',
          protocol_address: config.seaport.v1_6
        },
        fulfiller: { address: buyerAddress }
      }, {
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        timeout: 3500
      });
      const latency = Date.now() - t0;
      trackKeyUse(apiKey, latency, '200 OK');
      config.opensea.clearKeyCooldown(apiKey);
      return { success: true, data: res.data, apiKey };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status || err.code || 'Timeout';
      const errDetail = err.response?.data?.errors?.join(', ') || err.response?.data?.detail || err.message;
      trackKeyUse(apiKey, Date.now() - t0, `${status}`);

      const isDeadOrder = /not valid|not found|cancelled|expired|inactive/i.test(errDetail) || err.response?.status === 400;
      if (isDeadOrder) {
        return { success: false, isDeadOrder: true, error: errDetail };
      }

      if (status === 429) {
        config.opensea.markKeyCooldown(apiKey, 3000);
        continue;
      }
    }
  }

  const finalDetail = lastErr?.response?.data?.errors?.join(', ') || lastErr?.response?.data?.detail || lastErr?.message || 'All OpenSea API keys failed';
  return { success: false, isDeadOrder: false, error: finalDetail };
}

// ⚡ ZERO-HOP DIRECT SUB-MILLISECOND SNIPE EXECUTION (AEROMINT MULTI-RPC BLAST)
async function executeZeroHopSnipe(parsed, reason, tTriggerStart) {
  if (!activeSniperEngine.isArmed) return;

  // 🛡️ FEATURE 1: Anti-Drain Circuit Breaker Check
  if (activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit) {
    activeSniperEngine.isArmed = false;
    broadcastSnipeLog(`🛑 [CIRCUIT BREAKER HIT] Max snipes limit reached (${activeSniperEngine.snipesExecutedCount}/${activeSniperEngine.maxSnipesLimit}). Sniper auto-paused.`);
    broadcastToClients({
      type: 'circuit_breaker_paused',
      executed: activeSniperEngine.snipesExecutedCount,
      limit: activeSniperEngine.maxSnipesLimit
    });
    return;
  }

  const tokenId = String(parsed.tokenId);
  if (activeSniperEngine.snipedTokenIds.has(tokenId)) return;
  const protocolData = parsed.protocolData;
  const orderHash = parsed.orderHash || protocolData?.orderHash;
  if (orderHash && activeSniperEngine.invalidOrderHashes && activeSniperEngine.invalidOrderHashes.has(orderHash)) return;

  if (activeSniperEngine.pendingSnipes && activeSniperEngine.pendingSnipes.has(tokenId)) return;
  if (!activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes = new Set();

  if ((!protocolData?.parameters || !protocolData?.signature) && !orderHash) {
    broadcastSnipeLog(`⚠ [SNIPER V2] Cannot snipe #${tokenId}: both protocolData and orderHash are missing!`);
    return;
  }

  // 🛡️ ATOMIC SYNCHRONOUS LOCK: Mark immediately so SSE payload.sniped = true (prevents duplicate frontend dispatch)
  activeSniperEngine.pendingSnipes.add(tokenId);
  activeSniperEngine.snipedTokenIds.add(tokenId);

  broadcastSnipeLog(`🎯 ⚡ [TRIGGER MATCHED] Woodie #${tokenId} at ${parsed.price} ETH [${reason}]`);

  try {
    let currentWorker = activeSniperEngine.walletSigner;
    let buyerAddress = activeSniperEngine.buyerAddress;
    let buyerName = activeSniperEngine.buyerName;

    if (activeSniperEngine.workerPool && activeSniperEngine.workerPool.length > 0) {
      if (activeSniperEngine.workerStrategy === 'round_robin') {
        const w = activeSniperEngine.workerPool[activeSniperEngine.workerIndex % activeSniperEngine.workerPool.length];
        activeSniperEngine.workerIndex++;
        currentWorker = w.signer;
        buyerAddress = w.address;
        buyerName = w.name;
      } else if (!currentWorker) {
        currentWorker = activeSniperEngine.workerPool[0].signer;
        buyerAddress = activeSniperEngine.workerPool[0].address;
        buyerName = activeSniperEngine.workerPool[0].name;
      }
    }

    if (!currentWorker && !activeSniperEngine.dryRun) {
      broadcastSnipeLog(`⚠ [SNIPER V2] No valid worker signer available for execution!`);
      activeSniperEngine.pendingSnipes.delete(tokenId);
      return;
    }

    let txObj = null;

    if (protocolData?.parameters && protocolData?.signature) {
      // Path A: 0ms Instant Direct Seaport Transaction
      broadcastSnipeLog(`⚡ [SEAPORT DIRECT] Building 0ms direct Seaport transaction from protocolData...`);
      txObj = seaportExecutor.buildSeaportTransaction(
        protocolData,
        buyerAddress || '0x0000000000000000000000000000000000000001',
        activeSniperEngine.gasSpeed || 'turbo',
        activeSniperEngine.customGas
      );
    } else if (orderHash) {
      // Path B: OpenSea Fulfillment API Fallback via Rotating 24/7 API Shop
      broadcastSnipeLog(`📡 [SEAPORT FULFILLMENT] Fetching OpenSea Seaport calldata for hash ${orderHash.slice(0, 14)}... via 24/7 API Shop...`);
      const fulRes = await fetchSeaportFulfillmentWithShop(orderHash, parsed.chain || 'robinhood', buyerAddress, tokenId);
      if (!fulRes.success) {
        if (fulRes.isDeadOrder) {
          if (orderHash) activeSniperEngine.invalidOrderHashes.add(orderHash);
          activeSniperEngine.snipedTokenIds.add(tokenId);
          broadcastSnipeLog(`ℹ [ORDER INACTIVE] #${tokenId} (${orderHash ? orderHash.slice(0, 14) + '...' : ''}) is no longer active on OpenSea (cancelled/filled). Blacklisted.`);
        } else {
          broadcastSnipeLog(`❌ [FULFILLMENT ERROR] OpenSea returned error for #${tokenId}: ${fulRes.error}`);
        }
        activeSniperEngine.pendingSnipes.delete(tokenId);
        return;
      }

      if (!fulRes.data?.fulfillment_data?.transaction) {
        broadcastSnipeLog(`❌ [FULFILLMENT ERROR] OpenSea returned no fulfillment transaction for #${tokenId}`);
        activeSniperEngine.pendingSnipes.delete(tokenId);
        return;
      }

      const txData = fulRes.data.fulfillment_data.transaction;
      const fnName = txData.function.split('(')[0];
      let calldata;
      try {
        calldata = seaportExecutor.seaportInterface.encodeFunctionData(fnName, [txData.input_data.parameters]);
      } catch (encErr) {
        broadcastSnipeLog(`❌ [SEAPORT ABI ERROR] Failed to encode Seaport function ${fnName}: ${encErr.message}`);
        activeSniperEngine.pendingSnipes.delete(tokenId);
        return;
      }
      if (txData.calldata_suffix) calldata += txData.calldata_suffix.replace('0x', '');

      let gasPrice;
      if (activeSniperEngine.customGas?.customMaxFeeGwei && parseFloat(activeSniperEngine.customGas.customMaxFeeGwei) > 0) {
        gasPrice = ethers.parseUnits(String(activeSniperEngine.customGas.customMaxFeeGwei), 'gwei');
      } else {
        const gasSpeed = activeSniperEngine.gasSpeed || 'turbo';
        let gasMultiplier = 175n;
        if (gasSpeed === 'surge') gasMultiplier = 235n;
        if (gasSpeed === 'hyped') gasMultiplier = 300n;
        gasPrice = (seaportExecutor.cachedBaseFee * gasMultiplier) / 100n;
      }

      txObj = {
        to: txData.to,
        data: calldata,
        value: BigInt(txData.value || '0'),
        gasLimit: 260000n,
        gasPrice: gasPrice,
        type: 0 // Legacy Type 0 for Robinhood L2
      };
    }

    if (!txObj) {
      broadcastSnipeLog(`❌ [SNIPER V2] Failed to construct transaction for #${tokenId}`);
      activeSniperEngine.pendingSnipes.delete(tokenId);
      return;
    }

    const isSim = activeSniperEngine.dryRun;
    let txHash = '';

    if (isSim) {
      const simulatedLatency = Math.floor(Math.random() * 3) + 1;
      txHash = '0xsimulated_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
      broadcastSnipeLog(`🧪 [PAPER SNIPE] Token #${tokenId} simulated in ${simulatedLatency}ms! MockTx: ${txHash}`);
    } else {
      broadcastSnipeLog(`➔ [RAM SIGN & BLAST] Broadcasting transaction for #${tokenId} (Worker: ${buyerName} - ${buyerAddress.slice(0, 6)}...)...`);
      
      const txResponse = await currentWorker.sendTransaction(txObj);
      txHash = txResponse.hash;
      const tSigned = performance.now();
      const latencyMs = (tSigned - tTriggerStart).toFixed(2);
      
      broadcastSnipeLog(`🚀 [MEMPOOL ACCEPTED] TxHash: ${txHash} (${latencyMs}ms) ➔ Mining on Robinhood Chain...`);

      // Track receipt in background
      txResponse.wait(1).then(receipt => {
        if (receipt) {
          broadcastSnipeLog(`🎉 [ON-CHAIN CONFIRMED] Block #${receipt.blockNumber}! Token #${tokenId} secured by ${buyerName} (Tx: ${txHash.slice(0, 14)}...)!`);
          broadcastToClients({
            type: 'zero_hop_snipe_confirmed',
            slug: activeSniperEngine.slug,
            tokenId: tokenId,
            price: parsed.price,
            buyerName: buyerName,
            txHash: txHash,
            blockNumber: receipt.blockNumber,
            timestamp: Date.now()
          });
        }
      }).catch(e => {
        broadcastSnipeLog(`❌ [TX REVERTED] Block revert for #${tokenId}: ${e.message}`);
        activeSniperEngine.snipedTokenIds.delete(tokenId);
      });
    }

    // Now that tx is broadcasted on-chain, mark as sniped and count
    activeSniperEngine.snipedTokenIds.add(tokenId);
    activeSniperEngine.snipesExecutedCount++;

    // Record on-chain snipe in user's cloud account & enforce quota lock
    if (!isSim && activeSniperEngine.authenticatedUserId) {
      dbRecordUserSnipe(activeSniperEngine.authenticatedUserId, 1).then(async () => {
        try {
          const u = await dbGetUserById(activeSniperEngine.authenticatedUserId);
          if (u && u.email !== OWNER_EMAIL && u.max_snipes_allowed > 0 && (u.total_snipes || 0) >= u.max_snipes_allowed) {
            activeSniperEngine.isArmed = false;
            console.log(`🛑 [QUOTA HARD-LOCK] User ${u.email} reached limit of ${u.max_snipes_allowed} snipes. Disarming engine.`);
            broadcastSnipeLog(`🛑 [QUOTA EXHAUSTED] Allocated limit of ${u.max_snipes_allowed} snipes reached. Engine auto-disarmed.`);
            broadcastToClients({
              type: 'quota_exhausted_disarm',
              message: `You have completed all ${u.max_snipes_allowed} allocated snipes. Sniper engine has been locked. Please renew in profile.`
            });
          }
        } catch (e) {}
      }).catch(() => {});
    }

    broadcastToClients({
      type: isSim ? 'paper_snipe_broadcast' : 'zero_hop_snipe_broadcast',
      slug: activeSniperEngine.slug,
      tokenId: tokenId,
      name: parsed.name,
      price: parsed.price,
      priceFormatted: parsed.priceFormatted,
      buyerName: buyerName,
      txHash: txHash,
      computeLatencyMs: (performance.now() - tTriggerStart).toFixed(2),
      isDryRun: isSim,
      snipesExecuted: activeSniperEngine.snipesExecutedCount,
      maxLimit: activeSniperEngine.maxSnipesLimit,
      reason: reason,
      timestamp: Date.now()
    });

    // Auto-pause if max limit reached
    if (activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit) {
      activeSniperEngine.isArmed = false;
      broadcastSnipeLog(`🛑 [CIRCUIT BREAKER] Completed ${activeSniperEngine.snipesExecutedCount} of ${activeSniperEngine.maxSnipesLimit} allowed snipes. Auto-disarmed.`);
      broadcastToClients({
        type: 'circuit_breaker_paused',
        executed: activeSniperEngine.snipesExecutedCount,
        limit: activeSniperEngine.maxSnipesLimit
      });
    }

  } catch (err) {
    if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokenId);
    activeSniperEngine.snipedTokenIds.delete(tokenId);
    broadcastSnipeLog(`❌ [ZERO-HOP SNIPE ERROR] Token #${tokenId}: ${err.message}`);
  }
}

// ⚡ MICROSECOND ZERO-HOP SNIPER TRIGGER EVALUATOR (ALL 4 RULES ENFORCED)
async function evaluateAndSnipe(parsed, incomingSlug, tTriggerStart = performance.now()) {
  if (!parsed || !parsed.tokenId) return;
  const itemSlug = (parsed.slug || incomingSlug || '').toLowerCase();

  if (!activeSniperEngine.isArmed) return;
  if (activeSniperEngine.slug !== '*' && activeSniperEngine.slug !== itemSlug) return;

  // 🛡️ Circuit Breaker guard
  if (activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit) {
    activeSniperEngine.isArmed = false;
    return;
  }

  const tokenIdStr = String(parsed.tokenId);
  if (activeSniperEngine.snipedTokenIds.has(tokenIdStr)) return;

  const orderHash = parsed.orderHash || parsed.protocolData?.orderHash;
  if (orderHash && activeSniperEngine.invalidOrderHashes && activeSniperEngine.invalidOrderHashes.has(orderHash)) return;

  // 🛡️ VALID SEAPORT ORDER GUARD: Skip incomplete listings that lack both orderHash and parameters
  const hasOrderHash = Boolean(orderHash && orderHash.length > 10);
  const hasProtocolParams = Boolean(parsed.protocolData?.parameters && parsed.protocolData?.signature);
  if (!hasOrderHash && !hasProtocolParams) {
    return; // Wait until order hash or protocol data is populated by OpenSea
  }

  let triggered = false;
  let reason = '';

  // 🎯 RULE 4: SPECIFIC TOKEN ID TRAP (HIGHEST PRIORITY)
  const isTokenIdActive = Boolean(activeSniperEngine.ruleStates?.tokenId || (activeSniperEngine.specificTokenIds && activeSniperEngine.specificTokenIds.size > 0));
  const cleanTokenId = String(parsed.tokenId || '').trim().replace(/[^0-9]/g, '');
  if (isTokenIdActive && cleanTokenId && activeSniperEngine.specificTokenIds && activeSniperEngine.specificTokenIds.has(cleanTokenId)) {
    const maxEth = activeSniperEngine.specificTokenMaxEth > 0
      ? activeSniperEngine.specificTokenMaxEth
      : (activeSniperEngine.maxFloorEth > 0 ? activeSniperEngine.maxFloorEth : Infinity);
    if (parsed.price <= maxEth) {
      triggered = true;
      reason = `🎯 Target Token #${cleanTokenId}: ${parsed.price} ETH <= Cap ${maxEth === Infinity ? 'Market' : maxEth + ' ETH'}`;
    }
  }

  // 👑 RULE 3: RARE TRAIT HUNTER (PRIORITY 2 - MULTI-TRAIT & DYNAMIC RESOLUTION)
  if (!triggered && activeSniperEngine.ruleStates.trait && (activeSniperEngine.traitFilter || (activeSniperEngine.traitFilters && activeSniperEngine.traitFilters.length > 0))) {
    const maxEth = activeSniperEngine.traitMaxEth || activeSniperEngine.traitFilter?.maxEth || 0;
    if (maxEth > 0 && parsed.price <= maxEth) {
      let itemTraits = parsed.rawEvent?.payload?.item?.metadata?.traits || parsed.traits || [];
      if (!itemTraits || itemTraits.length === 0) {
        const cachedInfo = rarityEngine.getTokenInfoSync(parsed.tokenId);
        if (cachedInfo?.traits && cachedInfo.traits.length > 0) {
          itemTraits = cachedInfo.traits;
        } else {
          // If not in RAM, fetch token rarity/traits with Key #3 keepalive agent
          const streamContract = parsed.contractAddress || rarityEngine.contractAddress;
          const streamChain = parsed.chain || rarityEngine.chain || 'robinhood';
          const resolved = await rarityEngine.fetchTokenRarity(parsed.tokenId, streamChain, streamContract);
          if (resolved?.traits) itemTraits = resolved.traits;
        }
      }

      const filters = (activeSniperEngine.traitFilters && activeSniperEngine.traitFilters.length > 0)
        ? activeSniperEngine.traitFilters
        : (activeSniperEngine.traitFilter ? [activeSniperEngine.traitFilter] : []);

      let matchedFilterName = '';
      const match = filters.some(f => {
        const targetType = (f.traitType || '').trim().toLowerCase();
        const targetVal = (f.traitValue || '').trim().toLowerCase();
        const found = itemTraits.some(t => {
          const tType = String(t.trait_type || '').trim().toLowerCase();
          const tVal = String(t.value || '').trim().toLowerCase();
          return (!targetType || tType === targetType) && (!targetVal || tVal === targetVal);
        });
        if (found) {
          matchedFilterName = `${f.traitType || 'Any'}: ${f.traitValue}`;
          return true;
        }
        return false;
      });

      if (match) {
        triggered = true;
        reason = `👑 Trait Match [${matchedFilterName}]: ${parsed.price} ETH <= Target ${maxEth} ETH`;
      }
    }
  }

  // ⚡ RULE 1: FLOOR UNDERPRICE TRAP (PRIORITY 3)
  if (!triggered && activeSniperEngine.ruleStates.floor && activeSniperEngine.maxFloorEth > 0) {
    if (parsed.price <= activeSniperEngine.maxFloorEth) {
      triggered = true;
      reason = `⚡ Floor Fat-Finger: ${parsed.price} ETH <= Target ${activeSniperEngine.maxFloorEth} ETH`;
    }
  }

  // 👑 RULE 2: TOP RARITY RANK SNIPE (PRIORITY 4)
  if (!triggered && activeSniperEngine.ruleStates.rarity && activeSniperEngine.maxRareEth > 0) {
    let rank = rarityEngine.getRaritySync(parsed.tokenId);
    if (rank === null) {
      const streamContract = parsed.contractAddress || rarityEngine.contractAddress;
      const streamChain = parsed.chain || rarityEngine.chain || 'robinhood';
      const resolved = await rarityEngine.fetchTokenRarity(parsed.tokenId, streamChain, streamContract);
      rank = resolved?.rank || null;
    }

    if (rank && rank <= activeSniperEngine.maxRareRank && parsed.price <= activeSniperEngine.maxRareEth) {
      triggered = true;
      reason = `👑 Top Rarity #${rank} at ${parsed.price} ETH <= Target ${activeSniperEngine.maxRareEth} ETH`;
    }
  }

  if (triggered) {
    console.log(`🎯 [SNIPER TRIGGERED] ${reason} on #${parsed.tokenId}`);
    executeZeroHopSnipe(parsed, reason, tTriggerStart);
  }
}

// Subscribes target slug to WebSocket Stream with Live Listing & Delisting Tracking
function subscribeSlugToOpenSea(slug) {
  if (!slug) return;
  const cleanSlug = slug.trim().toLowerCase();

  try {
    streamListener.subscribeToListings(cleanSlug, async (parsed) => {
      if (!parsed) return;
      const tTriggerStart = performance.now();
      const itemSlug = (parsed.slug || cleanSlug).toLowerCase();

      // Update in-memory activeCollectionStats & activeListedTokenIds
      const tokenIdStr = String(parsed.tokenId);
      const isNewToken = !activeListedTokenIds.has(tokenIdStr);
      activeListedTokenIds.add(tokenIdStr);
      if (activeCollectionStats && (activeCollectionStats.slug === itemSlug || activeCollectionStats.slug === cleanSlug)) {
        if (isNewToken && typeof activeCollectionStats.listedCount === 'number') {
          activeCollectionStats.listedCount++;
        }
        if (parsed.price > 0 && parsed.price < activeCollectionStats.floorEth) {
          activeCollectionStats.floorEth = parsed.price;
        }
      }

      // ⚡ MICROSECOND ZERO-HOP SNIPER TRIGGER CHECK (ALL 4 RULES ENFORCED)
      await evaluateAndSnipe(parsed, cleanSlug, tTriggerStart);



      // Asynchronously resolve true OpenRarity rank for UI display without blocking
      const rankCached = rarityEngine.getRaritySync(parsed.tokenId);

      const payload = {
        type: 'listing',
        slug: itemSlug,
        tokenId: parsed.tokenId,
        name: parsed.name || `#${parsed.tokenId}`,
        contractAddress: parsed.contractAddress || (activeCollectionStats?.contractAddress || ''),
        chain: parsed.chain || (activeCollectionStats?.chain || 'robinhood'),
        image: parsed.imageUrl,
        price: parsed.price,
        priceFormatted: parsed.priceFormatted,
        priceUsd: parseFloat((parsed.price * cachedEthPrice).toFixed(2)),
        rarityRank: rankCached,
        seller: parsed.seller ? `${parsed.seller.slice(0, 6)}...${parsed.seller.slice(-4)}` : '',
        sellerFull: parsed.seller || '',
        orderHash: parsed.orderHash,
        ageSeconds: 1,
        eventTimestamp: parsed.receivedAt || Date.now(),
        protocolData: parsed.protocolData,
        sniped: activeSniperEngine.snipedTokenIds.has(String(parsed.tokenId)),
        liveListedCount: activeCollectionStats ? activeCollectionStats.listedCount : null,
        liveFloorEth: activeCollectionStats ? activeCollectionStats.floorEth : null
      };

      // Broadcast immediately so UI prepends without waiting for remote rarity
      broadcastToClients(payload);

      // If rank wasn't in RAM, fetch it asynchronously and stream rank update
      if (rankCached === null) {
        const streamContract = parsed.contractAddress || rarityEngine.contractAddress;
        const streamChain = parsed.chain || rarityEngine.chain || 'robinhood';
        rarityEngine.resolveRarity(parsed.tokenId, streamChain, streamContract).then(info => {
          if (info && info.rank !== null) {
            broadcastToClients({
              type: 'rank_update',
              tokenId: parsed.tokenId,
              rarityRank: info.rank,
              name: info.name,
              image: info.image
            });
          }
        }).catch(() => {});
      }
    }, (delisted) => {
      // Handle live cancellations and completed sales (Delistings)
      if (!delisted || !delisted.tokenId) return;
      const dSlug = (delisted.slug || cleanSlug).toLowerCase();
      const delTokenId = String(delisted.tokenId);

      // 🛡️ CRITICAL DRAIN SAFEGUARD:
      // OpenSea fires onItemCancelled for bids, item offers, collection offers, and listings alike!
      // We ONLY decrement IF this token was ACTUALLY listed in activeListedTokenIds!
      if (activeListedTokenIds.has(delTokenId)) {
        activeListedTokenIds.delete(delTokenId);
        if (activeCollectionStats && activeCollectionStats.listedCount > 0) {
          activeCollectionStats.listedCount--;
        }

        console.log(`📉 [TRUE DELISTING] Token #${delTokenId} removed from order book. Listed count now: ${activeCollectionStats ? activeCollectionStats.listedCount : 0}`);

        broadcastToClients({
          type: 'delisting',
          slug: dSlug,
          tokenId: delTokenId,
          reason: delisted.reason || 'cancelled',
          liveListedCount: activeCollectionStats ? activeCollectionStats.listedCount : null
        });
      }
    });
  } catch (e) {}
}

// ─── BACKGROUND TELEMETRY, ETH PRICE & LISTED COUNT SYNC POLLERS ─────────────
// Periodic 30s Authoritative Listed Count Sync (1-Shot Direct from OpenSea Edge - No Pagination)
// Periodic 15s Authoritative OpenSea Stats Sync (Exact Match to Live OpenSea Webpage)
setInterval(async () => {
  if (!activeCollectionStats || !activeCollectionStats.slug) return;
  try {
    const slug = activeCollectionStats.slug;
    const stats = await fetchOpenSeaAuthoritativeStats(slug);
    if (stats) {
      if (stats.listedCount && stats.listedCount > 0) {
        activeCollectionStats.listedCount = stats.listedCount;
      }
      if (stats.floorEth && stats.floorEth > 0) {
        activeCollectionStats.floorEth = stats.floorEth;
      }
      broadcastToClients({
        type: 'stats_sync',
        slug: slug,
        liveListedCount: activeCollectionStats.listedCount,
        liveFloorEth: activeCollectionStats.floorEth,
        liveFloorUsd: stats.floorUsd || parseFloat((activeCollectionStats.floorEth * cachedEthPrice).toFixed(2))
      });
    }
  } catch(e) {}
}, 15000);

// ─── BACKGROUND TELEMETRY & ETH PRICE POLLERS ───────────────────────────────
let lastEthPriceUpdateMs = Date.now(); // 🛡️ AUDIT FIX LOW-2: Track staleness

async function fetchLiveEthPrice() {
  try {
    const res = await apiClient.get('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    if (res.data?.data?.amount) {
      cachedEthPrice = parseFloat(res.data.data.amount);
      lastEthPriceUpdateMs = Date.now();
    }
  } catch (err) {
    try {
      const bRes = await apiClient.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
      if (bRes.data?.price) {
        cachedEthPrice = parseFloat(bRes.data.price);
        lastEthPriceUpdateMs = Date.now();
      }
    } catch (e) {}
  }
  // 🛡️ AUDIT FIX LOW-2: Warn if ETH price goes stale (>5 min without update)
  if (Date.now() - lastEthPriceUpdateMs > 300000) {
    console.warn(`⚠ [PRICE] ETH price data is stale (last update: ${Math.round((Date.now() - lastEthPriceUpdateMs) / 60000)}min ago). USD calculations may be inaccurate.`);
  }
}
setInterval(fetchLiveEthPrice, 4000);
fetchLiveEthPrice();

async function fetchLiveTelemetry() {
  const t0 = Date.now();
  try {
    const rpcUrl = seaportExecutor.rpcs[0];
    const [blockRes, feeRes] = await Promise.allSettled([
      apiClient.post(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      apiClient.post(rpcUrl, { jsonrpc: '2.0', id: 2, method: 'eth_gasPrice', params: [] })
    ]);

    const latency = Date.now() - t0;
    if (blockRes.status === 'fulfilled' && blockRes.value.data?.result) {
      cachedTelemetry.blockNumber = parseInt(blockRes.value.data.result, 16);
      cachedTelemetry.latencyMs = latency;
      cachedTelemetry.timestamp = Date.now();
    }
    if (feeRes.status === 'fulfilled' && feeRes.value.data?.result) {
      const gasPriceWei = BigInt(feeRes.value.data.result);
      const gasPriceGwei = Number(gasPriceWei) / 1e9;
      cachedTelemetry.baseFeeGwei = parseFloat(gasPriceGwei.toFixed(4));
      cachedTelemetry.stdGasGwei = parseFloat((gasPriceGwei * 1.15).toFixed(4));
      cachedTelemetry.turboGasGwei = parseFloat((gasPriceGwei * 1.5).toFixed(4));
    }
  } catch (err) {}
}
setInterval(fetchLiveTelemetry, 2500);
fetchLiveTelemetry();

// ─── HIGH-SPEED MULTI-KEY REST FETCHER WITH FAILOVER & 429 BACKOFF ───────────
async function fetchOpenSeaWithFallback(pathStr, preferredKeyIndex = null) {
  const allKeys = config.opensea.apiKeys;
  const preferredKey = preferredKeyIndex !== null && allKeys[preferredKeyIndex] ? allKeys[preferredKeyIndex] : null;

  // Use Central API Shop: candidate keys with healthy non-cooldown keys sorted first
  const candidateKeys = config.opensea.getCandidateKeys(preferredKey);

  const sep = pathStr.includes('?') ? '&' : '?';
  const url = `${config.opensea.restApiBase}${pathStr}${sep}_t=${Date.now()}`;

  let lastErr = null;
  for (const key of candidateKeys) {
    const t0 = Date.now();
    try {
      const res = await apiClient.get(url, {
        headers: {
          'X-API-KEY': key,
          'Accept': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        },
        timeout: 5000
      });
      const latency = Date.now() - t0;
      trackKeyUse(key, latency, '200 OK');
      config.opensea.clearKeyCooldown(key); // Clear cooldown on success
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status || err.code || 'Timeout';
      trackKeyUse(key, Date.now() - t0, `${status}`);
      if (status === 429) {
        config.opensea.markKeyCooldown(key, 3000);
        await new Promise(r => setTimeout(r, 40));
      }
    }
  }
  throw lastErr || new Error('All OpenSea API keys failed');
}

function formatEthPrecise(num) {
  const n = parseFloat(num) || 0;
  if (n === 0) return '0.0000 ETH';
  if (n < 0.0001) return `${n.toFixed(6)} ETH`;
  if (n < 0.01) return `${n.toFixed(5)} ETH`;
  return `${n.toFixed(4)} ETH`;
}

// ─── API ROUTES ─────────────────────────────────────────────────────────────

// ─── 1. USER REGISTRATION (VIP INVITE CODE PROTECTED) ──────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, invite_code } = req.body;
    if (!email || !password || !invite_code) {
      return res.status(400).json({ success: false, error: 'Email, password, and VIP invite code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = invite_code.trim().toUpperCase().replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');
    const isOwner = cleanEmail === OWNER_EMAIL;

    // Verify VIP Invite Code in sniper_invites
    let inviteRecord = await dbGetInviteByCode(cleanCode);

    if (!inviteRecord && (cleanCode === 'SNIPER-VIP-2026' || cleanCode === 'SNIPER-VIP-ACCESS-2026' || cleanCode === 'AERO-VIP-ACCESS-2026' || isOwner)) {
      inviteRecord = {
        id: `inv_seed_${Date.now()}`,
        invite_code: cleanCode,
        validity_days: 365,
        max_snipes_limit: 0,
        max_uses: 500,
        used_count: 0,
        is_active: true
      };
      await dbUpsertInvite(inviteRecord).catch(() => {});
    }

    if (!inviteRecord && !isOwner) {
      return res.status(403).json({ success: false, error: '❌ Invalid VIP Invite Code. Access Denied.' });
    }

    if (inviteRecord && !inviteRecord.is_active && !isOwner) {
      return res.status(403).json({ success: false, error: '❌ This VIP Invite Code has been paused/deactivated.' });
    }

    if (inviteRecord && inviteRecord.max_uses && inviteRecord.used_count >= inviteRecord.max_uses && !isOwner) {
      return res.status(403).json({ success: false, error: '❌ This VIP Invite Code has reached its maximum registration limit.' });
    }

    const existingUser = await dbGetUserByEmail(cleanEmail);
    if (existingUser && !isOwner) {
      return res.status(400).json({ success: false, error: '⚠️ This email is already registered. Please go to "VIP Member Login" tab.' });
    }

    // Calculate Subscription Validity
    const validityDays = isOwner ? 3650 : (inviteRecord?.validity_days || 30);
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);

    const newUser = {
      id: existingUser ? existingUser.id : `sniper_u_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      email: cleanEmail,
      password_hash: hashPassword(password),
      role: isOwner ? 'admin' : 'vip_member',
      invite_code_used: cleanCode,
      valid_until: validUntil.toISOString(),
      max_snipes_allowed: isOwner ? 0 : (parseInt(inviteRecord?.max_snipes_limit) || 0),
      total_snipes: existingUser?.total_snipes || 0,
      is_banned: false,
      created_at: existingUser?.created_at || new Date().toISOString(),
      last_active_at: new Date().toISOString()
    };

    await dbUpsertUser(newUser);

    // Consume invite code count
    if (inviteRecord && inviteRecord.id) {
      await dbUpdateInvite(inviteRecord.id, { used_count: (inviteRecord.used_count || 0) + 1 }).catch(() => {});
    }

    // Generate unique single-device active session token
    const sessionToken = `sniper_sess_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    await dbSaveUserConfig(newUser.id, { session_token: sessionToken, last_login_ip: req.ip });

    console.log(`[Sniper DB] Registered new user: ${cleanEmail}`);

    const regAllowed = parseInt(newUser.max_snipes_allowed) || 0;
    const regUsed = newUser.total_snipes || 0;
    const regRem = regAllowed > 0 ? Math.max(0, regAllowed - regUsed) : null;

    const clientSafeUser = {
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      invite_code_used: newUser.invite_code_used,
      valid_until: newUser.valid_until,
      max_snipes_allowed: regAllowed,
      total_snipes: regUsed,
      snipes_used: regUsed,
      snipes_remaining: regRem !== null ? regRem : 0,
      is_banned: newUser.is_banned,
      created_at: newUser.created_at,
      user_metadata: { role: newUser.role, name: cleanEmail.split('@')[0] }
    };
    const userConfig = await dbGetUserConfig(newUser.id);
    return res.json({ success: true, user: clientSafeUser, sessionToken: sessionToken, config: userConfig });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 2. USER LOGIN (WITH SINGLE-DEVICE CONCURRENCY LOCK) ────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const isOwner = cleanEmail === OWNER_EMAIL;
    let user = await dbGetUserByEmail(cleanEmail);

    const reqHash = hashPassword(password);
    const sessionToken = `sniper_sess_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // 1. Account existence check
    if (!user) {
      if (isOwner) {
        user = {
          id: 'owner-sniper-master-001',
          email: cleanEmail,
          password_hash: hashPassword(password),
          role: 'admin',
          invite_code_used: 'ROOT-OWNER',
          valid_until: '2099-12-31T23:59:59+00:00',
          max_snipes_allowed: 0,
          total_snipes: 0,
          is_banned: false,
          created_at: new Date().toISOString(),
          last_active_at: new Date().toISOString()
        };
        await dbUpsertUser(user);
      } else {
        return res.status(404).json({ success: false, error: '❌ Account not found. Please register with a VIP Invite Code first.' });
      }
    }

    // 2. STRICT PASSWORD VERIFICATION FOR EVERYONE (INCLUDING OWNER!)
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: '❌ Incorrect password. Please try again.' });
    }

    // 3. Auto-upgrade legacy hash if needed
    if (user.password_hash && !user.password_hash.startsWith('$2')) {
      await dbUpdateUser(user.id, { password_hash: hashPassword(password) });
    }

    // 4. Ban check (Owner is never banned)
    if (user.is_banned && !isOwner) {
      return res.status(403).json({ success: false, error: '🚫 Account Suspended. Your access has been deactivated by Administrator.' });
    }

    // 5. Expiry & Quota checks (Exempt for owner)
    if (!isOwner) {
      if (user.valid_until && new Date(user.valid_until) < new Date()) {
        return res.status(403).json({
          success: false,
          error: `⏳ VIP Validity Expired. Your subscription ended on ${new Date(user.valid_until).toLocaleDateString()}. Please contact Admin to renew.`
        });
      }

      if (user.max_snipes_allowed > 0 && user.total_snipes >= user.max_snipes_allowed) {
        return res.status(403).json({
          success: false,
          error: `🎯 Snipes Quota Exhausted. You have completed all ${user.max_snipes_allowed} allocated snipes for this key. Contact Admin to extend quota.`
        });
      }
    }

    // 6. Update last active timestamp ONLY (NEVER OVERWRITE password_hash!)
    await dbUpdateUser(user.id, {
      last_active_at: new Date().toISOString(),
      ...(isOwner ? { role: 'admin', is_banned: false } : {})
    });

    // 7. Single-device concurrency lock: overwrite sessionToken
    await dbSaveUserConfig(user.id, { session_token: sessionToken, last_login_ip: req.ip });
    const userConfig = await dbGetUserConfig(user.id);

    const logAllowed = isOwner ? 0 : (parseInt(user.max_snipes_allowed) || 0);
    const logUsed = user.total_snipes !== undefined ? user.total_snipes : (user.snipes_used || 0);
    const logRem = logAllowed > 0 ? Math.max(0, logAllowed - logUsed) : null;

    const clientSafeUser = {
      id: user.id,
      email: user.email,
      role: isOwner ? 'admin' : (user.role || 'vip_member'),
      invite_code_used: user.invite_code_used,
      valid_until: isOwner ? '2099-12-31T23:59:59+00:00' : user.valid_until,
      max_snipes_allowed: logAllowed,
      total_snipes: logUsed,
      snipes_used: logUsed,
      snipes_remaining: logRem,
      is_banned: false,
      created_at: user.created_at,
      user_metadata: isOwner ? { role: 'admin', name: 'Bharat' } : { role: user.role || 'vip_member', name: cleanEmail.split('@')[0] }
    };

    return res.json({ success: true, user: clientSafeUser, sessionToken: sessionToken, config: userConfig });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 3. REAL-TIME ACTIVE SESSION HEARTBEAT ───────────────────────────────────
app.get('/api/auth/heartbeat', async (req, res) => {
  try {
    let { email, userId, sessionToken } = req.query;
    if (!sessionToken && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      sessionToken = req.headers.authorization.split('Bearer ')[1].trim();
    }
    if (!email && !userId && sessionToken) {
      try {
        const configRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>session_token=eq.${encodeURIComponent(sessionToken)}`, {
          headers: supabaseHeaders,
          timeout: 4000
        });
        if (configRes.data && configRes.data.length > 0) {
          userId = configRes.data[0].user_id;
        }
      } catch(e) {}
    }
    if (!email && !userId) return res.status(400).json({ valid: false });

    const cleanEmail = (email || '').trim().toLowerCase();
    const isOwner = cleanEmail === OWNER_EMAIL;
    
    let user = null;
    if (userId) user = await dbGetUserById(userId);
    if (!user && cleanEmail) user = await dbGetUserByEmail(cleanEmail);

    if (!user) {
      return res.json({
        valid: false,
        reason: 'USER_DELETED',
        message: '🚫 Session terminated. User account was deleted by Administrator.'
      });
    }

    if (isOwner) {
      if (sessionToken && user.id) {
        const config = await dbGetUserConfig(user.id);
        if (config && config.session_token && config.session_token !== sessionToken) {
          return res.json({
            valid: false,
            reason: 'CONCURRENT_LOGIN',
            message: '⚠️ Session Overwritten: Your admin account was accessed from another browser or window.'
          });
        }
      }
      return res.json({
        valid: true,
        valid_until: '2099-12-31T23:59:59+00:00',
        max_snipes_allowed: 0,
        total_snipes: 0,
        is_banned: false,
        role: 'admin'
      });
    }

    if (user.is_banned) {
      return res.json({
        valid: false,
        reason: 'BANNED',
        message: '🚫 Your account has been suspended by Administrator.'
      });
    }

    // Single-device concurrency check
    if (sessionToken && user.id) {
      const config = await dbGetUserConfig(user.id);
      if (config && config.session_token && config.session_token !== sessionToken) {
        return res.json({
          valid: false,
          reason: 'CONCURRENT_LOGIN',
          message: '⚠️ Session Overwritten: Your account was just logged in from another device/browser. Multi-device account sharing is disabled.'
        });
      }
    }

    // Check Time Expiry
    if (user.valid_until && new Date(user.valid_until) < new Date()) {
      return res.json({
        valid: false,
        reason: 'EXPIRED_TIME',
        message: `⏳ Your VIP Time Validity has expired on ${new Date(user.valid_until).toLocaleDateString()}. Contact Admin to renew.`
      });
    }

    // Check Snipes Quota Expiry
    if (user.max_snipes_allowed > 0 && (user.total_snipes || 0) >= user.max_snipes_allowed) {
      return res.json({
        valid: false,
        reason: 'EXPIRED_SNIPES',
        message: `🎯 Snipes Quota Reached! You have used all ${user.max_snipes_allowed}/${user.max_snipes_allowed} snipes allocated to this key.`
      });
    }

    const hbMax = user.max_snipes_allowed !== undefined ? parseInt(user.max_snipes_allowed) : 0;
    const hbUsed = user.total_snipes !== undefined ? user.total_snipes : (user.snipes_used || 0);
    const hbRem = hbMax > 0 ? Math.max(0, hbMax - hbUsed) : null;
    return res.json({
      valid: true,
      valid_until: user.valid_until,
      max_snipes_allowed: hbMax,
      snipes_remaining: hbRem,
      snipes_used: hbUsed,
      total_snipes: hbUsed,
      is_banned: false,
      role: user.role
    });
  } catch (err) {
    console.error('[Sniper Heartbeat Error]:', err.message);
    return res.json({ valid: false, error: 'HEARTBEAT_ERROR', message: 'Unable to verify session. Please retry.' });
  }
});

// ─── 4. CHANGE PASSWORD ─────────────────────────────────────────────────────
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const email = req.body.email;
    const oldPassword = req.body.oldPassword || req.body.current_password;
    const newPassword = req.body.newPassword || req.body.new_password;
    if (!email || !oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Email, current password, and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await dbGetUserByEmail(cleanEmail);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (!verifyPassword(oldPassword, user.password_hash)) {
      return res.status(401).json({ success: false, error: '❌ Current password is incorrect.' });
    }

    await dbUpdateUser(user.id, {
      password_hash: hashPassword(newPassword)
    });

    console.log(`[Sniper DB] Password changed successfully for: ${cleanEmail}`);
    return res.json({ success: true, message: '✅ Password changed successfully!' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 5. REDEEM TOP-UP / RENEWAL CODE ─────────────────────────────────────────
app.post('/api/auth/redeem-topup', async (req, res) => {
  try {
    const email = req.body.email;
    const topupCode = req.body.topupCode || req.body.invite_code || req.body.code;
    if (!email || !topupCode) {
      return res.status(400).json({ success: false, error: 'Email and Top-up Code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = topupCode.trim().toUpperCase().replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');

    const codeRecord = await dbGetInviteByCode(cleanCode);
    if (!codeRecord) {
      return res.status(404).json({ success: false, error: '❌ Invalid Top-up / Renewal Code.' });
    }

    if (!codeRecord.is_active) {
      return res.status(403).json({ success: false, error: '❌ This code has been deactivated.' });
    }

    if (codeRecord.max_uses && codeRecord.used_count >= codeRecord.max_uses) {
      return res.status(403).json({ success: false, error: '❌ This top-up code has already reached its redemption limit.' });
    }

    const user = await dbGetUserByEmail(cleanEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    const addDays = codeRecord.validity_days || 30;
    const baseDate = new Date(user.valid_until) > new Date() ? new Date(user.valid_until) : new Date();
    baseDate.setDate(baseDate.getDate() + addDays);
    const newValidUntil = baseDate.toISOString();

    let newMaxSnipes = user.max_snipes_allowed;
    if (codeRecord.max_snipes_limit > 0) {
      newMaxSnipes = (user.max_snipes_allowed || 0) + codeRecord.max_snipes_limit;
    } else if (codeRecord.max_snipes_limit === 0) {
      newMaxSnipes = 0; // unlimited
    }

    await dbUpdateUser(user.id, {
      valid_until: newValidUntil,
      max_snipes_allowed: newMaxSnipes
    });

    if (codeRecord.id) {
      await dbUpdateInvite(codeRecord.id, { used_count: (codeRecord.used_count || 0) + 1 });
    }

    console.log(`[Sniper DB] Top-up applied for ${cleanEmail}: +${addDays}d`);
    return res.json({
      success: true,
      message: `🎉 Top-up applied! Added +${addDays} Days & updated Snipes Quota.`,
      valid_until: newValidUntil,
      max_snipes_allowed: newMaxSnipes
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 6. CLOUD USER CONFIG & WALLET VAULT PERSISTENCE ────────────────────────
app.get('/api/user-config', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.json({ success: true, config: null });
    const config = await dbGetUserConfig(userId);
    return res.json({ success: true, config });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/user-config', async (req, res) => {
  try {
    const { userId, config, ...rest } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
    const payloadToSave = config || rest;
    const saved = await dbSaveUserConfig(userId, payloadToSave);
    return res.json({ success: true, message: 'Cloud Vault config saved successfully.', config: saved });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/user-config', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.json({ success: true });
    await dbDeleteUserConfig(userId);
    return res.json({ success: true, message: 'Cloud Vault data wiped from server.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 6B. MANAGED FLEET RPC CLUSTER SERVICES (CLOUD SYNCED) ──────────────────
const DEFAULT_GLOBAL_FLEET = {
  robinhood: [
    { id: 'fleet-rbh-1', network_key: 'robinhood', name: '⚡ Sniper Official RPC', url: 'https://robinhood-mainnet.g.alchemy.com/v2/alch_FtrEfyyJYzEBZ0SQ3ctbJ', is_active: true, priority: 1 },
    { id: 'fleet-rbh-2', network_key: 'robinhood', name: '⚡ Robinhood Official Sequencer', url: 'https://rpc.mainnet.chain.robinhood.com', is_active: true, priority: 2 },
    { id: 'fleet-rbh-3', network_key: 'robinhood', name: '⚡ Robinhood Direct Node', url: 'https://mainnet.chain.robinhood.com/rpc', is_active: true, priority: 3 }
  ],
  base: [
    { id: 'fleet-base-1', network_key: 'base', name: '⚡ Base Official Sequencer', url: 'https://mainnet.base.org', is_active: true, priority: 1 },
    { id: 'fleet-base-2', network_key: 'base', name: '⚡ Base 1RPC Dedicated', url: 'https://1rpc.io/base', is_active: true, priority: 2 }
  ],
  arbitrum: [
    { id: 'fleet-arb-1', network_key: 'arbitrum', name: '⚡ Arbitrum One Turbo', url: 'https://arb1.arbitrum.io/rpc', is_active: true, priority: 1 }
  ],
  polygon: [
    { id: 'fleet-poly-1', network_key: 'polygon', name: '⚡ Polygon PoS Dedicated', url: 'https://polygon-rpc.com', is_active: true, priority: 1 }
  ],
  ethereum: [
    { id: 'fleet-eth-1', network_key: 'ethereum', name: '⚡ Ethereum LlamaRPC Fast', url: 'https://eth.llamarpc.com', is_active: true, priority: 1 }
  ]
};

async function dbGetCloudFleet(networkKey = 'robinhood') {
  try {
    const config = await dbGetUserConfig('SYSTEM_GLOBAL_FLEET_RPCS');
    if (config && config[networkKey] && Array.isArray(config[networkKey]) && config[networkKey].length > 0) {
      return config[networkKey];
    }
  } catch (e) {
    console.error('[Fleet DB] Get error:', e.message);
  }
  return DEFAULT_GLOBAL_FLEET[networkKey] || DEFAULT_GLOBAL_FLEET['robinhood'];
}

async function dbSaveCloudFleet(networkKey, rpcList) {
  try {
    const existing = await dbGetUserConfig('SYSTEM_GLOBAL_FLEET_RPCS') || {};
    existing[networkKey] = rpcList;
    await dbSaveUserConfig('SYSTEM_GLOBAL_FLEET_RPCS', existing);
    return true;
  } catch (e) {
    console.error('[Fleet DB] Save error:', e.message);
    return false;
  }
}

app.get('/api/fleet-rpcs', async (req, res) => {
  const network = req.query.network || 'robinhood';
  try {
    const rpcs = await dbGetCloudFleet(network);
    return res.json({ success: true, rpcs, fleetRpcs: rpcs });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/fleet-rpcs/save', adminAuthMiddleware, async (req, res) => {
  const payload = req.body.rpc || req.body;
  const { id, networkKey = (payload.network || 'robinhood'), name, url, isActive = true, priority = 1 } = payload;
  if (!name || !url) {
    return res.status(400).json({ success: false, error: 'Name and URL are required' });
  }
  try {
    const currentList = await dbGetCloudFleet(networkKey);
    const rpcId = id || `fleet-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const newRecord = {
      id: rpcId,
      network_key: networkKey,
      name: name.trim(),
      url: url.trim(),
      is_active: isActive !== false,
      priority: parseInt(priority) || 1,
      updated_at: new Date().toISOString()
    };

    const index = currentList.findIndex(r => r.id === rpcId);
    let updated;
    if (index >= 0) {
      updated = [...currentList];
      updated[index] = newRecord;
    } else {
      updated = [newRecord, ...currentList];
    }
    updated.sort((a, b) => (parseInt(a.priority) || 99) - (parseInt(b.priority) || 99));
    await dbSaveCloudFleet(networkKey, updated);
    return res.json({ success: true, rpc: newRecord, rpcs: updated, fleetRpcs: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/fleet-rpcs/delete', adminAuthMiddleware, async (req, res) => {
  const payload = req.body;
  const id = payload.id;
  const networkKey = payload.networkKey || payload.network || 'robinhood';
  if (!id) return res.status(400).json({ success: false, error: 'ID is required' });
  try {
    const currentList = await dbGetCloudFleet(networkKey);
    const updated = currentList.filter(r => r.id !== id);
    await dbSaveCloudFleet(networkKey, updated);
    return res.json({ success: true, rpcs: updated, fleetRpcs: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/fleet-rpcs/toggle', adminAuthMiddleware, async (req, res) => {
  const payload = req.body;
  const id = payload.id;
  const isActive = payload.isActive !== undefined ? payload.isActive : (payload.active !== undefined ? payload.active : true);
  const networkKey = payload.networkKey || payload.network || 'robinhood';
  if (!id) return res.status(400).json({ success: false, error: 'ID is required' });
  try {
    const currentList = await dbGetCloudFleet(networkKey);
    const updated = currentList.map(r => r.id === id ? { ...r, is_active: Boolean(isActive) } : r);
    await dbSaveCloudFleet(networkKey, updated);
    return res.json({ success: true, rpcs: updated, fleetRpcs: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 7. ADMIN CONTROLS (ADMINAUTHMIDDLEWARE PROTECTED) ───────────────────────

// Fetch all registered users
app.get('/api/users', adminAuthMiddleware, async (req, res) => {
  const users = await dbGetUsers();
  
  if (!users.some(u => u.email === OWNER_EMAIL)) {
    users.unshift({
      id: 'owner_sniper_001',
      email: OWNER_EMAIL,
      role: 'admin',
      invite_code_used: 'MASTER_OWNER_KEY',
      valid_until: new Date(Date.now() + 3650 * 86400000).toISOString(),
      max_snipes_allowed: 0,
      total_snipes: 0,
      is_banned: false,
      created_at: new Date('2026-01-01').toISOString(),
      last_active_at: new Date().toISOString()
    });
  }

  const safeList = users.map(u => ({
    id: u.id,
    user_id: u.id,
    email: u.email,
    role: u.email === OWNER_EMAIL ? 'admin' : (u.role || 'vip_member'),
    invite_code_used: u.invite_code_used || '—',
    valid_until: u.valid_until,
    max_snipes_allowed: u.max_snipes_allowed || 0,
    total_snipes: u.total_snipes || 0,
    is_banned: Boolean(u.is_banned),
    created_at: u.created_at,
    last_active_at: u.last_active_at
  }));
  res.json({ success: true, users: safeList });
});

// Extend Validity Days
app.post('/api/users/extend-validity', adminAuthMiddleware, async (req, res) => {
  try {
    const userId = req.body.userId || req.body.user_id;
    const user = await dbGetUserById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    let newValidUntil;
    if (req.body.valid_until) {
      newValidUntil = new Date(req.body.valid_until).toISOString();
    } else {
      const addDays = parseInt(req.body.days) || 30;
      const baseDate = user.valid_until && new Date(user.valid_until) > new Date() ? new Date(user.valid_until) : new Date();
      baseDate.setDate(baseDate.getDate() + addDays);
      newValidUntil = baseDate.toISOString();
    }

    const updated = await dbUpdateUser(user.id, { valid_until: newValidUntil });
    if (updated) return res.json({ success: true, valid_until: updated.valid_until });
    return res.status(500).json({ success: false, error: 'Update failed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Extend Snipes Quota Limit
app.post('/api/users/extend-snipes', adminAuthMiddleware, async (req, res) => {
  try {
    const userId = req.body.userId || req.body.user_id;
    const addCount = req.body.count || req.body.add_snipes || 10;
    const user = await dbGetUserById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    let newQuota = user.max_snipes_allowed;
    if (req.body.set_unlimited) {
      newQuota = 0;
    } else if (req.body.set_total_quota !== undefined) {
      newQuota = parseInt(req.body.set_total_quota) || 0;
    } else {
      newQuota = (user.max_snipes_allowed || 0) + parseInt(addCount);
    }

    const updated = await dbUpdateUser(user.id, { max_snipes_allowed: newQuota });
    if (updated) return res.json({ success: true, max_snipes_allowed: updated.max_snipes_allowed, total_snipes: updated.total_snipes });
    return res.status(500).json({ success: false, error: 'Update failed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Toggle Ban
app.post('/api/users/toggle-ban', adminAuthMiddleware, async (req, res) => {
  try {
    const userId = req.body.userId || req.body.user_id;
    const user = await dbGetUserById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const isBanned = req.body.is_banned !== undefined ? Boolean(req.body.is_banned) : !user.is_banned;
    const updated = await dbUpdateUser(user.id, { is_banned: isBanned });
    if (updated) {
      console.log(`[Sniper DB] User ${updated.email} ban state set to: ${updated.is_banned}`);
      return res.json({ success: true, is_banned: updated.is_banned, message: isBanned ? 'User banned' : 'User unbanned' });
    }
    return res.status(500).json({ success: false, error: 'Update failed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Permanently Delete User
app.post('/api/users/delete', adminAuthMiddleware, async (req, res) => {
  try {
    const target = req.body.userId || req.body.user_id || req.body.id || req.body.email;
    if (!target) return res.status(400).json({ success: false, error: 'User ID or email is required' });

    let user = await dbGetUserById(target);
    if (!user) user = await dbGetUserByEmail(target);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    if (user.email === OWNER_EMAIL) {
      return res.status(400).json({ success: false, error: 'Cannot delete platform owner account' });
    }

    const ok = await dbDeleteUser(user.id);
    await dbDeleteUserConfig(user.id);
    if (ok) {
      console.log(`[Sniper DB] Permanently deleted user ${user.email} (${user.id})`);
      return res.json({ success: true, message: 'User deleted permanently' });
    }
    return res.status(500).json({ success: false, error: 'Delete failed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Record on-chain snipe operation
app.post('/api/users/record-snipe', async (req, res) => {
  try {
    const { user_id, email, count } = req.body;
    const identifier = user_id || email;
    if (identifier) {
      const newTotal = await dbRecordUserSnipe(identifier, parseInt(count) || 1);
      if (newTotal !== null) return res.json({ success: true, total_snipes: newTotal });
    }
    return res.status(404).json({ success: false, error: 'User not found' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Fetch all VIP invites
app.get('/api/invites', adminAuthMiddleware, async (req, res) => {
  const invites = await dbGetInvites();
  res.json({ success: true, invites });
});

// Create Dual-Constraint VIP Invite Code
app.post('/api/invites/create', adminAuthMiddleware, async (req, res) => {
  try {
    const code = req.body.code;
    const validityDays = req.body.validityDays || req.body.validity_days || 30;
    const maxSnipesLimit = req.body.maxSnipesLimit !== undefined ? req.body.maxSnipesLimit : (req.body.snipes_quota !== undefined ? req.body.snipes_quota : 0);
    const maxUses = req.body.maxUses || req.body.max_uses || 1;
    if (!code) return res.status(400).json({ success: false, error: 'Code is required' });

    const clean = code.trim().toUpperCase().replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');
    const newInvite = {
      invite_code: clean,
      note: 'VIP Access Key (Admin Generated)',
      validity_days: parseInt(validityDays) || 30,
      max_snipes_limit: parseInt(maxSnipesLimit) || 0,
      max_uses: parseInt(maxUses) || 1,
      used_count: 0,
      is_active: true
    };

    const saved = await dbUpsertInvite(newInvite);
    return res.json({ success: true, invite: saved });
  } catch (err) {
    console.error('[Sniper DB - CreateInvite Error]:', err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
  }
});

// Toggle Invite Active
app.post('/api/invites/toggle', adminAuthMiddleware, async (req, res) => {
  try {
    const inviteId = req.body.inviteId || req.body.invite_id || req.body.id || req.body.code || req.body.invite_code;
    const isActive = req.body.isActive !== undefined ? req.body.isActive : req.body.is_active;
    if (!inviteId) return res.status(400).json({ success: false, error: 'inviteId is required' });
    const updated = await dbUpdateInvite(inviteId, { is_active: Boolean(isActive) });
    if (updated) return res.json({ success: true, message: 'Invite status updated' });
    return res.status(500).json({ success: false, error: 'Failed to update invite in database' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Invite
app.post('/api/invites/delete', adminAuthMiddleware, async (req, res) => {
  try {
    const inviteId = req.body.inviteId || req.body.invite_id || req.body.id || req.body.code || req.body.invite_code;
    if (!inviteId) return res.status(400).json({ success: false, error: 'inviteId is required' });
    const ok = await dbDeleteInvite(inviteId);
    if (ok) return res.json({ success: true, message: 'Invite deleted successfully' });
    return res.status(500).json({ success: false, error: 'Failed to delete invite from database' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  const [users, invites] = await Promise.all([dbGetUsers(), dbGetInvites()]);
  res.json({
    status: 'online',
    app: 'NFT Sniper V2 Cloud API (Supabase PostgreSQL Isolated Database)',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    database: 'Supabase PostgreSQL 24/7 Cloud (Sniper Isolated)',
    registeredUsersCount: users.length,
    activeInvitesCount: invites.length
  });
});

// SSE Stream for Real-Time UI Broadcasts
app.get('/api/stream/events', (req, res) => {
  const slug = (req.query.slug || '').trim().toLowerCase();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const client = { res, slug };
  sseClients.add(client);
  if (slug) subscribeSlugToOpenSea(slug);

  // 🛡️ AUDIT FIX L-3: Fast 500ms SSE reconnect for sniper responsiveness
  res.write('retry: 500\n\n');
  res.write(`data: ${JSON.stringify({ type: 'connected', slug, time: Date.now() })}\n\n`);

  req.on('close', () => {
    sseClients.delete(client);
    if (slug) {
      const hasOther = Array.from(sseClients).some(c => c.slug === slug);
      const isSniperActive = activeSniperEngine.isArmed && (activeSniperEngine.slug === slug || activeSniperEngine.slug === '*');
      if (!hasOther && !isSniperActive) streamListener.unsubscribe(slug);
    }
  });
});

// Explicit Clear Stream
app.post('/api/stream/clear', (req, res) => {
  const { slug } = req.body;
  if (slug) streamListener.unsubscribe(slug);
  else streamListener.unsubscribeAll();
  res.json({ success: true, message: 'Stream unsubscribed successfully' });
});

// ETH Index Price
app.get('/api/eth-price', (req, res) => {
  res.json({
    success: true,
    priceUsd: cachedEthPrice,
    formatted: `$${cachedEthPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`,
    timestamp: Date.now()
  });
});

// Live Telemetry
app.get('/api/telemetry', (req, res) => {
  res.json({
    success: true,
    ...cachedTelemetry,
    ethPriceUsd: cachedEthPrice
  });
});

// Batch Fetch On-Chain Balances
app.post('/api/wallets/balances', async (req, res) => {
  const { addresses } = req.body;
  if (!addresses || !Array.isArray(addresses)) {
    return res.status(400).json({ success: false, error: 'addresses array required' });
  }

  const rpcUrl = seaportExecutor.rpcs[0];
  const results = {};

  await Promise.all(addresses.map(async (addr) => {
    if (!addr || !addr.startsWith('0x') || addr.length !== 42) return;
    try {
      const rpcRes = await apiClient.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [addr.trim(), 'latest']
      });
      if (rpcRes.data?.result) {
        const balWei = BigInt(rpcRes.data.result);
        const ethStr = ethers.formatEther(balWei);
        const ethNum = parseFloat(ethStr);
        results[addr.trim()] = {
          balanceWei: balWei.toString(),
          balanceEth: ethNum,
          balanceEthStr: ethStr,
          balanceUsd: ethNum * cachedEthPrice,
          formatted: `${ethStr} ETH`
        };
      }
    } catch (e) {
      results[addr.trim()] = { balanceWei: '0', balanceEth: 0, balanceEthStr: '0.0', balanceUsd: 0, formatted: '0.000000 ETH' };
    }
  }));

  res.json({ success: true, balances: results });
});

// Arm Sniper Engine (8-Feature Advanced Suite)
app.post('/api/snipe/arm', async (req, res) => {
  const {
    slug,
    triggerMode,
    maxFloorEth,
    maxRareRank,
    maxRareEth,
    gasSpeed,
    customGas,
    buyerPrivateKey,
    buyerName,
    workers,
    workerStrategy,
    maxSnipesLimit,
    dryRun,
    specificTokenIds,
    specificTokenMaxEth,
    traitFilter,
    traitFilters,
    traitMaxEth,
    ruleStates,
    userId
  } = req.body;

  // License & Subscription Verification Guard
  if (userId) {
    try {
      const dbUser = await dbGetUserById(userId);
      if (dbUser) {
        if (dbUser.is_banned) {
          return res.status(403).json({ success: false, error: '🚫 Account suspended by Administrator.' });
        }
        if (dbUser.valid_until && new Date(dbUser.valid_until) < new Date() && dbUser.email !== OWNER_EMAIL) {
          return res.status(403).json({ success: false, error: `⏳ VIP Validity expired on ${new Date(dbUser.valid_until).toLocaleDateString()}. Please renew.` });
        }
        if (dbUser.max_snipes_allowed > 0 && (dbUser.total_snipes || 0) >= dbUser.max_snipes_allowed && dbUser.email !== OWNER_EMAIL) {
          return res.status(403).json({ success: false, error: `🎯 Snipes Quota reached (${dbUser.total_snipes}/${dbUser.max_snipes_allowed}). Please extend quota.` });
        }
      }
    } catch (e) {}
  }

  if (!buyerPrivateKey && !dryRun) {
    return res.status(400).json({ success: false, error: 'Buyer wallet private key is required' });
  }

  try {
    const provider = seaportExecutor.providers[0];
    let signer = null;
    let buyerAddress = '0x0000000000000000000000000000000000000001';

    if (buyerPrivateKey) {
      const cleanPk = buyerPrivateKey.trim();
      signer = new ethers.Wallet(cleanPk, provider);
      buyerAddress = signer.address;
    }

    // Build worker pool for multi-worker strategy
    const workerPool = [];
    if (Array.isArray(workers) && workers.length > 0) {
      workers.forEach(w => {
        if (w.privateKey) {
          try {
            const s = new ethers.Wallet(w.privateKey.trim(), provider);
            workerPool.push({
              signer: s,
              address: s.address,
              name: w.name || 'Worker',
              privateKey: w.privateKey.trim()
            });
          } catch(e) {}
        }
      });
    }
    if (workerPool.length === 0 && signer) {
      workerPool.push({ signer, address: buyerAddress, name: buyerName || 'Worker', privateKey: buyerPrivateKey });
    }

    // Parse specific token IDs set with regex split and full sanitization
    const tokenSet = new Set();
    if (specificTokenIds) {
      const items = Array.isArray(specificTokenIds) 
        ? specificTokenIds 
        : String(specificTokenIds).split(/[\s,]+/);
      items.forEach(id => {
        const clean = String(id).trim().replace(/[^0-9]/g, '');
        if (clean) tokenSet.add(clean);
      });
    }

    activeSniperEngine = {
      isArmed: true,
      armedTimestamp: Date.now(),
      slug: (slug || '*').trim().toLowerCase(),
      triggerMode: triggerMode || 'both',
      maxFloorEth: parseFloat(maxFloorEth) || 0,
      maxRareRank: parseInt(maxRareRank, 10) || 1200,
      maxRareEth: parseFloat(maxRareEth) || 0,
      gasSpeed: gasSpeed || 'turbo',
      customGas: customGas || null,
      buyerPrivateKey: buyerPrivateKey || '',
      buyerAddress: buyerAddress,
      buyerName: buyerName || 'Worker',
      walletSigner: signer,
      snipedTokenIds: new Set(),
      invalidOrderHashes: new Set(),
      pendingSnipes: new Set(),

      // 8 Features
      maxSnipesLimit: (maxSnipesLimit !== undefined && maxSnipesLimit !== null) ? parseInt(maxSnipesLimit, 10) : 1,
      snipesExecutedCount: 0,
      specificTokenIds: tokenSet,
      specificTokenMaxEth: parseFloat(specificTokenMaxEth) || 0,
      traitFilter: (traitFilter && (traitFilter.traitType || traitFilter.traitValue)) ? {
        traitType: (traitFilter.traitType || '').trim(),
        traitValue: (traitFilter.traitValue || '').trim(),
        maxEth: parseFloat(traitFilter.maxEth) || 0
      } : null,
      traitFilters: Array.isArray(traitFilters) ? traitFilters.map(f => ({
        traitType: String(f.traitType || '').trim(),
        traitValue: String(f.traitValue || '').trim()
      })).filter(f => f.traitType || f.traitValue) : [],
      traitMaxEth: parseFloat(traitMaxEth) || (traitFilter?.maxEth ? parseFloat(traitFilter.maxEth) : 0),
      dryRun: !!dryRun,
      workerStrategy: workerStrategy || 'single',
      workerPool: workerPool,
      workerIndex: 0,
      ruleStates: {
        floor: ruleStates?.floor !== false,
        rarity: ruleStates?.rarity !== false,
        trait: !!ruleStates?.trait || (Array.isArray(traitFilters) && traitFilters.length > 0) || !!traitFilter,
        tokenId: !!ruleStates?.tokenId || (tokenSet.size > 0)
      },
      authenticatedUserId: userId || null
    };

    console.log(`🎯 ⚡ [SNIPER ARMED - 8-FEATURE PRO ENGINE]`);
    console.log(`   Target Slug: "${activeSniperEngine.slug}" | Mode: ${activeSniperEngine.dryRun ? '🧪 PAPER SNIPE (SIMULATED)' : '⚡ LIVE MAINNET'}`);
    console.log(`   Limit: ${activeSniperEngine.maxSnipesLimit === 0 ? 'Unlimited' : activeSniperEngine.maxSnipesLimit + ' Snipes'} | Workers: ${workerPool.length} (${activeSniperEngine.workerStrategy})`);
    console.log(`   Rules: Floor=${activeSniperEngine.ruleStates.floor} | Rarity=${activeSniperEngine.ruleStates.rarity} | Trait=${activeSniperEngine.ruleStates.trait} | TokenTrap=${activeSniperEngine.ruleStates.tokenId}`);

    if (activeSniperEngine.slug && activeSniperEngine.slug !== '*') {
      subscribeSlugToOpenSea(activeSniperEngine.slug);
    }

    res.json({
      success: true,
      message: 'Ultra-Fast 8-Feature Sniper Engine ARMED in Node.js backend memory',
      buyerAddress: buyerAddress,
      targetSlug: activeSniperEngine.slug,
      isDryRun: activeSniperEngine.dryRun,
      workersLoaded: workerPool.length,
      maxLimit: activeSniperEngine.maxSnipesLimit
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Live Hunting Radar Telemetry Endpoint (Feature 7)
app.get('/api/snipe/telemetry', (req, res) => {
  res.json({
    success: true,
    isArmed: activeSniperEngine.isArmed,
    snipesExecutedCount: activeSniperEngine.snipesExecutedCount,
    maxSnipesLimit: activeSniperEngine.maxSnipesLimit,
    dryRun: activeSniperEngine.dryRun,
    targetSlug: activeSniperEngine.slug,
    workerStrategy: activeSniperEngine.workerStrategy,
    workersCount: activeSniperEngine.workerPool ? activeSniperEngine.workerPool.length : 1,
    ruleStates: activeSniperEngine.ruleStates,
    activeCollectionStats: activeCollectionStats,
    timestamp: Date.now()
  });
});

// Disarm Sniper Engine
app.post('/api/snipe/disarm', (req, res) => {
  activeSniperEngine.isArmed = false;
  activeSniperEngine.walletSigner = null;
  activeSniperEngine.buyerPrivateKey = '';
  // 🛡️ AUDIT FIX C-1: Purge all worker private keys from RAM on disarm
  if (activeSniperEngine.workerPool && activeSniperEngine.workerPool.length > 0) {
    activeSniperEngine.workerPool.forEach(w => { delete w.privateKey; w.signer = null; });
  }
  // 🛡️ AUDIT FIX C-2: Reset nonce cache on disarm
  walletNonceMap.clear();
  console.log(`⏸ [SNIPER V2 DISARMED] Keys purged from RAM.`);
  res.json({ success: true, message: 'Sniper Engine Disarmed & Keys Purged' });
});

// Manual Buy / Fallback with Multi-RPC Blast
app.post('/api/snipe/buy', async (req, res) => {
  const { buyerPrivateKey, protocolData, orderHash, tokenId, gasSpeed, workerIndex } = req.body;

  // 🛡️ AUDIT FIX LOW-8: Prefer armed worker pool (keys already in RAM) over HTTP-sent key
  let signer = null;
  let buyerAddress = '';
  const provider = seaportExecutor.providers[0];

  if (activeSniperEngine.workerPool && activeSniperEngine.workerPool.length > 0) {
    // Use specified worker or first available from pool
    const idx = (typeof workerIndex === 'number' && workerIndex < activeSniperEngine.workerPool.length) ? workerIndex : 0;
    const worker = activeSniperEngine.workerPool[idx];
    if (worker && worker.signer) {
      signer = worker.signer;
      buyerAddress = worker.address || signer.address;
    }
  }

  // Fallback: accept private key from request if no armed workers available
  if (!signer && buyerPrivateKey) {
    signer = new ethers.Wallet(buyerPrivateKey, provider);
    buyerAddress = signer.address;
  }

  if (!signer) {
    return res.status(400).json({ success: false, error: 'No armed worker wallet available. Arm the sniper first or provide a buyer key.' });
  }

  const tokIdStr = String(tokenId || '');
  if (!activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes = new Set();
  if (!activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds = new Set();

  if (tokIdStr) {
    if (activeSniperEngine.pendingSnipes.has(tokIdStr) || activeSniperEngine.snipedTokenIds.has(tokIdStr)) {
      return res.json({
        success: true,
        alreadyProcessing: true,
        message: `Token #${tokIdStr} is already being processed by zero-hop engine.`
      });
    }
    // 🛡️ ATOMIC SYNCHRONOUS LOCK: Claim token in RAM immediately to block concurrent backend dispatch
    activeSniperEngine.pendingSnipes.add(tokIdStr);
    activeSniperEngine.snipedTokenIds.add(tokIdStr);
  }

  try {
    // Helper function to handle post-buy circuit breaker & stats
    const handleSnipeSuccess = (txHash, blockNumber) => {
      if (tokIdStr && activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
      if (tokenId) activeSniperEngine.snipedTokenIds.add(String(tokenId));
      activeSniperEngine.snipesExecutedCount++;

      const isCircuitBreakerHit = activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit;
      if (isCircuitBreakerHit) {
        activeSniperEngine.isArmed = false;
        broadcastSnipeLog(`🛑 [CIRCUIT BREAKER] Completed ${activeSniperEngine.snipesExecutedCount} of ${activeSniperEngine.maxSnipesLimit} allowed snipes. Auto-disarmed.`);
        broadcastToClients({
          type: 'circuit_breaker_paused',
          executed: activeSniperEngine.snipesExecutedCount,
          limit: activeSniperEngine.maxSnipesLimit
        });
      }

      return {
        isCircuitBreakerHit,
        snipesExecuted: activeSniperEngine.snipesExecutedCount,
        maxLimit: activeSniperEngine.maxSnipesLimit
      };
    };

    // 1. Direct Seaport protocol_data execution if provided
    if (protocolData?.parameters && protocolData?.signature) {
      const txObj = seaportExecutor.buildSeaportTransaction(protocolData, buyerAddress, gasSpeed || 'turbo');
      const tx = await signer.sendTransaction(txObj);
      const receipt = await tx.wait(1);

      const cbStatus = handleSnipeSuccess(tx.hash, receipt.blockNumber);

      return res.json({
        success: true,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        buyer: buyerAddress,
        tokenId,
        circuitBreakerHit: cbStatus.isCircuitBreakerHit,
        executedCount: cbStatus.snipesExecuted,
        maxLimit: cbStatus.maxLimit
      });
    }

    // 2. Fallback to OpenSea Fulfillment API using 24/7 API Shop
    const hashToFulfill = orderHash || protocolData?.orderHash;
    if (hashToFulfill) {
      const fulRes = await fetchSeaportFulfillmentWithShop(hashToFulfill, 'robinhood', buyerAddress, tokenId);
      if (!fulRes.success) {
        if (fulRes.isDeadOrder) {
          if (hashToFulfill && activeSniperEngine.invalidOrderHashes) {
            activeSniperEngine.invalidOrderHashes.add(hashToFulfill);
          }
          if (tokenId && activeSniperEngine.snipedTokenIds) {
            activeSniperEngine.snipedTokenIds.add(String(tokenId));
          }
        } else {
          // Temporary error: rollback locks so retry is possible
          if (tokIdStr) {
            if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
            if (activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds.delete(tokIdStr);
          }
        }
        return res.status(400).json({
          success: false,
          isDeadOrder: fulRes.isDeadOrder,
          error: `OpenSea Fulfillment API: ${fulRes.error}`
        });
      }

      if (fulRes.data?.fulfillment_data?.transaction) {
        const txData = fulRes.data.fulfillment_data.transaction;
        const fnName = txData.function.split('(')[0];
        let calldata = seaportExecutor.seaportInterface.encodeFunctionData(fnName, [txData.input_data.parameters]);
        if (txData.calldata_suffix) calldata += txData.calldata_suffix.replace('0x', '');

        const txObj = {
          to: txData.to,
          data: calldata,
          value: BigInt(txData.value || '0'),
          gasLimit: 260000n,
          gasPrice: (seaportExecutor.cachedBaseFee * 235n) / 100n,
          type: 0
        };

        const tx = await signer.sendTransaction(txObj);
        const receipt = await tx.wait(1);

        const cbStatus = handleSnipeSuccess(tx.hash, receipt.blockNumber);

        return res.json({
          success: true,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          buyer: buyerAddress,
          tokenId,
          circuitBreakerHit: cbStatus.isCircuitBreakerHit,
          executedCount: cbStatus.snipesExecuted,
          maxLimit: cbStatus.maxLimit
        });
      }
    }

    if (tokIdStr) {
      if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
      if (activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds.delete(tokIdStr);
    }
    return res.status(400).json({ success: false, error: 'Missing protocol order data or order hash' });
  } catch (err) {
    if (tokIdStr) {
      if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
      if (activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds.delete(tokIdStr);
    }
    const errDetail = err.response?.data?.errors?.join(', ') || err.response?.data?.detail || err.message;
    return res.status(500).json({ success: false, error: errDetail });
  }
});

// ─── AEROMINT-STYLE 1-SECOND UNIFIED COLLECTION SCANNER ─────────────────────
// ─── FUZZY SLUG AUTO-RESOLVER (TYPO PROTECTION) ────────────────────────────
function levenshteinDistance(s1, s2) {
  const m = s1.length, n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function resolveClosestCollectionSlug(inputSlug) {
  if (!inputSlug) return inputSlug;
  const clean = inputSlug.trim().toLowerCase();
  
  // Check in-memory activeCollectionStats
  if (activeCollectionStats && activeCollectionStats.slug) {
    const s = activeCollectionStats.slug.toLowerCase();
    if (s === clean) return activeCollectionStats.slug;
  }

  const candidatePool = new Set(['ponsguy-nft', 'ntrpygenesis', 'rhmachines']);

  // Check cache folder
  try {
    const cacheDir = path.join(__dirname, 'cache');
    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir);
      files.filter(f => f.endsWith('-rarity.json')).forEach(f => {
        candidatePool.add(f.replace('-rarity.json', '').toLowerCase());
      });
    }
  } catch(e) {}

  for (const candidate of candidatePool) {
    if (candidate === clean) return candidate;
    const a = clean.replace(/[^a-z0-9]/g, '');
    const b = candidate.replace(/[^a-z0-9]/g, '');
    if (a === b) return candidate;
    const dist = levenshteinDistance(a, b);
    if (dist <= 3) {
      console.log(`🔍 [TYPO AUTO-RESOLVED] "${clean}" ➔ "${candidate}" (distance: ${dist})`);
      return candidate;
    }
  }

  return clean;
}

// ─── 1-SHOT DIRECT AUTHORITATIVE STATS RESOLVER (EXACT OPENSEA MATCH) ─────────
async function fetchOpenSeaAuthoritativeStats(slug) {
  try {
    const res = await fetch(`https://opensea.io/collection/${slug}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(3500)
    });
    if (!res.ok) return null;
    const html = await res.text();

    let listedCount = null, floorEth = null, floorUsd = null, owners = null;

    // 🛡️ AUDIT FIX MED-1: Try structured JSON extraction FIRST (robust against HTML changes)
    try {
      // OpenSea embeds URQL/Next.js data as JSON in script tags
      const jsonBlocks = html.match(/<script[^>]*>(\{[^<]*"listedItemCount"[^<]*})<\/script>/g);
      if (jsonBlocks) {
        for (const block of jsonBlocks) {
          const jsonStr = block.replace(/<\/?script[^>]*>/g, '');
          try {
            const data = JSON.parse(jsonStr);
            const traverse = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              if (obj.listedItemCount !== undefined) listedCount = parseInt(obj.listedItemCount, 10);
              if (obj.floorPrice?.unit !== undefined) floorEth = parseFloat(obj.floorPrice.unit);
              if (obj.floorPrice?.usd !== undefined) floorUsd = parseFloat(obj.floorPrice.usd);
              if (obj.ownerCount !== undefined) owners = parseInt(obj.ownerCount, 10);
              for (const val of Object.values(obj)) traverse(val);
            };
            traverse(data);
            if (listedCount !== null) break; // Found what we need
          } catch (parseErr) {} // Not valid JSON, try next block
        }
      }
    } catch (jsonErr) {}

    // Regex fallback if JSON extraction didn't find data
    if (listedCount === null) {
      const mListed = html.match(/"listedItemCount":\s*(\d+)/);
      listedCount = mListed ? parseInt(mListed[1], 10) : null;
    }
    if (floorEth === null) {
      const mFloorUnit = html.match(/"floorPrice":\{[^}]*?"unit":\s*([\d\.]+)/);
      floorEth = mFloorUnit ? parseFloat(mFloorUnit[1]) : null;
    }
    if (floorUsd === null) {
      const mFloorUsd = html.match(/"floorPrice":\{[^}]*?"usd":\s*([\d\.]+)/);
      floorUsd = mFloorUsd ? parseFloat(mFloorUsd[1]) : null;
    }
    if (owners === null) {
      const mOwners = html.match(/"ownerCount":\s*(\d+)/);
      owners = mOwners ? parseInt(mOwners[1], 10) : null;
    }

    // 🛡️ AUDIT FIX MED-1: Warn when extraction fails for debugging
    if (listedCount === null && floorEth === null) {
      console.warn(`⚠ [STATS] Failed to extract any stats from OpenSea HTML for "${slug}" — format may have changed`);
    }

    return {
      listedCount: (listedCount && listedCount > 0) ? listedCount : null,
      floorEth: (floorEth && floorEth > 0) ? floorEth : null,
      floorUsd: (floorUsd && floorUsd > 0) ? floorUsd : null,
      owners
    };
  } catch (e) {
    console.warn(`⚠ [STATS] fetchOpenSeaAuthoritativeStats error for "${slug}": ${e.message}`);
  }
  return null;
}

// ─── NON-BLOCKING ASYNC BACKGROUND LISTING INDEXER ──────────────────────────
let activeIndexingJob = null;

async function runBackgroundListingIndexer(slug, startCursor, initialTokenIds) {
  const jobKey = `${slug}_${Date.now()}`;
  activeIndexingJob = jobKey;

  initialTokenIds.forEach(id => activeListedTokenIds.add(String(id)));
  if (activeCollectionStats && activeCollectionStats.slug === slug) {
    if (!activeCollectionStats.listedCount || activeListedTokenIds.size > activeCollectionStats.listedCount) {
      activeCollectionStats.listedCount = activeListedTokenIds.size;
    }
  }

  let cursor = startCursor;
  let page = 1;
  const maxPages = 80;

  console.log(`🚀 [ASYNC INDEXER] Starting background full ingestion for "${slug}"...`);

  while (cursor && page < maxPages) {
    if (activeIndexingJob !== jobKey) {
      console.log(`⏹ [ASYNC INDEXER] Aborting previous indexing job for "${slug}" (new scan started)`);
      break;
    }
    page++;
    try {
      const keyIdx = (page % 5) + 1; // Round-robin Keys #2..#6
      const pageUrl = `/listings/collection/${slug}/all?limit=100&next=${cursor}`;
      const pageRes = await fetchOpenSeaWithFallback(pageUrl, keyIdx);
      const items = Array.isArray(pageRes?.listings) ? pageRes.listings : [];

      items.forEach(item => {
        const id = String(item.asset?.identifier || item.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria || '');
        if (id && id !== '0') activeListedTokenIds.add(id);
      });

      if (activeCollectionStats && activeCollectionStats.slug === slug) {
        if (!activeCollectionStats.listedCount || activeListedTokenIds.size > activeCollectionStats.listedCount) {
          activeCollectionStats.listedCount = activeListedTokenIds.size;
        }
      }

      if (page % 2 === 0) {
        broadcastToClients({
          type: 'count_sync',
          slug: slug,
          liveListedCount: activeCollectionStats?.listedCount || activeListedTokenIds.size,
          isComplete: false
        });
      }

      if (!pageRes?.next || items.length === 0) break;
      cursor = pageRes.next;
    } catch(err) {
      break;
    }
  }

  if (activeIndexingJob === jobKey && activeCollectionStats && activeCollectionStats.slug === slug) {
    if (!activeCollectionStats.listedCount || activeListedTokenIds.size > activeCollectionStats.listedCount) {
      activeCollectionStats.listedCount = activeListedTokenIds.size;
    }
    console.log(`✔ [ASYNC INDEXER COMPLETE] "${slug}": ${activeListedTokenIds.size} unique floor tokens indexed | Authoritative: ${activeCollectionStats.listedCount}`);
    broadcastToClients({
      type: 'count_sync',
      slug: slug,
      liveListedCount: activeCollectionStats.listedCount,
      isComplete: true
    });
  }
}

app.post('/api/scan', async (req, res) => {
  let { input } = req.body;
  if (!input) return res.status(400).json({ success: false, error: 'Collection URL or slug required' });

  input = input.trim();
  if (input.includes('opensea.io/collection/')) {
    const parts = input.split('opensea.io/collection/');
    input = parts[1].split('/')[0].split('?')[0].trim();
  } else if (input.includes('opensea.io/assets/')) {
    const parts = input.split('opensea.io/assets/')[1].split('/');
    if (parts.length >= 2 && parts[1].startsWith('0x')) {
      input = parts[1].split('?')[0].trim();
    }
  }
  let slug = resolveClosestCollectionSlug(input.toLowerCase());

  try {
    // ⚡ 1. RESOLVE COLLECTION METADATA (Key #1 priority + smart contract fallback + backoff retry)
    let colData = null;
    try {
      colData = await fetchOpenSeaWithFallback(`/collections/${slug}`, 0);
    } catch (e) {}

    // Fallback if slug was a contract address or 0x address
    if (!colData && slug.startsWith('0x')) {
      try {
        const cRes = await fetchOpenSeaWithFallback(`/chain/robinhood/contract/${slug}`, 0);
        if (cRes?.collection) {
          slug = cRes.collection;
          colData = await fetchOpenSeaWithFallback(`/collections/${slug}`, 0);
        }
      } catch(e) {}
    }

    // Failsafe Retry: If colData is still null (e.g. momentary 429 burst), wait 150ms and try once more
    if (!colData) {
      await new Promise(r => setTimeout(r, 150));
      try {
        colData = await fetchOpenSeaWithFallback(`/collections/${slug}`, 0);
      } catch(e) {}
    }

    if (!colData) {
      return res.status(404).json({ success: false, error: `Collection "${input}" not found on OpenSea. Please verify the slug/contract.` });
    }

    // ⚡ 2. FETCH TRAITS, INITIAL LISTINGS & DIRECT STATS IN PARALLEL
    const [tRes, page1Res, directStats] = await Promise.all([
      fetchOpenSeaWithFallback(`/traits/${slug}`, 2).catch(() => null),
      fetchOpenSeaWithFallback(`/listings/collection/${slug}/all?limit=50`, 3).catch(() => null),
      fetchOpenSeaAuthoritativeStats(slug).catch(() => null)
    ]);

    // Immediately initialize activeCollectionStats with authoritative direct count
    activeCollectionStats = {
      slug: colData?.collection || slug,
      name: colData?.name || slug.toUpperCase(),
      totalSupply: colData?.total_supply || 9999,
      listedCount: directStats?.listedCount || (activeCollectionStats?.slug === slug && activeCollectionStats.listedCount > 0 ? activeCollectionStats.listedCount : 100),
      floorEth: directStats?.floorEth || 0.005
    };

    // Subscribe WebSocket immediately so no listings are missed
    subscribeSlugToOpenSea(slug);

    // Traits parsing
    let collectionTraits = null;
    if (tRes && tRes.counts) {
      collectionTraits = {
        categories: Object.keys(tRes.counts || tRes.categories || {}),
        counts: tRes.counts
      };
    }

    let allRawListings = Array.isArray(page1Res?.listings) ? page1Res.listings : [];
    let cursor = page1Res?.next;
    let scanPage = 1;
    // 🛡️ Lean 3-page scan ensures instant sub-second response and prevents OpenSea 429 rate limit triggers
    const targetUniqueTokens = 60;
    const maxScanPages = 3;

    // Track unique tokens by ID keeping lowest price
    const tokenBestListingMap = new Map();
    allRawListings.forEach(item => {
      const tokenId = String(item.asset?.identifier || item.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria || '0');
      if (!tokenId || tokenId === '0') return;
      const decimals = item.price?.current?.decimals || 18;
      const valBig = BigInt(item.price?.current?.value || '0');
      const priceEth = Number(valBig) / Number(10n ** BigInt(decimals));
      const existing = tokenBestListingMap.get(tokenId);
      if (!existing || priceEth < existing.price) {
        tokenBestListingMap.set(tokenId, { item, price: priceEth });
      }
    });

    // If page 1 had fewer than targetUniqueTokens, follow next cursor up to maxScanPages
    while (cursor && tokenBestListingMap.size < targetUniqueTokens && scanPage < maxScanPages) {
      scanPage++;
      try {
        const keyIdx = (scanPage % 5) + 1;
        const pageRes = await fetchOpenSeaWithFallback(`/listings/collection/${slug}/all?limit=50&next=${cursor}`, keyIdx);
        const items = Array.isArray(pageRes?.listings) ? pageRes.listings : [];
        items.forEach(item => {
          const tokenId = String(item.asset?.identifier || item.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria || '0');
          if (!tokenId || tokenId === '0') return;
          const decimals = item.price?.current?.decimals || 18;
          const valBig = BigInt(item.price?.current?.value || '0');
          const priceEth = Number(valBig) / Number(10n ** BigInt(decimals));
          const existing = tokenBestListingMap.get(tokenId);
          if (!existing || priceEth < existing.price) {
            tokenBestListingMap.set(tokenId, { item, price: priceEth });
          }
        });
        allRawListings = allRawListings.concat(items);
        if (!pageRes?.next || items.length === 0) break;
        cursor = pageRes.next;
      } catch(e) {
        break;
      }
    }

    const primaryContract = colData?.contracts?.[0] || {};
    const contractAddress = primaryContract.address || (slug.startsWith('0x') ? slug : '0x8c71d170fbd94bcba93bb08fc2cfd0e8620cd9ce');
    const chain = primaryContract.chain || 'robinhood';
    const totalSupply = colData?.total_supply || 9999;

    // Now format structured objects for realListings
    const realListings = [];
    tokenBestListingMap.forEach(({ item, price }, tokenId) => {
      const priceEth = price;
      const createdAt = item.order_created_at ? (typeof item.order_created_at === 'number' ? item.order_created_at * 1000 : new Date(item.order_created_at).getTime()) : Date.now();
      const trueRank = rarityEngine.getRaritySync(tokenId);
      realListings.push({
        tokenId,
        name: `#${tokenId}`,
        contractAddress,
        chain,
        image: item.asset?.image_url || '',
        price: priceEth,
        priceFormatted: formatEthPrecise(priceEth),
        priceUsd: parseFloat((priceEth * cachedEthPrice).toFixed(2)),
        rarityRank: trueRank,
        seller: item.protocol_data?.parameters?.offerer?.slice(0, 8) || '',
        sellerFull: item.protocol_data?.parameters?.offerer || '',
        orderHash: item.order_hash || '',
        ageSeconds: Math.max(1, Math.round((Date.now() - createdAt) / 1000)),
        eventTimestamp: createdAt,
        protocolData: item.protocol_data || null,
        sniped: false
      });
    });

    realListings.sort((a, b) => a.price - b.price);

    let floorEth = 0.0395;
    if (directStats?.floorEth) floorEth = directStats.floorEth;
    else if (realListings.length > 0) floorEth = realListings[0].price;
    else if (colData?.stats?.floor_price) floorEth = parseFloat(colData.stats.floor_price);

    // Load Rarity Engine into RAM asynchronously
    rarityEngine.loadCollection(slug, chain).catch(() => {});

    // High-speed batch rank resolver for top floor listings
    if (realListings.length > 0) {
      const tokenIds = realListings.slice(0, 30).map(l => l.tokenId).filter(Boolean);
      rarityEngine.batchFetchRarities(tokenIds, chain, contractAddress).then(rarities => {
        realListings.forEach(l => {
          const info = rarities[String(l.tokenId)] || rarityEngine.getTokenInfoSync(l.tokenId);
          if (info && info.rank !== null && info.rank > 0) l.rarityRank = info.rank;
        });
      }).catch(() => {});
    }

    // Determine exact authoritative count (prefer 1-shot direct stats, fallback to active stats, then listings)
    const finalListedCount = directStats?.listedCount || (activeCollectionStats && activeCollectionStats.slug === slug && activeCollectionStats.listedCount > 0 ? activeCollectionStats.listedCount : realListings.length);

    // 🛡️ AUDIT FIX M-5: Cancel any running indexer BEFORE clearing to prevent stale token injection
    activeIndexingJob = null;
    // Reset activeListedTokenIds with initial page
    activeListedTokenIds.clear();
    realListings.forEach(item => {
      if (item.tokenId) activeListedTokenIds.add(String(item.tokenId));
    });

    // Save initial activeCollectionStats
    activeCollectionStats = {
      slug: colData?.collection || slug,
      name: colData?.name || slug.toUpperCase(),
      totalSupply,
      listedCount: finalListedCount,
      floorEth,
      contractAddress,
      chain
    };

    // 🚀 Only fire background indexer if direct stats weren't obtained to avoid wasteful API spam
    if (page1Res?.next && !directStats?.listedCount) {
      runBackgroundListingIndexer(slug, page1Res.next, Array.from(activeListedTokenIds));
    }

    console.log(`✔ [FAST SCAN COMPLETE in <500ms] ${colData?.name || slug}: ${realListings.length} floor listings ready | Authoritative Listed: ${finalListedCount} | Floor: ${floorEth} ETH!`);

    return res.json({
      success: true,
      name: colData?.name || slug.toUpperCase(),
      slug: colData?.collection || slug,
      contractAddress,
      chain: chain.toUpperCase(),
      totalSupply,
      floorEth,
      floorUsd: directStats?.floorUsd || parseFloat((floorEth * cachedEthPrice).toFixed(2)),
      listedCount: finalListedCount,
      description: colData?.description || 'Verified OpenSea Mainnet NFT Collection',
      image: colData?.image_url || '',
      traits: collectionTraits,
      realListings
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/token/rarity', async (req, res) => {
  const tokenId = req.query.tokenId;
  const chain = req.query.chain || rarityEngine.chain || 'robinhood';
  const contract = req.query.contract || rarityEngine.contractAddress;
  if (!tokenId) return res.status(400).json({ success: false, error: 'tokenId required' });
  try {
    const info = await rarityEngine.resolveRarity(tokenId, chain, contract);
    res.json({ success: true, info });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/tokens/rarity-batch', async (req, res) => {
  const { tokenIds, chain, contractAddress } = req.body || {};
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    return res.json({ success: true, rarities: {} });
  }
  try {
    const rarities = await rarityEngine.batchFetchRarities(
      tokenIds,
      chain || rarityEngine.chain,
      contractAddress || rarityEngine.contractAddress
    );
    res.json({ success: true, rarities });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Live Listings Poller Fallback
app.get('/api/listings/live', async (req, res) => {
  const slug = (req.query.slug || '').trim().toLowerCase();
  if (!slug) return res.json({ success: true, listings: [] });

  try {
    const evData = await fetchOpenSeaWithFallback(`/events/collection/${slug}?event_type=listing&limit=15`, 3);
    let listings = [];
    if (evData && Array.isArray(evData.asset_events)) {
      listings = evData.asset_events.map(ev => {
        const asset = ev.asset || {};
        const tokenId = asset.identifier || asset.token_id || String(ev.event_id || '0');
        const priceEth = ev.payment ? (parseFloat(ev.payment.quantity) / (10 ** (ev.payment.decimals || 18))) : 0.035;
        const eventTime = ev.event_timestamp ? ev.event_timestamp * 1000 : Date.now();
        return {
          tokenId,
          name: asset.name || `#${tokenId}`,
          image: asset.image_url || asset.display_image_url || '',
          imageUrl: asset.image_url || asset.display_image_url || '',
          price: priceEth,
          priceFormatted: formatEthPrecise(priceEth),
          priceUsd: parseFloat((priceEth * cachedEthPrice).toFixed(2)),
          rarityRank: rarityEngine.getRaritySync(tokenId),
          seller: ev.maker ? `${ev.maker.slice(0, 6)}...${ev.maker.slice(-4)}` : '',
          sellerFull: ev.maker || '',
          orderHash: ev.order_hash || '',
          ageSeconds: Math.max(1, Math.round((Date.now() - eventTime) / 1000)),
          eventTimestamp: eventTime,
          protocolData: ev.protocol_data || null,
          contractAddress: asset.asset_contract?.address || (activeCollectionStats?.contractAddress || ''),
          chain: 'robinhood',
          slug: slug,
          sniped: false
        };
      });

      // 🛡️ DUAL-PATH REDUNDANCY: If sniper is armed, ONLY evaluate FRESH live listings!
      // NEVER auto-snipe historical listings that took place before sniper was armed or older than 30s!
      if (activeSniperEngine.isArmed) {
        const minArmedTime = activeSniperEngine.armedTimestamp ? (activeSniperEngine.armedTimestamp - 5000) : Date.now();
        for (const item of listings) {
          const hasHash = Boolean(item.orderHash && item.orderHash.length > 10);
          const hasParams = Boolean(item.protocolData?.parameters && item.protocolData?.signature);
          if (!hasHash && !hasParams) continue; // Skip incomplete OpenSea events until orderHash is indexed

          const isAfterArm = item.eventTimestamp >= minArmedTime;
          const isFresh = item.ageSeconds <= 30;
          if (isAfterArm && isFresh) {
            const tokStr = String(item.tokenId);
            const isDead = item.orderHash && activeSniperEngine.invalidOrderHashes && activeSniperEngine.invalidOrderHashes.has(item.orderHash);
            if (!activeSniperEngine.snipedTokenIds.has(tokStr) && !isDead) {
              evaluateAndSnipe(item, slug);
            }
          }
        }
      }
    }
    res.json({ success: true, listings });
  } catch (err) {
    res.json({ success: false, listings: [] });
  }
});

// Dedicated Collection Traits Endpoint for Dynamic Dropdown
app.get('/api/collection/traits', async (req, res) => {
  const slug = (req.query.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ success: false, error: 'Slug required' });

  try {
    const data = await fetchOpenSeaWithFallback(`/traits/${slug}`, 2);
    if (data && data.counts) {
      return res.json({
        success: true,
        slug,
        categories: Object.keys(data.counts || data.categories || {}),
        counts: data.counts
      });
    }
    return res.json({ success: true, slug, categories: [], counts: {} });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── OPENSEA 6-KEY POOL MANAGEMENT ─────────────────────────────────────────
app.get('/api/opensea/keys', userAuthMiddleware, (req, res) => {
  const keys = config.opensea.apiKeys;
  const list = keys.map((k, i) => {
    const stat = openseaKeyStats[k] || { label: `Key #${i + 1}`, role: 'extra', count: 0, lastPingMs: 100, status: '200 OK' };
    return {
      key: `Key #${i + 1}`,
      masked: `${k.slice(0, 6)}••••••••••••${k.slice(-4)}`,
      label: stat.label,
      role: stat.role,
      requestsServed: stat.count,
      lastPingMs: stat.lastPingMs,
      status: stat.status,
      isStreamKey: (i === 0)
    };
  });

  const totalRequests = Object.values(openseaKeyStats).reduce((acc, s) => acc + s.count, 0);

  res.json({
    success: true,
    totalKeys: keys.length,
    totalRequests,
    strategy: '6-Key Role-Specialized Laser Grid',
    keys: list
  });
});

app.post('/api/opensea/test-key', async (req, res) => {
  const { apiKey } = req.body;
  const targetKey = apiKey || config.opensea.getNextRestKey();
  const t0 = Date.now();

  try {
    const apiRes = await apiClient.get(`${config.opensea.restApiBase}/collections/rhmachines`, {
      headers: { 'X-API-KEY': targetKey, 'Accept': 'application/json' },
      timeout: 5000
    });
    const latency = Date.now() - t0;
    trackKeyUse(targetKey, latency, '200 OK');

    res.json({
      success: true,
      apiKey: targetKey,
      masked: `${targetKey.slice(0, 8)}...${targetKey.slice(-4)}`,
      latencyMs: latency,
      status: '200 OK (Live & Operational)',
      collectionChecked: apiRes.data?.name || 'rhmachines'
    });
  } catch (err) {
    const latency = Date.now() - t0;
    const statusCode = err.response?.status || 'Network Error';
    trackKeyUse(targetKey, latency, `${statusCode} Error`);

    res.json({
      success: false,
      apiKey: targetKey,
      masked: `${targetKey.slice(0, 8)}...${targetKey.slice(-4)}`,
      latencyMs: latency,
      status: `${statusCode} Error`,
      error: err.response?.data?.detail || err.message
    });
  }
});

// ─── MULTI-WALLET FLEET FUNDING & ZERO-DUST SWEEPING ────────────────────────
app.post('/api/wallet/fund', async (req, res) => {
  const { masterPrivateKey, workers, amountEth } = req.body;
  if (!masterPrivateKey || !Array.isArray(workers) || workers.length === 0 || !amountEth) {
    return res.status(400).json({ success: false, error: 'Missing required funding parameters' });
  }

  const provider = seaportExecutor.providers[0];
  try {
    const masterSigner = new ethers.Wallet(masterPrivateKey, provider);
    const masterAddress = masterSigner.address;
    const masterBalWei = await provider.getBalance(masterAddress);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 25000000n;
    const defaultGasLimit = 30000n;
    const estGasPerTx = defaultGasLimit * gasPrice;
    const sendAmountWei = ethers.parseEther(amountEth.toString());
    const totalNeededWei = (sendAmountWei + estGasPerTx) * BigInt(workers.length);

    if (masterBalWei < totalNeededWei) {
      return res.status(400).json({
        success: false,
        error: `Insufficient Master Treasury balance. Available: ${ethers.formatEther(masterBalWei)} ETH | Needed: ${ethers.formatEther(totalNeededWei)} ETH`
      });
    }

    let nonce = await provider.getTransactionCount(masterAddress, 'pending');
    const txResults = [];

    for (const w of workers) {
      try {
        const txReq = {
          to: w.address,
          value: sendAmountWei,
          gasLimit: defaultGasLimit,
          nonce: nonce++,
          gasPrice: gasPrice,
          type: 0
        };
        const tx = await masterSigner.sendTransaction(txReq);
        txResults.push({ address: w.address, name: w.name, txHash: tx.hash, success: true });
      } catch (txErr) {
        txResults.push({ address: w.address, name: w.name, error: txErr.message, success: false });
      }
    }

    res.json({
      success: txResults.some(t => t.success),
      fundedCount: txResults.filter(t => t.success).length,
      totalCount: workers.length,
      txResults
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/wallet/sweep', async (req, res) => {
  const { masterAddress, workers } = req.body;
  if (!masterAddress || !Array.isArray(workers) || workers.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing masterAddress or workers array' });
  }

  const provider = seaportExecutor.providers[0];
  try {
    const block = await provider.getBlock('latest');
    const feeData = await provider.getFeeData();
    const liveGasPrice = block?.baseFeePerGas || feeData.gasPrice || 20200000n;
    const exactTransferGasLimit = 21225n;
    const exactGasCostWei = exactTransferGasLimit * liveGasPrice;

    const sweepResults = [];
    let totalSweptWei = 0n;

    for (const w of workers) {
      if (!w.privateKey) continue;
      try {
        const workerSigner = new ethers.Wallet(w.privateKey, provider);
        const balWei = await provider.getBalance(workerSigner.address);

        if (balWei > exactGasCostWei) {
          const sendWei = balWei - exactGasCostWei;
          const txReq = {
            to: masterAddress.trim(),
            value: sendWei,
            gasLimit: exactTransferGasLimit,
            gasPrice: liveGasPrice,
            type: 0
          };
          const tx = await workerSigner.sendTransaction(txReq);
          sweepResults.push({
            address: workerSigner.address,
            name: w.name,
            sweptEth: ethers.formatEther(sendWei),
            txHash: tx.hash,
            success: true
          });
          totalSweptWei += sendWei;
        } else {
          sweepResults.push({
            address: workerSigner.address,
            name: w.name,
            balEth: ethers.formatEther(balWei),
            reason: 'Balance is below network gas fee',
            success: false
          });
        }
      } catch (wErr) {
        sweepResults.push({
          address: w.address,
          name: w.name,
          error: wErr.message,
          success: false
        });
      }
    }

    res.json({
      success: sweepResults.some(s => s.success),
      sweptCount: sweepResults.filter(s => s.success).length,
      totalSweptEth: ethers.formatEther(totalSweptWei),
      liveGasGwei: ethers.formatUnits(liveGasPrice, 'gwei'),
      sweepResults
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/wallet/send', async (req, res) => {
  const { fromPrivateKey, toAddress, amountEth } = req.body;
  if (!fromPrivateKey || !toAddress || !amountEth) {
    return res.status(400).json({ success: false, error: 'Missing transfer parameters' });
  }

  const provider = seaportExecutor.providers[0];
  try {
    const signer = new ethers.Wallet(fromPrivateKey, provider);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 25000000n;
    const sendWei = ethers.parseEther(amountEth.toString());

    const tx = await signer.sendTransaction({
      to: toAddress,
      value: sendWei,
      gasLimit: 30000n,
      gasPrice: gasPrice,
      type: 0
    });

    res.json({ success: true, txHash: tx.hash, from: signer.address, to: toAddress, amountEth });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(` ⚡ AERO-SNIPER V2: ULTRA LOW-LATENCY PRODUCTION BOT`);
    console.log(` 👉 http://localhost:${PORT}`);
    console.log(` ⚡ 6-Key OpenSea Laser Grid (Role-Specialized) ACTIVE`);
    console.log(` ⚡ AeroMint-Style 1-Sec Unified Collection Scan ACTIVE`);
    console.log(` ⚡ Multi-RPC Simultaneous Mempool Blast ACTIVE`);
    console.log(`======================================================\n`);
  });
}

export default app;