import axios from 'axios';
import {
  activeSniperEngine,
  activeSniperEngines,
  activeCollectionStats,
  setActiveCollectionStats,
  cachedEthPrice
} from './state.js';
import { fetchOpenSeaWithFallback, formatEthPrecise } from './openSeaClient.js';
import { subscribeSlugToOpenSea } from './routes/stream.js';
import { resolveClosestCollectionSlug } from './routes/scan.js';
import { dbGetUserByEmail, dbGetUsers, dbUpdateUser } from './db.js';

// Environment Bindings
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8849256750:AAGL6tEK_2tatSxgS-RjWp2ngE7B6lh29RI';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '1683360811';
const TELEGRAM_FEED_BOT_TOKEN = process.env.TELEGRAM_FEED_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
const TELEGRAM_FEED_CHANNEL_ID = process.env.TELEGRAM_FEED_CHANNEL_ID || TELEGRAM_ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.RENDER_EXTERNAL_URL || 'https://aero-sniper.onrender.com';

let lastUpdateId = 0;
let isPollingActive = false;

// Default Universal Settings
let botActiveDiscountPercent = 20;
let botActiveGasPreset = 'turbo';
let botPaperSnipeMode = false;

// 4 Sniper Strategies State (Synchronized with active engine)
export const botRuleConfig = {
  ruleStates: {
    floor: true,
    rarity: true,
    trait: false,
    tokenId: false
  },
  floor: {
    discountPercent: 20,
    maxEth: 0,
    maxUsd: 0
  },
  rarity: {
    maxRank: 1200,
    multiplier: 1.25,
    maxEth: 0
  },
  trait: {
    filters: [], // [{ traitType, traitValue, maxEth }]
    maxEth: 0.05
  },
  tokenId: {
    tokens: [], // ['7129', '8485']
    maxEth: 0.1
  }
};

// User interactive prompt state tracker
const userPromptState = new Map();

/**
 * 🔢 Format ETH cleanly without scientific notation or floating point spam
 */
export function formatDisplayEth(val) {
  const n = parseFloat(val);
  if (isNaN(n) || n === 0) return '0.0000';
  if (n < 0.000001) return n.toFixed(8).replace(/0+$/, '');
  if (n < 0.0001) return n.toFixed(6).replace(/0+$/, '');
  if (n < 0.01) return n.toFixed(5);
  return n.toFixed(4);
}

/**
 * 🗑️ CLEAR ACTIVE TARGET (RESET ENGINE TO FRESH STANDBY)
 */
export function clearBotTarget() {
  setActiveCollectionStats(null);
  for (const [k, engine] of activeSniperEngines.entries()) {
    engine.slug = null;
    engine.contractAddress = null;
    engine.isArmed = false;
    engine.maxFloorEth = 0;
  }
  activeSniperEngine.slug = null;
  activeSniperEngine.contractAddress = null;
  activeSniperEngine.isArmed = false;
  activeSniperEngine.maxFloorEth = 0;
  console.log('🗑️ [TELEGRAM] Active sniper target cleared. Reset to Standby.');
}

/**
 * 🔍 SCAN & TARGET COLLECTION VIA TELEGRAM
 */
export async function executeScanForBot(input) {
  if (!input) return null;
  let clean = input.trim();
  if (clean.includes('opensea.io/collection/')) {
    clean = clean.split('opensea.io/collection/')[1].split('/')[0].split('?')[0].trim();
  } else if (clean.includes('opensea.io/assets/')) {
    const parts = clean.split('opensea.io/assets/')[1].split('/');
    if (parts.length >= 2 && parts[1].startsWith('0x')) {
      clean = parts[1].split('?')[0].trim();
    }
  }
  const slug = resolveClosestCollectionSlug(clean.toLowerCase());

  try {
    const [colData, listingsRes] = await Promise.all([
      fetchOpenSeaWithFallback(`/collections/${slug}`).catch(() => null),
      fetchOpenSeaWithFallback(`/listings/collection/${slug}/all?limit=25`).catch(() => null)
    ]);

    if (!colData) return null;

    let floorEth = 0;
    if (listingsRes?.listings?.length > 0) {
      const prices = listingsRes.listings
        .map(l => parseFloat(l.price?.current?.value || 0) / 1e18)
        .filter(v => v > 0 && isFinite(v));
      if (prices.length > 0) {
        floorEth = Math.min(...prices);
      }
    }

    const stats = {
      slug: slug,
      name: colData.name || slug,
      description: colData.description || '',
      imageUrl: colData.image_url || '',
      contract: colData.contracts?.[0]?.address || colData.primary_asset_contracts?.[0]?.address || '',
      floorEth: floorEth,
      totalSupply: colData.total_supply || colData.stats?.total_supply || 0,
      chain: 'robinhood'
    };

    setActiveCollectionStats(stats);
    try {
      subscribeSlugToOpenSea(slug);
    } catch(e) {}

    // Calculate default floor rule price if not set
    if (botRuleConfig.floor.maxEth === 0 && floorEth > 0) {
      botRuleConfig.floor.maxEth = floorEth * (1 - (botRuleConfig.floor.discountPercent || 20) / 100);
      botRuleConfig.floor.maxUsd = botRuleConfig.floor.maxEth * cachedEthPrice;
    }
    if (botRuleConfig.rarity.maxEth === 0 && floorEth > 0) {
      botRuleConfig.rarity.maxEth = floorEth * (botRuleConfig.rarity.multiplier || 1.25);
    }

    // Synchronize to active engines
    syncRulesToEngines(slug, stats.contract);

    return stats;
  } catch (err) {
    console.warn('[TELEGRAM SCAN] Error scanning collection:', err.message);
    return null;
  }
}

/**
 * 🔄 Synchronize 4 Rules State to all running Sniper Engines
 */
export function syncRulesToEngines(slug = null, contract = null) {
  const targetSlug = slug || activeCollectionStats?.slug;
  const targetContract = contract || activeCollectionStats?.contract;

  for (const [k, engine] of activeSniperEngines.entries()) {
    if (targetSlug) engine.slug = targetSlug;
    if (targetContract) engine.contractAddress = targetContract;
    engine.ruleStates = { ...botRuleConfig.ruleStates };
    engine.maxFloorEth = botRuleConfig.floor.maxEth;
    engine.maxRareRank = botRuleConfig.rarity.maxRank;
    engine.maxRareEth = botRuleConfig.rarity.maxEth;
    engine.traitFilters = [...botRuleConfig.trait.filters];
    engine.maxTraitEth = botRuleConfig.trait.maxEth;
    engine.targetTokenIds = [...botRuleConfig.tokenId.tokens];
    engine.maxTokenEth = botRuleConfig.tokenId.maxEth;
    engine.gasSpeed = botActiveGasPreset;
    engine.isDryRun = botPaperSnipeMode;
  }

  if (targetSlug) activeSniperEngine.slug = targetSlug;
  if (targetContract) activeSniperEngine.contractAddress = targetContract;
  activeSniperEngine.ruleStates = { ...botRuleConfig.ruleStates };
  activeSniperEngine.maxFloorEth = botRuleConfig.floor.maxEth;
  activeSniperEngine.maxRareRank = botRuleConfig.rarity.maxRank;
  activeSniperEngine.maxRareEth = botRuleConfig.rarity.maxEth;
  activeSniperEngine.traitFilters = [...botRuleConfig.trait.filters];
  activeSniperEngine.maxTraitEth = botRuleConfig.trait.maxEth;
  activeSniperEngine.targetTokenIds = [...botRuleConfig.tokenId.tokens];
  activeSniperEngine.maxTokenEth = botRuleConfig.tokenId.maxEth;
  activeSniperEngine.gasSpeed = botActiveGasPreset;
  activeSniperEngine.isDryRun = botPaperSnipeMode;
}

