import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from '../../src/config.js';
import {
  rarityEngine,
  activeCollectionStats,
  setActiveCollectionStats,
  activeListedTokenIds,
  collectionMetadataCache,
  cachedEthPrice,
  broadcastToClients
} from '../state.js';
import { fetchOpenSeaWithFallback, formatEthPrecise } from '../openSeaClient.js';
import { subscribeSlugToOpenSea } from './stream.js';
import { getNow } from '../../src/timeSync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Root of sniper v2 directory is two levels up from backend/routes
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const router = express.Router();

export function levenshteinDistance(s1, s2) {
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

export function resolveClosestCollectionSlug(inputSlug) {
  if (!inputSlug) return inputSlug;
  const clean = inputSlug.trim().toLowerCase();
  
  if (activeCollectionStats && activeCollectionStats.slug) {
    const s = activeCollectionStats.slug.toLowerCase();
    if (s === clean) return activeCollectionStats.slug;
  }

  const candidatePool = new Set(['ponsguy-nft', 'ntrpygenesis', 'rhmachines']);

  try {
    const cacheDir = path.join(PROJECT_ROOT, 'cache');
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
export async function fetchOpenSeaAuthoritativeStats(slug) {
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

    try {
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
            if (listedCount !== null) break;
          } catch (parseErr) {}
        }
      }
    } catch (jsonErr) {}

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

    if (listedCount === null && floorEth === null) {
      console.warn(`⚠ [STATS] Failed to extract any stats from OpenSea HTML for "${slug}"`);
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

export async function runBackgroundListingIndexer(slug, startCursor, initialTokenIds) {
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
      const keyIdx = (page % 5) + 1;
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

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// POST /api/scan
router.post('/scan', async (req, res) => {
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

  // Synchronous disk cache pre-load (<3ms)
  rarityEngine.loadFromDiskCache(slug, input.startsWith('0x') ? input : null);

  try {
    let colData = null;
    let tRes = null;
    let page1Res = null;

    const cachedMeta = collectionMetadataCache.get(slug);
    if (cachedMeta && cachedMeta.expiresAt > Date.now()) {
      colData = cachedMeta.colData;
      tRes = cachedMeta.tRes;
    }

    const fetches = [];
    if (!colData) {
      fetches.push(fetchOpenSeaWithFallback(`/collections/${slug}`, 0).then(d => { colData = d; }).catch(() => null));
    }
    fetches.push(fetchOpenSeaWithFallback(`/listings/collection/${slug}/all?limit=50`, 1).then(d => { page1Res = d; }).catch(() => null));
    if (!tRes) {
      fetches.push(fetchOpenSeaWithFallback(`/traits/${slug}`, 2).then(d => { tRes = d; }).catch(() => null));
    }

    await Promise.all(fetches);

    if (!colData && slug.startsWith('0x')) {
      try {
        const cRes = await fetchOpenSeaWithFallback(`/chain/robinhood/contract/${slug}`, 0);
        if (cRes?.collection) {
          slug = cRes.collection;
          colData = await fetchOpenSeaWithFallback(`/collections/${slug}`, 0);
          rarityEngine.loadFromDiskCache(slug, input);
        }
      } catch(e) {}
    }

    if (!colData && cachedMeta) {
      colData = cachedMeta.colData;
      tRes = cachedMeta.tRes;
    } else if (!colData) {
      await new Promise(r => setTimeout(r, 150));
      try {
        colData = await fetchOpenSeaWithFallback(`/collections/${slug}`, 4);
      } catch(e) {}
    }

    if (!colData) {
      collectionMetadataCache.delete(slug);
      return res.status(404).json({ success: false, error: `Collection "${input}" not found on OpenSea. Please verify the slug/contract.` });
    }

    collectionMetadataCache.set(slug, { colData, tRes, expiresAt: Date.now() + 120000 });

    fetchOpenSeaAuthoritativeStats(slug).then(directStats => {
      if (directStats && (directStats.listedCount || directStats.floorEth)) {
        if (activeCollectionStats && activeCollectionStats.slug === slug) {
          if (directStats.listedCount) activeCollectionStats.listedCount = directStats.listedCount;
          if (directStats.floorEth) activeCollectionStats.floorEth = directStats.floorEth;
          broadcastToClients({
            type: 'stats_sync',
            slug: slug,
            liveListedCount: activeCollectionStats.listedCount,
            liveFloorEth: activeCollectionStats.floorEth,
            liveFloorUsd: directStats.floorUsd || parseFloat((activeCollectionStats.floorEth * cachedEthPrice).toFixed(2))
          });
        }
      }
    }).catch(() => {});

    let apiFloorEth = null;
    if (Array.isArray(page1Res?.listings) && page1Res.listings.length > 0) {
      for (const item of page1Res.listings) {
        const valBig = BigInt(item.price?.current?.value || '0');
        const decimals = item.price?.current?.decimals || 18;
        if (valBig > 0n) {
          const pEth = Number(valBig) / Number(10n ** BigInt(decimals));
          if (pEth > 0 && (apiFloorEth === null || pEth < apiFloorEth)) {
            apiFloorEth = pEth;
          }
        }
      }
    }

    const resolvedFloor = apiFloorEth || (colData?.stats?.floor_price ? parseFloat(colData.stats.floor_price) : null);
    const resolvedTotalSupply = colData?.total_supply || null;

    const primaryContract = colData?.contracts?.[0] || {};
    const contractAddress = primaryContract.address || (slug.startsWith('0x') ? slug : '');
    const chain = primaryContract.chain || 'robinhood';

    rarityEngine.collectionSlug = slug;
    rarityEngine.contractAddress = contractAddress;
    rarityEngine.chain = chain;
    rarityEngine.loadFromDiskCache(slug, contractAddress);

    let collectionTraits = null;
    if (tRes && tRes.counts) {
      collectionTraits = {
        categories: Object.keys(tRes.counts || tRes.categories || {}),
        counts: tRes.counts
      };
    }

    const tokenBestListingMap = new Map();
    const allRawListings = Array.isArray(page1Res?.listings) ? page1Res.listings : [];
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

    const realListings = [];
    tokenBestListingMap.forEach(({ item, price }, tokenId) => {
      const priceEth = price;
      const createdAt = item.order_created_at ? (typeof item.order_created_at === 'number' ? (item.order_created_at > 1e11 ? item.order_created_at : item.order_created_at * 1000) : new Date(item.order_created_at).getTime()) : getNow();
      const trueRank = rarityEngine.getRaritySync(tokenId);
      const cachedInfo = rarityEngine.getTokenInfoSync(tokenId);
      realListings.push({
        tokenId,
        name: cachedInfo?.name || item.asset?.name || `#${tokenId}`,
        contractAddress,
        chain,
        image: cachedInfo?.image || item.asset?.image_url || '',
        price: priceEth,
        priceFormatted: formatEthPrecise(priceEth),
        priceUsd: parseFloat((priceEth * cachedEthPrice).toFixed(2)),
        rarityRank: trueRank,
        seller: item.protocol_data?.parameters?.offerer?.slice(0, 8) || '',
        sellerFull: item.protocol_data?.parameters?.offerer || '',
        orderHash: item.order_hash || '',
        ageSeconds: Math.max(0, Math.round((getNow() - createdAt) / 1000)),
        eventTimestamp: createdAt,
        protocolData: item.protocol_data || null,
        sniped: false
      });
    });

    realListings.sort((a, b) => a.price - b.price);

    const floorEth = (realListings.length > 0 ? realListings[0].price : resolvedFloor);

    activeIndexingJob = null;
    activeListedTokenIds.clear();
    realListings.forEach(item => {
      if (item.tokenId) activeListedTokenIds.add(String(item.tokenId));
    });

    const newStats = {
      slug: colData?.collection || slug,
      name: colData?.name || slug.toUpperCase(),
      totalSupply: resolvedTotalSupply,
      listedCount: realListings.length,
      floorEth,
      contractAddress,
      chain
    };
    setActiveCollectionStats(newStats);

    subscribeSlugToOpenSea(slug);

    if (realListings.length > 0) {
      const missingIds = realListings
        .filter(l => l.rarityRank == null || !l.image)
        .slice(0, 20)
        .map(l => l.tokenId);
      if (missingIds.length > 0) {
        rarityEngine.batchFetchRarities(missingIds, chain, contractAddress, slug).then(rarities => {
          Object.entries(rarities).forEach(([tId, info]) => {
            if (!info) return;
            // 👑 1. BROADCAST ISOLATED RANK UPDATE ONLY IF VALID POSITIVE RANK EXISTS
            if (info.rank != null && Number(info.rank) > 0) {
              broadcastToClients({
                type: 'rank_update',
                slug: slug,
                tokenId: tId,
                rarityRank: Number(info.rank)
              });
            }
            // 🖼️ 2. BROADCAST ISOLATED METADATA/IMAGE UPDATE (ZERO CROSSTALK WITH RANK)
            if (info.image || (info.name && !info.name.startsWith('#'))) {
              broadcastToClients({
                type: 'metadata_update',
                slug: slug,
                tokenId: tId,
                name: info.name,
                image: info.image
              });
            }
          });
        }).catch(() => {});
      }
    }

    console.log(`✔ [FAST SCAN COMPLETE in <500ms] ${colData?.name || slug}: ${realListings.length} floor listings ready | Floor: ${floorEth} ETH!`);

    return res.json({
      success: true,
      name: colData?.name || slug.toUpperCase(),
      slug: colData?.collection || slug,
      contractAddress,
      chain: chain.toUpperCase(),
      totalSupply: resolvedTotalSupply,
      floorEth,
      floorUsd: parseFloat((floorEth * cachedEthPrice).toFixed(2)),
      listedCount: realListings.length,
      description: colData?.description || 'Verified OpenSea Mainnet NFT Collection',
      image: colData?.image_url || '',
      traits: collectionTraits,
      streamKey: config.opensea.streamKey,
      realListings
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/collection/traits
router.get('/collection/traits', async (req, res) => {
  const slug = (req.query.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ success: false, error: 'Slug required' });

  try {
    const data = await fetchOpenSeaWithFallback(`/traits/${slug}`);
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

export default router;
