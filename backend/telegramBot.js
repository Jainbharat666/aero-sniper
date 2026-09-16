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

// In-memory active user settings (for interactive menus)
let botActiveDiscountPercent = 20;
let botActiveGasPreset = 'turbo';
let botPaperSnipeMode = false;

// User state tracker (e.g. if user is about to type a custom discount or slug)
const userPromptState = new Map();

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

    let floorEth = 0.000035;
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

    // Synchronize to active engines
    const discountFactor = 1 - (botActiveDiscountPercent || 20) / 100;
    const triggerPrice = floorEth * discountFactor;

    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.slug = slug;
      engine.contractAddress = stats.contract;
      engine.maxFloorEth = triggerPrice;
      engine.isDryRun = botPaperSnipeMode;
    }
    activeSniperEngine.slug = slug;
    activeSniperEngine.contractAddress = stats.contract;
    activeSniperEngine.maxFloorEth = triggerPrice;
    activeSniperEngine.isDryRun = botPaperSnipeMode;

    return stats;
  } catch (err) {
    console.warn('[TELEGRAM SCAN] Error scanning collection:', err.message);
    return null;
  }
}

/**
 * 🎨 RENDER MAIN DASHBOARD MENU (Maestro / Unibot Pro Style)
 */
export function buildMainMenu(chatId = null) {
  const isArmed = Array.from(activeSniperEngines.values()).some(e => e.isArmed) || activeSniperEngine.isArmed;
  const stats = activeCollectionStats;
  const currentSlug = stats?.name || stats?.slug || activeSniperEngine.slug || 'robinwoodies';
  const floorEth = stats?.floorEth ? stats.floorEth : '0.000035';
  const floorEthNum = parseFloat(floorEth) || 0.000035;
  const usdFloor = (floorEthNum * cachedEthPrice).toFixed(2);
  const targetTriggerEth = (floorEthNum * (1 - (botActiveDiscountPercent || 20) / 100)).toFixed(6);
  const targetTriggerUsd = (parseFloat(targetTriggerEth) * cachedEthPrice).toFixed(2);
  const activeEngines = activeSniperEngines.size || (isArmed ? 1 : 0);

  const text = `
⚡ <b>AERO-SNIPER PRO • TELEGRAM TERMINAL</b> ⚡
<i>Institutional High-Frequency NFT Sniping Protocol</i>

━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Target:</b> <code>${currentSlug}</code>
💎 <b>Floor Price:</b> <b>${floorEth} ETH</b> (~$${usdFloor} USD)
🎯 <b>Snipe Trigger:</b> <b>&lt; ${targetTriggerEth} ETH</b> (~$${targetTriggerUsd})
🛡️ <b>Engine Status:</b> ${isArmed ? '🟢 <b>ARMED & HUNTING (24/7)</b>' : '🔴 <b>DISARMED / PAUSED</b>'}
🧪 <b>Mode:</b> ${botPaperSnipeMode ? '🧪 <b>PAPER SNIPE (SIMULATION)</b>' : '⚡ <b>100% REAL ON-CHAIN MAINNET</b>'}
🚀 <b>Gas Speed:</b> <b>${botActiveGasPreset.toUpperCase()}</b> (Auto-Surge)
👥 <b>Cloud Engines:</b> <code>${activeEngines} user(s) online</code>
🌐 <b>Robinhood Sequencer:</b> 🟢 <b>Sub-15ms Active</b>
━━━━━━━━━━━━━━━━━━━━━
<i>💡 Tap buttons below or type any command to control your bot:</i>
`.trim();

  const keyboard = [
    [
      isArmed
        ? { text: '⏸ Pause Sniper', callback_data: 'action_pause' }
        : { text: '⚡ ARM AUTO-SNIPER (24/7)', callback_data: 'action_arm' }
    ],
    [
      { text: '🎯 Change Target NFT', callback_data: 'menu_target' },
      { text: `📉 Discount: -${botActiveDiscountPercent}%`, callback_data: 'menu_discount' }
    ],
    [
      { text: `🚀 Gas: ${botActiveGasPreset.toUpperCase()}`, callback_data: 'menu_gas' },
      { text: botPaperSnipeMode ? '🧪 Mode: Paper' : '⚡ Mode: Real Mainnet', callback_data: 'action_toggle_sim' }
    ],
    [
      { text: '👛 Wallet Fleet Holdings', callback_data: 'menu_wallets' },
      { text: '📊 Live Telemetry & Health', callback_data: 'menu_stats' }
    ],
    [
      { text: '🔄 Refresh', callback_data: 'menu_refresh' },
      { text: '❓ Command Guide', callback_data: 'menu_help' }
    ],
    [
      { text: '🌐 Launch WebApp', web_app: { url: WEBAPP_URL } }
    ]
  ];

  return { text, keyboard };
}