/**
 * 🎨 1. MAIN DASHBOARD MENU (Hub)
 */
export function buildMainMenu(chatId = null) {
  const isArmed = Array.from(activeSniperEngines.values()).some(e => e.isArmed) || activeSniperEngine.isArmed;
  const stats = activeCollectionStats;
  const hasTarget = !!(stats && stats.slug);
  const activeEngines = activeSniperEngines.size || (isArmed ? 1 : 0);

  let text = '';
  let keyboard = [];

  if (hasTarget) {
    const currentSlug = stats.name || stats.slug;
    const floorEthNum = parseFloat(stats.floorEth) || 0;
    const floorEthDisp = formatDisplayEth(floorEthNum);
    const usdFloor = (floorEthNum * cachedEthPrice).toFixed(2);

    // Rule Summary Lines
    const r1State = botRuleConfig.ruleStates.floor ? '🟢 ON' : '⚪ OFF';
    const r1Val = botRuleConfig.floor.maxEth > 0 ? `${formatDisplayEth(botRuleConfig.floor.maxEth)} ETH` : `-${botRuleConfig.floor.discountPercent}%`;

    const r2State = botRuleConfig.ruleStates.rarity ? '🟢 ON' : '⚪ OFF';
    const r2Val = `Top #${botRuleConfig.rarity.maxRank} (Cap: ${formatDisplayEth(botRuleConfig.rarity.maxEth)} ETH)`;

    const r3State = botRuleConfig.ruleStates.trait ? '🟢 ON' : '⚪ OFF';
    const r3Val = `${botRuleConfig.trait.filters.length} traits (Cap: ${formatDisplayEth(botRuleConfig.trait.maxEth)} ETH)`;

    const r4State = botRuleConfig.ruleStates.tokenId ? '🟢 ON' : '⚪ OFF';
    const r4Val = `${botRuleConfig.tokenId.tokens.length} token IDs (Cap: ${formatDisplayEth(botRuleConfig.tokenId.maxEth)} ETH)`;

    text = `
⚡ <b>AERO-SNIPER PRO • TELEGRAM TERMINAL</b> ⚡
<i>Institutional High-Frequency NFT Sniping Protocol</i>

━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Active Target:</b> <code>${currentSlug}</code>
💎 <b>Current Floor:</b> <b>${floorEthDisp} ETH</b> (~$${usdFloor} USD)
🛡️ <b>Engine Status:</b> ${isArmed ? '🟢 <b>ARMED & HUNTING (24/7)</b>' : '🔴 <b>DISARMED / STANDBY</b>'}
🧪 <b>Mode:</b> ${botPaperSnipeMode ? '🧪 <b>PAPER SNIPE (SIMULATION)</b>' : '⚡ <b>100% REAL ON-CHAIN MAINNET</b>'}
🚀 <b>Gas Speed:</b> <b>${botActiveGasPreset.toUpperCase()}</b> (Auto-Surge)

<b>Active Trigger Strategies:</b>
• 1️⃣ <b>Floor Trap:</b> [${r1State}] <code>${r1Val}</code>
• 2️⃣ <b>Rarity Rank:</b> [${r2State}] <code>${r2Val}</code>
• 3️⃣ <b>Rare Traits:</b> [${r3State}] <code>${r3Val}</code>
• 4️⃣ <b>Token Trap:</b> [${r4State}] <code>${r4Val}</code>
━━━━━━━━━━━━━━━━━━━━━
<i>💡 Tap buttons below to Arm, adjust 4 rules, or clear target:</i>
`.trim();

    keyboard = [
      [
        isArmed
          ? { text: '⏸ Pause Sniper', callback_data: 'action_pause' }
          : { text: '⚡ ARM AUTO-SNIPER (24/7)', callback_data: 'action_arm' }
      ],
      [
        { text: '⚙️ Configure 4 Sniper Rules', callback_data: 'menu_rules_hub' }
      ],
      [
        { text: '🎯 Change Target', callback_data: 'menu_target' },
        { text: '🗑️ Clear Target', callback_data: 'action_clear_target' }
      ],
      [
        { text: `🚀 Gas: ${botActiveGasPreset.toUpperCase()}`, callback_data: 'menu_gas' },
        { text: botPaperSnipeMode ? '🧪 Mode: Paper' : '⚡ Mode: Real', callback_data: 'action_toggle_sim' }
      ],
      [
        { text: '👛 Wallet Fleet Holdings', callback_data: 'menu_wallets' },
        { text: '📊 Live Telemetry', callback_data: 'menu_stats' }
      ],
      [
        { text: '🔄 Refresh', callback_data: 'menu_refresh' },
        { text: '❓ Guide', callback_data: 'menu_help' },
        { text: '🌐 Launch WebApp', web_app: { url: WEBAPP_URL } }
      ]
    ];
  } else {
    // 🛡️ CLEAN FRESH STANDBY STATE
    text = `
⚡ <b>AERO-SNIPER PRO • TELEGRAM TERMINAL</b> ⚡
<i>Institutional High-Frequency NFT Sniping Protocol</i>

━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Target:</b> <code>🔍 No Collection Loaded (Standby)</code>
💎 <b>Floor Price:</b> <code>-- ETH</code>
🛡️ <b>Engine Status:</b> 🔴 <b>STANDBY (Awaiting Target)</b>
🧪 <b>Mode:</b> ${botPaperSnipeMode ? '🧪 <b>PAPER SNIPE (SIMULATION)</b>' : '⚡ <b>100% REAL ON-CHAIN MAINNET</b>'}
🚀 <b>Gas Speed:</b> <b>${botActiveGasPreset.toUpperCase()}</b> (Auto-Surge)
👥 <b>Cloud Engines:</b> <code>${activeEngines} user(s) online</code>
🌐 <b>Robinhood Sequencer:</b> 🟢 <b>Sub-15ms Active</b>
━━━━━━━━━━━━━━━━━━━━━
<i>💡 Send any OpenSea link/slug in chat or tap below to set target:</i>
`.trim();

    keyboard = [
      [
        { text: '🔍 Search & Set Target NFT', callback_data: 'menu_target' }
      ],
      [
        { text: '⚙️ Configure 4 Sniper Rules', callback_data: 'menu_rules_hub' },
        { text: `🚀 Gas: ${botActiveGasPreset.toUpperCase()}`, callback_data: 'menu_gas' }
      ],
      [
        { text: botPaperSnipeMode ? '🧪 Mode: Paper' : '⚡ Mode: Real', callback_data: 'action_toggle_sim' },
        { text: '👛 Wallet Fleet', callback_data: 'menu_wallets' }
      ],
      [
        { text: '📊 Telemetry & Health', callback_data: 'menu_stats' },
        { text: '🔄 Refresh', callback_data: 'menu_refresh' }
      ],
      [
        { text: '❓ Command Guide', callback_data: 'menu_help' },
        { text: '🌐 Launch WebApp', web_app: { url: WEBAPP_URL } }
      ]
    ];
  }

  return { text, keyboard };
}

/**
 * ⚙️ 2. RULES HUB MENU (Overview of all 4 strategies)
 */
