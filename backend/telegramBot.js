import axios from 'axios';
import { ethers } from 'ethers';
import {
  activeSniperEngine,
  activeSniperEngines,
  activeCollectionStats,
  setActiveCollectionStats,
  cachedEthPrice,
  userLogBuffers
} from './state.js';
import { fetchOpenSeaWithFallback, formatEthPrecise } from './openSeaClient.js';
import { subscribeSlugToOpenSea } from './routes/stream.js';
import { resolveClosestCollectionSlug } from './routes/scan.js';
import { armEngineForUser, sweepAndSnipeActiveListings } from './routes/sniper.js';
import { 
  dbGetUserByEmail, 
  dbGetUsers, 
  dbUpdateUser, 
  dbGetUserConfig, 
  dbSaveUserConfig, 
  dbGetUserById, 
  SUPABASE_URL, 
  supabaseHeaders, 
  OWNER_EMAIL 
} from './db.js';

// Environment Bindings
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8849256750:AAGL6tEK_2tatSxgS-RjWp2ngE7B6lh29RI';
export const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '1683360811';
export const ADMIN_UPDATE_BOT_TOKEN = process.env.TELEGRAM_FEED_BOT_TOKEN || '8890886636:AAFHz6T-Yxc_1EqjTggZcg2HpepYvNC7tvY';
export const TELEGRAM_FEED_CHANNEL_ID = process.env.TELEGRAM_FEED_CHANNEL_ID || null;
export const adminRegisteredChatIds = new Set([TELEGRAM_ADMIN_CHAT_ID]);
const WEBAPP_URL = process.env.RENDER_EXTERNAL_URL || 'https://aero-sniper.onrender.com';

let lastUpdateId = 0;
let isPollingActive = false;

// Default Universal Settings
let botActiveDiscountPercent = 20;
let botActiveGasPreset = 'turbo';
let botPaperSnipeMode = false;

// In-memory cache for user authorization to make button interactions instantaneous (<1ms)
const userChatAuthCache = new Map(); // chatId -> { data, expiresAt }
const AUTH_CACHE_TTL_MS = 30000; // 30 seconds

export function invalidateChatAuthCache(chatId = null) {
  if (chatId) {
    userChatAuthCache.delete(String(chatId));
  } else {
    userChatAuthCache.clear();
  }
}

/**
 * 🔒 GET LINKED USER & CLOUD CONFIG FOR TELEGRAM CHAT ID (Cached for ultra-fast UI)
 */
export async function getLinkedUserForChat(chatId) {
  if (!chatId) return null;
  const strId = String(chatId);

  // 1. Check in-memory cache
  const cached = userChatAuthCache.get(strId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  try {
    // 2. Search sniper_user_configs for matching telegram_chat_id
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>telegram_chat_id=eq.${encodeURIComponent(strId)}`, {
      headers: supabaseHeaders,
      timeout: 5000
    });

    if (res.data && res.data.length > 0) {
      const userId = res.data[0].user_id;
      const config = res.data[0].config || {};
      const user = await dbGetUserById(userId);

      if (user) {
        const isOwner = user.email?.toLowerCase() === OWNER_EMAIL || user.role === 'admin';
        const isBanned = !!user.is_banned;
        let isExpired = false;
        if (!isOwner && user.valid_until) {
          isExpired = new Date(user.valid_until) < new Date();
        }
        const authData = { user, config, isOwner, isBanned, isExpired };
        userChatAuthCache.set(strId, { data: authData, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
        return authData;
      }
    }

    userChatAuthCache.set(strId, { data: null, expiresAt: Date.now() + 10000 });
    return null;
  } catch (e) {
    console.error('[TELEGRAM AUTH CHECK ERROR]:', e.message);
    return null;
  }
}

/**
 * 🔑 VERIFY & BIND ONE-TIME LINK TOKEN (BURN-AFTER-READING & SINGLE ACCOUNT LOCK)
 */
export async function verifyAndLinkTelegramToken(chatId, rawToken, senderInfo = {}) {
  if (!chatId || !rawToken) {
    return { success: false, error: 'Empty token input.' };
  }

  // Robust extraction: supports /start AERO-TG-XXXX-XXXX-XXXX or direct token
  const match = rawToken.match(/AERO[-_]TG[-_][A-Z0-9]{4}[-_][A-Z0-9]{4}[-_][A-Z0-9]{4}/i) || 
                rawToken.match(/AERO[-_]TG[-_][A-Z0-9_-]+/i) ||
                rawToken.match(/TG[-_][A-Z0-9_-]+/i);
  const cleanToken = match ? match[0].toUpperCase().replace(/_/g, '-') : rawToken.toUpperCase().replace('/START', '').replace(/\s+/g, '').trim();

  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>telegram_link_token=eq.${encodeURIComponent(cleanToken)}`, {
      headers: supabaseHeaders,
      timeout: 6000
    });

    if (!res.data || res.data.length === 0) {
      return { success: false, error: '❌ <b>Invalid or Already Used Link Token.</b>\nEach secret token can only be redeemed once to lock an account to Telegram.' };
    }

    const userId = res.data[0].user_id;
    const config = res.data[0].config || {};
    const user = await dbGetUserById(userId);

    if (!user) {
      return { success: false, error: '❌ Associated user account not found.' };
    }

    // Check subscription validity
    const isOwner = user.email?.toLowerCase() === OWNER_EMAIL || user.role === 'admin';
    if (!isOwner && user.valid_until && new Date(user.valid_until) < new Date()) {
      return { success: false, error: '⚠️ <b>Subscription Expired.</b>\nYour VIP access has ended. Please renew your plan on the website.' };
    }

    // 🔥 INSTANT TOKEN BURN (Single-Use Destruction & Account Locking)
    delete config.telegram_link_token;
    delete config.telegram_token_expires_at;
    config.telegram_chat_id = String(chatId);
    config.telegram_username = senderInfo.username || '';
    config.telegram_first_name = senderInfo.first_name || '';
    config.telegram_linked_at = new Date().toISOString();

    await dbSaveUserConfig(userId, config, true);
    await dbUpdateUser(userId, { telegram_chat_id: String(chatId) }).catch(() => {});

    // Invalidate auth cache so newly linked chat is immediately recognized
    invalidateChatAuthCache(chatId);

    // Sync to memory engine
    syncRulesToEngines();

    return { success: true, user, config };
  } catch (err) {
    return { success: false, error: '❌ Server verification error: ' + err.message };
  }
}

