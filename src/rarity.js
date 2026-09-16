import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { config } from './config.js';

export class RarityEngine {
  constructor() {
    this.tokenRarityMap = new Map(); // tokenId -> { tokenId, rank, score, traits, name, image, isExactOpenRarity }
    this.traitIndexMap = new Map(); // "trait_type:value" -> Set of tokenIds
    this.totalSupply = 0;
    this.collectionName = '';
    this.collectionSlug = '';
    this.contractAddress = '';
    this.chain = 'robinhood';
    const isVercel = Boolean(process.env.VERCEL);
    this.bundleCacheDir = path.resolve(process.cwd(), 'cache');
    this.writeCacheDir = isVercel ? path.join('/tmp', 'cache') : this.bundleCacheDir;
    this.cacheDir = this.writeCacheDir;
    this.isDirty = false;
    this.saveTimeout = null;

    try {
      if (!fs.existsSync(this.writeCacheDir)) {
        fs.mkdirSync(this.writeCacheDir, { recursive: true });
      }
    } catch (e) {}

    // High-speed persistent HTTPS keep-alive agent with pooling
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 20,
      timeout: 5000,
    });

    this.client = axios.create({
      httpsAgent: this.httpsAgent,
      timeout: 5000,
    });
  }

  getCachePath(slug) {
    const filename = `${(slug || 'default').toLowerCase()}-rarity.json`;
    const writePath = path.join(this.writeCacheDir, filename);
    if (fs.existsSync(writePath)) return writePath;
    const bundlePath = path.join(this.bundleCacheDir, filename);
    if (fs.existsSync(bundlePath)) return bundlePath;
    return writePath;
  }

  /**
   * CRITICAL BUG FIX:
   * Returns the exact integer rank directly (e.g. 42), or null if not yet cached/unknown.
   * NEVER returns an object, so (rank <= maxRareRank) evaluations in sniper engine work 100% reliably!
   */
  getRaritySync(tokenId) {
    if (!tokenId) return null;
    const item = this.tokenRarityMap.get(String(tokenId));
    if (item && typeof item.rank === 'number' && item.rank > 0 && item.rank < 999999) {
      return item.rank;
    }
    return null;
  }

  /**
   * Returns the full metadata object if needed by UI
   */
  getTokenInfoSync(tokenId) {
    if (!tokenId) return null;
    return this.tokenRarityMap.get(String(tokenId)) || null;
  }

  /**
   * ⚡ 0ms INVERTED TRAIT INDEXER
   * Indexes each trait attribute into RAM for sub-millisecond instant matching
   */
  indexTokenTraits(tokenId, traits) {
    if (!tokenId || !traits || !Array.isArray(traits)) return;
    const idStr = String(tokenId);
    for (const t of traits) {
      const tType = String(t.trait_type || t.traitType || t.type || '').trim().toLowerCase();
      const tVal = String(t.value !== undefined ? t.value : (t.val !== undefined ? t.val : '')).trim().toLowerCase();
      if (tType && tVal) {
        const key = `${tType}:${tVal}`;
        if (!this.traitIndexMap.has(key)) {
          this.traitIndexMap.set(key, new Set());
        }
        this.traitIndexMap.get(key).add(idStr);
      }
    }
  }

  /**
   * ⚡ 0.0ms INSTANT TRAIT LOOKUP
   * Checks if tokenId possesses traitType and traitValue in RAM
   */
  hasTraitSync(tokenId, traitType, traitValue) {
    if (!tokenId) return false;
    const idStr = String(tokenId);
    const tType = (traitType || '').trim().toLowerCase();
    const tVal = (traitValue || '').trim().toLowerCase();
    const key = `${tType}:${tVal}`;
    const set = this.traitIndexMap.get(key);
    if (set && set.has(idStr)) return true;

    // Fallback: check token info traits directly
    const info = this.getTokenInfoSync(idStr);
    if (info?.traits?.length > 0) {
      return info.traits.some(t => {
        const itemType = String(t.trait_type || t.traitType || t.type || '').trim().toLowerCase();
        const itemVal = String(t.value !== undefined ? t.value : (t.val !== undefined ? t.val : '')).trim().toLowerCase();
        return (!tType || itemType === tType) && (!tVal || itemVal === tVal);
      });
    }
    return false;
  }

  /**
   * Load collection overview and contract info using Key #3 with fallback to pool
   */
  async loadCollection(collectionSlug, chain = 'robinhood') {
    this.collectionSlug = collectionSlug.trim().toLowerCase();
    this.chain = chain || 'robinhood';
    console.log(chalk.cyan(`
🔍 [RARITY ENGINE V2] Loading collection: `) + chalk.yellow(this.collectionSlug));

    const keysToTry = config.opensea.getCandidateKeys(null, true);
    for (const apiKey of keysToTry) {
      try {
        const colRes = await this.client.get(
          `${config.opensea.restApiBase}/collections/${this.collectionSlug}`,
          { headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' }, timeout: 4000 }
        );
        const colData = colRes.data;
        this.collectionName = colData.name || this.collectionSlug;
        this.totalSupply = colData.total_supply || 10000;

        const primaryContract = colData.contracts?.[0];
        this.contractAddress = primaryContract?.address || '';
        if (primaryContract?.chain) {
          this.chain = primaryContract.chain.toLowerCase();
        }

        console.log(chalk.green(`✔ [RARITY ENGINE V2] Active: `) + chalk.bold(this.collectionName));
        console.log(chalk.gray(`  Chain: ${this.chain.toUpperCase()} | Contract: ${this.contractAddress} | Supply: ${this.totalSupply}`));

        // Load cached rarity ranks from disk
        this.loadFromDiskCache();

        return {
          name: this.collectionName,
          slug: this.collectionSlug,
          totalSupply: this.totalSupply,
          contractAddress: this.contractAddress,
          chain: this.chain,
          cachedRanksCount: this.tokenRarityMap.size
        };
      } catch (err) {
        if (err.response?.status === 429) {
          config.opensea.markKeyCooldown(apiKey, 2500);
          continue;
        }
        break; // If not 429 (e.g. 404), break immediately
      }
    }

    // Fallback: still try loading from disk cache
    this.loadFromDiskCache();
    return null;
  }

  loadFromDiskCache(slug = this.collectionSlug, contract = this.contractAddress) {
    const targetSlug = (slug || this.collectionSlug || '').toLowerCase();
    const targetContract = (contract || this.contractAddress || '').toLowerCase();

    // 🛡️ PER-COLLECTION ISOLATION: Wipe in-memory token map when loading collection
    if (!this.currentCollectionSlug || this.currentCollectionSlug !== targetSlug) {
      this.tokenRarityMap.clear();
      this.traitIndexMap.clear();
    }
    if (targetSlug) this.currentCollectionSlug = targetSlug;
    if (targetContract) this.currentContractAddress = targetContract;

    const candidateFiles = [];
    if (targetSlug) {
      candidateFiles.push(path.join(this.bundleCacheDir, `${targetSlug}-rarity.json`));
      candidateFiles.push(path.join(this.writeCacheDir, `${targetSlug}-rarity.json`));
    }
    if (targetContract) {
      candidateFiles.push(path.join(this.bundleCacheDir, `${targetContract}-rarity.json`));
      candidateFiles.push(path.join(this.writeCacheDir, `${targetContract}-rarity.json`));
    }

    let loadedCount = 0;
    const checked = new Set();
    for (const cacheFile of candidateFiles) {
      if (!cacheFile || checked.has(cacheFile)) continue;
      checked.add(cacheFile);
      if (fs.existsSync(cacheFile)) {
        try {
          const raw = fs.readFileSync(cacheFile, 'utf8');
          const data = JSON.parse(raw);
          for (const [id, item] of Object.entries(data)) {
            if (!item) continue;
            this.tokenRarityMap.set(String(id), item);
            if (item.traits && Array.isArray(item.traits) && item.traits.length > 0) {
              this.indexTokenTraits(id, item.traits);
            }
            if (item.rank != null && item.rank > 0) loadedCount++;
          }
          console.log(chalk.green(`✔ [RARITY ENGINE V2] Loaded cached token ranks from disk: ${path.basename(cacheFile)} (${loadedCount} validated ranks)`));
        } catch (e) {}
      }
    }
    return loadedCount > 0;
  }

  /**
   * NON-BLOCKING ASYNC CACHE SAVING (Debounced dirty write)
   * Avoids freezing the Node.js event loop during high-speed sniping!
   */
  scheduleSave() {
    this.isDirty = true;
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      if (!this.isDirty || !this.collectionSlug) return;
      this.isDirty = false;
      try {
        const cacheFile = path.join(this.writeCacheDir, `${this.collectionSlug.toLowerCase()}-rarity.json`);
        const obj = {};
        for (const [id, item] of this.tokenRarityMap.entries()) {
          if (item && item.rank != null && item.rank > 0) {
            obj[id] = item;
          }
        }
        await fs.promises.writeFile(cacheFile, JSON.stringify(obj, null, 2), 'utf8');
      } catch (e) {}
    }, 2000);
  }

  /**
   * Fetch exact OpenRarity rank using Key #3 with fast failover across REST pool
   */
  async fetchTokenRarity(tokenId, chain = this.chain, contract = this.contractAddress) {
    const idStr = String(tokenId);

    const existingCached = this.tokenRarityMap.get(idStr);
    if (existingCached && existingCached.rank != null && existingCached.rank > 0) {
      return existingCached;
    }

    const targetChain = (chain || this.chain || 'robinhood').toLowerCase();
    const targetContract = contract || this.contractAddress;
    if (!targetContract) return null;

    const url = `${config.opensea.restApiBase}/chain/${targetChain}/contract/${targetContract}/nfts/${idStr}`;

    // Use Central API Shop rotating counter across healthy REST keys
    const keysToTry = config.opensea.getCandidateKeys(null, true);

    for (const apiKey of keysToTry) {
      try {
        const res = await this.client.get(url, {
          headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' },
          timeout: 4000
        });
        const nft = res.data?.nft;
        if (!nft) continue;
        config.opensea.clearKeyCooldown(apiKey);

        const existing = this.tokenRarityMap.get(idStr);
        const rank = (nft?.rarity?.rank != null && Number(nft.rarity.rank) > 0)
          ? Number(nft.rarity.rank)
          : (existing?.rank != null && Number(existing.rank) > 0 ? Number(existing.rank) : null);
        const name = nft?.name || existing?.name || `#${idStr}`;
        const traits = (nft?.traits && nft.traits.length > 0) ? nft.traits : (existing?.traits || []);
        const image = nft?.display_image_url || nft?.image_url || existing?.image || '';

        const tokenInfo = {
          tokenId: idStr,
          name,
          rank,
          score: nft?.rarity?.score || existing?.score || 0,
          traits,
          image,
          isExactOpenRarity: Boolean(rank !== null && rank > 0),
          checked: true
        };

        if ((rank != null && rank > 0) || (tokenInfo.traits && tokenInfo.traits.length > 0)) {
          this.tokenRarityMap.set(idStr, tokenInfo);
          if (tokenInfo.traits && tokenInfo.traits.length > 0) {
            this.indexTokenTraits(idStr, tokenInfo.traits);
          }
          this.scheduleSave();
        }

        return tokenInfo;
      } catch (err) {
        if (err.response?.status === 429) {
          config.opensea.markKeyCooldown(apiKey, 2500);
        }
        continue;
      }
    }

    // Fast metadata fallback for Robinwoodies if OpenSea keys are rate limited
    if (targetContract.toLowerCase() === '0xa50aeb4eea9eea1a7111091af3f7dd392f8be8b5') {
      try {
        const metaRes = await this.client.get(`https://www.scatter.art/api/instareveal/mpqygv7uxqcw1urlz6ief4xg/${idStr}`, { timeout: 1500 });
        if (metaRes.data?.attributes) {
          const rawAttrs = metaRes.data.attributes;
          const tokenInfo = {
            tokenId: idStr,
            name: metaRes.data.name || `#${idStr}`,
            rank: existingCached?.rank || null,
            score: existingCached?.score || 0,
            traits: rawAttrs,
            image: metaRes.data.image || '',
            isExactOpenRarity: Boolean(existingCached?.rank != null && existingCached.rank > 0),
            checked: true
          };
          this.tokenRarityMap.set(idStr, tokenInfo);
          this.indexTokenTraits(idStr, tokenInfo.traits);
          this.scheduleSave();
          return tokenInfo;
        }
      } catch(e) {}
    }

    // Fallback: If token was already known in memory or disk cache, NEVER wipe its rank!
    const existing = this.tokenRarityMap.get(idStr);
    if (existing && existing.rank != null && existing.rank > 0) {
      return existing;
    }

    return {
      tokenId: idStr,
      name: existing?.name || `#${idStr}`,
      rank: (existing?.rank != null && existing.rank > 0) ? existing.rank : null,
      score: existing?.score || 0,
      traits: existing?.traits || [],
      image: existing?.image || '',
      isExactOpenRarity: Boolean(existing?.rank != null && existing.rank > 0),
      checked: true
    };
  }

  /**
   * HIGH-SPEED BATCH RARITY RESOLVER (6-Key Parallel Laser Grid)
   * Resolves floor token rarities smoothly across all 6 keys without aborting or exceeding rate limits.
   */
  async batchFetchRarities(tokenIds, chain = this.chain, contract = this.contractAddress, slug = this.collectionSlug) {
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) return {};
    const targetSlug = (slug || this.collectionSlug || '').toLowerCase();
    const targetContract = (contract || this.contractAddress || '').toLowerCase();
    if (targetSlug && (!this.collectionSlug || this.collectionSlug !== targetSlug)) {
      this.collectionSlug = targetSlug;
      this.tokenRarityMap.clear();
      this.loadFromDiskCache(targetSlug, targetContract);
    }
    if (targetContract && (!this.contractAddress || this.contractAddress.toLowerCase() !== targetContract)) {
      this.contractAddress = targetContract;
    }
    if (this.tokenRarityMap.size === 0) {
      this.loadFromDiskCache(targetSlug, targetContract);
    }
    const targetChain = (chain || this.chain || 'robinhood').toLowerCase();
    if (!targetContract) return {};

    const results = {};
    const missingIds = [];

    for (const id of tokenIds) {
      const idStr = String(id);
      const cached = this.tokenRarityMap.get(idStr);
      if (cached && cached.rank != null && cached.rank > 0) {
        results[idStr] = cached;
      } else {
        missingIds.push(idStr);
      }
    }

    if (missingIds.length === 0) {
      return results;
    }

    // Limit to top 20 missing floor tokens per batch
    const cappedMissing = missingIds.slice(0, 20);
    const keys = config.opensea.apiKeys;
    let keyIdx = 0;

    const worker = async (tokenId) => {
      const idStr = String(tokenId);
      const candidateKeys = config.opensea.getCandidateKeys(null, true);
      const keysToTry = candidateKeys.length > 0 ? candidateKeys : keys;

      for (let attempt = 0; attempt < Math.min(keysToTry.length, 4); attempt++) {
        const assignedKey = keysToTry[(keyIdx++) % keysToTry.length];
        if (config.opensea.isKeyCooledDown(assignedKey)) continue;

        const url = `${config.opensea.restApiBase}/chain/${targetChain}/contract/${targetContract}/nfts/${idStr}`;
        try {
          const res = await this.client.get(url, {
            headers: { 'X-API-KEY': assignedKey, 'Accept': 'application/json' },
            timeout: 3500
          });
          const nft = res.data?.nft;
          if (nft) {
            const existing = this.tokenRarityMap.get(idStr);
            const rank = nft?.rarity?.rank != null ? Number(nft.rarity.rank) : (existing?.rank ?? null);
            const name = nft?.name || existing?.name || `#${idStr}`;
            const traits = (nft?.traits && nft.traits.length > 0) ? nft.traits : (existing?.traits || []);
            const image = nft?.display_image_url || nft?.image_url || existing?.image || '';

            const tokenInfo = {
              tokenId: idStr,
              name,
              rank,
              score: nft?.rarity?.score || existing?.score || 0,
              traits,
              image,
              isExactOpenRarity: (rank !== null && rank > 0),
              checked: true
            };
            if ((rank != null && rank > 0) || (tokenInfo.traits && tokenInfo.traits.length > 0)) {
              this.tokenRarityMap.set(idStr, tokenInfo);
              if (tokenInfo.traits && tokenInfo.traits.length > 0) {
                this.indexTokenTraits(idStr, tokenInfo.traits);
              }
              this.scheduleSave();
            }
            results[idStr] = tokenInfo;
            config.opensea.clearKeyCooldown(assignedKey);
            return;
          }
        } catch (err) {
          if (err.response?.status === 429) {
            config.opensea.markKeyCooldown(assignedKey, 2500);
            continue;
          }
          if (err.response?.status === 404) {
            const existing = this.tokenRarityMap.get(idStr);
            if (existing && existing.rank != null && existing.rank > 0) {
              results[idStr] = existing;
            } else {
              results[idStr] = {
                tokenId: idStr,
                name: existing?.name || `#${idStr}`,
                rank: null,
                score: 0,
                traits: [],
                image: existing?.image || '',
                isExactOpenRarity: false,
                checked: true
              };
            }
            return;
          }
        }
      }

      // If all attempts failed, preserve existing or return fallback
      const existing = this.tokenRarityMap.get(idStr);
      if (existing && existing.rank != null && existing.rank > 0) {
        results[idStr] = existing;
      } else {
        results[idStr] = {
          tokenId: idStr,
          name: existing?.name || `#${idStr}`,
          rank: null,
          score: 0,
          traits: [],
          image: existing?.image || '',
          isExactOpenRarity: false,
          checked: true
        };
      }
    };

    await Promise.all(cappedMissing.map(worker));
    return results;
  }

  /**
   * Universal 100% Live On-The-Fly Resolver
   */
  async resolveRarity(tokenId, chain, contract) {
    const idStr = String(tokenId);
    const cached = this.tokenRarityMap.get(idStr);
    if (cached && cached.rank != null && cached.rank > 0) {
      return cached;
    }
    return await this.fetchTokenRarity(idStr, chain || this.chain, contract || this.contractAddress);
  }

  /**
   * Print top rarest items in formatted table
   */
  printTopRareTable(limit = 10) {
    const tokens = Array.from(this.tokenRarityMap.values())
      .filter(t => t.rank && t.rank < 999999)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit);

    if (tokens.length === 0) return;

    const table = new Table({
      head: [
        chalk.bold.yellow('Rarity Rank'),
        chalk.bold.cyan('Token ID'),
        chalk.bold.white('Name'),
        chalk.bold.green('Source')
      ],
      colWidths: [14, 14, 30, 20],
    });

    for (const t of tokens) {
      table.push([
        `#${t.rank.toLocaleString()}`,
        t.tokenId,
        t.name || `#${t.tokenId}`,
        'OpenRarity (Live)'
      ]);
    }

    console.log(table.toString());
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DYNAMIC RARITY CALCULATOR — Local IC (Information Content) Scoring
// Works for ANY arbitrary collection using 1 single /traits API call.
// Same algorithm as OpenRarity: -log2(probability) per trait value.
// ══════════════════════════════════════════════════════════════════════════════

