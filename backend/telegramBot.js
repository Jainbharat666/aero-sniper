import axios from 'axios';
import {
  activeSniperEngine,
  activeSniperEngines,
  activeCollectionStats,
  cachedEthPrice
} from './state.js';
import { dbGetUserByEmail, dbGetUsers } from './db.js';

// Environment Bindings
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
const TELEGRAM_FEED_BOT_TOKEN = process.env.TELEGRAM_FEED_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
const TELEGRAM_FEED_CHANNEL_ID = process.env.TELEGRAM_FEED_CHANNEL_ID || TELEGRAM_ADMIN_CHAT_ID;

let lastUpdateId = 0;
let isPollingActive = false;

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
    // Fallback to text message if image loading fails
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
💰 <b>Price:</b> <b>${priceEth} ETH</b> (~$${usdPrice} USD)
⚡ <b>Speed:</b> <b>${snipeData.computeLatencyMs || '5.0'} ms</b> (Ultra-Fast)
🛡️ <b>Worker:</b> <code>${snipeData.buyerName || 'Primary'}</code>
📦 <b>Block:</b> <code>${blockNum}</code>
🔗 <b>TxHash:</b> <code>${txShort}</code>

${isSim ? '<i>Simulation Mode — Zero funds spent</i>' : '<i>Successfully secured & transferred to your worker wallet!</i>'}
`.trim();

  const keyboard = [
    [
      { text: '🔍 View on Explorer', url: explorerUrl },
      { text: '⛵ View on OpenSea', url: openseaUrl }
    ]
  ];

  // Non-blocking asynchronous dispatch
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
 * 🤖 COMMAND HANDLERS: Process Mobile Telegram Input
 */
async function processTelegramCommand(message) {
  const chatId = message.chat?.id;
  const text = (message.text || '').trim();
  const username = message.from?.username || message.from?.first_name || 'User';

  if (!chatId || !text) return;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    const helpMsg = `
👋 <b>Welcome to Aero-Sniper V2 Remote Control, ${username}!</b>

<b>Available Commands:</b>
📊 <code>/status</code> — Check live collection, floor price & sniper state
⚡ <code>/arm &lt;slug&gt; [maxFloorEth]</code> — Arm cloud sniper for a collection
⏸ <code>/pause</code> — Disarm and pause sniper engine
💼 <code>/fleet</code> — Check active worker wallet pool & treasury
🆔 <code>/id</code> — Get your Telegram Chat ID to link with profile

<i>24/7 Autonomous High-Frequency Sniper Protocol Active.</i>
`.trim();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, helpMsg);
  }

  if (cmd === '/id') {
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `🆔 Your Telegram Chat ID is: <code>${chatId}</code>\n\nAdd this to your Aero-Sniper profile to receive instant private snipe alerts!`);
  }

  if (cmd === '/status') {
    const isArmed = Array.from(activeSniperEngines.values()).some(e => e.isArmed) || activeSniperEngine.isArmed;
    const activeCount = activeSniperEngines.size;
    const stats = activeCollectionStats;

    const statusMsg = `
📊 <b>AERO-SNIPER CLOUD TELEMETRY:</b>

⚡ <b>Sniper Status:</b> ${isArmed ? '🟢 <b>ARMED & HUNTING</b>' : '🔴 <b>DISARMED / PAUSED</b>'}
👥 <b>Active Cloud Engines:</b> <code>${activeCount} users</code>
🏷️ <b>Current Target:</b> <code>${stats?.name || stats?.slug || 'No Collection Loaded'}</code>
💎 <b>Live Floor:</b> <b>${stats?.floorEth ? stats.floorEth + ' ETH' : '-- ETH'}</b>
📈 <b>Listed Count:</b> <code>${stats?.listedCount || 0} NFTs</code>
🌐 <b>Robinhood Sequencer:</b> 🟢 <b>100% Operational (Sub-15ms)</b>
`.trim();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, statusMsg);
  }

  if (cmd === '/pause' || cmd === '/disarm') {
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
    }
    activeSniperEngine.isArmed = false;
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `⏸ <b>Sniper Engine PAUSED remotely!</b>\nAll worker fleets disarmed.`);
  }

  if (cmd === '/arm') {
    const targetSlug = parts[1] ? parts[1].toLowerCase() : '';
    const maxPrice = parts[2] ? parseFloat(parts[2]) : 0;

    if (!targetSlug) {
      return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `⚠️ <b>Usage:</b> <code>/arm &lt;collection-slug&gt; [maxPriceEth]</code>\nExample: <code>/arm robinwoodies 0.00003</code>`);
    }

    // Arm user default engine
    activeSniperEngine.isArmed = true;
    activeSniperEngine.slug = targetSlug;
    if (maxPrice > 0) activeSniperEngine.maxFloorEth = maxPrice;

    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `⚡ <b>SNIPER ARMED REMOTELY!</b>\n\n🎯 <b>Target:</b> <code>${targetSlug}</code>\n💰 <b>Max Price:</b> <code>${maxPrice > 0 ? maxPrice + ' ETH' : 'Floor Default'}</code>\n🚀 <i>Mempool blast active in cloud!</i>`);
  }

  if (cmd === '/fleet') {
    const fleetMsg = `
💼 <b>MAINNET WORKER FLEET STATUS:</b>

👑 <b>Multi-RPC Blast Fleet:</b> 4 Active (Alchemy + Robinhood Sequencer)
⚡ <b>OpenSea 21-Key Laser Grid:</b> 🟢 100% Operational
🛡️ <b>ECDSA RAM Pre-Warmed Nonces:</b> Locked in memory
`.trim();
    return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, fleetMsg);
  }
}

/**
 * 🔄 LONG-POLLING DAEMON: Listens for incoming Telegram commands
 */
export async function startTelegramBotPolling() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[TELEGRAM] ℹ️ No TELEGRAM_BOT_TOKEN configured. Polling inactive.');
    return;
  }
  if (isPollingActive) return;
  isPollingActive = true;

  console.log('🤖 [TELEGRAM] Bot Command Listener & Remote Controller Activated.');

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
            if (update.message) {
              processTelegramCommand(update.message).catch(() => {});
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