/**
 * 🔒 BUILD UNLINKED GATEKEEPER SCREEN
 */
export function buildUnlinkedGatekeeperMenu() {
  const text = `
🔒 <b>AERO-SNIPER VIP • ACCESS RESTRICTED</b> 🔒
<i>Institutional High-Frequency NFT Sniping Protocol</i>

━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>Access Denied: Telegram Account Not Linked</b>

This Telegram terminal is exclusively reserved for active <b>Aero-Sniper Pro</b> subscribers.

<b>How to Connect Your Account:</b>
1️⃣ Log in to your dashboard: <a href="${WEBAPP_URL}">${WEBAPP_URL.replace('https://', '')}</a>
2️⃣ Click <b>[ 📱 Telegram Sync ]</b> in the top navbar.
3️⃣ Tap <b>"1-Click Open in Telegram"</b> or copy your <b>Secret Link Token</b> and send it into this chat.

━━━━━━━━━━━━━━━━━━━━━
🛡️ <i>Your token is private, one-time use, and burns immediately upon connection.</i>
`.trim();

  const keyboard = [
    [
      { text: '❓ How to Connect Account', callback_data: 'gate_help' }
    ]
  ];

  return { text, keyboard };
}

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
 * 🗑️ CLEAR ACTIVE TARGET & PURGE SESSION LOGS (Strictly User-Isolated)
 */
export async function clearBotTarget(chatId = null) {
  let targetUserId = null;
  if (chatId) {
    const authInfo = await getLinkedUserForChat(chatId);
    if (authInfo?.user?.id) {
      targetUserId = String(authInfo.user.id);
    }
  }

  if (targetUserId) {
    if (activeSniperEngines.has(targetUserId)) {
      const engine = activeSniperEngines.get(targetUserId);
      engine.slug = null;
      engine.contractAddress = null;
      engine.isArmed = false;
      engine.maxFloorEth = 0;
      if (engine.snipedTokenIds) engine.snipedTokenIds.clear();
      if (engine.pendingSnipes) engine.pendingSnipes.clear();
      activeSniperEngines.delete(targetUserId);
    }
    userLogBuffers.delete(targetUserId);
    console.log(`🗑️ [TELEGRAM] User [${targetUserId}] target and session logs cleared.`);
  } else {
    activeSniperEngine.slug = null;
    activeSniperEngine.contractAddress = null;
    activeSniperEngine.isArmed = false;
    activeSniperEngine.maxFloorEth = 0;
    console.log('🗑️ [TELEGRAM] Global active sniper target cleared. Reset to Standby.');
  }
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
  const tokenSet = new Set((botRuleConfig.tokenId.tokens || []).map(t => String(t).replace(/[^0-9]/g, '')).filter(Boolean));

  let floorCap = botRuleConfig.floor.maxEth;
  if (floorCap === 0 && activeCollectionStats?.floorEth > 0) {
    floorCap = activeCollectionStats.floorEth * (1 - (botRuleConfig.floor.discountPercent || 20) / 100);
  }

  for (const [k, engine] of activeSniperEngines.entries()) {
    if (targetSlug) engine.slug = targetSlug;
    if (targetContract) engine.contractAddress = targetContract;
    engine.ruleStates = { ...botRuleConfig.ruleStates };
    engine.discountPercent = botRuleConfig.floor.discountPercent || 20;
    engine.maxFloorEth = floorCap;
    engine.baseFloorEth = activeCollectionStats?.floorEth || 0;
    engine.maxRareRank = botRuleConfig.rarity.maxRank;
    engine.maxRareEth = botRuleConfig.rarity.maxEth;
    engine.traitFilters = [...botRuleConfig.trait.filters];
    engine.traitMaxEth = botRuleConfig.trait.maxEth;
    engine.specificTokenIds = tokenSet;
    engine.specificTokenMaxEth = botRuleConfig.tokenId.maxEth;
    engine.gasSpeed = botActiveGasPreset;
    engine.isDryRun = botPaperSnipeMode;
    engine.dryRun = botPaperSnipeMode;
  }

  if (targetSlug) activeSniperEngine.slug = targetSlug;
  if (targetContract) activeSniperEngine.contractAddress = targetContract;
  activeSniperEngine.ruleStates = { ...botRuleConfig.ruleStates };
  activeSniperEngine.discountPercent = botRuleConfig.floor.discountPercent || 20;
  activeSniperEngine.maxFloorEth = floorCap;
  activeSniperEngine.baseFloorEth = activeCollectionStats?.floorEth || 0;
  activeSniperEngine.maxRareRank = botRuleConfig.rarity.maxRank;
  activeSniperEngine.maxRareEth = botRuleConfig.rarity.maxEth;
  activeSniperEngine.traitFilters = [...botRuleConfig.trait.filters];
  activeSniperEngine.traitMaxEth = botRuleConfig.trait.maxEth;
  activeSniperEngine.specificTokenIds = tokenSet;
  activeSniperEngine.specificTokenMaxEth = botRuleConfig.tokenId.maxEth;
  activeSniperEngine.gasSpeed = botActiveGasPreset;
  activeSniperEngine.isDryRun = botPaperSnipeMode;
  activeSniperEngine.dryRun = botPaperSnipeMode;
}

/**
 * 🎨 1. MAIN DASHBOARD MENU (Hub)
 */
/**
 * 🎨 1. MAIN DASHBOARD MENU (Hub with Gatekeeper Protection)
 */