export function buildRulesHubMenu() {
  const floorEth = parseFloat(activeCollectionStats?.floorEth) || 0;
  const floorDisp = formatDisplayEth(floorEth);

  const r1 = botRuleConfig.ruleStates.floor ? '🟢 ACTIVE' : '⚪ PAUSED';
  const r2 = botRuleConfig.ruleStates.rarity ? '🟢 ACTIVE' : '⚪ PAUSED';
  const r3 = botRuleConfig.ruleStates.trait ? '🟢 ACTIVE' : '⚪ PAUSED';
  const r4 = botRuleConfig.ruleStates.tokenId ? '🟢 ACTIVE' : '⚪ PAUSED';

  const text = `
⚙️ <b>SNIPER TRIGGER RULES DECK</b> ⚙️

Collection Floor: <b>${floorDisp} ETH</b> (~$${(floorEth * cachedEthPrice).toFixed(2)})

<b>1️⃣ Rule 1: Floor Underprice Trap [${r1}]</b>
• Buy below discount or exact ETH/USD max cap.
• Trigger: <code>${botRuleConfig.floor.maxEth > 0 ? formatDisplayEth(botRuleConfig.floor.maxEth) + ' ETH ($' + botRuleConfig.floor.maxUsd.toFixed(2) + ')' : '-' + botRuleConfig.floor.discountPercent + '%'}</code>

<b>2️⃣ Rule 2: Top Rarity Rank Snipe [${r2}]</b>
• Buy top ranked NFTs (OpenRarity instant calculation).
• Target: <code>Rank <= #${botRuleConfig.rarity.maxRank} @ Max ${formatDisplayEth(botRuleConfig.rarity.maxEth)} ETH</code>

<b>3️⃣ Rule 3: Rare Trait Hunter [${r3}]</b>
• Snipe God traits / 1 of 1s (e.g. Laser eyes, Crown).
• Targets: <code>${botRuleConfig.trait.filters.length} active trait(s) (Cap: ${formatDisplayEth(botRuleConfig.trait.maxEth)} ETH)</code>

<b>4️⃣ Rule 4: Target Specific Token ID [${r4}]</b>
• Priority 1 grail trap for specific token IDs.
• Target: <code>${botRuleConfig.tokenId.tokens.length > 0 ? botRuleConfig.tokenId.tokens.map(t => '#' + t).join(', ') : 'None'} (Cap: ${formatDisplayEth(botRuleConfig.tokenId.maxEth)} ETH)</code>
━━━━━━━━━━━━━━━━━━━━━
<i>Select a rule below to configure its settings:</i>
`.trim();

  const keyboard = [
    [
      { text: `1️⃣ Floor Trap [${r1}]`, callback_data: 'menu_rule_floor' },
      { text: `2️⃣ Rarity Rank [${r2}]`, callback_data: 'menu_rule_rarity' }
    ],
    [
      { text: `3️⃣ Rare Traits [${r3}]`, callback_data: 'menu_rule_trait' },
      { text: `4️⃣ Token IDs [${r4}]`, callback_data: 'menu_rule_token' }
    ],
    [
      { text: '🔙 Back to Main Dashboard', callback_data: 'menu_main' }
    ]
  ];

  return { text, keyboard };
}

/**
 * ⚡ 3. RULE 1: FLOOR UNDERPRICE TRAP MENU
 */
