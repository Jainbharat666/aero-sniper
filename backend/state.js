import { StreamListener } from '../src/stream.js';
import { RarityEngine, DynamicRarityCalculator } from '../src/rarity.js';
import { SeaportExecutor } from '../src/executor.js';
import { config } from '../src/config.js';

export const streamListener = new StreamListener(config.opensea.streamKey);
export const rarityEngine = new RarityEngine();
export const dynamicRarityCalc = new DynamicRarityCalculator();
export const seaportExecutor = new SeaportExecutor('robinhood');
export const sseClients = new Set();

export let activeCollectionStats = null;
export function setActiveCollectionStats(val) {
  activeCollectionStats = val;
}

export const activeListedTokenIds = new Set();
export const inFlightEvaluationTokens = new Set(); // 🛡️ Microsecond atomic lock against race conditions
export const collectionMetadataCache = new Map();
export const liveListingsCache = new Map();

export let cachedEthPrice = 2500;
export function setCachedEthPrice(price) {
  cachedEthPrice = price;
}

export let activeIndexingJob = null;
export function setActiveIndexingJob(val) {
  activeIndexingJob = val;
}

export const walletNonceMap = new Map();
export async function getNextNonce(provider, address) {
  if (!walletNonceMap.has(address)) {
    const onChainNonce = await provider.getTransactionCount(address, 'pending');
    walletNonceMap.set(address, onChainNonce);
  }
  const nonce = walletNonceMap.get(address);
  walletNonceMap.set(address, nonce + 1);
  return nonce;
}

// 🏪 Dynamic Key Stats — auto-generated for ANY number of API keys
const _keyRoles = ['stream', 'fulfillment', 'rarity', 'floor', 'scanner', 'backup'];
const _keyLabels = ['WebSocket Stream (Dedicated)', 'Seaport Fulfillment Data', 'Rarity & Traits Ingestion', 'Floor & Live Order Poller', 'Rapid Collection Scanner', 'High-Traffic Backup Relay'];
export const openseaKeyStats = {};
config.opensea.apiKeys.forEach((key, i) => {
  openseaKeyStats[key] = {
    label: `Key #${i + 1}: ${_keyLabels[i] || 'REST Pool'}`,
    role: _keyRoles[i] || 'pool',
    count: 0,
    lastPingMs: 80 + Math.round(Math.random() * 30),
    status: '200 OK'
  };
});

export function trackKeyUse(key, latency = 0, status = '200 OK') {
  if (!openseaKeyStats[key]) {
    openseaKeyStats[key] = { label: `Key (Custom)`, role: 'extra', count: 0, lastPingMs: latency || 100, status };
  }
  openseaKeyStats[key].count++;
  if (latency > 0) openseaKeyStats[key].lastPingMs = latency;
  openseaKeyStats[key].status = status;
}

export const cachedTelemetry = {
  blockNumber: 57070000,
  baseFeeGwei: 0.035,
  stdGasGwei: 0.040,
  turboGasGwei: 0.053,
  latencyMs: 16,
  timestamp: Date.now()
};

// ⚡ MULTI-TENANT SNIPER ENGINES MAP (Map<userId/userKey, UserSniperEngine>)
export const activeSniperEngines = new Map();

export let activeSniperEngine = {
  isArmed: false,
  armedTimestamp: 0,
  slug: '',
  triggerMode: 'both',
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

export function setActiveSniperEngine(val, userKey = 'default') {
  activeSniperEngine = val;
  if (val && (val.userId || userKey)) {
    const key = String(val.userId || userKey);
    activeSniperEngines.set(key, val);
  }
}

export function broadcastToClients(payload, targetUserId = null) {
  if (!payload) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    // If targeted to a specific user, ensure client matches targetUserId
    if (targetUserId) {
      if (!client.userId || String(client.userId) !== String(targetUserId)) {
        return;
      }
    }
    if (!payload.slug || !client.slug || client.slug.toLowerCase() === payload.slug.toLowerCase() || client.slug === '*') {
      try {
        client.res.write(msg);
      } catch (e) {
        sseClients.delete(client);
      }
    }
  });
}

// 📜 RING BUFFER FOR PERSISTENT EXECUTION LOGS (Stores last 150 logs per user in RAM)
export const userLogBuffers = new Map(); // userId -> Array of { message, timestamp }
export const globalLogBuffer = [];

export function recordLogToBuffer(msg, targetUserId = null) {
  const logItem = { message: msg, timestamp: Date.now() };
  if (targetUserId) {
    const key = String(targetUserId);
    if (!userLogBuffers.has(key)) userLogBuffers.set(key, []);
    const buf = userLogBuffers.get(key);
    buf.push(logItem);
    if (buf.length > 150) buf.shift();
  }
  globalLogBuffer.push(logItem);
  if (globalLogBuffer.length > 150) globalLogBuffer.shift();
}

export function getRecentLogs(targetUserId = null, limit = 100) {
  if (targetUserId) {
    const key = String(targetUserId);
    if (userLogBuffers.has(key)) {
      return userLogBuffers.get(key).slice(-limit);
    }
    return []; // 🛡️ Strict multi-tenant isolation: Fresh log state for new subscribers
  }
  return globalLogBuffer.slice(-limit);
}

export function broadcastSnipeLog(msg, targetUserId = null) {
  console.log(msg);
  recordLogToBuffer(msg, targetUserId);
  broadcastToClients({
    type: 'snipe_log',
    message: msg,
    targetUserId: targetUserId || undefined,
    timestamp: Date.now()
  }, targetUserId);
}


