import express from 'express';
import { dbGetUserConfig, dbSaveUserConfig, adminAuthMiddleware, dbGetUsers, dbGetInvites } from '../db.js';
import { seaportExecutor, cachedTelemetry, cachedEthPrice, setCachedEthPrice } from '../state.js';
import { apiClient } from '../openSeaClient.js';
import { setLiveEthPrice } from '../../src/config.js';
import { getNow, getSyncStatus } from '../../src/timeSync.js';

const router = express.Router();

export const DEFAULT_GLOBAL_FLEET = {
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

export async function dbGetCloudFleet(networkKey = 'robinhood') {
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

export async function dbSaveCloudFleet(networkKey, rpcList) {
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

export async function syncFleetToExecutor(networkKey = 'robinhood') {
  try {
    const rpcs = await dbGetCloudFleet(networkKey);
    if (Array.isArray(rpcs) && rpcs.length > 0) {
      const activeUrls = rpcs.filter(r => r.is_active !== false && r.url).map(r => r.url);
      if (activeUrls.length > 0) {
        seaportExecutor.setRpcFleet(activeUrls);
      }
    }
  } catch (err) {
    console.warn('[FLEET SYNC]:', err.message);
  }
}

// Initialize fleet sync on boot
syncFleetToExecutor('robinhood');

// ─── BACKGROUND TELEMETRY & ETH PRICE POLLERS ─────────────────────────────────
let lastEthPriceUpdateMs = Date.now();

export async function fetchLiveEthPrice() {
  try {
    const res = await apiClient.get('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    if (res.data?.data?.amount) {
      const price = parseFloat(res.data.data.amount);
      setCachedEthPrice(price);
      setLiveEthPrice(price);
      lastEthPriceUpdateMs = Date.now();
    }
  } catch (err) {
    try {
      const bRes = await apiClient.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
      if (bRes.data?.price) {
        const price = parseFloat(bRes.data.price);
        setCachedEthPrice(price);
        setLiveEthPrice(price);
        lastEthPriceUpdateMs = Date.now();
      }
    } catch (e) {}
  }
  if (Date.now() - lastEthPriceUpdateMs > 300000) {
    console.warn(`⚠ [PRICE] ETH price data is stale. USD calculations may be inaccurate.`);
  }
}
setInterval(fetchLiveEthPrice, 4000);
fetchLiveEthPrice();

export async function fetchLiveTelemetry() {
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

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// GET /api/fleet-rpcs
router.get('/fleet-rpcs', async (req, res) => {
  const network = req.query.network || 'robinhood';
  try {
    const rpcs = await dbGetCloudFleet(network);
    return res.json({ success: true, rpcs, fleetRpcs: rpcs });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/fleet-rpcs/save
router.post('/fleet-rpcs/save', adminAuthMiddleware, async (req, res) => {
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
    syncFleetToExecutor(networkKey);
    return res.json({ success: true, rpc: newRecord, rpcs: updated, fleetRpcs: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/fleet-rpcs/delete
router.post('/fleet-rpcs/delete', adminAuthMiddleware, async (req, res) => {
  const payload = req.body;
  const id = payload.id;
  const networkKey = payload.networkKey || payload.network || 'robinhood';
  if (!id) return res.status(400).json({ success: false, error: 'ID is required' });
  try {
    const currentList = await dbGetCloudFleet(networkKey);
    const updated = currentList.filter(r => r.id !== id);
    await dbSaveCloudFleet(networkKey, updated);
    syncFleetToExecutor(networkKey);
    return res.json({ success: true, rpcs: updated, fleetRpcs: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/fleet-rpcs/toggle
router.post('/fleet-rpcs/toggle', adminAuthMiddleware, async (req, res) => {
  const payload = req.body;
  const id = payload.id;
  const isActive = payload.isActive !== undefined ? payload.isActive : (payload.active !== undefined ? payload.active : true);
  const networkKey = payload.networkKey || payload.network || 'robinhood';
  if (!id) return res.status(400).json({ success: false, error: 'ID is required' });
  try {
    const currentList = await dbGetCloudFleet(networkKey);
    const updated = currentList.map(r => r.id === id ? { ...r, is_active: Boolean(isActive) } : r);
    await dbSaveCloudFleet(networkKey, updated);
    syncFleetToExecutor(networkKey);
    return res.json({ success: true, rpcs: updated, fleetRpcs: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/eth-price
router.get('/eth-price', (req, res) => {
  res.json({
    success: true,
    priceUsd: cachedEthPrice,
    formatted: `$${cachedEthPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`,
    timestamp: Date.now()
  });
});

// GET /api/telemetry
router.get('/telemetry', (req, res) => {
  res.json({
    success: true,
    ...cachedTelemetry,
    ethPriceUsd: cachedEthPrice
  });
});

// GET /api/ntp-time
router.get('/ntp-time', async (req, res) => {
  const status = getSyncStatus();
  res.json({
    success: true,
    ...status,
    ntpNow: getNow(),
    localNow: Date.now()
  });
});

// GET /api/health
router.get('/health', async (req, res) => {
  try {
    const [users, invites] = await Promise.all([dbGetUsers(), dbGetInvites()]);
    res.json({
      status: 'online',
      app: 'NFT Sniper V2 Cloud API (Supabase PostgreSQL Isolated Database)',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      userCount: users.length,
      inviteCount: invites.length,
      streamKeyActive: Boolean(process.env.OPENSEA_STREAM_KEY),
      port: process.env.PORT || 3000
    });
  } catch (err) {
    res.status(500).json({ status: 'degraded', error: err.message });
  }
});

export default router;