export class DynamicRarityCalculator {
  constructor() {
    this.traitWeights = new Map();   // "traitType:traitValue" → { ic, count, probability }
    this.traitTypes = new Set();     // All known trait type names
    this.totalSupply = 0;
    this.collectionSlug = null;
    this.tokenScores = new Map();    // tokenId → { score, rank }
    this.sortedScores = [];          // sorted array for binary search rank estimation
    this.isReady = false;
  }

  /**
   * Ingest trait distribution from OpenSea /collection/{slug}/traits response.
   * This is the ONLY API call needed — gives complete trait counts for the entire collection.
   *
   * @param {Object} traitsResponse - Response from GET /api/v2/collection/{slug}/traits
   *   Expected shape: { categories: { "Background": { "Blue": 312, ... }, ... } }
   *   OR flat shape:  { "Background": { "Blue": 312, ... }, ... }
   * @param {number} totalSupply - Collection total supply
   */
  ingestTraitsSummary(traitsResponse, totalSupply) {
    if (!traitsResponse || totalSupply <= 0) return;

    this.totalSupply = totalSupply;
    this.traitWeights.clear();
    this.traitTypes.clear();

    // Handle both { categories: {...} } and flat { "Background": {...} } shapes
    const categories = traitsResponse.categories || traitsResponse;
    if (!categories || typeof categories !== 'object') return;

    for (const [traitType, values] of Object.entries(categories)) {
      if (!values || typeof values !== 'object') continue;
      this.traitTypes.add(traitType);

      // Count how many tokens have any value for this trait type
      let traitTypeTotal = 0;
      for (const count of Object.values(values)) {
        traitTypeTotal += (typeof count === 'number' ? count : parseInt(count, 10) || 0);
      }
      const nullCount = Math.max(0, totalSupply - traitTypeTotal);

      // Compute Information Content (IC) = -log2(probability) for each trait value
      for (const [traitValue, rawCount] of Object.entries(values)) {
        const count = typeof rawCount === 'number' ? rawCount : parseInt(rawCount, 10) || 0;
        if (count <= 0) continue;
        const probability = count / totalSupply;
        const ic = -Math.log2(probability);
        this.traitWeights.set(`${traitType}:${traitValue}`, { ic, count, probability });
      }

      // IC for "null" / missing trait (tokens that don't have this trait type)
      if (nullCount > 0) {
        const probability = nullCount / totalSupply;
        const ic = -Math.log2(probability);
        this.traitWeights.set(`${traitType}:__null__`, { ic, count: nullCount, probability });
      }
    }

    this.isReady = this.traitWeights.size > 0;
    console.log(chalk.cyan(`⚡ [DynamicRarityCalc] Ingested ${this.traitWeights.size} trait weights for supply=${totalSupply} (${this.traitTypes.size} trait types)`));
  }