export async function buildMainMenu(chatId = null) {
  const authInfo = await getLinkedUserForChat(chatId);
  if (!authInfo || authInfo.isBanned) {
    return buildUnlinkedGatekeeperMenu();
  }

  const { user, config, isOwner, isExpired } = authInfo;
  if (isExpired) {
    const expiredText = `
⚠️ <b>VIP SUBSCRIPTION EXPIRED</b> ⚠️

👤 <b>Account:</b> <code>${user.email}</code>
⏳ <b>Status:</b> <b>Access Ended</b>

Please log in to <a href="${WEBAPP_URL}">Aero-Sniper Dashboard</a> and top up your plan.
`.trim();
    const keyboard = [[{ text: '❓ How to Renew', callback_data: 'gate_help' }]];
    return { text: expiredText, keyboard };
  }

  const wallets = config.walletFleet || config.wallets || [];
  const userEngine = user?.id ? (activeSniperEngines.get(user.id) || activeSniperEngines.get(String(user.id))) : null;
  const isArmed = userEngine ? userEngine.isArmed : (activeSniperEngine ? activeSniperEngine.isArmed : false);
  const stats = activeCollectionStats;
  const currentSlug = userEngine?.slug || stats?.name || stats?.slug || 'Standby (No Target)';
  const floorEthDisp = formatDisplayEth(stats?.floorEth || 0);
  const usdFloor = ((stats?.floorEth || 0) * cachedEthPrice).toFixed(2);

  // Compact rule badges
  const r1Badge = botRuleConfig.ruleStates.floor ? '🟢' : '⚪';
  const r2Badge = botRuleConfig.ruleStates.rarity ? '🟢' : '⚪';
  const r3Badge = botRuleConfig.ruleStates.trait ? '🟢' : '⚪';
  const r4Badge = botRuleConfig.ruleStates.tokenId ? '🟢' : '⚪';

  const text = `
⚡ <b>AERO-SNIPER PRO</b>
━━━━━━━━━━━━━━━━━━━━
🎯 <b>Target:</b> <code>${currentSlug}</code>
💎 <b>Floor:</b> <b>${floorEthDisp} ETH</b> (~$${usdFloor})
🛡️ <b>Engine:</b> ${isArmed ? '🟢 <b>ARMED (24/7)</b>' : '🔴 <b>STANDBY</b>'} • ${botPaperSnipeMode ? '🧪 <i>Paper</i>' : '⚡ <i>Real</i>'}
💼 <b>Fleet:</b> <b>${wallets.length} Wallets</b> • 🚀 <b>Gas:</b> <b>${botActiveGasPreset.toUpperCase()}</b>

⚙️ <b>Rules:</b> Floor [${r1Badge}] • Rank [${r2Badge}] • Trait [${r3Badge}] • ID [${r4Badge}]
`.trim();

  const keyboard = [
    [
      isArmed
        ? { text: '⏸ Pause Sniper', callback_data: 'action_pause' }
        : { text: '⚡ ARM SNIPER (24/7)', callback_data: 'action_arm' }
    ],
    [
      { text: '🎯 Target', callback_data: 'menu_target' },
      { text: '⚙️ Rules Hub', callback_data: 'menu_rules_hub' }
    ],
    [
      { text: `👛 Wallets (${wallets.length})`, callback_data: 'menu_wallets' },
      { text: `🚀 Gas: ${botActiveGasPreset.toUpperCase()}`, callback_data: 'menu_gas' }
    ],
    [
      { text: botPaperSnipeMode ? '🧪 Mode: Paper' : '⚡ Mode: Real', callback_data: 'action_toggle_sim' },
      { text: '🔄 Refresh', callback_data: 'menu_refresh' }
    ]
  ];

  return { text, keyboard };
}

/**
 * ⚙️ 2. RULES HUB MENU (Overview of all 4 strategies)
 */
