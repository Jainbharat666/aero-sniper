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

let restKeyIndex = 1; // Keys 1..5 for REST, Key 0 reserved for Stream

export const config = {
  opensea: {
    // Key #1 is dedicated exclusively to the 24/7 WebSocket Stream
    streamKey: process.env.OPENSEA_API_KEY_STREAM || pool[0],
    fulfillmentKey: process.env.OPENSEA_API_KEY_FULFILLMENT || pool[1],
    rarityKey: process.env.OPENSEA_API_KEY_RARITY || pool[2],
    floorKey: process.env.OPENSEA_API_KEY_FLOOR || pool[3],
    apiKeys: pool,
    streamWsUrl: 'wss://stream.openseabeta.com/socket',
    restApiBase: 'https://api.opensea.io/api/v2',

    // Round-Robin Load Balancer across REST keys (Leaves Key #0 untouched for Stream)
    getNextRestKey() {
      const restPool = pool.slice(1);
      const key = restPool[restKeyIndex % restPool.length];
      restKeyIndex++;
      return key;
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