  /**
   * Score a single token from its traits array.
   * Called in <0.01ms per token — ZERO API calls needed.
   *
   * @param {Array} traits - [{ trait_type: "Background", value: "Blue" }, ...]
   * @returns {number} Raw IC score (higher = rarer)
   */
  scoreToken(traits) {
    if (!this.isReady || !traits || traits.length === 0) return 0;

    let totalIC = 0;
    const seenTypes = new Set();

    for (const trait of traits) {
      const traitType = String(trait.trait_type || trait.traitType || trait.type || '').trim();
      const traitValue = String(trait.value !== undefined ? trait.value : '').trim();
      if (!traitType || !traitValue) continue;

      const key = `${traitType}:${traitValue}`;
      const weight = this.traitWeights.get(key);
      if (weight) {
        totalIC += weight.ic;
      } else {
        // Unknown trait value = extremely rare, assign maximum IC
        totalIC += Math.log2(this.totalSupply);
      }
      seenTypes.add(traitType);
    }

    // Account for missing trait types (null traits contribute IC)
    for (const traitType of this.traitTypes) {
      if (!seenTypes.has(traitType)) {
        const nullWeight = this.traitWeights.get(`${traitType}:__null__`);
        if (nullWeight) {
          totalIC += nullWeight.ic;
        }
      }
    }

    return totalIC;
  }

