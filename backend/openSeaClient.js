import https from 'https';
import axios from 'axios';
import { config } from '../src/config.js';
import { trackKeyUse } from './state.js';

export const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 60,
  maxFreeSockets: 20,
  timeout: 5000
});

export const apiClient = axios.create({
  httpsAgent,
  timeout: 5000
});

export async function fetchOpenSeaWithFallback(pathStr, preferredKeyIndex = null) {
  const allKeys = config.opensea.apiKeys;
  const preferredKey = preferredKeyIndex !== null && allKeys[preferredKeyIndex] ? allKeys[preferredKeyIndex] : null;
  const candidateKeys = config.opensea.getCandidateKeys(preferredKey, false);

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
      config.opensea.clearKeyCooldown(key);
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

export function formatEthPrecise(num) {
  const n = parseFloat(num) || 0;
  if (n === 0) return '0.0000 ETH';
  if (n < 0.0001) return `${n.toFixed(6)} ETH`;
  if (n < 0.01) return `${n.toFixed(5)} ETH`;
  return `${n.toFixed(4)} ETH`;
}
