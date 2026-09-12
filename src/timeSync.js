/**
 * timeSync.js — RFC 5905 UDP NTP Internet Clock Sync for Aero-Sniper V2
 *
 * Synchronizes the sniper engine with internet atomic clocks (Stratum 1 & 2),
 * primarily time.cloudflare.com (the same edge time source used by OpenSea).
 * Exposes getNow() as a drop-in replacement for Date.now() to eliminate
 * local system clock drift (+414ms).
 */

import dgram from 'dgram';
import https from 'https';

// Authoritative UDP NTP Servers (Stratum 1 & 2)
const UDP_NTP_SERVERS = [
  'time.cloudflare.com',
  'time.google.com',
  'pool.ntp.org'
];

// Fallback HTTP Anycast endpoints
const HTTP_FALLBACK_SOURCES = [
  'https://1.1.1.1',
  'https://www.google.com'
];

// Internal state
let _ntpOffsetMs = 0;           // ms to add to Date.now() for corrected time
let _lastSyncAt = 0;            // local timestamp of last successful sync
let _lastSyncSource = 'local';  // which source was used
let _roundTripMs = 0;           // last measured round-trip latency
let _syncCount = 0;             // total successful syncs
let _isSyncing = false;

/**
 * Direct RFC 5905 UDP NTP query
 * @param {string} server
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{offset: number, rtt: number, server: string}>}
 */
function queryNtpUdp(server, port = 123, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = dgram.createSocket('udp4');
    } catch (err) {
      return reject(err);
    }

    const buf = Buffer.alloc(48);
    buf[0] = 0x1b; // LI = 0, VN = 3, Mode = 3 (Client)

    const t0 = Date.now();
    let timer = setTimeout(() => {
      try { client.close(); } catch (_) {}
      reject(new Error(`NTP UDP Timeout (${server})`));
    }, timeoutMs);

    client.send(buf, 0, buf.length, port, server, (err) => {
      if (err) {
        clearTimeout(timer);
        try { client.close(); } catch (_) {}
        return reject(err);
      }
    });

    client.on('message', (msg) => {
      clearTimeout(timer);
      const t3 = Date.now();
      try { client.close(); } catch (_) {}

      if (msg.length < 48) {
        return reject(new Error('Invalid NTP packet size'));
      }

      // Transmit Timestamp is at byte 40..47
      const sec = msg.readUInt32BE(40);
      const frac = msg.readUInt32BE(44);
      // Convert NTP time (from 1900) to Unix epoch (from 1970)
      const unixSec = sec - 2208988800;
      const unixMs = (unixSec * 1000) + Math.round((frac * 1000) / 4294967296);

      const rtt = t3 - t0;
      const midpoint = t0 + Math.round(rtt / 2);
      const offset = unixMs - midpoint;

      resolve({ server, rtt, offset });
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      reject(err);
    });
  });
}

/**
 * Fallback HTTP HEAD Date Header query (Cloudflare Anycast edge)
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{offset: number, rtt: number, server: string}>}
 */
function queryHttpHeadTime(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      const t1 = Date.now();
      const serverDate = res.headers['date'];
      if (!serverDate) return reject(new Error('No Date header'));
      const serverMs = new Date(serverDate).getTime();
      const rtt = t1 - t0;
      // Quantize 1-second resolution HTTP Date (+500ms midpoint)
      const serverEstMs = serverMs + 500;
      const midpoint = t0 + Math.round(rtt / 2);
      const offset = serverEstMs - midpoint;
      resolve({ server: url, rtt, offset });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.end();
  });
}

/**
 * Fetch NTP time from internet sources and compute offset.
 * @returns {Promise<{offset: number, roundTripMs: number, source: string}>}
 */
export async function syncNtpOffset() {
  if (_isSyncing) return { offset: _ntpOffsetMs, roundTripMs: _roundTripMs, source: _lastSyncSource };
  _isSyncing = true;

  // 1. Primary: Direct UDP NTP race/sequence across low-latency servers
  for (const server of UDP_NTP_SERVERS) {
    try {
      const res = await queryNtpUdp(server, 123, 1500);
      // Discard asymmetric lag samples (>250ms RTT)
      if (res.rtt > 250) continue;

      _ntpOffsetMs = res.offset;
      _roundTripMs = res.rtt;
      _lastSyncSource = `UDP:${res.server}`;
      _lastSyncAt = Date.now();
      _syncCount++;
      _isSyncing = false;

      console.log(`[NTP] ✅ Synced via ${res.server} (UDP): offset=${_ntpOffsetMs > 0 ? '+' : ''}${_ntpOffsetMs}ms | RTT=${res.rtt}ms`);
      return { offset: _ntpOffsetMs, roundTripMs: res.rtt, source: _lastSyncSource };
    } catch (err) {
      // Try next UDP server
    }
  }

  // 2. Secondary: HTTP HEAD Anycast fallback if UDP is blocked
  for (const url of HTTP_FALLBACK_SOURCES) {
    try {
      const res = await queryHttpHeadTime(url, 1500);
      if (res.rtt > 300) continue;

      _ntpOffsetMs = res.offset;
      _roundTripMs = res.rtt;
      _lastSyncSource = `HTTP:${res.server}`;
      _lastSyncAt = Date.now();
      _syncCount++;
      _isSyncing = false;

      console.log(`[NTP] ✅ Synced via ${res.server} (HTTP HEAD): offset=${_ntpOffsetMs > 0 ? '+' : ''}${_ntpOffsetMs}ms | RTT=${res.rtt}ms`);
      return { offset: _ntpOffsetMs, roundTripMs: res.rtt, source: _lastSyncSource };
    } catch (err) {
      // Try next fallback
    }
  }

  // All sources failed — keep existing offset (or 0 on first run)
  console.warn('[NTP] ⚠️ All NTP sources unreachable. Retaining current offset.');
  if (!_lastSyncSource || _lastSyncSource === 'local') {
    _lastSyncSource = 'local_fallback';
  }
  _isSyncing = false;
  return { offset: _ntpOffsetMs, roundTripMs: _roundTripMs, source: _lastSyncSource };
}

/**
 * Returns the internet-corrected current timestamp in milliseconds.
 * Drop-in replacement for Date.now().
 */
export function getNow() {
  return Date.now() + _ntpOffsetMs;
}

/**
 * Get current sync status.
 */
export function getSyncStatus() {
  return {
    offsetMs: _ntpOffsetMs,
    roundTripMs: _roundTripMs,
    source: _lastSyncSource,
    syncCount: _syncCount,
    lastSyncAt: _lastSyncAt,
    lastSyncAgo: _lastSyncAt ? Date.now() - _lastSyncAt : null,
    isSynced: _lastSyncSource !== 'local_fallback' && _syncCount > 0
  };
}

// Auto-sync every 30 seconds while server is running
let _autoSyncTimer = null;

export function startAutoSync(intervalMs = 30000) {
  syncNtpOffset().catch(() => {});

  if (_autoSyncTimer) clearInterval(_autoSyncTimer);
  _autoSyncTimer = setInterval(() => {
    syncNtpOffset().catch(() => {});
  }, intervalMs);

  if (_autoSyncTimer.unref) _autoSyncTimer.unref();
}

export function stopAutoSync() {
  if (_autoSyncTimer) {
    clearInterval(_autoSyncTimer);
    _autoSyncTimer = null;
  }
}
