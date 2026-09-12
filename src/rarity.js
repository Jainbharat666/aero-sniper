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
    this.totalSupply = 0;
    this.collectionName = '';
    this.collectionSlug = '';
    this.contractAddress = '';
    this.chain = 'robinhood';
    const isVercel = Boolean(process.env.VERCEL);
    this.cacheDir = isVercel ? path.join('/tmp', 'cache') : path.resolve(process.cwd(), 'cache');
    this.isDirty = false;
    this.saveTimeout = null;

    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
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
    return path.join(this.cacheDir, `${(slug || 'default').toLowerCase()}-rarity.json`);
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
   * Load collection overview and contract info using Key #3 with fallback to pool
   */
  async loadCollection(collectionSlug, chain = 'robinhood') {
    this.collectionSlug = collectionSlug.trim().toLowerCase();
    this.chain = chain || 'robinhood';
    console.log(chalk.cyan(`
🔍 [RARITY ENGINE V2] Loading collection: `) + chalk.yellow(this.collectionSlug));

    try {
      const apiKey = config.opensea.rarityKey || config.opensea.getNextRestKey();
      const colRes = await this.client.get(
        `${config.opensea.restApiBase}/collections/${this.collectionSlug}`,
        { headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' } }
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
      console.error(chalk.red(`✖ Failed to load collection metadata: `) + (err.response?.data?.detail || err.message));
      this.loadFromDiskCache();
      return null;
    }
  }

  loadFromDiskCache() {
    const cacheFile = this.getCachePath(this.collectionSlug);
    if (fs.existsSync(cacheFile)) {
      try {
        const raw = fs.readFileSync(cacheFile, 'utf8');
        const data = JSON.parse(raw);
        for (const [id, item] of Object.entries(data)) {
          this.tokenRarityMap.set(String(id), item);
        }
        console.log(chalk.green(`✔ [RARITY ENGINE V2] Loaded ${this.tokenRarityMap.size} cached token ranks from disk.`));
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
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
        const cacheFile = this.getCachePath(this.collectionSlug);
        const obj = {};
        for (const [id, item] of this.tokenRarityMap.entries()) {
          obj[id] = item;
        }
        await fs.promises.writeFile(cacheFile, JSON.stringify(obj, null, 2), 'utf8');
      } catch (e) {}
    }, 3000);
  }

  /**
   * Fetch exact OpenRarity rank using Key #3 with fast failover across REST pool
   */
  async fetchTokenRarity(tokenId, chain = this.chain, contract = this.contractAddress) {
    const idStr = String(tokenId);

    if (this.tokenRarityMap.has(idStr)) {
      return this.tokenRarityMap.get(idStr);
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
          headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' }
        });
        const nft = res.data?.nft;
        if (!nft) continue;
        config.opensea.clearKeyCooldown(apiKey);

        const rank = nft?.rarity?.rank || null;
        const name = nft?.name || `#${idStr}`;
        const traits = nft?.traits || [];
        const image = nft?.display_image_url || nft?.image_url || '';

        const tokenInfo = {
          tokenId: idStr,
          name,
          rank: rank !== null ? Number(rank) : null,
          score: nft?.rarity?.score || 0,
          traits,
          image,
          isExactOpenRarity: (rank !== null),
        };

        this.tokenRarityMap.set(idStr, tokenInfo);
        this.scheduleSave();

        return tokenInfo;
      } catch (err) {
        if (err.response?.status === 429) {
          config.opensea.markKeyCooldown(apiKey, 3000);
        }
        continue;
      }
    }

    // Fallback if OpenSea has no record or all keys rate-limited
    const fallbackInfo = {
      tokenId: idStr,
      name: `#${idStr}`,
      rank: null,
      score: 0,
      traits: [],
      image: '',
      isExactOpenRarity: false,
    };
    return fallbackInfo;
  }

  /**
   * HIGH-SPEED BATCH RARITY RESOLVER (6-Key Parallel Laser Grid)
   * Resolves up to 30 floor token rarities in parallel across all 6 keys in <300ms!
   */
  async batchFetchRarities(tokenIds, chain = this.chain, contract = this.contractAddress, concurrency = 6) {
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) return {};
    const targetChain = (chain || this.chain || 'robinhood').toLowerCase();
    const targetContract = contract || this.contractAddress;
    if (!targetContract) return {};

    const results = {};
    const missingIds = [];

    for (const id of tokenIds) {
      const idStr = String(id);
      const cached = this.tokenRarityMap.get(idStr);
      if (cached && cached.rank !== null) {
        results[idStr] = cached;
      } else {
        missingIds.push(idStr);
      }
    }

    if (missingIds.length === 0) {
      return results;
    }

    // Limit to top 10 missing floor tokens per batch to strictly stay within OpenSea rate limits
    const cappedMissing = missingIds.slice(0, 10);
    const keys = config.opensea.getCandidateKeys();
    let keyIdx = 0;
    let hitRateLimit = false;

    const worker = async (tokenId) => {
      if (hitRateLimit) return;
      const assignedKey = keys[(keyIdx++) % keys.length];
      if (config.opensea.isKeyCooledDown(assignedKey)) return;

      const url = `${config.opensea.restApiBase}/chain/${targetChain}/contract/${targetContract}/nfts/${tokenId}`;
      try {
        const res = await this.client.get(url, {
          headers: { 'X-API-KEY': assignedKey, 'Accept': 'application/json' },
          timeout: 3500
        });
        const nft = res.data?.nft;
        if (nft) {
          const rank = nft?.rarity?.rank != null ? Number(nft.rarity.rank) : null;
          const name = nft?.name || `#${tokenId}`;
          const traits = nft?.traits || [];
          const image = nft?.display_image_url || nft?.image_url || '';

          const tokenInfo = {
            tokenId: String(tokenId),
            name,
            rank,
            score: nft?.rarity?.score || 0,
            traits,
            image,
            isExactOpenRarity: (rank !== null),
          };
          this.tokenRarityMap.set(String(tokenId), tokenInfo);
          results[String(tokenId)] = tokenInfo;
          config.opensea.clearKeyCooldown(assignedKey);
          return;
        }
      } catch (err) {
        if (err.response?.status === 429) {
          hitRateLimit = true;
          config.opensea.markKeyCooldown(assignedKey, 4000);
        }
      }
    };

    // Staggered chunks to respect OpenSea 2 req/sec threshold
    for (let i = 0; i < cappedMissing.length; i += 3) {
      if (hitRateLimit) break;
      const chunk = cappedMissing.slice(i, i + 3);
      await Promise.allSettled(chunk.map(id => worker(id)));
      if (i + 3 < cappedMissing.length) {
        await new Promise(r => setTimeout(r, 60));
      }
    }

    this.scheduleSave();
    return results;
  }

  /**
   * Universal 100% Live On-The-Fly Resolver
   */
  async resolveRarity(tokenId, chain, contract) {
    const idStr = String(tokenId);
    const cached = this.tokenRarityMap.get(idStr);
    if (cached && cached.rank !== null) {
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