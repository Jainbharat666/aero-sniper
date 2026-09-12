import { OpenSeaStreamClient } from '@opensea/stream-js';
import { WebSocket } from 'ws';
import chalk from 'chalk';
import { config, formatEthPrecise, getLiveEthPrice } from './config.js';
import { getNow } from './timeSync.js';

export class StreamListener {
  constructor(apiKey = config.opensea.streamKey) {
    this.apiKey = apiKey;
    this.client = null;
    this.isConnected = false;
    this.status = 'idle';
    this.subscribedSlug = '*';
    this.activeSubscriptions = new Map();
    this.statusCallbacks = new Set();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.lastHeartbeat = Date.now();
    this.totalEventsReceived = 0;
    this._savedListingCallback = null;
    this._savedDelistingCallback = null;

    // 🛡️ Socket Liveness Monitor: Only reconnect if underlying socket is actually disconnected/closed
    // (Never kill connection just because a low-volume collection has no listings for 60s!)
    if (!process.env.VERCEL) {
      this.heartbeatCheckInterval = setInterval(() => {
        if (this.isConnected && this.client?.socket && typeof this.client.socket.isConnected === 'function') {
          if (!this.client.socket.isConnected()) {
            console.warn(`⚠ [STREAM V2] Underlying socket disconnected — reconnecting`);
            this._scheduleReconnect();
          }
        }
      }, 15000);
    }
  }

  onStatusChange(cb) {
    if (typeof cb === 'function') {
      this.statusCallbacks.add(cb);
      cb({ status: this.status, isConnected: this.isConnected });
    }
  }

  _notifyStatus(status, detail = '') {
    this.status = status;
    this.isConnected = (status === 'connected');
    for (const cb of this.statusCallbacks) {
      try {
        cb({ status, isConnected: this.isConnected, detail, attempts: this.reconnectAttempts });
      } catch (e) {}
    }
  }

