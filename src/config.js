import dotenv from 'dotenv';
dotenv.config();

// Parse 6 OpenSea API Keys
const allKeys = (process.env.OPENSEA_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 0);

const DEFAULT_KEYS = [
  '5f32ee9b98e84ea184a514f975ad4f3f', // Key #1: Dedicated Stream
  '840e6b17791d415db3c98657fbc71979', // Key #2: Fulfillment
  '411d0cfd7b294d71a71dc852999dcbfc', // Key #3: Rarity
  'a88ffbf11b864b8398af8b2c5e3921fa', // Key #4: Floor Poller
  '4793b5e5637a4a3fa75e81c828970113', // Key #5: Backup 1
  '7f2b82423f01405eac037f4b1a661027'  // Key #6: Backup 2
];

const pool = allKeys.length >= 6 ? allKeys : DEFAULT_KEYS;

// 🏪 CENTRAL "API SHOP" 24/7 CONTINUOUS ROTATING CAROUSEL
let globalKeyIndex = 0;
const keyCooldownMap = new Map(); // apiKey -> cooldownUntilTimestampMs

export const config = {
  opensea: {
    // Legacy single-purpose mappings preserved for backward compatibility
    streamKey: process.env.OPENSEA_API_KEY_STREAM || pool[0],
    fulfillmentKey: process.env.OPENSEA_API_KEY_FULFILLMENT || pool[1],
    rarityKey: process.env.OPENSEA_API_KEY_RARITY || pool[2],
    floorKey: process.env.OPENSEA_API_KEY_FLOOR || pool[3],
    apiKeys: pool,
    streamWsUrl: 'wss://stream.openseabeta.com/socket',
    restApiBase: 'https://api.opensea.io/api/v2',

    /**
     * 🏪 CENTRAL API SHOP: 24/7 Continuous Carousel across all 6 OpenSea API Keys.
     * Every module draws from this round-robin pool.
     * Automatically skips keys in 429 quarantine!
     */
    getNextApiKey(excludeStreamKey = false) {
      const now = Date.now();
      const activePool = excludeStreamKey ? pool.slice(1) : pool;

      // Find the next available key that is NOT currently in cooldown
      for (let attempt = 0; attempt < activePool.length; attempt++) {
        const key = activePool[globalKeyIndex % activePool.length];
        globalKeyIndex++;
        const cooldownUntil = keyCooldownMap.get(key) || 0;
        if (cooldownUntil <= now) {
          return key;
        }
      }

      // If all keys are momentarily cooled down, pick the one that expires soonest
      let bestKey = activePool[0];
      let minCooldown = Infinity;
      for (const k of activePool) {
        const cd = keyCooldownMap.get(k) || 0;
        if (cd < minCooldown) {
          minCooldown = cd;
          bestKey = k;
        }
      }
      return bestKey;
    },

    /**
     * Backward-compatible alias for REST endpoints
     */
    getNextRestKey() {
      return this.getNextApiKey(true);
    },

    /**
     * 🛡️ 429 Quarantine: Put an API key into cooldown (default 3000ms)
     */
    markKeyCooldown(key, durationMs = 3000) {
      if (!key) return;
      keyCooldownMap.set(key, Date.now() + durationMs);
    },

    /**
     * Clear cooldown when a key succeeds
     */
    clearKeyCooldown(key) {
      if (!key) return;
      keyCooldownMap.delete(key);
    },

    /**
     * Check if a key is currently in cooldown
     */
    isKeyCooledDown(key) {
      return (keyCooldownMap.get(key) || 0) > Date.now();
    },

    /**
     * Get candidate keys sorted so healthy (non-cooldown) keys come first
     */
    getCandidateKeys(preferredKey = null) {
      const now = Date.now();
      const list = preferredKey ? [preferredKey] : [];
      for (const k of pool) {
        if (!list.includes(k)) list.push(k);
      }
      list.sort((a, b) => {
        const aCool = (keyCooldownMap.get(a) || 0) > now ? 1 : 0;
        const bCool = (keyCooldownMap.get(b) || 0) > now ? 1 : 0;
        return aCool - bCool;
      });
      return list;
    },

    // Get any key by index
    getKeyByIndex(i) {
      return pool[i % pool.length];
    }
  },

  networks: {
    robinhood: {
      name: 'Robinhood Chain',
      chainId: 4663,
      rpcUrls: [
        process.env.ROBINHOOD_RPC_URL || 'https://robinhood-mainnet.g.alchemy.com/v2/alch_FtrEfyyJYzEBZ0SQ3ctbJ',
        process.env.ROBINHOOD_FALLBACK_RPC || 'https://rpc.mainnet.chain.robinhood.com'
      ],
      symbol: 'ETH',
      explorer: 'https://robinhoodchain.blockscout.com',
    },
    ethereum: {
      name: 'Ethereum Mainnet',
      chainId: 1,
      rpcUrls: [
        process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
        'https://rpc.ankr.com/eth'
      ],
      symbol: 'ETH',
      explorer: 'https://etherscan.io',
    },
    base: {
      name: 'Base',
      chainId: 8453,
      rpcUrls: [
        process.env.BASE_RPC_URL || 'https://mainnet.base.org',
        'https://base.llamarpc.com'
      ],
      symbol: 'ETH',
      explorer: 'https://basescan.org',
    },
    polygon: {
      name: 'Polygon',
      chainId: 137,
      rpcUrls: [
        process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
        'https://rpc.ankr.com/polygon'
      ],
      symbol: 'POL',
      explorer: 'https://polygonscan.com',
    },
    arbitrum: {
      name: 'Arbitrum One',
      chainId: 42161,
      rpcUrls: [
        process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        'https://arbitrum.llamarpc.com'
      ],
      symbol: 'ETH',
      explorer: 'https://arbiscan.io',
    },
  },

  seaport: {
    v1_6: process.env.SEAPORT_V1_6_ADDRESS || '0x0000000000000068F116a894984e2DB1123eB395',
    v1_5: process.env.SEAPORT_V1_5_ADDRESS || '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC',
  }
};