export function buildFloorRuleMenu() {
  const floorEth = parseFloat(activeCollectionStats?.floorEth) || 0;
  const state = botRuleConfig.ruleStates.floor ? '🟢 ACTIVE' : '⚪ PAUSED';
  const maxEth = botRuleConfig.floor.maxEth > 0 ? botRuleConfig.floor.maxEth : floorEth * (1 - botRuleConfig.floor.discountPercent / 100);
  const maxUsd = maxEth * cachedEthPrice;

  const text = `
1️⃣ <b>RULE 1: FLOOR UNDERPRICE TRAP</b> [${state}]

Current Floor: <b>${formatDisplayEth(floorEth)} ETH</b> (~$${(floorEth * cachedEthPrice).toFixed(2)})
Max Buy Cap: <b>${formatDisplayEth(maxEth)} ETH</b> (~$${maxUsd.toFixed(2)} USD)
Discount Mode: <b>-${botRuleConfig.floor.discountPercent}% Below Floor</b>

<i>🎯 Buys any listing listed below this maximum price.</i>
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.floor ? '⏸ Pause Floor Rule' : '▶️ Activate Floor Rule', callback_data: 'toggle_rule_floor' }
    ],
    [
      { text: '-10%', callback_data: 'set_r1_pct_10' },
      { text: '-20%', callback_data: 'set_r1_pct_20' },
      { text: '-30%', callback_data: 'set_r1_pct_30' },
      { text: '-50% 🔥', callback_data: 'set_r1_pct_50' },
      { text: '-80% ⚡', callback_data: 'set_r1_pct_80' }
    ],
    [
      { text: '✏️ Set Custom Max Price (ETH)', callback_data: 'prompt_r1_eth' }
    ],
    [
      { text: '💵 Set Custom Max Price (USD $)', callback_data: 'prompt_r1_usd' }
    ],
    [
      { text: '🔙 Back to Rules Deck', callback_data: 'menu_rules_hub' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 👑 4. RULE 2: TOP RARITY RANK SNIPE MENU
 */
export function buildRarityRuleMenu() {
  const floorEth = parseFloat(activeCollectionStats?.floorEth) || 0;
  const state = botRuleConfig.ruleStates.rarity ? '🟢 ACTIVE' : '⚪ PAUSED';
  const maxEth = botRuleConfig.rarity.maxEth > 0 ? botRuleConfig.rarity.maxEth : floorEth * (botRuleConfig.rarity.multiplier || 1.25);
  const maxUsd = maxEth * cachedEthPrice;

  const text = `
2️⃣ <b>RULE 2: TOP RARITY RANK SNIPE</b> [${state}]

Target Rank: <b>Rank &lt;= #${botRuleConfig.rarity.maxRank}</b>
Max Buy Cap: <b>${formatDisplayEth(maxEth)} ETH</b> (~$${maxUsd.toFixed(2)} USD)
Price Multiplier: <b>${botRuleConfig.rarity.multiplier}x Floor</b>

<i>👑 Automatically snipes high rarity NFTs using OpenRarity sub-millisecond RAM calculation.</i>
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.rarity ? '⏸ Pause Rarity Rule' : '▶️ Activate Rarity Rule', callback_data: 'toggle_rule_rarity' }
    ],
    [
      { text: 'Top #100', callback_data: 'set_r2_rank_100' },
      { text: 'Top #500', callback_data: 'set_r2_rank_500' },
      { text: 'Top #1200', callback_data: 'set_r2_rank_1200' },
      { text: '✏️ Custom Rank', callback_data: 'prompt_r2_rank' }
    ],
    [
      { text: '1.0x Floor', callback_data: 'set_r2_mult_100' },
      { text: '1.25x Floor', callback_data: 'set_r2_mult_125' },
      { text: '1.50x Floor', callback_data: 'set_r2_mult_150' },
      { text: '✏️ Custom ETH Cap', callback_data: 'prompt_r2_eth' }
    ],
    [
      { text: '🔙 Back to Rules Deck', callback_data: 'menu_rules_hub' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 💎 5. RULE 3: RARE TRAIT HUNTER MENU
 */
export function buildTraitRuleMenu() {
  const state = botRuleConfig.ruleStates.trait ? '🟢 ACTIVE' : '⚪ PAUSED';
  const traitsList = botRuleConfig.trait.filters.length > 0
    ? botRuleConfig.trait.filters.map((f, i) => `${i + 1}. <code>${f.traitType ? f.traitType + ': ' : ''}${f.traitValue}</code>`).join('\n')
    : '<i>No trait filters added yet.</i>';

  const text = `
3️⃣ <b>RULE 3: RARE TRAIT HUNTER</b> [${state}]

Max Price Cap: <b>${formatDisplayEth(botRuleConfig.trait.maxEth)} ETH</b> (~$${(botRuleConfig.trait.maxEth * cachedEthPrice).toFixed(2)})

<b>Active Targeted Traits:</b>
${traitsList}

<i>💎 Instantly snipes whenever an NFT listed with ANY of these traits is detected.</i>
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.trait ? '⏸ Pause Trait Rule' : '▶️ Activate Trait Rule', callback_data: 'toggle_rule_trait' }
    ],
    [
      { text: '➕ Add Trait Filter', callback_data: 'prompt_r3_add_trait' },
      { text: '💰 Set Max ETH Cap', callback_data: 'prompt_r3_eth' }
    ],
    [
      { text: '🗑️ Clear All Traits', callback_data: 'action_r3_clear_traits' },
      { text: '🔙 Back to Rules', callback_data: 'menu_rules_hub' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 🎯 6. RULE 4: TARGET SPECIFIC TOKEN ID TRAP MENU
 */
export function buildTokenIdRuleMenu() {
  const state = botRuleConfig.ruleStates.tokenId ? '🟢 ACTIVE' : '⚪ PAUSED';
  const tokensList = botRuleConfig.tokenId.tokens.length > 0
    ? botRuleConfig.tokenId.tokens.map(t => `#${t}`).join(', ')
    : '<i>No token IDs added yet.</i>';

  const text = `
4️⃣ <b>RULE 4: TARGET TOKEN ID TRAP</b> [${state}]

Max Price Cap: <b>${formatDisplayEth(botRuleConfig.tokenId.maxEth)} ETH</b> (~$${(botRuleConfig.tokenId.maxEth * cachedEthPrice).toFixed(2)})

<b>Targeted Token IDs:</b>
<code>${tokensList}</code>

<i>🎯 Priority 1 grail trap: Immediately snipes these exact token IDs when listed.</i>
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.tokenId ? '⏸ Pause Token Rule' : '▶️ Activate Token Rule', callback_data: 'toggle_rule_token' }
    ],
    [
      { text: '🎯 Enter Token IDs (e.g. 7129, 8485)', callback_data: 'prompt_r4_tokens' },
      { text: '💰 Set Max ETH Cap', callback_data: 'prompt_r4_eth' }
    ],
    [
      { text: '🗑️ Clear Token IDs', callback_data: 'action_r4_clear_tokens' },
      { text: '🔙 Back to Rules', callback_data: 'menu_rules_hub' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 🎯 BUILD TARGET COLLECTION MENU
 */
export function buildTargetMenu() {
  const currentSlug = activeCollectionStats?.name || activeCollectionStats?.slug || 'None (Standby)';
  const text = `
🎯 <b>SELECT TARGET COLLECTION:</b>

Choose a collection below or <b>send any OpenSea URL / slug directly into this chat</b>:

Current Active: <code>${currentSlug}</code>
`.trim();

  const keyboard = [
    [
      { text: '✍️ Type / Paste Custom Slug or URL', callback_data: 'prompt_custom_target' }
    ],
    [
      { text: '🌲 Woodies', callback_data: 'set_target_robinwoodies' },
      { text: '🐂 Bulls Runners', callback_data: 'set_target_bulls-runners-genesis' }
    ],
    [
      { text: '🤖 RH Machines', callback_data: 'set_target_rhmachines' },
      { text: '⚡ NTRPY Genesis', callback_data: 'set_target_ntrpygenesis' }
    ],
    [
      { text: '🗑️ Clear Target (Reset)', callback_data: 'action_clear_target' },
      { text: '🔙 Main Menu', callback_data: 'menu_main' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 🚀 BUILD GAS PRESET MENU
 */
export function buildGasMenu() {
  const text = `
🚀 <b>SELECT GAS WAR ENGINE PRESET:</b>

Choose your Robinhood Chain mempool racing multiplier:

🛡️ <b>Safe (125%):</b> Standard tip, optimal for low-traffic drops.
🚀 <b>Turbo (175%):</b> Institutional priority, recommended default.
⚡ <b>Surge (235%):</b> Aggressive front-running for high-demand snipes.
🔥 <b>Hyped (300%):</b> Maximum gas blitz for sub-10ms priority execution.
`.trim();

  const keyboard = [
    [
      { text: '🛡️ Safe (125%)', callback_data: 'set_gas_safe' },
      { text: '🚀 Turbo (175%)', callback_data: 'set_gas_turbo' }
    ],
    [
      { text: '⚡ Surge (235%)', callback_data: 'set_gas_surge' },
      { text: '🔥 Hyped (300%)', callback_data: 'set_gas_hyped' }
    ],
    [
      { text: '🔙 Back to Main Menu', callback_data: 'menu_main' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 👛 BUILD WALLETS FLEET STATUS MENU
 */
export async function buildWalletsMenu() {
  const users = await dbGetUsers().catch(() => []);
  const primaryUser = users[0];
  const wallets = primaryUser?.vault?.wallets || [];
  const masterWallet = wallets.find(w => w.role === 'master') || wallets[0];

  let totalEth = 0;
  wallets.forEach(w => {
    totalEth += parseFloat(w.balance || 0);
  });
  const totalUsd = (totalEth * cachedEthPrice).toFixed(2);

  let walletLines = '';
  if (wallets.length === 0) {
    walletLines = '<i>No wallets configured in cloud vault. Add keys via WebApp or Bot.</i>';
  } else {
    walletLines = wallets.slice(0, 6).map((w, idx) => {
      const shortAddr = w.address ? `${w.address.slice(0, 6)}...${w.address.slice(-4)}` : '0x...';
      const roleTag = w.role === 'master' ? '👑 Master' : '⚡ Worker';
      const bal = formatDisplayEth(w.balance || 0);
      return `• <b>${roleTag} (${w.name || '#' + (idx + 1)}):</b> <code>${shortAddr}</code> — <b>${bal} ETH</b>`;
    }).join('\n');
    if (wallets.length > 6) {
      walletLines += `\n<i>...and ${wallets.length - 6} more worker sub-wallets</i>`;
    }
  }

  const text = `
👛 <b>MAINNET WALLET FLEET STATUS</b> 👛

💰 <b>Total Fleet Value:</b> <b>${formatDisplayEth(totalEth)} ETH</b> (~$${totalUsd} USD)
👥 <b>Total Active Wallets:</b> <b>${wallets.length} wallet(s)</b>
👑 <b>Master Holding:</b> <code>${masterWallet?.address ? masterWallet.address.slice(0, 8) + '...' + masterWallet.address.slice(-6) : 'None Set'}</code>

<b>Active Fleet List:</b>
${walletLines}

🛡️ <i>Auto-Rotation & Anti-Scam Architecture Active</i>
`.trim();

  const keyboard = [
    [
      { text: '🔄 Refresh Balances', callback_data: 'menu_wallets' },
      { text: '🔙 Back to Menu', callback_data: 'menu_main' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 📡 Send Telegram Message with HTML formatting
 */
export async function sendTelegramMessage(token, chatId, text, inlineKeyboard = null) {
  if (!token || !chatId || !text) return false;
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (inlineKeyboard) {
      payload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload, { timeout: 6000 });
    return true;
  } catch (err) {
    console.warn(`[TELEGRAM] Failed to send message to ${chatId}:`, err.response?.data?.description || err.message);
    return false;
  }
}

/**
 * 🔄 Edit Message Text (Instant Dynamic Menu Refresh with Photo & Fallback Support)
 */
export async function editTelegramMessage(token, chatId, messageId, text, inlineKeyboard = null) {
  if (!token || !chatId || !messageId) return false;
  const replyMarkup = inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined;

  // 1. Try editMessageText (Normal text messages)
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, payload, { timeout: 6000 });
    return true;
  } catch (err) {
    const desc = err.response?.data?.description || '';
    if (desc.includes('message is not modified')) return true;

    // 2. Try editMessageCaption (For messages sent with photo / preview banner)
    try {
      const payloadCap = {
        chat_id: chatId,
        message_id: messageId,
        caption: text,
        parse_mode: 'HTML'
      };
      if (replyMarkup) payloadCap.reply_markup = replyMarkup;
      await axios.post(`https://api.telegram.org/bot${token}/editMessageCaption`, payloadCap, { timeout: 6000 });
      return true;
    } catch (errCap) {
      const descCap = errCap.response?.data?.description || '';
      if (descCap.includes('message is not modified')) return true;

      // 3. Fallback: Send fresh message if editing isn't allowed or fails
      try {
        await sendTelegramMessage(token, chatId, text, inlineKeyboard);
        return true;
      } catch (errSend) {
        return false;
      }
    }
  }
}