  connect() {
    return new Promise((resolve) => {
      if (this.isConnected && this.client) {
        return resolve(this.client);
      }

      this._notifyStatus('connecting', 'Initiating WebSocket handshake...');
      console.log(chalk.cyan(`🔌 [STREAM V2] Connecting to OpenSea WebSocket (Dedicated Key #1)...`));

      try {
        this.client = new OpenSeaStreamClient({
          token: this.apiKey,
          connectOptions: {
            transport: WebSocket,
          },
          onError: (err) => {
            console.error(chalk.red(`⚠ [STREAM V2] WebSocket Error:`), err.message || err);
            this._notifyStatus('error', err.message || String(err));
            this._scheduleReconnect();
          },
        });

        this.client.connect();
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._notifyStatus('connected', 'Live WebSocket Stream Active');
        console.log(chalk.green(`✔ [STREAM V2] Connected to OpenSea Stream API successfully!`));

        // Auto-restore subscription if one was previously active
        if (this.subscribedSlug && this._savedListingCallback) {
          console.log(chalk.cyan(`🔄 [STREAM V2] Auto-restoring WebSocket subscription for: ${this.subscribedSlug}`));
          this.subscribeToListings(this.subscribedSlug, this._savedListingCallback, this._savedDelistingCallback);
        }

        resolve(this.client);
      } catch (err) {
        console.error(chalk.red(`✖ [STREAM V2] Connection failed:`), err.message);
        this._notifyStatus('error', err.message);
        this._scheduleReconnect();
        resolve(null);
      }
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(chalk.red(`✖ [STREAM V2] Max reconnection attempts reached.`));
      this._notifyStatus('disconnected', 'Max retries exceeded');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 15000);
    this._notifyStatus('reconnecting', `Reconnecting in ${Math.round(delay / 1000)}s (Attempt ${this.reconnectAttempts})`);
    console.log(chalk.yellow(`🔄 [STREAM V2] Reconnecting in ${delay}ms...`));

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  subscribeToListings(collectionSlug = '*', onListingCallback, onDelistingCallback) {
    const slug = (collectionSlug || '*').trim().toLowerCase();

    if (typeof onListingCallback === 'function') this._savedListingCallback = onListingCallback;
    if (typeof onDelistingCallback === 'function') this._savedDelistingCallback = onDelistingCallback;

    if (!this.client || !this.isConnected) {
      this.connect();
    }

    if (this.activeSubscriptions.has(slug)) {
      try {
        const prevUnsub = this.activeSubscriptions.get(slug);
        if (typeof prevUnsub === 'function') prevUnsub();
      } catch (e) {}
      this.activeSubscriptions.delete(slug);
    }

    console.log(chalk.cyan(`👂 [STREAM V2] Subscribing WebSocket to: `) + chalk.yellow(slug));
    this.subscribedSlug = slug;

    try {
      // 1. Listen for new listings
      const unsubListed = this.client.onItemListed(slug, (event) => {
        this.totalEventsReceived++;
        this.lastHeartbeat = Date.now();
        const parsed = this.parseListingEvent(event);
        if (parsed && typeof onListingCallback === 'function') {
          onListingCallback(parsed);
        }
      });

      // 2. Listen for cancelled listings (delistings)
      const unsubCancelled = this.client.onItemCancelled(slug, (event) => {
        this.lastHeartbeat = Date.now();
        try {
          const nftIdParts = (event.payload?.item?.nft_id || '').split('/');
          const tokenId = nftIdParts[2] || '';
          if (tokenId && typeof onDelistingCallback === 'function') {
            onDelistingCallback({ tokenId, slug, reason: 'cancelled', rawEvent: event });
          }
        } catch(e) {}
      });

      // 3. Listen for completed sales (item sold & removed from order book)
      const unsubSold = this.client.onItemSold(slug, (event) => {
        this.lastHeartbeat = Date.now();
        try {
          const nftIdParts = (event.payload?.item?.nft_id || '').split('/');
          const tokenId = nftIdParts[2] || '';
          if (tokenId && typeof onDelistingCallback === 'function') {
            onDelistingCallback({ tokenId, slug, reason: 'sold', rawEvent: event });
          }
        } catch(e) {}
      });

      const unsubAll = () => {
        try { unsubListed(); } catch(e) {}
        try { unsubCancelled(); } catch(e) {}
        try { unsubSold(); } catch(e) {}
      };

      this.activeSubscriptions.set(slug, unsubAll);
      return unsubAll;
    } catch (err) {
      console.error(chalk.red(`⚠ [STREAM V2] Error subscribing to ${slug}:`), err.message);
      return () => {};
    }
  }

  unsubscribe(collectionSlug) {
    const slug = (collectionSlug || '').trim().toLowerCase();
    if (this.activeSubscriptions.has(slug)) {
      try {
        const unsub = this.activeSubscriptions.get(slug);
        if (typeof unsub === 'function') unsub();
      } catch (e) {}
      this.activeSubscriptions.delete(slug);
      console.log(chalk.gray(`✔ [STREAM V2] Unsubscribed WebSocket from: ${slug}`));
    }
  }

  unsubscribeAll() {
    for (const [slug, unsub] of this.activeSubscriptions.entries()) {
      try {
        if (typeof unsub === 'function') unsub();
      } catch (e) {}
    }
    this.activeSubscriptions.clear();
    console.log(chalk.gray(`✔ [STREAM V2] Unsubscribed from all OpenSea collections.`));
  }

  // 🛡️ AUDIT FIX M-3: Disconnect method for heartbeat-driven reconnection
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.unsubscribeAll();
    if (this.client) {
      try { this.client.disconnect(); } catch (e) {}
      this.client = null;
    }
    this.isConnected = false;
    this._notifyStatus('disconnected', 'Manual disconnect');
    console.log(chalk.gray(`✔ [STREAM V2] Disconnected from OpenSea WebSocket.`));
  }

  parseListingEvent(event) {
    const receivedAt = getNow();
    try {
      const p = event.payload;
      if (!p || !p.item) return null;

      const nftIdParts = (p.item.nft_id || '').split('/');
      const chain = nftIdParts[0] || p.chain || 'robinhood';
      const contractAddress = nftIdParts[1] || '';
      const tokenId = nftIdParts[2] || '';

      const decimals = p.payment_token?.decimals || 18;
      const basePriceBig = BigInt(p.base_price || '0');
      const divisor = 10n ** BigInt(decimals);
      const priceEth = Number(basePriceBig) / Number(divisor);
      const symbol = p.payment_token?.symbol || 'ETH';
      const livePrice = getLiveEthPrice() || Number(p.payment_token?.usd_price) || 0;
      const usdPrice = livePrice > 0 ? (priceEth * livePrice).toFixed(2) : null;

      // 🛡️ AUDIT FIX LOW-4: formatEthPrecise imported from config.js (single source of truth)

      return {
        slug: (p.collection?.slug || '').toLowerCase(),
        chain: chain.toLowerCase(),
        contractAddress: contractAddress.toLowerCase(),
        tokenId,
        name: p.item.metadata?.name || `#${tokenId}`,
        imageUrl: p.item.metadata?.image_url || '',
        price: priceEth,
        priceFormatted: formatEthPrecise(priceEth),
        priceUsd: usdPrice,
        symbol,
        seller: p.maker?.address || '',
        orderHash: p.order_hash || '',
        protocolAddress: p.protocol_address || '',
        protocolData: p.protocol_data || null,
        eventTimestamp: p.event_timestamp || new Date(getNow()).toISOString(),
        receivedAt: receivedAt,
        rawEvent: event,
      };
    } catch (err) {
      console.warn(chalk.yellow(`⚠ [STREAM V2] Error parsing listing event: ${err.message}`));
      return null;
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.unsubscribeAll();
    if (this.client) {
      try {
        this.client.disconnect();
      } catch (e) {}
      this.client = null;
      this._notifyStatus('disconnected', 'Stream stopped');
      console.log(chalk.gray(`[STREAM V2] Stream disconnected.`));
    }
  }
}