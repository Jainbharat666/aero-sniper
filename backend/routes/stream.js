import express from 'express';
import { config } from '../../src/config.js';
import {
  streamListener,
  activeListedTokenIds,
  activeCollectionStats,
  rarityEngine,
  activeSniperEngine,
  activeSniperEngines,
  sseClients,
  cachedEthPrice,
  broadcastToClients,
  dynamicRarityCalc
} from '../state.js';
import { fetchOpenSeaWithFallback, formatEthPrecise } from '../openSeaClient.js';
import { evaluateAndSnipe, sweepAndSnipeActiveListings } from './sniper.js';
import { fetchOpenSeaAuthoritativeStats } from './scan.js';
import { getNow } from '../../src/timeSync.js';

const router = express.Router();

// Subscribes target slug to WebSocket Stream with Live Listing & Delisting Tracking
export function subscribeSlugToOpenSea(slug) {
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
      let rankCached = rarityEngine.getRaritySync(parsed.tokenId);
      let isEstimatedRank = false;

      // Fallback: Dynamic IC-based estimated rank from traits (0.01ms, zero API calls)
      if (rankCached == null && dynamicRarityCalc.isReady && parsed.traits?.length > 0) {
        const { estimatedRank, isEstimated } = dynamicRarityCalc.scoreAndEstimateRank(parsed.tokenId, parsed.traits);
        if (estimatedRank > 0) {
          rankCached = estimatedRank;
          isEstimatedRank = true;
        }
      }

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
        isEstimatedRank: isEstimatedRank,
        seller: parsed.seller ? `${parsed.seller.slice(0, 6)}...${parsed.seller.slice(-4)}` : '',
        sellerFull: parsed.seller || '',
        orderHash: parsed.orderHash,
        ageSeconds: Math.max(0, Math.round((getNow() - (parsed.eventTimestamp ? (typeof parsed.eventTimestamp === 'number' ? (parsed.eventTimestamp > 1e11 ? parsed.eventTimestamp : parsed.eventTimestamp * 1000) : new Date(parsed.eventTimestamp).getTime()) : (parsed.receivedAt || getNow()))) / 1000)),
        eventTimestamp: parsed.receivedAt || getNow(),
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

// ─── ⚡ 24/7 AUTONOMOUS CLOUD POLLER FOR ARMED TARGETS (ROBINHOOD CHAIN & OPENSEA) ───
setInterval(async () => {
  const armedSlugs = new Set();
  for (const [k, engine] of activeSniperEngines.entries()) {
    if (engine && engine.isArmed && engine.slug && engine.slug !== '*') {
      armedSlugs.add(engine.slug.toLowerCase());
    }
  }
  if (activeSniperEngine && activeSniperEngine.isArmed && activeSniperEngine.slug && activeSniperEngine.slug !== '*') {
    armedSlugs.add(activeSniperEngine.slug.toLowerCase());
  }

  if (armedSlugs.size === 0) return;

  for (const slug of armedSlugs) {
    try {
      await sweepAndSnipeActiveListings(slug);
    } catch(e) {}
  }
}, 2500);

// ─── PERIODIC 45s STATS SYNC (Optimized: Idle Guarded & Anti-Cloudflare Block) ───
setInterval(async () => {
  if (!activeCollectionStats || !activeCollectionStats.slug) return;
  // Skip background sync if no clients connected and no sniper is armed (Zero wasted calls)
  const hasActiveClients = sseClients && sseClients.size > 0;
  const isAnySniperActive = Array.from(activeSniperEngines.values()).some(e => e.isArmed) || (activeSniperEngine && activeSniperEngine.isArmed);
  if (!hasActiveClients && !isAnySniperActive) return;

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
}, 45000);

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// GET /api/stream/ws-config
router.get('/stream/ws-config', (req, res) => {
  res.json({
    success: true,
    streamKey: config.opensea.streamKey,
    wsUrl: 'wss://stream-api.opensea.io/socket/websocket'
  });
});

// GET /api/stream/events (SSE)
router.get('/stream/events', (req, res) => {
  const slug = (req.query.slug || '').trim().toLowerCase();
  const userId = (req.query.userId || '').trim();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const client = { res, slug, userId };
  sseClients.add(client);
  if (slug) subscribeSlugToOpenSea(slug);

  res.write('retry: 500\n\n');
  res.write(`data: ${JSON.stringify({ type: 'connected', slug, userId, time: Date.now() })}\n\n`);

  req.on('close', () => {
    sseClients.delete(client);
    if (slug) {
      const hasOther = Array.from(sseClients).some(c => c.slug === slug);
      const isAnySniperActive = Array.from(activeSniperEngines.values()).some(e => e.isArmed && (e.slug === slug || e.slug === '*')) ||
                                (activeSniperEngine.isArmed && (activeSniperEngine.slug === slug || activeSniperEngine.slug === '*'));
      if (!hasOther && !isAnySniperActive) streamListener.unsubscribe(slug);
    }
  });
});

// POST /api/stream/clear
router.post('/stream/clear', (req, res) => {
  const { slug } = req.body;
  if (slug) streamListener.unsubscribe(slug);
  else streamListener.unsubscribeAll();
  res.json({ success: true, message: 'Stream unsubscribed successfully' });
});

// GET /api/listings/live
router.get('/listings/live', async (req, res) => {
  const slug = (req.query.slug || '').trim().toLowerCase();
  if (!slug) return res.json({ success: true, listings: [] });

  try {
    const evData = await fetchOpenSeaWithFallback(`/events/collection/${slug}?event_type=listing&limit=15`);
    let listings = [];
    if (evData && Array.isArray(evData.asset_events)) {
      listings = evData.asset_events.map(ev => {
        const asset = ev.asset || {};
        const tokenId = asset.identifier || asset.token_id || String(ev.event_id || '0');
        let priceEth = 0;
        if (ev.payment?.quantity) {
          priceEth = parseFloat(ev.payment.quantity) / (10 ** (ev.payment.decimals || 18));
        } else if (ev.protocol_data?.parameters?.consideration?.[0]?.startAmount) {
          priceEth = Number(BigInt(ev.protocol_data.parameters.consideration[0].startAmount)) / 1e18;
        }
        const eventTime = ev.event_timestamp ? (typeof ev.event_timestamp === 'number' ? (ev.event_timestamp > 1e11 ? ev.event_timestamp : ev.event_timestamp * 1000) : new Date(ev.event_timestamp).getTime()) : Date.now();
        const cachedInfo = rarityEngine.getTokenInfoSync(tokenId);
        let resolvedRank = cachedInfo?.rank ?? rarityEngine.getRaritySync(tokenId);
        let isEstimatedRank = false;

        if (resolvedRank == null && dynamicRarityCalc.isReady) {
          const traits = asset.traits || ev.traits;
          if (traits?.length > 0) {
            const { estimatedRank, isEstimated } = dynamicRarityCalc.scoreAndEstimateRank(tokenId, traits);
            if (estimatedRank > 0) {
              resolvedRank = estimatedRank;
              isEstimatedRank = true;
            }
          }
        }

        const resolvedImage = asset.image_url || asset.display_image_url || cachedInfo?.image || '';
        const resolvedName = cachedInfo?.name || asset.name || `#${tokenId}`;
        return {
          tokenId,
          name: resolvedName,
          image: resolvedImage,
          imageUrl: resolvedImage,
          price: priceEth,
          priceFormatted: formatEthPrecise(priceEth),
          priceUsd: parseFloat((priceEth * cachedEthPrice).toFixed(2)),
          rarityRank: resolvedRank,
          isEstimatedRank: isEstimatedRank,
          seller: ev.maker ? `${ev.maker.slice(0, 6)}...${ev.maker.slice(-4)}` : '',
          sellerFull: ev.maker || '',
          orderHash: ev.order_hash || '',
          ageSeconds: Math.max(0, Math.round((Date.now() - eventTime) / 1000)),
          eventTimestamp: eventTime,
          protocolData: ev.protocol_data || null,
          contractAddress: asset.asset_contract?.address || (activeCollectionStats?.contractAddress || ''),
          chain: 'robinhood',
          slug: slug,
          sniped: activeSniperEngine.snipedTokenIds.has(String(tokenId))
        };
      }).filter(item => item.price > 0 && item.tokenId && item.tokenId !== '0');

      if (activeSniperEngine.isArmed) {
        const minArmedTime = activeSniperEngine.armedTimestamp ? (activeSniperEngine.armedTimestamp - 5000) : Date.now();
        for (const item of listings) {
          const hasHash = Boolean(item.orderHash && item.orderHash.length > 10);
          const hasParams = Boolean(item.protocolData?.parameters && item.protocolData?.signature);
          if (!hasHash && !hasParams) continue;

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
    res.json({ success: true, listings: [] });
  }
});

export default router;