/**
 * 🔔 Answer Callback Query (Removes loading spinner on button tap)
 */
export async function answerCallbackQuery(token, callbackQueryId, notificationText = '') {
  if (!token || !callbackQueryId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: notificationText,
      show_alert: false
    }, { timeout: 4000 });
  } catch (e) {}
}

/**
 * 🖼️ Send Telegram Photo with Caption
 */
export async function sendTelegramPhoto(token, chatId, photoUrl, caption, inlineKeyboard = null) {
  if (!token || !chatId) return false;
  if (!photoUrl) return sendTelegramMessage(token, chatId, caption, inlineKeyboard);

  try {
    const payload = {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'HTML'
    };
    if (inlineKeyboard) {
      payload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, payload, { timeout: 8000 });
    return true;
  } catch (err) {
    return sendTelegramMessage(token, chatId, caption, inlineKeyboard);
  }
}

/**
 * 🎯 1. PRIVATE SNIPE ALERT (Sent to the user's Telegram)
 */
export async function dispatchPrivateSnipeAlert(userEngine, snipeData) {
  const token = TELEGRAM_BOT_TOKEN;
  const chatId = userEngine?.telegramChatId || userEngine?.chatId || TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return;

  const isSim = !!snipeData.isDryRun;
  const modeBadge = isSim ? '🧪 <b>PAPER SNIPE SIMULATED</b>' : '⚡ <b>LIVE ON-CHAIN SNIPE CONFIRMED!</b>';
  const tokenName = snipeData.name || `#${snipeData.tokenId}`;
  const priceEth = formatDisplayEth(snipeData.price || 0);
  const usdPrice = (parseFloat(snipeData.price || 0) * cachedEthPrice).toFixed(2);
  const txHash = snipeData.txHash || '';
  const txShort = txHash.length > 18 ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : txHash;
  const blockNum = snipeData.blockNumber ? `#${snipeData.blockNumber}` : 'Mined';
  const explorerUrl = `https://explorer.mainnet.robinhood.com/tx/${txHash}`;
  const openseaUrl = `https://opensea.io/assets/robinhood/${snipeData.contractAddress || ''}/${snipeData.tokenId}`;

  const caption = `
🏆 ${modeBadge}

🎯 <b>Token:</b> <code>${tokenName}</code>
🏷️ <b>Collection:</b> <code>${userEngine?.slug || 'Collection'}</code>
💰 <b>Price Bought:</b> <b>${priceEth} ETH</b> (~$${usdPrice} USD)
⚡ <b>Compute Latency:</b> <b>${snipeData.computeLatencyMs || '5.0'} ms</b>
🛡️ <b>Worker Wallet:</b> <code>${snipeData.buyerName || 'Primary'}</code>
📦 <b>Robinhood Block:</b> <code>${blockNum}</code>
🔗 <b>TxHash:</b> <code>${txShort}</code>

${isSim ? '<i>Simulation Mode — Zero funds spent</i>' : '<i>Successfully secured & transferred to your worker wallet!</i>'}
`.trim();

  const keyboard = [
    [
      { text: '🔍 View on Explorer', url: explorerUrl },
      { text: '⛵ View on OpenSea', url: openseaUrl }
    ],
    [
      { text: '🌐 Open WebApp', web_app: { url: WEBAPP_URL } }
    ]
  ];

  sendTelegramPhoto(token, chatId, snipeData.image || snipeData.imageUrl, caption, keyboard).catch(() => {});
}

/**
 * 📢 2. UNIVERSAL MASTER FEED ALERT (Broadcast to Global Admin / Channel)
 */
export async function dispatchGlobalMasterFeedAlert(snipeData) {
  const token = TELEGRAM_FEED_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  const channelId = TELEGRAM_FEED_CHANNEL_ID || TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !channelId) return;

  const tokenName = snipeData.name || `#${snipeData.tokenId}`;
  const priceEth = formatDisplayEth(snipeData.price || 0);
  const usdPrice = (parseFloat(snipeData.price || 0) * cachedEthPrice).toFixed(2);
  const buyerDisplay = snipeData.buyerName || 'VIP Member';
  const explorerUrl = `https://explorer.mainnet.robinhood.com/tx/${snipeData.txHash}`;

  const text = `
👑 <b>AERO-SNIPER V2 • MASTER MINT FEED</b> ⚡

👤 <b>Trader:</b> <code>${buyerDisplay}</code>
🎯 <b>NFT:</b> <b>${tokenName}</b>
🏷️ <b>Collection:</b> <code>${snipeData.slug || 'Collection'}</code>
💰 <b>Price Bought:</b> <b>${priceEth} ETH</b> (~$${usdPrice} USD)
⚡ <b>Mempool Blast Latency:</b> <b>${snipeData.computeLatencyMs || '5.0'} ms</b>
🔗 <b>Tx:</b> <a href="${explorerUrl}">Click to View On-Chain</a>

🌐 <i>Aero-Sniper Institutional High-Frequency Protocol Active</i>
`.trim();

  const keyboard = [
    [{ text: '🚀 Verify on Robinhood Mainnet', url: explorerUrl }]
  ];

  sendTelegramPhoto(token, channelId, snipeData.image || snipeData.imageUrl, text, keyboard).catch(() => {});
}

/**
 * 🔘 INTERACTIVE CALLBACK QUERY ROUTER (Handle Button Taps)
 */