export function buildRulesHubMenu() {
  const floorEth = parseFloat(activeCollectionStats?.floorEth) || 0;
  const floorDisp = formatDisplayEth(floorEth);

  const r1 = botRuleConfig.ruleStates.floor ? '🟢 ON' : '⚪ OFF';
  const r2 = botRuleConfig.ruleStates.rarity ? '🟢 ON' : '⚪ OFF';
  const r3 = botRuleConfig.ruleStates.trait ? '🟢 ON' : '⚪ OFF';
  const r4 = botRuleConfig.ruleStates.tokenId ? '🟢 ON' : '⚪ OFF';

  const r1Val = botRuleConfig.floor.maxEth > 0 ? `${formatDisplayEth(botRuleConfig.floor.maxEth)} ETH` : `-${botRuleConfig.floor.discountPercent}%`;
  const r2Val = `Top #${botRuleConfig.rarity.maxRank}`;
  const r3Val = `${botRuleConfig.trait.filters.length} traits`;
  const r4Val = `${botRuleConfig.tokenId.tokens.length} IDs`;

  const text = `
⚙️ <b>SNIPER RULES HUB</b>
━━━━━━━━━━━━━━━━━━━━
💎 <b>Floor:</b> <b>${floorDisp} ETH</b> (~$${(floorEth * cachedEthPrice).toFixed(2)})

1️⃣ <b>Floor Trap:</b> [${r1}] ➔ <code>${r1Val}</code>
2️⃣ <b>Rarity Rank:</b> [${r2}] ➔ <code>${r2Val}</code>
3️⃣ <b>Rare Traits:</b> [${r3}] ➔ <code>${r3Val}</code>
4️⃣ <b>Token IDs:</b> [${r4}] ➔ <code>${r4Val}</code>
`.trim();

  const keyboard = [
    [
      { text: `1️⃣ Floor [${r1}]`, callback_data: 'menu_rule_floor' },
      { text: `2️⃣ Rarity [${r2}]`, callback_data: 'menu_rule_rarity' }
    ],
    [
      { text: `3️⃣ Traits [${r3}]`, callback_data: 'menu_rule_trait' },
      { text: `4️⃣ Token IDs [${r4}]`, callback_data: 'menu_rule_token' }
    ],
    [
      { text: '🔙 Back to Dashboard', callback_data: 'menu_main' }
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
1️⃣ <b>FLOOR UNDERPRICE TRAP</b> [${state}]
━━━━━━━━━━━━━━━━━━━━
💎 <b>Floor:</b> <b>${formatDisplayEth(floorEth)} ETH</b> (~$${(floorEth * cachedEthPrice).toFixed(2)})
🎯 <b>Max Buy Cap:</b> <b>${formatDisplayEth(maxEth)} ETH</b> (~$${maxUsd.toFixed(2)})
📉 <b>Discount Mode:</b> <b>-${botRuleConfig.floor.discountPercent}% Below Floor</b>
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.floor ? '⏸ Pause Floor Rule' : '▶️ Activate Floor Rule', callback_data: 'toggle_rule_floor' }
    ],
    [
      { text: '-10%', callback_data: 'set_r1_pct_10' },
      { text: '-20%', callback_data: 'set_r1_pct_20' },
      { text: '-30%', callback_data: 'set_r1_pct_30' },
      { text: '-50%', callback_data: 'set_r1_pct_50' }
    ],
    [
      { text: '✏️ Set ETH Cap', callback_data: 'prompt_r1_eth' },
      { text: '💵 Set USD Cap', callback_data: 'prompt_r1_usd' }
    ],
    [
      { text: '🔙 Back to Rules', callback_data: 'menu_rules_hub' }
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
2️⃣ <b>TOP RARITY RANK SNIPE</b> [${state}]
━━━━━━━━━━━━━━━━━━━━
👑 <b>Target Rank:</b> <b>Rank &lt;= #${botRuleConfig.rarity.maxRank}</b>
💰 <b>Max Buy Cap:</b> <b>${formatDisplayEth(maxEth)} ETH</b> (~$${maxUsd.toFixed(2)})
📊 <b>Multiplier:</b> <b>${botRuleConfig.rarity.multiplier}x Floor</b>
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.rarity ? '⏸ Pause Rarity Rule' : '▶️ Activate Rarity Rule', callback_data: 'toggle_rule_rarity' }
    ],
    [
      { text: 'Top #100', callback_data: 'set_r2_rank_100' },
      { text: 'Top #500', callback_data: 'set_r2_rank_500' },
      { text: 'Top #1200', callback_data: 'set_r2_rank_1200' },
      { text: '✏️ Rank', callback_data: 'prompt_r2_rank' }
    ],
    [
      { text: '1.0x', callback_data: 'set_r2_mult_100' },
      { text: '1.25x', callback_data: 'set_r2_mult_125' },
      { text: '1.50x', callback_data: 'set_r2_mult_150' },
      { text: '✏️ ETH Cap', callback_data: 'prompt_r2_eth' }
    ],
    [
      { text: '🔙 Back to Rules', callback_data: 'menu_rules_hub' }
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
    ? botRuleConfig.trait.filters.map((f, i) => `• <code>${f.traitType ? f.traitType + ': ' : ''}${f.traitValue}</code>`).join('\n')
    : '<i>No trait filters added yet.</i>';

  const text = `
3️⃣ <b>RARE TRAIT HUNTER</b> [${state}]
━━━━━━━━━━━━━━━━━━━━
💰 <b>Max Cap:</b> <b>${formatDisplayEth(botRuleConfig.trait.maxEth)} ETH</b> (~$${(botRuleConfig.trait.maxEth * cachedEthPrice).toFixed(2)})

<b>Active Targeted Traits:</b>
${traitsList}
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.trait ? '⏸ Pause Trait Rule' : '▶️ Activate Trait Rule', callback_data: 'toggle_rule_trait' }
    ],
    [
      { text: '➕ Add Trait', callback_data: 'prompt_r3_add_trait' },
      { text: '💰 Max ETH Cap', callback_data: 'prompt_r3_eth' }
    ],
    [
      { text: '🗑️ Clear Traits', callback_data: 'action_r3_clear_traits' },
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
    : 'None';

  const text = `
4️⃣ <b>TARGET TOKEN ID TRAP</b> [${state}]
━━━━━━━━━━━━━━━━━━━━
💰 <b>Max Cap:</b> <b>${formatDisplayEth(botRuleConfig.tokenId.maxEth)} ETH</b> (~$${(botRuleConfig.tokenId.maxEth * cachedEthPrice).toFixed(2)})
🎯 <b>Targeted IDs:</b> <code>${tokensList}</code>
`.trim();

  const keyboard = [
    [
      { text: botRuleConfig.ruleStates.tokenId ? '⏸ Pause Token Rule' : '▶️ Activate Token Rule', callback_data: 'toggle_rule_token' }
    ],
    [
      { text: '🎯 Enter Token IDs', callback_data: 'prompt_r4_tokens' },
      { text: '💰 Max ETH Cap', callback_data: 'prompt_r4_eth' }
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
  const currentSlug = activeCollectionStats?.name || activeCollectionStats?.slug || 'Standby (No Target)';
  const text = `
🎯 <b>TARGET COLLECTION</b>
━━━━━━━━━━━━━━━━━━━━
Current: <code>${currentSlug}</code>
`.trim();

  const keyboard = [
    [
      { text: '✍️ Custom Slug or URL', callback_data: 'prompt_custom_target' }
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
      { text: '🗑️ Clear Target', callback_data: 'action_clear_target' },
      { text: '🔙 Dashboard', callback_data: 'menu_main' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 🚀 BUILD GAS PRESET MENU
 */
export function buildGasMenu() {
  const text = `
🚀 <b>GAS SPEED SELECTOR</b>
━━━━━━━━━━━━━━━━━━━━
Current Preset: <b>${botActiveGasPreset.toUpperCase()}</b>
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
      { text: '🔙 Back to Dashboard', callback_data: 'menu_main' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 👛 BUILD WALLETS FLEET STATUS MENU
 */
/**
 * ⚡ Fetch On-Chain Live Balance with Multi-RPC Failover
 */
async function fetchWalletOnChainBalance(address) {
  if (!address || !address.startsWith('0x')) return '0';
  const rpcEndpoints = [
    'https://rpc.mainnet.chain.robinhood.com',
    'https://robinhood-mainnet.g.alchemy.com/v2/alch_FtrEfyyJYzEBZ0SQ3ctbJ'
  ];

  for (const rpc of rpcEndpoints) {
    try {
      const res = await axios.post(rpc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest']
      }, { timeout: 4000 });
      if (res.data?.result) {
        return ethers.formatEther(BigInt(res.data.result));
      }
    } catch (e) {}
  }
  return '0';
}

/**
 * 👛 BUILD WALLETS FLEET STATUS MENU
 */
export async function buildWalletsMenu(chatId = null) {
  const authInfo = await getLinkedUserForChat(chatId);
  if (!authInfo) return buildUnlinkedGatekeeperMenu();

  const { user, config } = authInfo;
  const wallets = config.walletFleet || config.wallets || [];
  const masterWallet = wallets.find(w => w.role === 'master' || w.name?.includes('Master')) || wallets[0];

  // Live RPC Balance refresh from Robinhood Chain in parallel across all fleet wallets
  if (wallets.length > 0) {
    await Promise.all(wallets.map(async (w) => {
      try {
        if (w.address && w.address.startsWith('0x')) {
          w.balance = await fetchWalletOnChainBalance(w.address);
        }
      } catch (e) {}
    }));
  }

  let totalEth = 0;
  let activeCount = 0;
  wallets.forEach(w => {
    totalEth += parseFloat(w.balance || 0);
    if (w.selected !== false) activeCount++;
  });
  const totalUsd = (totalEth * cachedEthPrice).toFixed(2);

  let walletLines = '';
  if (wallets.length === 0) {
    walletLines = '<i>No wallets configured yet. Add wallets below.</i>';
  } else {
    walletLines = wallets.slice(0, 10).map((w, idx) => {
      const shortAddr = w.address ? `${w.address.slice(0, 6)}...${w.address.slice(-4)}` : '0x...';
      const isMaster = w.role === 'master' || w.name?.includes('Master') || idx === 0;
      const roleTag = isMaster ? '👑 Master' : `⚡ Worker #${idx + 1}`;
      const bal = formatDisplayEth(w.balance || 0);
      const usdVal = (parseFloat(w.balance || 0) * cachedEthPrice).toFixed(2);
      const isSelected = w.selected !== false;
      const statusIcon = isSelected ? '🟢' : '⚪';
      return `• <b>${roleTag}:</b> <code>${shortAddr}</code>\n   ${bal} ETH (~$${usdVal}) [${statusIcon}]`;
    }).join('\n');
    if (wallets.length > 10) {
      walletLines += `\n<i>+ ${wallets.length - 10} more sub-wallets</i>`;
    }
  }

  const text = `
👛 <b>WALLET FLEET STATUS</b>
━━━━━━━━━━━━━━━━━━━━
💰 <b>Total Value:</b> <b>${formatDisplayEth(totalEth)} ETH</b> (~$${totalUsd})
👥 <b>Fleet:</b> <b>${activeCount}/${wallets.length} active</b>

${walletLines}
`.trim();

  // Generate 2-per-row toggle buttons for each wallet
  const walletToggleButtons = [];
  for (let i = 0; i < wallets.length; i += 2) {
    const row = [];
    const w1 = wallets[i];
    const isSel1 = w1.selected !== false;
    const u1 = (parseFloat(w1.balance || 0) * cachedEthPrice).toFixed(2);
    row.push({
      text: `${isSel1 ? '🟢' : '⚪'} #${i + 1} ($${u1})`,
      callback_data: `toggle_wallet_${i}`
    });

    if (i + 1 < wallets.length) {
      const w2 = wallets[i + 1];
      const isSel2 = w2.selected !== false;
      const u2 = (parseFloat(w2.balance || 0) * cachedEthPrice).toFixed(2);
      row.push({
        text: `${isSel2 ? '🟢' : '⚪'} #${i + 2} ($${u2})`,
        callback_data: `toggle_wallet_${i + 1}`
      });
    }
    walletToggleButtons.push(row);
  }

  const keyboard = [
    ...walletToggleButtons,
    [
      { text: '⚡ Select All', callback_data: 'wallets_select_all' },
      { text: '⚪ Unselect All', callback_data: 'wallets_unselect_all' }
    ],
    [
      { text: '➕ Import Key', callback_data: 'prompt_add_wallet' },
      { text: '⚡ +5 Workers', callback_data: 'action_generate_workers' }
    ],
    [
      { text: '🔄 Refresh', callback_data: 'menu_wallets' },
      { text: '🔙 Dashboard', callback_data: 'menu_main' }
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
 * 🖼️ Send Telegram Photo with Caption (Instant text fallback if invalid URL)
 */
export async function sendTelegramPhoto(token, chatId, photoUrl, caption, inlineKeyboard = null) {
  if (!token || !chatId) return false;

  // Instant fallback to text message if photoUrl is invalid or non-HTTP
  if (!photoUrl || typeof photoUrl !== 'string' || (!photoUrl.startsWith('http://') && !photoUrl.startsWith('https://'))) {
    return sendTelegramMessage(token, chatId, caption, inlineKeyboard);
  }

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
    await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, payload, { timeout: 6000 });
    return true;
  } catch (err) {
    return sendTelegramMessage(token, chatId, caption, inlineKeyboard);
  }
}

/**
 * 🎯 1. PRIVATE SNIPE ALERT (Sent to the specific user's Telegram)
 */
export async function dispatchPrivateSnipeAlert(userEngine, snipeData) {
  const token = TELEGRAM_BOT_TOKEN;
  let chatId = userEngine?.telegramChatId || userEngine?.chatId;

  if (!chatId && userEngine?.userId) {
    try {
      const uConfig = await dbGetUserConfig(userEngine.userId);
      if (uConfig?.telegram_chat_id) {
        chatId = uConfig.telegram_chat_id;
        userEngine.telegramChatId = chatId;
      }
    } catch (_) {}
  }

  if (!token || !chatId) return;

  const isSim = !!snipeData.isDryRun;
  const modeBadge = isSim ? '🧪 <b>PAPER SNIPE SIMULATED</b>' : '⚡ <b>LIVE ON-CHAIN SNIPE CONFIRMED!</b>';
  const tokenName = snipeData.name || `#${snipeData.tokenId}`;
  const priceEth = formatDisplayEth(snipeData.price || 0);
  const usdPrice = (parseFloat(snipeData.price || 0) * cachedEthPrice).toFixed(2);
  const floorDisp = formatDisplayEth(snipeData.floorEth || 0);
  const txHash = snipeData.txHash || '';
  const txShort = txHash.length > 18 ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : txHash;
  const blockNum = snipeData.blockNumber ? `#${snipeData.blockNumber}` : 'Mined';
  const explorerUrl = `https://explorer.mainnet.robinhood.com/tx/${txHash}`;
  const openseaUrl = `https://opensea.io/assets/robinhood/${snipeData.contractAddress || ''}/${snipeData.tokenId}`;

  const caption = `
🏆 ${modeBadge}

🎯 <b>Token:</b> <code>${tokenName}</code>
🏷️ <b>Collection:</b> <code>${snipeData.collectionName || userEngine?.slug || 'Collection'}</code>
💎 <b>Market Floor:</b> <b>${floorDisp} ETH</b>
💰 <b>Price Bought:</b> <b>${priceEth} ETH</b> (~$${usdPrice} USD)
📉 <b>Advantage:</b> <b>${snipeData.discountStr || 'Target Price Met'}</b>
🎯 <b>Strategy:</b> <code>${snipeData.reason || 'Auto-Rule Trigger'}</code>
⚡ <b>Compute Latency:</b> <b>${snipeData.computeLatencyMs || '5.0'} ms</b>
🛡️ <b>Worker Wallet:</b> <code>${snipeData.buyerName || 'Primary'} ${snipeData.buyerAddressShort ? '(' + snipeData.buyerAddressShort + ')' : ''}</code>
📦 <b>Robinhood Block:</b> <code>${blockNum}</code>
🔗 <b>TxHash:</b> <code>${txShort}</code>

${isSim ? '<i>Simulation Mode — Zero funds spent</i>' : '<i>Successfully secured & transferred to your worker wallet!</i>'}
`.trim();

  const keyboard = [
    [
      { text: '🔍 View on Explorer', url: explorerUrl },
      { text: '⛵ View on OpenSea', url: openseaUrl }
    ]
  ];

  sendTelegramPhoto(token, chatId, snipeData.image || snipeData.imageUrl, caption, keyboard).catch(() => {});
}

/**
 * 👑 GET ADMIN RECIPIENTS FOR LIVE MASTER FEED
 */
export async function getAdminNotificationChatIds() {
  const ids = new Set(adminRegisteredChatIds);
  if (TELEGRAM_ADMIN_CHAT_ID) ids.add(String(TELEGRAM_ADMIN_CHAT_ID));
  if (TELEGRAM_FEED_CHANNEL_ID) ids.add(String(TELEGRAM_FEED_CHANNEL_ID));

  try {
    const ownerRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_users?email=eq.${encodeURIComponent(OWNER_EMAIL)}&select=id`, {
      headers: supabaseHeaders,
      timeout: 3000
    });
    if (ownerRes.data?.length > 0) {
      const ownerId = ownerRes.data[0].id;
      const cfg = await dbGetUserConfig(ownerId);
      if (cfg?.telegram_chat_id) {
        ids.add(String(cfg.telegram_chat_id));
      }
    }
  } catch (_) {}

  return Array.from(ids).filter(Boolean);
}

/**
 * 📢 2. UNIVERSAL MASTER FEED ALERT (Broadcast to Admin via @aeroupdatebot)
 */
export async function dispatchGlobalMasterFeedAlert(snipeData) {
  const token = ADMIN_UPDATE_BOT_TOKEN;
  if (!token) return;

  const targetChatIds = await getAdminNotificationChatIds();
  if (!targetChatIds || targetChatIds.length === 0) return;

  const tokenName = snipeData.name || `#${snipeData.tokenId}`;
  const priceEth = formatDisplayEth(snipeData.price || 0);
  const usdPrice = (parseFloat(snipeData.price || 0) * cachedEthPrice).toFixed(2);
  const floorDisp = formatDisplayEth(snipeData.floorEth || 0);
  const floorUsd = (parseFloat(snipeData.floorEth || 0) * cachedEthPrice).toFixed(2);
  const explorerUrl = `https://explorer.mainnet.robinhood.com/tx/${snipeData.txHash}`;
  const openseaUrl = `https://opensea.io/assets/robinhood/${snipeData.contractAddress || ''}/${snipeData.tokenId}`;
  const userTag = snipeData.userEmail ? `<code>${snipeData.userEmail}</code>` : (snipeData.userId ? `<code>UID: ${snipeData.userIdShort}</code>` : 'VIP Member');

  const text = `
👑 <b>AERO-SNIPER V2 • MASTER ADMIN FEED</b> ⚡
<i>Institutional Real-Time Subscriber Activity</i>

━━━━━━━━━━━━━━━━━━━━━
👤 <b>Subscriber:</b> ${userTag}
💼 <b>Fleet Wallet:</b> <code>${snipeData.buyerName || 'Worker'} ${snipeData.buyerAddressShort ? '(' + snipeData.buyerAddressShort + ')' : ''}</code>
🏷️ <b>Collection:</b> <code>${snipeData.collectionName || snipeData.slug || 'Collection'}</code>
🎯 <b>NFT Sniped:</b> <b>${tokenName}</b>
💎 <b>Collection Floor:</b> <b>${floorDisp} ETH</b> (~$${floorUsd} USD)
💰 <b>Price Bought:</b> <b>${priceEth} ETH</b> (~$${usdPrice} USD)
📉 <b>Advantage:</b> <b>${snipeData.discountStr || 'Trigger Met'}</b>
🎯 <b>Strategy:</b> <code>${snipeData.reason || 'Auto-Rule'}</code>
⚡ <b>Compute Latency:</b> <b>${snipeData.computeLatencyMs || '5.0'} ms</b>
🔗 <b>Tx:</b> <a href="${explorerUrl}">View Robinhood Block Receipt</a>
━━━━━━━━━━━━━━━━━━━━━
🌐 <i>Aero-Sniper Pro Multi-Tenant Engine</i>
`.trim();

  const keyboard = [
    [
      { text: '🚀 View on Explorer', url: explorerUrl },
      { text: '⛵ View on OpenSea', url: openseaUrl }
    ]
  ];

  for (const cId of targetChatIds) {
    sendTelegramPhoto(token, cId, snipeData.image || snipeData.imageUrl, text, keyboard).catch(() => {});
  }
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

  // ⚡ INSTANT ACKNOWLEDGEMENT: Release Telegram UI button spinner immediately (<10ms)
  answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id).catch(() => {});

  // 🔒 Gatekeeper Help Callback
  if (data === 'gate_help') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const helpMsg = `
ℹ️ <b>HOW TO CONNECT YOUR ACCOUNT</b>

1️⃣ Open <a href="${WEBAPP_URL}">${WEBAPP_URL.replace('https://', '')}</a> in your browser.
2️⃣ Log in to your subscriber account.
3️⃣ Click <b>[ 📱 Telegram Sync ]</b> at the top of the dashboard.
4️⃣ Click <b>"1-Click Open in Telegram"</b> or copy your secret token and paste it here.

🔒 <i>Tokens burn immediately after single use for maximum security.</i>
`.trim();
    const keyboard = [
      [{ text: '🔙 Back', callback_data: 'menu_main' }]
    ];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, helpMsg, keyboard);
  }

  // 🔒 Subscriber Authentication & Gatekeeper Check
  const authInfo = await getLinkedUserForChat(chatId);
  if (!authInfo || authInfo.isBanned || authInfo.isExpired) {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🔒 VIP Subscription Required');
    const gateMenu = await buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, gateMenu.text, gateMenu.keyboard);
  }

  // 1. Arm Action
  if (data === 'action_arm' || data === 'arm') {
    if (!activeCollectionStats?.slug) {
      await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚠️ Please set a target collection first!');
      const menu = buildTargetMenu();
      return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
    }

    const { user, config } = authInfo;
    await armEngineForUser(user.id, config, activeCollectionStats.slug, botRuleConfig, {
      dryRun: botPaperSnipeMode,
      gasSpeed: botActiveGasPreset,
      telegramChatId: String(chatId)
    });
    syncRulesToEngines();

    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚡ Sniper ARMED in Cloud 24/7!');
    const menu = await buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 2. Pause Action
  if (data === 'action_pause' || data === 'pause') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
    }
    activeSniperEngine.isArmed = false;
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⏸ Sniper PAUSED!');
    const menu = await buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 3. Clear Target Action
  if (data === 'action_clear_target' || data === 'clear_target') {
    await clearBotTarget(chatId);
    userPromptState.delete(chatId);
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🗑️ Target & Session Cleared! Reset to Fresh Standby.');
    const menu = await buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, '🗑️ <b>Target & Session Cleared!</b>\n\nAll session logs and active feeds have been wiped clean.\n\n' + menu.text, menu.keyboard);
  }

  // 4. Toggle Simulation (Paper Snipe)
  if (data === 'action_toggle_sim') {
    botPaperSnipeMode = !botPaperSnipeMode;
    syncRulesToEngines();
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, botPaperSnipeMode ? '🧪 Paper Snipe Activated (0 ETH spent)' : '⚡ Real Mainnet Activated!');
    const menu = await buildMainMenu(chatId);
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
    const menu = await buildMainMenu(chatId);
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
    const menu = await buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 12. Wallets Sub-Menu & Actions
  if (data === 'menu_wallets') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🔄 Refreshing wallet fleet...');
    const menu = await buildWalletsMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Toggle Individual Wallet Selection
  if (data.startsWith('toggle_wallet_')) {
    const idx = parseInt(data.replace('toggle_wallet_', ''), 10);
    if (authInfo?.user?.id) {
      const userConfig = (await dbGetUserConfig(authInfo.user.id)) || {};
      const targetWallets = userConfig.walletFleet || userConfig.wallets || [];
      if (targetWallets[idx]) {
        targetWallets[idx].selected = !(targetWallets[idx].selected !== false);
        userConfig.walletFleet = targetWallets;
        userConfig.wallets = targetWallets;
        await dbSaveUserConfig(authInfo.user.id, userConfig);
        syncRulesToEngines();
        const newState = targetWallets[idx].selected ? '🟢 Armed for Sniping' : '⚪ Disarmed';
        await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `Wallet #${idx + 1}: ${newState}`);
      }
    }
    const menu = await buildWalletsMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Select All Wallets
  if (data === 'wallets_select_all') {
    if (authInfo?.user?.id) {
      const userConfig = (await dbGetUserConfig(authInfo.user.id)) || {};
      const targetWallets = userConfig.walletFleet || userConfig.wallets || [];
      targetWallets.forEach(w => { w.selected = true; });
      userConfig.walletFleet = targetWallets;
      userConfig.wallets = targetWallets;
      await dbSaveUserConfig(authInfo.user.id, userConfig);
      syncRulesToEngines();
      await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚡ All wallets armed for sniping!');
    }
    const menu = await buildWalletsMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Unselect All Wallets
  if (data === 'wallets_unselect_all') {
    if (authInfo?.user?.id) {
      const userConfig = (await dbGetUserConfig(authInfo.user.id)) || {};
      const targetWallets = userConfig.walletFleet || userConfig.wallets || [];
      targetWallets.forEach(w => { w.selected = false; });
      userConfig.walletFleet = targetWallets;
      userConfig.wallets = targetWallets;
      await dbSaveUserConfig(authInfo.user.id, userConfig);
      syncRulesToEngines();
      await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚪ All wallets disarmed.');
    }
    const menu = await buildWalletsMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Prompt Add Wallet / Private Key
  if (data === 'prompt_add_wallet') {
    userPromptState.set(chatId, { action: 'awaiting_private_key' });
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
🔐 <b>ADD WALLET / IMPORT PRIVATE KEY:</b>

Please type or paste your <b>Private Key</b> (64-hex starting with <code>0x...</code>) in your next message.

🛡️ <i>Your key is encrypted in memory and stored securely in your private cloud vault for sub-15ms Robinhood sniping.</i>
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_wallets' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Generate 5 Worker Wallets
  if (data === 'action_generate_workers') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚡ Generating 5 Worker Wallets...');
    if (authInfo?.user?.id) {
      const userConfig = (await dbGetUserConfig(authInfo.user.id)) || {};
      if (!Array.isArray(userConfig.walletFleet)) userConfig.walletFleet = [];

      for (let i = 0; i < 5; i++) {
        const randWallet = ethers.Wallet.createRandom();
        userConfig.walletFleet.push({
          address: randWallet.address,
          privateKey: randWallet.privateKey,
          name: `Worker #${userConfig.walletFleet.length + 1}`,
          role: 'worker',
          balance: '0',
          selected: true
        });
      }

      await dbSaveUserConfig(authInfo.user.id, userConfig);
      syncRulesToEngines();
      await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '✅ 5 Worker Wallets Generated!');
    }
    const menu = await buildWalletsMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 13. Stats / Telemetry
  if (data === 'menu_stats' || data === 'menu_refresh' || data === 'bot_refresh') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🔄 Refreshed');
    const menu = await buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 14. Back to Main Menu
  if (data === 'menu_main') {
    userPromptState.delete(chatId);
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = await buildMainMenu(chatId);
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

  // 🔑 1. DETECT ONE-TIME WEB-TO-TELEGRAM LINK TOKEN
  const isTokenInput = text.startsWith('/start AERO') || 
                       text.startsWith('AERO-TG-') || 
                       text.startsWith('AERO_TG_') || 
                       /AERO[-_]TG[-_][A-Z0-9_-]+/i.test(text);

  if (isTokenInput) {
    sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '🔐 <b>Verifying Secret Subscriber Token...</b>');
    const linkRes = await verifyAndLinkTelegramToken(chatId, text, message.from);

    if (linkRes.success) {
      const user = linkRes.user;
      const config = linkRes.config;
      const walletCount = (config.walletFleet || config.wallets || []).length;

      const welcomeText = `
🎉 <b>TELEGRAM SUBSCRIBER SYNC SUCCESSFUL!</b> 🎉
━━━━━━━━━━━━━━━━━━━━━
👤 <b>Account:</b> <code>${user.email}</code>
💼 <b>Fleet Connected:</b> <b>${walletCount} wallet(s)</b>
⚡ <b>Cloud Sniper Engine:</b> <b>24/7 Active</b>

🛡️ <i>Your one-time link token has burned for security. Your phone is now securely bound to your private cloud sniper!</i>
`.trim();

      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcomeText);
      const menu = await buildMainMenu(chatId);
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
    } else {
      const failText = linkRes.error || '❌ Invalid token.';
      const gateMenu = buildUnlinkedGatekeeperMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `${failText}\n\n` + gateMenu.text, gateMenu.keyboard);
    }
  }

  // 🔒 2. SUBSCRIBER AUTHENTICATION CHECK
  const authInfo = await getLinkedUserForChat(chatId);
  if (!authInfo || authInfo.isBanned || authInfo.isExpired) {
    const gateMenu = await buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, gateMenu.text, gateMenu.keyboard);
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
    const menu = await buildMainMenu(chatId);
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

  // 10. Awaiting Wallet Private Key Import
  if (prompt?.action === 'awaiting_private_key') {
    userPromptState.delete(chatId);
    const cleanKey = text.trim();
    try {
      const walletObj = new ethers.Wallet(cleanKey);
      if (authInfo?.user?.id) {
        const userConfig = (await dbGetUserConfig(authInfo.user.id)) || {};
        if (!Array.isArray(userConfig.walletFleet)) userConfig.walletFleet = [];

        const isMaster = userConfig.walletFleet.length === 0 || !userConfig.walletFleet.some(w => w.role === 'master');
        userConfig.walletFleet.push({
          address: walletObj.address,
          privateKey: walletObj.privateKey,
          name: isMaster ? 'Master Holding' : `Worker #${userConfig.walletFleet.length + 1}`,
          role: isMaster ? 'master' : 'worker',
          balance: '0'
        });

        await dbSaveUserConfig(authInfo.user.id, userConfig);
        syncRulesToEngines();
      }

      const menu = await buildWalletsMenu(chatId);
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Wallet Imported Successfully!</b>\nAddress: <code>${walletObj.address}</code>\nRole: <b>Worker</b>\n\n` + menu.text, menu.keyboard);
    } catch (e) {
      const menu = await buildWalletsMenu(chatId);
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `❌ <b>Invalid Private Key!</b>\nPlease ensure you send a valid 64-character hex private key starting with <code>0x...</code>\n\n` + menu.text, menu.keyboard);
    }
  }

  // Standard Commands
  if (text.startsWith('/start') || text === '/menu') {
    const menu = await buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  if (text === '/rules') {
    const menu = buildRulesHubMenu();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  if (text === '/clear' || text === '/reset') {
    await clearBotTarget(chatId);
    userPromptState.delete(chatId);
    const menu = await buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '🗑️ <b>Target & Session Cleared!</b>\n\nAll session logs and active feeds have been wiped clean. Reset to Fresh Standby.\n\n' + menu.text, menu.keyboard);
  }

  if (text === '/arm' || text === '/start_sniper') {
    if (!activeCollectionStats?.slug) {
      const menu = buildTargetMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⚠️ <b>Please set a target collection before arming!</b>\n\n' + menu.text, menu.keyboard);
    }
    const { user, config } = authInfo;
    await armEngineForUser(user.id, config, activeCollectionStats.slug, botRuleConfig, {
      dryRun: botPaperSnipeMode,
      gasSpeed: botActiveGasPreset,
      telegramChatId: String(chatId)
    });
    syncRulesToEngines();
    const menu = await buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⚡ <b>SNIPER ARMED (24/7 Live Cloud Engine)!</b>\n\n' + menu.text, menu.keyboard);
  }

  if (text === '/pause' || text === '/disarm') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
    }
    activeSniperEngine.isArmed = false;
    const menu = await buildMainMenu(chatId);
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
      const menu = await buildMainMenu(chatId);
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Target Changed to:</b> <code>${stats.name}</code>\nFloor: <b>${formatDisplayEth(stats.floorEth)} ETH</b>\n\n` + menu.text, menu.keyboard);
    } else {
      const menu = buildTargetMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
    }
  }

  // /wallets
  if (text === '/wallets') {
    const menu = await buildWalletsMenu(chatId);
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
  const menu = await buildMainMenu(chatId);
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

  // 👑 Admin Update Bot Poller: Auto-links anyone who sends /start to @aeroupdatebot
  let lastAdminUpdateId = 0;
  const adminPollLoop = async () => {
    if (!ADMIN_UPDATE_BOT_TOKEN || ADMIN_UPDATE_BOT_TOKEN === TELEGRAM_BOT_TOKEN) return;
    while (isPollingActive) {
      try {
        const res = await axios.get(`https://api.telegram.org/bot${ADMIN_UPDATE_BOT_TOKEN}/getUpdates`, {
          params: { offset: lastAdminUpdateId + 1, timeout: 20 },
          timeout: 25000
        });

        if (res.data?.ok && Array.isArray(res.data.result)) {
          for (const update of res.data.result) {
            lastAdminUpdateId = update.update_id;
            const msg = update.message;
            if (msg && msg.chat?.id) {
              const cId = String(msg.chat.id);
              adminRegisteredChatIds.add(cId);
              sendTelegramMessage(
                ADMIN_UPDATE_BOT_TOKEN,
                cId,
                `👑 <b>AERO-SNIPER MASTER ADMIN FEED ONLINE</b> ⚡\n\n✅ <b>Connected!</b> (Chat ID: <code>${cId}</code>)\n\nYou will receive real-time notifications here whenever ANY subscriber snipes an NFT across the network.`
              ).catch(() => {});
            }
          }
        }
      } catch (err) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };

  adminPollLoop().catch(() => {});
}

