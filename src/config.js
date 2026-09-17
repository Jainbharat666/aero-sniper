import dotenv from 'dotenv';
dotenv.config();

const _DEFAULT_OPENSEA_KEYS = [
  '5f32ee9b98e84ea184a514f975ad4f3f',
  '840e6b17791d415db3c98657fbc71979',
  '411d0cfd7b294d71a71dc852999dcbfc',
  'a88ffbf11b864b8398af8b2c5e3921fa',
  '4793b5e5637a4a3fa75e81c828970113',
  '7f2b82423f01405eac037f4b1a661027',
  'c502c24976ef4b29973e09560eb9084d',
  'a94e7d2f7ce04316a780f11f68464ee6',
  'b45a8a66d1fd47249176eee6fc4039c8',
  'b872a7f857ab49ad9879f2738bbabdf7',
  'cfee017832604b8f815551d0de9467a9',
  'e5b58347741249f0a4c7727e505c9aec',
  'e18f059e824640fa9deb5c7d03f21e40',
  '357c07f497f540008baf72b636ff4a21',
  'aa1436ba729f47b199aa0fab360515b2',
  '55d42d01083f4145bd17833449965841',
  'da369f3f803f4e769d523caea3ad0128',
  'c39b8ccd48874a32986e32a454aa87e0',
  '1471e3e2d15040aebcf9e9c3a6e8ce63',
  '9a4e25a567df42a5aea313e61eedc672',
  '469d53cf079e47b69e8f34d1aa8aedc4'
];

// Parse N OpenSea API Keys from environment (flexible pool — supports 6, 21, or any count)
const envKeyList = (process.env.OPENSEA_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 0);

const individualEnvKeys = [
  process.env.OPENSEA_API_KEY_STREAM,
  process.env.OPENSEA_API_KEY_FULFILLMENT,
  process.env.OPENSEA_API_KEY_RARITY,
  process.env.OPENSEA_API_KEY_FLOOR,
  process.env.OPENSEA_API_KEY_BACKUP1,
  process.env.OPENSEA_API_KEY_BACKUP2
].filter(Boolean).map(k => k.trim());

const pool = envKeyList.length > 0 
  ? envKeyList 
  : (individualEnvKeys.length > 0 ? individualEnvKeys : _DEFAULT_OPENSEA_KEYS);

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

    addApiKey(key) {
      if (key && !pool.includes(key)) {
        pool.push(key);
      }
    },

    removeApiKey(key) {
      const idx = pool.indexOf(key);
      if (idx > 0) {
        pool.splice(idx, 1);
        keyCooldownMap.delete(key);
      }
    },

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
     * Get candidate keys rotated in a round-robin circle with healthy (non-cooldown) keys first
     */
    getCandidateKeys(preferredKey = null, excludeStream = false) {
      const now = Date.now();
      const activePool = excludeStream && pool.length > 1 ? pool.slice(1) : pool;
      
      let startIdx;
      if (preferredKey && activePool.includes(preferredKey)) {
        startIdx = activePool.indexOf(preferredKey);
      } else {
        startIdx = globalKeyIndex % activePool.length;
        globalKeyIndex++; // Rotate counter atomically for next caller
      }

      // Rotate pool circularly starting from startIdx
      const rotated = [];
      for (let i = 0; i < activePool.length; i++) {
        rotated.push(activePool[(startIdx + i) % activePool.length]);
      }

      // Healthy non-cooldown keys first, preserving the rotated circle order
      rotated.sort((a, b) => {
        const aCool = (keyCooldownMap.get(a) || 0) > now ? 1 : 0;
        const bCool = (keyCooldownMap.get(b) || 0) > now ? 1 : 0;
        return aCool - bCool;
      });

      // If excludeStream was true but all active keys are in cooldown, include stream key as emergency backup
      if (excludeStream && pool.length > 1 && rotated.every(k => (keyCooldownMap.get(k) || 0) > now)) {
        rotated.push(pool[0]);
      }

      return rotated;
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
        process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
        process.env.ROBINHOOD_FALLBACK_RPC || 'https://mainnet.chain.robinhood.com/rpc'
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
  'function fulfillOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)',
  'function fulfillAdvancedOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData) advancedOrder, (uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)'
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