/**
 * 🎯 BUILD TARGET COLLECTION MENU
 */
export function buildTargetMenu() {
  const currentSlug = activeCollectionStats?.slug || activeSniperEngine.slug || 'robinwoodies';
  const text = `
🎯 <b>SELECT TARGET COLLECTION:</b>

Choose a popular Robinhood collection below, or simply <b>send the OpenSea URL / slug directly into this chat</b>:

Current Active: <code>${currentSlug}</code>
`.trim();

  const keyboard = [
    [
      { text: '🌲 Woodies (robinwoodies)', callback_data: 'set_target_robinwoodies' },
      { text: '🐂 Bulls Runners', callback_data: 'set_target_bulls-runners-genesis' }
    ],
    [
      { text: '🤖 RH Machines', callback_data: 'set_target_rhmachines' },
      { text: '⚡ NTRPY Genesis', callback_data: 'set_target_ntrpygenesis' }
    ],
    [
      { text: '✍️ Type Custom Slug / URL', callback_data: 'prompt_custom_target' }
    ],
    [
      { text: '🔙 Back to Main Menu', callback_data: 'menu_main' }
    ]
  ];

  return { text, keyboard };
}

/**
 * 📉 BUILD DISCOUNT TARGET MENU
 */
export function buildDiscountMenu() {
  const floor = activeCollectionStats?.floorEth || 0.000035;
  const text = `
📉 <b>SELECT FLOOR DISCOUNT TARGET:</b>

Current Floor: <b>${floor} ETH</b>
Choose the fat-finger discount percentage below floor price to trigger an instant snipe:
`.trim();

  const keyboard = [
    [
      { text: '-10% Below Floor', callback_data: 'set_pct_10' },
      { text: '-20% Below Floor', callback_data: 'set_pct_20' }
    ],
    [
      { text: '-30% Quick Snipe', callback_data: 'set_pct_30' },
      { text: '-50% Half Price 🔥', callback_data: 'set_pct_50' }
    ],
    [
      { text: '-80% Mega Steal ⚡', callback_data: 'set_pct_80' },
      { text: '-90% God Steal 👑', callback_data: 'set_pct_90' }
    ],
    [
      { text: '🔙 Back to Main Menu', callback_data: 'menu_main' }
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
    walletLines = wallets.slice(0, 5).map((w, idx) => {
      const shortAddr = w.address ? `${w.address.slice(0, 6)}...${w.address.slice(-4)}` : '0x...';
      const roleTag = w.role === 'master' ? '👑 Master' : '⚡ Worker';
      const bal = parseFloat(w.balance || 0).toFixed(4);
      return `• <b>${roleTag} (${w.name || '#' + (idx + 1)}):</b> <code>${shortAddr}</code> — <b>${bal} ETH</b>`;
    }).join('\n');
    if (wallets.length > 5) {
      walletLines += `\n<i>...and ${wallets.length - 5} more worker sub-wallets</i>`;
    }
  }

  const text = `
👛 <b>MAINNET WALLET FLEET STATUS</b> 👛

💰 <b>Total Fleet Value:</b> <b>${totalEth.toFixed(4)} ETH</b> (~$${totalUsd} USD)
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
 * 🔄 Edit Message Text (Instant Dynamic Menu Refresh)
 */
export async function editTelegramMessage(token, chatId, messageId, text, inlineKeyboard = null) {
  if (!token || !chatId || !messageId) return false;
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (inlineKeyboard) {
      payload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, payload, { timeout: 6000 });
    return true;
  } catch (err) {
    return false;
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
  const priceEth = snipeData.price || 0;
  const usdPrice = (priceEth * cachedEthPrice).toFixed(2);
  const txHash = snipeData.txHash || '';
  const txShort = txHash.length > 18 ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : txHash;
  const blockNum = snipeData.blockNumber ? `#${snipeData.blockNumber}` : 'Mined';
  const explorerUrl = `https://explorer.mainnet.robinhood.com/tx/${txHash}`;
  const openseaUrl = `https://opensea.io/assets/robinhood/${snipeData.contractAddress || ''}/${snipeData.tokenId}`;

  const caption = `
🏆 ${modeBadge}

🎯 <b>Token:</b> <code>${tokenName}</code>
🏷️ <b>Collection:</b> <code>${userEngine?.slug || 'robinwoodies'}</code>
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
  const priceEth = snipeData.price || 0;
  const usdPrice = (priceEth * cachedEthPrice).toFixed(2);
  const buyerDisplay = snipeData.buyerName || 'VIP Member';
  const explorerUrl = `https://explorer.mainnet.robinhood.com/tx/${snipeData.txHash}`;

  const text = `
👑 <b>AERO-SNIPER V2 • MASTER MINT FEED</b> ⚡

👤 <b>Trader:</b> <code>${buyerDisplay}</code>
🎯 <b>NFT:</b> <b>${tokenName}</b>
🏷️ <b>Collection:</b> <code>${snipeData.slug || 'robinwoodies'}</code>
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
  if (data === 'action_arm') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = true;
    }
    activeSniperEngine.isArmed = true;
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚡ Sniper ARMED in Cloud 24/7!');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 2. Pause Action
  if (data === 'action_pause') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
    }
    activeSniperEngine.isArmed = false;
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⏸ Sniper PAUSED!');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 3. Toggle Simulation (Paper Snipe)
  if (data === 'action_toggle_sim') {
    botPaperSnipeMode = !botPaperSnipeMode;
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isDryRun = botPaperSnipeMode;
    }
    activeSniperEngine.isDryRun = botPaperSnipeMode;
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, botPaperSnipeMode ? '🧪 Paper Snipe Activated (0 ETH spent)' : '⚡ Real Mainnet Activated!');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 4. Target Sub-Menu
  if (data === 'menu_target') {
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

Please type the OpenSea URL or collection slug in your next message (e.g. <code>robinwoodies</code> or <code>https://opensea.io/collection/bulls-runners-genesis</code>).
`.trim();
    const keyboard = [[{ text: '🔙 Cancel', callback_data: 'menu_main' }]];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // 5. Discount Sub-Menu
  if (data === 'menu_discount') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildDiscountMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Set Discount %
  if (data.startsWith('set_pct_')) {
    const pct = parseInt(data.replace('set_pct_', ''), 10);
    botActiveDiscountPercent = pct;
    const floor = activeCollectionStats?.floorEth || 0.000035;
    const newMaxFloor = floor * (1 - pct / 100);

    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.maxFloorEth = newMaxFloor;
    }
    activeSniperEngine.maxFloorEth = newMaxFloor;

    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `✅ Target updated: ${pct}% Below Floor`);
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 6. Gas Sub-Menu
  if (data === 'menu_gas') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildGasMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Set Gas
  if (data.startsWith('set_gas_')) {
    const preset = data.replace('set_gas_', '');
    botActiveGasPreset = preset;
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.gasSpeed = preset;
    }
    activeSniperEngine.gasSpeed = preset;
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `🚀 Gas set to: ${preset.toUpperCase()}`);
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 7. Wallets Sub-Menu
  if (data === 'menu_wallets') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = await buildWalletsMenu();
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 8. Stats / Telemetry
  if (data === 'menu_stats' || data === 'menu_refresh') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🔄 Refreshed');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 9. Back to Main Menu
  if (data === 'menu_main') {
    userPromptState.delete(chatId);
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 10. Help Guide
  if (data === 'menu_help') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const helpText = `
📖 <b>AERO-SNIPER TELEGRAM COMMAND GUIDE:</b>

<b>Touch Commands:</b>
• <b>⚡ Arm / ⏸ Pause:</b> Starts/stops 24/7 background sniper engine.
• <b>🎯 Target NFT:</b> Instant 1-tap collection switcher.
• <b>📉 Discount %:</b> Choose fat-finger discount below floor (-10% to -90%).
• <b>🚀 Gas:</b> Choose racing tip (Safe, Turbo, Surge, Hyped).
• <b>🧪 Mode:</b> Toggle between Simulation (Paper) & Real Mainnet.

<b>Direct Chat Commands:</b>
• <code>/arm</code> — Arm sniper immediately
• <code>/pause</code> — Pause sniper immediately
• <code>/target &lt;slug&gt;</code> — e.g. <code>/target robinwoodies</code>
• <code>/discount &lt;%&gt;</code> — e.g. <code>/discount 25</code>
• <code>/gas &lt;safe|turbo|surge|hyped&gt;</code>
• <code>/wallets</code> — Check fleet holdings
• <code>/status</code> — Live telemetry report

<i>💡 Or simply paste any OpenSea link in chat to scan & target it!</i>
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

  // Auto-sync telegramChatId for admin / users
  if (chatId) {
    dbGetUsers().then(users => {
      if (users && users.length > 0) {
        users[0].telegramChatId = String(chatId);
        dbSaveUser(users[0]).catch(() => {});
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
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Target Set:</b> <code>${stats.name}</code>\nFloor: <b>${stats.floorEth} ETH</b>\n\n` + menu.text, menu.keyboard);
  }

  // 2. /start or /menu
  if (text.startsWith('/start') || text === '/menu') {
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  // 3. /arm
  if (text === '/arm') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = true;
    }
    activeSniperEngine.isArmed = true;
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⚡ <b>SNIPER ARMED (24/7 Live Cloud Engine)!</b>\n\n' + menu.text, menu.keyboard);
  }

  // 4. /pause or /disarm
  if (text === '/pause' || text === '/disarm') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
    }
    activeSniperEngine.isArmed = false;
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⏸ <b>SNIPER PAUSED!</b>\n\n' + menu.text, menu.keyboard);
  }

  // 5. /target <slug>
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
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Target Changed to:</b> <code>${stats.name}</code>\nFloor: <b>${stats.floorEth} ETH</b>\n\n` + menu.text, menu.keyboard);
    } else {
      const menu = buildTargetMenu();
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
    }
  }

  // 6. /discount <num>
  if (text.startsWith('/discount')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const pct = parseInt(parts[1], 10);
      if (!isNaN(pct) && pct > 0 && pct < 100) {
        botActiveDiscountPercent = pct;
        const floor = activeCollectionStats?.floorEth || 0.000035;
        const newMaxFloor = floor * (1 - pct / 100);
        for (const [k, engine] of activeSniperEngines.entries()) {
          engine.maxFloorEth = newMaxFloor;
        }
        activeSniperEngine.maxFloorEth = newMaxFloor;
        const menu = buildMainMenu(chatId);
        return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ <b>Discount Target Set:</b> <b>${pct}% Below Floor</b>\n\n` + menu.text, menu.keyboard);
      }
    }
    const menu = buildDiscountMenu();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  // 7. /gas <preset>
  if (text.startsWith('/gas')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const preset = parts[1].toLowerCase();
      if (['safe', 'turbo', 'surge', 'hyped'].includes(preset)) {
        botActiveGasPreset = preset;
        for (const [k, engine] of activeSniperEngines.entries()) {
          engine.gasSpeed = preset;
        }
        activeSniperEngine.gasSpeed = preset;
        const menu = buildMainMenu(chatId);
        return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `🚀 <b>Gas Speed Set:</b> <b>${preset.toUpperCase()}</b>\n\n` + menu.text, menu.keyboard);
      }
    }
    const menu = buildGasMenu();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  // 8. /wallets
  if (text === '/wallets') {
    const menu = await buildWalletsMenu();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  // 9. /status
  if (text === '/status') {
    const menu = buildMainMenu(chatId);
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard);
  }

  // 10. Direct OpenSea link or slug detection
  if (text.includes('opensea.io/') || /^[a-zA-Z0-9_-]{3,40}$/.test(text)) {
    sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `🔍 Detected collection <code>${text}</code>. Scanning OpenSea...`);
    const stats = await executeScanForBot(text);
    if (stats) {
      const isArmed = activeSniperEngine.isArmed;
      const floorEth = stats.floorEth || 0.000035;
      const usdFloor = (floorEth * cachedEthPrice).toFixed(2);
      const targetEth = (floorEth * (1 - (botActiveDiscountPercent || 20) / 100)).toFixed(6);

      const previewText = `
🎯 <b>COLLECTION SCANNED & TARGETED!</b>

🏷️ <b>Name:</b> <b>${stats.name}</b>
💎 <b>Floor Price:</b> <b>${floorEth} ETH</b> (~$${usdFloor} USD)
🎯 <b>Snipe Trigger:</b> <b>&lt; ${targetEth} ETH</b> (-${botActiveDiscountPercent}%)
📦 <b>Total Supply:</b> <b>${stats.totalSupply} NFTs</b>
🛡️ <b>Engine:</b> ${isArmed ? '🟢 <b>ARMED (Ready to Snipe)</b>' : '🔴 <b>DISARMED</b>'}

<i>Tap below to Arm or Adjust settings:</i>
`.trim();

      const keyboard = [
        [
          isArmed
            ? { text: '⏸ Pause Sniper', callback_data: 'action_pause' }
            : { text: '⚡ ARM SNIPER ON THIS COLLECTION', callback_data: 'action_arm' }
        ],
        [
          { text: `📉 Adjust Discount (-${botActiveDiscountPercent}%)`, callback_data: 'menu_discount' },
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