  /**
   * Bulk-rank all known tokens after scanning floor listings.
   *
   * @param {Map|Object} tokenTraitsMap - Map<tokenId, traits[]> or { tokenId: traits[], ... }
   */
  bulkRankTokens(tokenTraitsMap) {
    if (!this.isReady) return;

    this.tokenScores.clear();
    this.sortedScores = [];

    const entries = tokenTraitsMap instanceof Map
      ? tokenTraitsMap
      : new Map(Object.entries(tokenTraitsMap));

    for (const [tokenId, traits] of entries) {
      if (!traits || !Array.isArray(traits) || traits.length === 0) continue;
      const score = this.scoreToken(traits);
      this.tokenScores.set(String(tokenId), { score, rank: 0 });
    }

    // Sort by score descending (higher IC = rarer = lower rank number)
    this.sortedScores = [...this.tokenScores.entries()]
      .sort((a, b) => b[1].score - a[1].score);

    // Assign ranks
    for (let i = 0; i < this.sortedScores.length; i++) {
      const [tokenId] = this.sortedScores[i];
      this.tokenScores.get(tokenId).rank = i + 1;
    }

    console.log(chalk.green(`✔ [DynamicRarityCalc] Ranked ${this.sortedScores.length} tokens from traits`));
  }

  /**
   * Instant rank lookup for any token already in the ranked set.
   * 0.001ms response — used by stream handler and UI.
   *
   * @param {string} tokenId
   * @returns {number|null} Rank (1-based) or null if not ranked
   */
  getRank(tokenId) {
    const entry = this.tokenScores.get(String(tokenId));
    return entry && entry.rank > 0 ? entry.rank : null;
  }

