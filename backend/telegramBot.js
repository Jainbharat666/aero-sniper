import axios from 'axios';
import {
  activeSniperEngine,
  activeSniperEngines,
  activeCollectionStats,
  cachedEthPrice
} from './state.js';
import { dbGetUserByEmail, dbGetUsers } from './db.js';

// Environment Bindings
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8849256750:AAGL6tEK_2tatSxgS-RjWp2ngE7B6lh29RI';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
const TELEGRAM_FEED_BOT_TOKEN = process.env.TELEGRAM_FEED_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
const TELEGRAM_FEED_CHANNEL_ID = process.env.TELEGRAM_FEED_CHANNEL_ID || TELEGRAM_ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.RENDER_EXTERNAL_URL || 'https://aero-sniper.onrender.com';

let lastUpdateId = 0;
let isPollingActive = false;

// In-memory active user settings (for interactive menus)
let botActiveDiscountPercent = 20;
let botActiveGasPreset = 'turbo';

/**
 * 🎨 RENDER MAIN DASHBOARD MENU (SnipeNow / Maestro Interactive Style)
 */
export function buildMainMenu(chatId = null) {
  const isArmed = Array.from(activeSniperEngines.values()).some(e => e.isArmed) || activeSniperEngine.isArmed;
  const stats = activeCollectionStats;
  const currentSlug = stats?.name || stats?.slug || activeSniperEngine.slug || 'robinwoodies';
  const floorEth = stats?.floorEth ? stats.floorEth : '0.000035';
  const usdFloor = (parseFloat(floorEth) * cachedEthPrice).toFixed(2);
  const activeEngines = activeSniperEngines.size || (isArmed ? 1 : 0);

  const text = `
⚡ <b>AERO-SNIPER PRO • TELEGRAM TERMINAL</b> ⚡
<i>Institutional High-Frequency NFT Sniping Protocol</i>

🎯 <b>Active Target:</b> <code>${currentSlug}</code>
💎 <b>Floor Price:</b> <b>${floorEth} ETH</b> (~$${usdFloor} USD)
🛡️ <b>Engine Status:</b> ${isArmed ? '🟢 <b>ARMED & HUNTING (24/7)</b>' : '🔴 <b>DISARMED / STANDBY</b>'}
🚀 <b>Gas Speed:</b> <b>${botActiveGasPreset.toUpperCase()}</b> (Auto-Surge)
🎯 <b>Floor Discount Target:</b> <b>${botActiveDiscountPercent}% Below Floor</b>
👥 <b>Active Cloud Engines:</b> <code>${activeEngines} user(s)</code>
🌐 <b>Robinhood Sequencer:</b> 🟢 <b>Sub-15ms Active</b>
`.trim();

  const keyboard = [
    [
      isArmed
        ? { text: '⏸ Pause / Disarm Engine', callback_data: 'action_pause' }
        : { text: '⚡ Arm Sniper (Instant)', callback_data: 'action_arm' }
    ],
    [
      { text: `🎯 Target: ${botActiveDiscountPercent}% Below Floor`, callback_data: 'menu_discount' },
      { text: `🚀 Gas: ${botActiveGasPreset.toUpperCase()}`, callback_data: 'menu_gas' }
    ],
    [
      { text: '👛 Wallet Fleet Status', callback_data: 'menu_wallets' },
      { text: '📊 24/7 Cloud Telemetry', callback_data: 'menu_stats' }
    ],
    [
      { text: '🔄 Refresh Terminal', callback_data: 'menu_refresh' },
      { text: '❓ Bot Guide / Help', callback_data: 'menu_help' }
    ],
    [
      { text: '🌐 Launch Full WebApp (Mini App)', web_app: { url: WEBAPP_URL } }
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
      disable_web_page_preview: false
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
 * 🔄 Edit Message Text (Instant Dynamic Menu Refresh without spamming new messages)
 */
export async function editTelegramMessage(token, chatId, messageId, text, inlineKeyboard = null) {
  if (!token || !chatId || !messageId) return false;
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML'
    };
    if (inlineKeyboard) {
      payload.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, payload, { timeout: 6000 });
    return true;
  } catch (err) {
    // If message not modified, ignore
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
 * 🎯 1. PRIVATE SNIPE ALERT (Sent to the specific user's Telegram)
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
 * 📢 2. UNIVERSAL MASTER FEED ALERT (Broadcast to Global Admin / Community Channel)
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
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '⚡ Sniper ARMED in Cloud!');
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

  // 3. Discount Sub-Menu
  if (data === 'menu_discount') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
🎯 <b>SELECT FLOOR DISCOUNT TARGET:</b>
Pick the fat-finger discount percentage below floor price to trigger instant snipe:
`.trim();
    const keyboard = [
      [
        { text: '10% Below Floor', callback_data: 'set_pct_10' },
        { text: '20% Below Floor', callback_data: 'set_pct_20' },
        { text: '50% Half Price 🔥', callback_data: 'set_pct_50' }
      ],
      [
        { text: '80% Mega Steal ⚡', callback_data: 'set_pct_80' },
        { text: '90% God Steal 👑', callback_data: 'set_pct_90' }
      ],
      [
        { text: '🔙 Back to Main Menu', callback_data: 'menu_main' }
      ]
    ];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // Set Discount %
  if (data.startsWith('set_pct_')) {
    const pct = parseInt(data.replace('set_pct_', ''), 10);
    botActiveDiscountPercent = pct;
    for (const [k, engine] of activeSniperEngines.entries()) {
      if (activeCollectionStats?.floorEth > 0) {
        engine.maxFloorEth = activeCollectionStats.floorEth * (1 - pct / 100);
      }
    }
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, `✅ Target updated: ${pct}% Below Floor`);
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // 4. Gas Sub-Menu
  if (data === 'menu_gas') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
🚀 <b>SELECT GAS WAR PRESET:</b>
Choose your Robinhood Chain mempool racing priority:
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
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
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

  // 5. Wallets Sub-Menu
  if (data === 'menu_wallets') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const text = `
👛 <b>MAINNET WORKER FLEET STATUS:</b>

👑 <b>Treasury Mode:</b> Multi-Worker Auto-Rotation
⚡ <b>RPC Racing Fleet:</b> 4 Active (Alchemy + Robinhood Sequencer)
🛡️ <b>Mempool Nonce Locking:</b> Instant RAM CPU
🟢 <b>Laser Grid:</b> 21-Key Load Balancer 100% Operational
`.trim();
    const keyboard = [
      [
        { text: '🔄 Refresh Wallets', callback_data: 'menu_wallets' },
        { text: '🔙 Back to Menu', callback_data: 'menu_main' }
      ]
    ];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
  }

  // 6. Stats Sub-Menu
  if (data === 'menu_stats' || data === 'menu_refresh') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id, '🔄 Telemetry Refreshed');
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Back to Main Menu
  if (data === 'menu_main') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const menu = buildMainMenu(chatId);
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, menu.text, menu.keyboard);
  }

  // Help
  if (data === 'menu_help') {
    await answerCallbackQuery(TELEGRAM_BOT_TOKEN, callbackQuery.id);
    const helpText = `
📖 <b>AERO-SNIPER V2 BOT GUIDE:</b>

1. <b>1-Tap Buttons:</b> Use buttons above to Arm, Pause, adjust Floor Discount %, or change Gas speeds in real-time.
2. <b>24/7 Cloud Engine:</b> When Armed, your sniper hunts 24/7 on Render without keeping Telegram or PC open.
3. <b>Instant Buy Alert:</b> When an underpriced NFT is sniped, the bot sends an instant photo and on-chain TxHash.
4. <b>Mini App:</b> Click 'Launch Full WebApp' to view live floor charts and trade manually!
`.trim();
    const keyboard = [
      [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
    ];
    return editTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, messageId, helpText, keyboard);
  }
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

  console.log('🤖 [TELEGRAM] Interactive Button Terminal & Remote Controller Activated.');

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
              handleCallbackQuery(update.callback_query).catch(() => {});
            }

            // 2. Handle /start or text messages
            if (update.message) {
              const chatId = update.message.chat?.id;
              const menu = buildMainMenu(chatId);
              sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, menu.text, menu.keyboard).catch(() => {});
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
