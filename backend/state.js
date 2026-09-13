import { StreamListener } from '../src/stream.js';
import { RarityEngine } from '../src/rarity.js';
import { SeaportExecutor } from '../src/executor.js';
import { config } from '../src/config.js';

export const streamListener = new StreamListener(config.opensea.streamKey);
export const rarityEngine = new RarityEngine();
export const seaportExecutor = new SeaportExecutor('robinhood');
export const sseClients = new Set();

export let activeCollectionStats = null;
export function setActiveCollectionStats(val) {
  activeCollectionStats = val;
}

export const activeListedTokenIds = new Set();
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

export const openseaKeyStats = {
  '5f32ee9b98e84ea184a514f975ad4f3f': { label: 'Key #1: WebSocket Stream (Dedicated)', role: 'stream', count: 0, lastPingMs: 82, status: '200 OK' },
  '840e6b17791d415db3c98657fbc71979': { label: 'Key #2: Seaport Fulfillment Data', role: 'fulfillment', count: 0, lastPingMs: 95, status: '200 OK' },
  '411d0cfd7b294d71a71dc852999dcbfc': { label: 'Key #3: Rarity & Traits Ingestion', role: 'rarity', count: 0, lastPingMs: 98, status: '200 OK' },
  'a88ffbf11b864b8398af8b2c5e3921fa': { label: 'Key #4: Floor & Live Order Poller', role: 'floor', count: 0, lastPingMs: 91, status: '200 OK' },
  '4793b5e5637a4a3fa75e81c828970113': { label: 'Key #5: Rapid Collection Scanner', role: 'scanner', count: 0, lastPingMs: 104, status: '200 OK' },
  '7f2b82423f01405eac037f4b1a661027': { label: 'Key #6: High-Traffic Backup Relay', role: 'backup', count: 0, lastPingMs: 110, status: '200 OK' }
};

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
export function setActiveSniperEngine(val) {
  activeSniperEngine = val;
}

export function broadcastToClients(payload) {
  if (!payload) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    if (!payload.slug || !client.slug || client.slug.toLowerCase() === payload.slug.toLowerCase() || client.slug === '*') {
      try {
        client.res.write(msg);
      } catch (e) {
        sseClients.delete(client);
      }
    }
  });
}

export function broadcastSnipeLog(msg) {
  console.log(msg);
  broadcastToClients({
    type: 'snipe_log',
    message: msg,
    timestamp: Date.now()
  });
}