async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;

  if (!chatId || !messageId) return;

  // 1. Arm Action
  if (data === 'action_arm' || data === 'arm') {
    if (!activeCollectionStats?.slug) {
      await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚠️ Please set a target collection first!');
      const menu = buildTargetMenu();
      return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
    }
    syncRulesToEngines();
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = true;
    }
    activeSniperEngine.isArmed = true;
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚡ Sniper ARMED in Cloud 24/7!');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 2. Pause Action
  if (data === 'action_pause' || data === 'pause') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
    }
    activeSniperEngine.isArmed = false;
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⏸ Sniper PAUSED!');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 3. Clear Target Action
  if (data === 'action_clear_target' || data === 'clear_target') {
    clearBotTarget();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🗑️ Target Cleared! Engine in Standby.');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 4. Toggle Simulation (Paper Snipe)
  if (data === 'action_toggle_sim') {
    botPaperSnipeMode = !botPaperSnipeMode;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, botPaperSnipeMode ? '🧪 Paper Snipe Activated (0 ETH spent)' : '⚡ Real Mainnet Activated!');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 5. Rules Hub Menu
  if (data === 'menu_rules_hub' || data === 'bot_rules_hub' || data === 'rules' || data === 'rules_hub') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildRulesHubMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 6. Rule 1: Floor Menu
  if (data === 'menu_rule_floor') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildFloorRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Toggle Rule 1
  if (data === 'toggle_rule_floor') {
    botRuleConfig.ruleStates.floor = !botRuleConfig.ruleStates.floor;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, botRuleConfig.ruleStates.floor ? '🟢 Floor Rule Active' : '⚪ Floor Rule Paused');
    const menu = buildFloorRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Set R1 Discount Presets
  if (data.startsWith('set_r1_pct_')) {
    const pct = parseInt(data.replace('set_r1_pct_', ''), 10);
    botRuleConfig.floor.discountPercent = pct;
    const floor = parseFloat(activeCollectionStats?.floorEth) || 0;
    if (floor > 0) {
      botRuleConfig.floor.maxEth = floor * (1 - pct / 100);
      botRuleConfig.floor.maxUsd = botRuleConfig.floor.maxEth * cachedEthPrice;
    }
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `✅ Floor Target: -${pct}% (${formatDisplayEth(botRuleConfig.floor.maxEth)} ETH)`);
    const menu = buildFloorRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Prompt R1 Custom ETH
  if (data === 'prompt_r1_eth') {
    userPromptState.set(chatId, { action: 'awaiting_r1_eth' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
✏️ <b>ENTER MAX PRICE IN ETH:</b>

Current Floor: <b>${formatDisplayEth(activeCollectionStats?.floorEth || 0)} ETH</b>

Please type your desired maximum trigger price in <b>ETH</b> (e.g. <code>0.025</code> or <code>0.000018</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_floor' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Prompt R1 Custom USD
  if (data === 'prompt_r1_usd') {
    userPromptState.set(chatId, { action: 'awaiting_r1_usd' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
💵 <b>ENTER MAX PRICE IN USD ($):</b>

ETH Price: <b>$${cachedEthPrice.toFixed(2)} USD</b>

Please type your desired maximum trigger price in <b>USD ($)</b> (e.g. <code>50</code> or <code>100</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_floor' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // 7. Rule 2: Rarity Menu
  if (data === 'menu_rule_rarity') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildRarityRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Toggle Rule 2
  if (data === 'toggle_rule_rarity') {
    botRuleConfig.ruleStates.rarity = !botRuleConfig.ruleStates.rarity;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, botRuleConfig.ruleStates.rarity ? '🟢 Rarity Rule Active' : '⚪ Rarity Rule Paused');
    const menu = buildRarityRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Set R2 Rank Presets
  if (data.startsWith('set_r2_rank_')) {
    const rank = parseInt(data.replace('set_r2_rank_', ''), 10);
    botRuleConfig.rarity.maxRank = rank;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `✅ Max Rank: Top #${rank}`);
    const menu = buildRarityRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Prompt R2 Custom Rank
  if (data === 'prompt_r2_rank') {
    userPromptState.set(chatId, { action: 'awaiting_r2_rank' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
👑 <b>ENTER MAX RARITY RANK:</b>

Please type the maximum rarity rank number (e.g. <code>250</code> or <code>700</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_rarity' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Set R2 Multiplier Presets
  if (data.startsWith('set_r2_mult_')) {
    const mult = parseInt(data.replace('set_r2_mult_', ''), 10) / 100;
    botRuleConfig.rarity.multiplier = mult;
    const floor = parseFloat(activeCollectionStats?.floorEth) || 0;
    if (floor > 0) {
      botRuleConfig.rarity.maxEth = floor * mult;
    }
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `✅ Price Cap: ${mult}x Floor (${formatDisplayEth(botRuleConfig.rarity.maxEth)} ETH)`);
    const menu = buildRarityRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Prompt R2 Custom ETH Cap
  if (data === 'prompt_r2_eth') {
    userPromptState.set(chatId, { action: 'awaiting_r2_eth' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
👑 <b>ENTER MAX ETH FOR TOP RARITY:</b>

Please type the maximum ETH price cap for rarity snipes (e.g. <code>0.05</code> or <code>0.1</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_rarity' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // 8. Rule 3: Trait Menu
  if (data === 'menu_rule_trait') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildTraitRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Toggle Rule 3
  if (data === 'toggle_rule_trait') {
    botRuleConfig.ruleStates.trait = !botRuleConfig.ruleStates.trait;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, botRuleConfig.ruleStates.trait ? '🟢 Trait Hunter Active' : '⚪ Trait Hunter Paused');
    const menu = buildTraitRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Prompt R3 Add Trait
  if (data === 'prompt_r3_add_trait') {
    userPromptState.set(chatId, { action: 'awaiting_r3_trait' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
💎 <b>ADD TRAIT FILTER:</b>

Type the trait you want to hunt (e.g. <code>Background: Red</code> or <code>Eyes: Laser</code> or <code>Golden</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_trait' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Prompt R3 ETH Cap
  if (data === 'prompt_r3_eth') {
    userPromptState.set(chatId, { action: 'awaiting_r3_eth' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
💎 <b>ENTER MAX ETH CAP FOR TRAITS:</b>

Please type the maximum ETH price for trait snipes (e.g. <code>0.08</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_trait' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Action R3 Clear Traits
  if (data === 'action_r3_clear_traits') {
    botRuleConfig.trait.filters = [];
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🗑️ All trait filters cleared.');
    const menu = buildTraitRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 9. Rule 4: Token ID Menu
  if (data === 'menu_rule_token') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildTokenIdRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Toggle Rule 4
  if (data === 'toggle_rule_token') {
    botRuleConfig.ruleStates.tokenId = !botRuleConfig.ruleStates.tokenId;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, botRuleConfig.ruleStates.tokenId ? '🟢 Token ID Trap Active' : '⚪ Token ID Trap Paused');
    const menu = buildTokenIdRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Prompt R4 Token IDs
  if (data === 'prompt_r4_tokens') {
    userPromptState.set(chatId, { action: 'awaiting_r4_tokens' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
🎯 <b>ENTER TARGET TOKEN IDs:</b>

Type token IDs separated by commas (e.g. <code>7129, 8485, 1</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_token' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Prompt R4 ETH Cap
  if (data === 'prompt_r4_eth') {
    userPromptState.set(chatId, { action: 'awaiting_r4_eth' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
🎯 <b>ENTER MAX ETH CAP FOR TOKEN IDs:</b>

Please type the maximum ETH price (e.g. <code>0.1</code>):
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_rule_token' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Action R4 Clear Tokens
  if (data === 'action_r4_clear_tokens') {
    botRuleConfig.tokenId.tokens = [];
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🗑️ All token IDs cleared.');
    const menu = buildTokenIdRuleMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 10. Target Sub-Menu
  if (data === 'menu_target' || data === 'bot_set_target') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildTargetMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Set preset target
  if (data.startsWith('set_target_')) {
    const slug = data.replace('set_target_', '');
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `🔍 Scanning ${slug}...`);
    const stats = await executeScanForBot(slug);
    if (stats) {
      await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `✅ Target: ${stats.name}`);
    }
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Prompt custom target
  if (data === 'prompt_custom_target') {
    userPromptState.set(chatId, { action: 'awaiting_custom_target' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
✍️ <b>SEND TARGET COLLECTION:</b>

Please type the OpenSea URL or collection slug in your next message (e.g. <code>bulls-runners-genesis</code> or <code>rhmachines</code>).
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_main' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // 11. Gas Sub-Menu
  if (data === 'menu_gas') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildGasMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Set Gas
  if (data.startsWith('set_gas_')) {
    const preset = data.replace('set_gas_', '');
    botActiveGasPreset = preset;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `🚀 Gas set to: ${preset.toUpperCase()}`);
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 12. Wallets Sub-Menu
  if (data === 'menu_wallets') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = await buildWalletsMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 13. Stats / Telemetry
  if (data === 'menu_stats' || data === 'menu_refresh' || data === 'bot_refresh') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🔄 Refreshed');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 14. Back to Main Menu
  if (data === 'menu_main') {
    userPromptState.delete(chatId);
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 15. Help Guide
  if (data === 'menu_help') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const helpText = `
📖 <b>AERO-SNIPER TELEGRAM COMMAND GUIDE:</b>

<b>4 Sniping Strategies:</b>
• <b>1️⃣ Floor Trap:</b> Snipes underpriced fat-finger dumps by discount % or exact max ETH/USD.
• <b>2️⃣ Rarity Rank:</b> Snipes top ranked NFTs (e.g. Rank &lt;= #500) within ETH budget.
• <b>3️⃣ Rare Traits:</b> Snipes God traits / 1 of 1s (e.g. Laser eyes, Golden).
• <b>4️⃣ Token IDs:</b> Snipes specific grail token IDs (e.g. #7129, #8485).

<b>Direct Chat Commands:</b>
• <code>/start</code> — Open main dashboard
• <code>/rules</code> — Configure 4 sniper rules
• <code>/arm</code> — Arm sniper immediately (24/7)
• <code>/pause</code> — Pause sniper immediately
• <code>/clear</code> — Clear target & reset to standby
• <code>/price &lt;eth&gt;</code> — e.g. <code>/price 0.025</code>
• <code>/usd &lt;$&gt;</code> — e.g. <code>/usd 50</code>
• <code>/rank &lt;num&gt;</code> — e.g. <code>/rank 500</code>
• <code>/gas &lt;safe|turbo|surge|hyped&gt;</code>
• <code>/wallets</code> — Check fleet holdings

<i>💡 Or paste any OpenSea link in chat to scan & target it!</i>
`.trim();
    const keyboard = [[{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, helpText, keyboard);
  }
}

/**
 * 📩 HANDLE INCOMING TEXT MESSAGES & COMMANDS
 */
async function handleTextMessage(message) {
  const chatId = message.chat?.id;
  const text = message.text?.trim();
  if (!chatId || !text) return;

  // Auto-sync telegramChatId
  if (chatId) {
    dbGetUsers().then(users => {
      if (users && users.length > 0) {
        users[0].telegramChatId = String(chatId);
        dbUpdateUser(users[0].id, { telegram_chat_id: String(chatId) }).catch(() => {});
      }
    }).catch(() => {});
  }

  const prompt = userPromptState.get(chatId);

  // 1. Awaiting Custom Target
  if (prompt?.action === 'awaiting_custom_target') {
    userPromptState.delete(chatId);
    sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `🔍 Scanning <code>${text}</code> on OpenSea...`);
    const stats = await executeScanForBot(text);
    if (!stats) {
      const errText = `❌ Collection <code>${text}</code> not found on OpenSea. Please verify the slug.`;
      const keyboard = [[{ text: '🔙 Main Menu', callback_data: 'menu_main' }]];
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, errText, keyboard);
    }
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Target Set:</b> <code>${stats.name}</code>\nFloor: <b>${formatDisplayEth(stats.floorEth)} ETH</b>\n\n` + menu.text, menu.keyboard);
  }

  // 2. Awaiting R1 Custom ETH
  if (prompt?.action === 'awaiting_r1_eth') {
    userPromptState.delete(chatId);
    const ethVal = parseFloat(text);
    if (!isNaN(ethVal) && ethVal > 0) {
      botRuleConfig.floor.maxEth = ethVal;
      botRuleConfig.floor.maxUsd = ethVal * cachedEthPrice;
      botRuleConfig.ruleStates.floor = true;
      syncRulesToEngines();
      const menu = buildFloorRuleMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Floor Max Price Set:</b> <b>${formatDisplayEth(ethVal)} ETH</b> (~$${(ethVal * cachedEthPrice).toFixed(2)} USD)\n\n` + menu.text, menu.keyboard);
    }
  }

  // 3. Awaiting R1 Custom USD
  if (prompt?.action === 'awaiting_r1_usd') {
    userPromptState.delete(chatId);
    const usdVal = parseFloat(text.replace('$', ''));
    if (!isNaN(usdVal) && usdVal > 0) {
      botRuleConfig.floor.maxUsd = usdVal;
      botRuleConfig.floor.maxEth = usdVal / cachedEthPrice;
      botRuleConfig.ruleStates.floor = true;
      syncRulesToEngines();
      const menu = buildFloorRuleMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Floor Max Price Set:</b> <b>$${usdVal.toFixed(2)} USD</b> (~${formatDisplayEth(botRuleConfig.floor.maxEth)} ETH)\n\n` + menu.text, menu.keyboard);
    }
  }

  // 4. Awaiting R2 Custom Rank
  if (prompt?.action === 'awaiting_r2_rank') {
    userPromptState.delete(chatId);
    const rankVal = parseInt(text.replace('#', ''), 10);
    if (!isNaN(rankVal) && rankVal > 0) {
      botRuleConfig.rarity.maxRank = rankVal;
      botRuleConfig.ruleStates.rarity = true;
      syncRulesToEngines();
      const menu = buildRarityRuleMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Rarity Max Rank Set:</b> <b>Top #${rankVal}</b>\n\n` + menu.text, menu.keyboard);
    }
  }

  // 5. Awaiting R2 Custom ETH
  if (prompt?.action === 'awaiting_r2_eth') {
    userPromptState.delete(chatId);
    const ethVal = parseFloat(text);
    if (!isNaN(ethVal) && ethVal > 0) {
      botRuleConfig.rarity.maxEth = ethVal;
      botRuleConfig.ruleStates.rarity = true;
      syncRulesToEngines();
      const menu = buildRarityRuleMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Rarity Max ETH Cap Set:</b> <b>${formatDisplayEth(ethVal)} ETH</b>\n\n` + menu.text, menu.keyboard);
    }
  }

  // 6. Awaiting R3 Add Trait
  if (prompt?.action === 'awaiting_r3_trait') {
    userPromptState.delete(chatId);
    let traitType = '';
    let traitValue = text;
    if (text.includes(':')) {
      const parts = text.split(':');
      traitType = parts[0].trim();
      traitValue = parts.slice(1).join(':').trim();
    }
    botRuleConfig.trait.filters.push({ traitType, traitValue, maxEth: botRuleConfig.trait.maxEth });
    botRuleConfig.ruleStates.trait = true;
    syncRulesToEngines();
    const menu = buildTraitRuleMenu();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Trait Filter Added:</b> <code>${traitType ? traitType + ': ' : ''}${traitValue}</code>\n\n` + menu.text, menu.keyboard);
  }

  // 7. Awaiting R3 Trait ETH Cap
  if (prompt?.action === 'awaiting_r3_eth') {
    userPromptState.delete(chatId);
    const ethVal = parseFloat(text);
    if (!isNaN(ethVal) && ethVal > 0) {
      botRuleConfig.trait.maxEth = ethVal;
      botRuleConfig.trait.filters.forEach(f => { f.maxEth = ethVal; });
      botRuleConfig.ruleStates.trait = true;
      syncRulesToEngines();
      const menu = buildTraitRuleMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Trait Max Price Cap Set:</b> <b>${formatDisplayEth(ethVal)} ETH</b>\n\n` + menu.text, menu.keyboard);
    }
  }

  // 8. Awaiting R4 Token IDs
  if (prompt?.action === 'awaiting_r4_tokens') {
    userPromptState.delete(chatId);
    const rawTokens = text.split(/[, ]+/).map(t => t.replace('#', '').trim()).filter(t => t.length > 0);
    if (rawTokens.length > 0) {
      botRuleConfig.tokenId.tokens = rawTokens;
      botRuleConfig.ruleStates.tokenId = true;
      syncRulesToEngines();
      const menu = buildTokenIdRuleMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Targeted Token IDs Set:</b> <code>${rawTokens.map(t => '#' + t).join(', ')}</code>\n\n` + menu.text, menu.keyboard);
    }
  }

  // 9. Awaiting R4 Token ETH Cap
  if (prompt?.action === 'awaiting_r4_eth') {
    userPromptState.delete(chatId);
    const ethVal = parseFloat(text);
    if (!isNaN(ethVal) && ethVal > 0) {
      botRuleConfig.tokenId.maxEth = ethVal;
      botRuleConfig.ruleStates.tokenId = true;
      syncRulesToEngines();
      const menu = buildTokenIdRuleMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Token ID Max Price Cap Set:</b> <b>${formatDisplayEth(ethVal)} ETH</b>\n\n` + menu.text, menu.keyboard);
    }
  }

  // Standard Commands
  if (text.startsWith('/start') || text === '/menu') {
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  if (text === '/rules') {
    const menu = buildRulesHubMenu();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  if (text === '/clear' || text === '/reset') {
    clearBotTarget();
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '🗑️ <b>Target Cleared! Reset to Fresh Standby.</b>\n\n' + menu.text, menu.keyboard);
  }

  if (text === '/arm') {
    if (!activeCollectionStats?.slug) {
      const menu = buildTargetMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⚠️ <b>Please set a target collection before arming!</b>\n\n' + menu.text, menu.keyboard);
    }
    syncRulesToEngines();
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = true;
    }
    activeSniperEngine.isArmed = true;
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⚡ <b>SNIPER ARMED (24/7 Live Cloud Engine)!</b>\n\n' + menu.text, menu.keyboard);
  }

  if (text === '/pause' || text === '/disarm') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
    }
    activeSniperEngine.isArmed = false;
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⏸ <b>SNIPER PAUSED!</b>\n\n' + menu.text, menu.keyboard);
  }

  // /price <eth>
  if (text.startsWith('/price')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const val = parseFloat(parts[1]);
      if (!isNaN(val) && val > 0) {
        botRuleConfig.floor.maxEth = val;
        botRuleConfig.floor.maxUsd = val * cachedEthPrice;
        botRuleConfig.ruleStates.floor = true;
        syncRulesToEngines();
        const menu = buildFloorRuleMenu();
        return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Floor Max Price:</b> <b>${formatDisplayEth(val)} ETH</b>\n\n` + menu.text, menu.keyboard);
      }
    }
  }

  // /usd <usd>
  if (text.startsWith('/usd')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const val = parseFloat(parts[1].replace('$', ''));
      if (!isNaN(val) && val > 0) {
        botRuleConfig.floor.maxUsd = val;
        botRuleConfig.floor.maxEth = val / cachedEthPrice;
        botRuleConfig.ruleStates.floor = true;
        syncRulesToEngines();
        const menu = buildFloorRuleMenu();
        return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Floor Max Price:</b> <b>$${val.toFixed(2)} USD</b> (${formatDisplayEth(botRuleConfig.floor.maxEth)} ETH)\n\n` + menu.text, menu.keyboard);
      }
    }
  }

  // /rank <rank>
  if (text.startsWith('/rank')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const val = parseInt(parts[1].replace('#', ''), 10);
      if (!isNaN(val) && val > 0) {
        botRuleConfig.rarity.maxRank = val;
        botRuleConfig.ruleStates.rarity = true;
        syncRulesToEngines();
        const menu = buildRarityRuleMenu();
        return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Rarity Max Rank:</b> <b>Top #${val}</b>\n\n` + menu.text, menu.keyboard);
      }
    }
  }

  // /target <slug>
  if (text.startsWith('/target')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const slugInput = parts.slice(1).join(' ').trim();
      sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `🔍 Scanning <code>${slugInput}</code> on OpenSea...`);
      const stats = await executeScanForBot(slugInput);
      if (!stats) {
        return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `❌ Could not find collection <code>${slugInput}</code> on OpenSea.`);
      }
      const menu = buildMainMenu(chatId);
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Target Changed to:</b> <code>${stats.name}</code>\nFloor: <b>${formatDisplayEth(stats.floorEth)} ETH</b>\n\n` + menu.text, menu.keyboard);
    } else {
      const menu = buildTargetMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
    }
  }

  // /wallets
  if (text === '/wallets') {
    const menu = await buildWalletsMenu();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  // Direct OpenSea link or slug detection
  if (text.includes('opensea.io/') || /^[a-zA-Z0-9_-]{3,40}$/.test(text)) {
    sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `🔍 Detected collection <code>${text}</code>. Scanning OpenSea...`);
    const stats = await executeScanForBot(text);
    if (stats) {
      const isArmed = activeSniperEngine.isArmed;
      const floorEth = stats.floorEth || 0;
      const floorDisp = formatDisplayEth(floorEth);
      const usdFloor = (floorEth * cachedEthPrice).toFixed(2);
      const targetEth = formatDisplayEth(botRuleConfig.floor.maxEth > 0 ? botRuleConfig.floor.maxEth : floorEth * 0.8);

      const previewText = `
🎯 <b>COLLECTION SCANNED & TARGETED!</b>

🏷️ <b>Name:</b> <b>${stats.name}</b>
💎 <b>Floor Price:</b> <b>${floorDisp} ETH</b> (~$${usdFloor} USD)
🎯 <b>Floor Snipe Trigger:</b> <b>&lt; ${targetEth} ETH</b>
📦 <b>Total Supply:</b> <b>${stats.totalSupply} NFTs</b>
🛡️ <b>Engine:</b> ${isArmed ? '🟢 <b>ARMED (Ready to Snipe)</b>' : '🔴 <b>DISARMED / STANDBY</b>'}

<i>Tap below to Arm, configure rules, or clear:</i>
`.trim();

      const keyboard = [
        [
          isArmed
            ? { text: '⏸ Pause Sniper', callback_data: 'action_pause' }
            : { text: '⚡ ARM SNIPER ON THIS COLLECTION', callback_data: 'action_arm' }
        ],
        [
          { text: '⚙️ Configure 4 Rules', callback_data: 'menu_rules_hub' },
          { text: '🗑️ Clear Target', callback_data: 'action_clear_target' }
        ],
        [
          { text: '🏠 Main Dashboard', callback_data: 'menu_main' }
        ]
      ];

      return sendTelegramPhoto(TELEGRAM_BOT_TOKEN, chatId, stats.imageUrl, previewText, keyboard);
    }
  }

  // Default fallback
  const menu = buildMainMenu(chatId);
  return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
}

/**
 * 🔄 LONG-POLLING DAEMON: Listens for incoming Telegram commands & button taps
 */
export async function startTelegramBotPolling() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[TELEGRAM] ℹ️ No TELEGRAM_BOT_TOKEN configured. Polling inactive.');
    return;
  }
  if (isPollingActive) return;
  isPollingActive = true;

  console.log('🤖 [TELEGRAM] Institutional Interactive Terminal & Remote Controller Online.');

  const pollLoop = async () => {
    while (isPollingActive) {
      try {
        const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, {
          params: { offset: lastUpdateId + 1, timeout: 20 },
          timeout: 25000
        });

        if (res.data?.ok && Array.isArray(res.data.result)) {
          for (const update of res.data.result) {
            lastUpdateId = update.update_id;

            // 1. Handle Button Taps (Callback Queries)
            if (update.callback_query) {
              handleCallbackQuery(update.callback_query).catch(err => {
                console.warn('[TELEGRAM CALLBACK ERR]', err.message);
              });
            }

            // 2. Handle Text Messages & Commands
            if (update.message) {
              handleTextMessage(update.message).catch(err => {
                console.warn('[TELEGRAM MESSAGE ERR]', err.message);
              });
            }
          }
        }
      } catch (err) {
        // Silent backoff on network hiccups
        await new Promise(r => setTimeout(r, 4000));
      }
    }
  };

  pollLoop().catch(() => {});
}