  /**
   * Score + estimate rank for a NEW token not yet in the ranked set.
   * Uses binary search across sorted scores for O(log n) rank estimation.
   * Used for incoming WebSocket listings of unseen tokens.
   *
   * @param {string} tokenId
   * @param {Array} traits - [{ trait_type, value }, ...]
   * @returns {{ score: number, estimatedRank: number, isEstimated: boolean }}
   */
  scoreAndEstimateRank(tokenId, traits) {
    const idStr = String(tokenId);

    // If already ranked, return exact rank
    const existing = this.tokenScores.get(idStr);
    if (existing && existing.rank > 0) {
      return { score: existing.score, estimatedRank: existing.rank, isEstimated: false };
    }

    const score = this.scoreToken(traits);
    if (score === 0 || this.sortedScores.length === 0) {
      return { score, estimatedRank: this.sortedScores.length + 1, isEstimated: true };
    }

    // Binary search: find where this score fits in the sorted array
    let estimatedRank = this.sortedScores.length + 1;
    let lo = 0, hi = this.sortedScores.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedScores[mid][1].score >= score) {
        lo = mid + 1;
      } else {
        estimatedRank = mid + 1;
        hi = mid - 1;
      }
    }

    // Cache for future lookups (don't re-sort the full array for perf)
    this.tokenScores.set(idStr, { score, rank: estimatedRank });

    return { score, estimatedRank, isEstimated: true };
  }

  /**
   * Get serializable trait weights for sending to frontend
   * Frontend can then do local scoring without any API calls
   */
  getSerializableState() {
    if (!this.isReady) return null;
    const weights = {};
    for (const [key, val] of this.traitWeights) {
      weights[key] = { ic: val.ic, count: val.count };
    }
    return {
      totalSupply: this.totalSupply,
      traitTypes: [...this.traitTypes],
      weights,
      rankedCount: this.sortedScores.length
    };
  }

  /**
   * Reset calculator for a new collection
   */
  reset() {
    this.traitWeights.clear();
    this.traitTypes.clear();
    this.tokenScores.clear();
    this.sortedScores = [];
    this.totalSupply = 0;
    this.collectionSlug = null;
    this.isReady = false;
  }
}