export const SEAPORT_V16_ABI = [
  'function fulfillBasicOrder_efficient_6GL6yc((address considerationToken, uint256 considerationIdentifier, uint256 considerationAmount, address offerer, address zone, address offerToken, uint256 offerIdentifier, uint256 offerAmount, uint8 basicOrderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 offererConduitKey, bytes32 fulfillerConduitKey, uint256 totalOriginalAdditionalRecipients, (uint256 amount, address recipient)[] additionalRecipients, bytes signature) parameters) payable returns (bool fulfilled)',
  'function fulfillBasicOrder_6B74FC10((address considerationToken, uint256 considerationIdentifier, uint256 considerationAmount, address offerer, address zone, address offerToken, uint256 offerIdentifier, uint256 offerAmount, uint8 basicOrderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 offererConduitKey, bytes32 fulfillerConduitKey, uint256 totalOriginalAdditionalRecipients, (uint256 amount, address recipient)[] additionalRecipients, bytes signature) parameters) payable returns (bool fulfilled)',
  'function fulfillOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)'
];

// 🛡️ AUDIT FIX LOW-4: Shared utility — single source of truth for ETH formatting
export function formatEthPrecise(num) {
  const n = parseFloat(num) || 0;
  if (n === 0) return '0.0000 ETH';
  if (n < 0.0001) return `${n.toFixed(6)} ETH`;
  if (n < 0.01) return `${n.toFixed(5)} ETH`;
  return `${n.toFixed(4)} ETH`;
}

// 🛡️ Shared Live ETH/USD Price Accessor (Eliminates hardcoded $2500 fallback)
let _currentLiveEthPrice = 0;
export function setLiveEthPrice(p) {
  const num = parseFloat(p);
  if (!isNaN(num) && num > 0) {
    _currentLiveEthPrice = num;
  }
}
export function getLiveEthPrice() {
  return _currentLiveEthPrice;
}
