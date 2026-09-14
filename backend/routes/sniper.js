import express from 'express';
import { ethers } from 'ethers';
import { performance } from 'perf_hooks';
import { config } from '../../src/config.js';
import {
  seaportExecutor,
  rarityEngine,
  dynamicRarityCalc,
  activeSniperEngine,
  setActiveSniperEngine,
  activeCollectionStats,
  walletNonceMap,
  trackKeyUse,
  broadcastToClients,
  broadcastSnipeLog
} from '../state.js';
import { apiClient } from '../openSeaClient.js';
import { dbGetUserById, dbRecordUserSnipe, OWNER_EMAIL } from '../db.js';
import { subscribeSlugToOpenSea } from './stream.js';

const router = express.Router();

/**
 * 🏪 UNIVERSAL RULEBOOK: High-Speed Seaport Fulfillment via 24/7 Rotating API Shop
 * Never locked to a single key. Rotates dynamically across all 6 OpenSea API Keys.
 * If a key returns 429, marks it in 3s cooldown and immediately retries on the next healthy key (<5ms).
 * If OpenSea confirms order is dead/cancelled/expired/invalid, stops immediately and reports isDeadOrder.
 */
export async function fetchSeaportFulfillmentWithShop(orderHash, chain, buyerAddress, tokenId) {
  const candidateKeys = config.opensea.getCandidateKeys();
  let lastErr = null;

  for (let i = 0; i < Math.min(candidateKeys.length, 5); i++) {
    const apiKey = candidateKeys[i];
    const t0 = Date.now();
    try {
      const res = await apiClient.post(`${config.opensea.restApiBase}/listings/fulfillment_data`, {
        listing: {
          hash: orderHash,
          chain: chain || 'robinhood',
          protocol_address: config.seaport.v1_6
        },
        fulfiller: { address: buyerAddress }
      }, {
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        timeout: 3500
      });
      const latency = Date.now() - t0;
      trackKeyUse(apiKey, latency, '200 OK');
      config.opensea.clearKeyCooldown(apiKey);
      return { success: true, data: res.data, apiKey };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status || err.code || 'Timeout';
      const errDetail = err.response?.data?.errors?.join(', ') || err.response?.data?.detail || err.message;
      trackKeyUse(apiKey, Date.now() - t0, `${status}`);

      const isDeadOrder = /not valid|not found|cancelled|expired|inactive/i.test(errDetail) || err.response?.status === 400;
      if (isDeadOrder) {
        return { success: false, isDeadOrder: true, error: errDetail };
      }

      if (status === 429) {
        config.opensea.markKeyCooldown(apiKey, 3000);
        await new Promise(r => setTimeout(r, 80));
        continue;
      }
    }
  }

  const finalDetail = lastErr?.response?.data?.errors?.join(', ') || lastErr?.response?.data?.detail || lastErr?.message || 'All OpenSea API keys failed';
  return { success: false, isDeadOrder: false, error: finalDetail };
}

// ⚡ ZERO-HOP DIRECT SUB-MILLISECOND SNIPE EXECUTION (AEROMINT MULTI-RPC BLAST)
export async function executeZeroHopSnipe(parsed, reason, tTriggerStart) {
  if (!activeSniperEngine.isArmed) return;

  // 🛡️ FEATURE 1: Anti-Drain Circuit Breaker Check
  if (activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit) {
    activeSniperEngine.isArmed = false;
    broadcastSnipeLog(`🛑 [CIRCUIT BREAKER HIT] Max snipes limit reached (${activeSniperEngine.snipesExecutedCount}/${activeSniperEngine.maxSnipesLimit}). Sniper auto-paused.`);
    broadcastToClients({
      type: 'circuit_breaker_paused',
      executed: activeSniperEngine.snipesExecutedCount,
      limit: activeSniperEngine.maxSnipesLimit
    });
    return;
  }

  const tokenId = String(parsed.tokenId);
  if (activeSniperEngine.snipedTokenIds.has(tokenId)) return;
  const protocolData = parsed.protocolData;
  const orderHash = parsed.orderHash || protocolData?.orderHash;
  if (orderHash && activeSniperEngine.invalidOrderHashes && activeSniperEngine.invalidOrderHashes.has(orderHash)) return;

  if (activeSniperEngine.pendingSnipes && activeSniperEngine.pendingSnipes.has(tokenId)) return;
  if (!activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes = new Set();

  if ((!protocolData?.parameters || !protocolData?.signature) && !orderHash) {
    broadcastSnipeLog(`⚠ [SNIPER V2] Cannot snipe #${tokenId}: both protocolData and orderHash are missing!`);
    return;
  }

  // 🛡️ ATOMIC SYNCHRONOUS LOCK: Mark immediately so SSE payload.sniped = true (prevents duplicate frontend dispatch)
  activeSniperEngine.pendingSnipes.add(tokenId);
  activeSniperEngine.snipedTokenIds.add(tokenId);

  broadcastSnipeLog(`🎯 ⚡ [TRIGGER MATCHED] Woodie #${tokenId} at ${parsed.price} ETH [${reason}]`);

  try {
    let currentWorker = activeSniperEngine.walletSigner;
    let buyerAddress = activeSniperEngine.buyerAddress;
    let buyerName = activeSniperEngine.buyerName;

    if (activeSniperEngine.workerPool && activeSniperEngine.workerPool.length > 0) {
      if (activeSniperEngine.workerStrategy === 'round_robin') {
        const w = activeSniperEngine.workerPool[activeSniperEngine.workerIndex % activeSniperEngine.workerPool.length];
        activeSniperEngine.workerIndex++;
        currentWorker = w.signer;
        buyerAddress = w.address;
        buyerName = w.name;
      } else if (!currentWorker) {
        currentWorker = activeSniperEngine.workerPool[0].signer;
        buyerAddress = activeSniperEngine.workerPool[0].address;
        buyerName = activeSniperEngine.workerPool[0].name;
      }
    }

    if (!currentWorker && !activeSniperEngine.dryRun) {
      broadcastSnipeLog(`⚠ [SNIPER V2] No valid worker signer available for execution!`);
      activeSniperEngine.pendingSnipes.delete(tokenId);
      return;
    }

    let txObj = null;

    if (protocolData?.parameters && protocolData?.signature) {
      // Path A: 0ms Instant Direct Seaport Transaction
      broadcastSnipeLog(`⚡ [SEAPORT DIRECT] Building 0ms direct Seaport transaction from protocolData...`);
      try {
        txObj = seaportExecutor.buildSeaportTransaction(
          protocolData,
          buyerAddress || '0x0000000000000000000000000000000000000001',
          activeSniperEngine.gasSpeed || 'turbo',
          activeSniperEngine.customGas
        );
        // ⚡ PREFLIGHT: Quick estimateGas to catch SignedZone/revert before wasting gas
        await seaportExecutor.providers[0].estimateGas({
          ...txObj,
          from: buyerAddress
        });
      } catch (pathAErr) {
        // Path A would revert — fallback to Path B (Fulfillment API with extraData)
        broadcastSnipeLog(`⚠ [PATH A REVERT] Direct Seaport would revert: ${pathAErr.message?.slice(0, 80)}. Falling back to Fulfillment API...`);
        txObj = null; // Reset — let Path B handle it
      }
    }

    if (!txObj && orderHash) {
      // Path B: OpenSea Fulfillment API Fallback via Rotating 24/7 API Shop
      broadcastSnipeLog(`📡 [SEAPORT FULFILLMENT] Fetching OpenSea Seaport calldata for hash ${orderHash.slice(0, 14)}... via 24/7 API Shop...`);
      const fulRes = await fetchSeaportFulfillmentWithShop(orderHash, parsed.chain || 'robinhood', buyerAddress, tokenId);
      if (!fulRes.success) {
        if (fulRes.isDeadOrder) {
          if (orderHash) activeSniperEngine.invalidOrderHashes.add(orderHash);
          activeSniperEngine.snipedTokenIds.add(tokenId);
          broadcastSnipeLog(`ℹ [ORDER INACTIVE] #${tokenId} (${orderHash ? orderHash.slice(0, 14) + '...' : ''}) is no longer active on OpenSea (cancelled/filled). Blacklisted.`);
        } else {
          broadcastSnipeLog(`❌ [FULFILLMENT ERROR] OpenSea returned error for #${tokenId}: ${fulRes.error}`);
        }
        activeSniperEngine.pendingSnipes.delete(tokenId);
        return;
      }

      if (!fulRes.data?.fulfillment_data?.transaction) {
        broadcastSnipeLog(`❌ [FULFILLMENT ERROR] OpenSea returned no fulfillment transaction for #${tokenId}`);
        activeSniperEngine.pendingSnipes.delete(tokenId);
        return;
      }

      const txData = fulRes.data.fulfillment_data.transaction;
      let calldata;

      // ⚡ BEST PATH: Use pre-encoded calldata from OpenSea directly (zero encoding needed)
      if (txData.data && txData.data.length > 10) {
        calldata = txData.data;
      } else {
        // 🔍 DEBUG: Log actual API response structure for diagnosis
        broadcastSnipeLog(`🔍 [DEBUG] txData keys: ${JSON.stringify(Object.keys(txData))}`);
        broadcastSnipeLog(`🔍 [DEBUG] input_data keys: ${JSON.stringify(Object.keys(txData.input_data || {}))}`);
        broadcastSnipeLog(`🔍 [DEBUG] function: ${txData.function}`);

        // RESILIENT: Try multiple field name patterns from OpenSea API
        const fnName = txData.function.split('(')[0];
        try {
          if (fnName === 'fulfillAdvancedOrder') {
            // OpenSea may use "order", "advancedOrder", or "parameters" as the key
            const advOrder = txData.input_data.order || txData.input_data.advancedOrder || txData.input_data.parameters;
            const criteria = txData.input_data.criteriaResolvers || txData.input_data.criteria_resolvers || [];
            const conduit = txData.input_data.fulfillerConduitKey || txData.input_data.fulfiller_conduit_key || ethers.ZeroHash;
            const recip = txData.input_data.recipient || buyerAddress;

            if (!advOrder) {
              // Last resort: try passing entire input_data as positional args
              broadcastSnipeLog(`🔍 [DEBUG] advOrder null. Full input_data: ${JSON.stringify(txData.input_data).slice(0, 500)}`);
              activeSniperEngine.pendingSnipes.delete(tokenId);
              return;
            }
            calldata = seaportExecutor.seaportInterface.encodeFunctionData(fnName, [advOrder, criteria, conduit, recip]);
          } else {
            calldata = seaportExecutor.seaportInterface.encodeFunctionData(fnName, [txData.input_data.parameters || txData.input_data.order]);
          }
        } catch (encErr) {
          broadcastSnipeLog(`❌ [SEAPORT ABI ERROR] Failed to encode ${fnName}: ${encErr.message}`);
          broadcastSnipeLog(`🔍 [DEBUG] input_data dump: ${JSON.stringify(txData.input_data).slice(0, 800)}`);
          activeSniperEngine.pendingSnipes.delete(tokenId);
          return;
        }
      }
      if (txData.calldata_suffix && !calldata.includes(txData.calldata_suffix.replace('0x', ''))) {
        calldata += txData.calldata_suffix.replace('0x', '');
      }

      let gasPrice;
      if (activeSniperEngine.customGas?.customMaxFeeGwei && parseFloat(activeSniperEngine.customGas.customMaxFeeGwei) > 0) {
        gasPrice = ethers.parseUnits(String(activeSniperEngine.customGas.customMaxFeeGwei), 'gwei');
      } else {
        const gasSpeed = activeSniperEngine.gasSpeed || 'turbo';
        let gasMultiplier = 175n;
        if (gasSpeed === 'surge') gasMultiplier = 235n;
        if (gasSpeed === 'hyped') gasMultiplier = 300n;
        gasPrice = (seaportExecutor.cachedBaseFee * gasMultiplier) / 100n;
      }

      txObj = {
        to: txData.to,
        data: calldata,
        value: BigInt(txData.value || '0'),
        gasLimit: 260000n,
        gasPrice: gasPrice,
        type: 0 // Legacy Type 0 for Robinhood L2
      };
    }

    if (!txObj) {
      broadcastSnipeLog(`❌ [SNIPER V2] Failed to construct transaction for #${tokenId}`);
      activeSniperEngine.pendingSnipes.delete(tokenId);
      return;
    }

    const isSim = activeSniperEngine.dryRun;
    let txHash = '';

    if (isSim) {
      const simulatedLatency = Math.floor(Math.random() * 3) + 1;
      txHash = '0xsimulated_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
      broadcastSnipeLog(`🧪 [PAPER SNIPE] Token #${tokenId} simulated in ${simulatedLatency}ms! MockTx: ${txHash}`);
    } else {
      broadcastSnipeLog(`➔ [RAM SIGN & BLAST] Broadcasting transaction for #${tokenId} (Worker: ${buyerName} - ${buyerAddress.slice(0, 6)}...)...`);
      
      const txResponse = await currentWorker.sendTransaction(txObj);
      txHash = txResponse.hash;
      const tSigned = performance.now();
      const latencyMs = (tSigned - tTriggerStart).toFixed(2);
      
      broadcastSnipeLog(`🚀 [MEMPOOL ACCEPTED] TxHash: ${txHash} (${latencyMs}ms) ➔ Mining on Robinhood Chain...`);

      // Track receipt in background
      txResponse.wait(1).then(receipt => {
        if (receipt) {
          broadcastSnipeLog(`🎉 [ON-CHAIN CONFIRMED] Block #${receipt.blockNumber}! Token #${tokenId} secured by ${buyerName} (Tx: ${txHash.slice(0, 14)}...)!`);
          broadcastToClients({
            type: 'zero_hop_snipe_confirmed',
            slug: activeSniperEngine.slug,
            tokenId: tokenId,
            price: parsed.price,
            buyerName: buyerName,
            txHash: txHash,
            blockNumber: receipt.blockNumber,
            timestamp: Date.now()
          });
        }
      }).catch(e => {
        broadcastSnipeLog(`❌ [TX REVERTED] Block revert for #${tokenId}: ${e.message}`);
        activeSniperEngine.snipedTokenIds.delete(tokenId);
      });
    }

    // Now that tx is broadcasted on-chain, mark as sniped and count
    activeSniperEngine.snipedTokenIds.add(tokenId);
    activeSniperEngine.snipesExecutedCount++;

    broadcastToClients({
      type: isSim ? 'paper_snipe_broadcast' : 'zero_hop_snipe_broadcast',
      slug: activeSniperEngine.slug,
      tokenId: tokenId,
      name: parsed.name,
      price: parsed.price,
      priceFormatted: parsed.priceFormatted,
      buyerName: buyerName,
      txHash: txHash,
      computeLatencyMs: (performance.now() - tTriggerStart).toFixed(2),
      isDryRun: isSim,
      snipesExecuted: activeSniperEngine.snipesExecutedCount,
      maxLimit: activeSniperEngine.maxSnipesLimit,
      reason: reason,
      timestamp: Date.now()
    });

    // Auto-pause if max limit reached
    if (activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit) {
      activeSniperEngine.isArmed = false;
      broadcastSnipeLog(`🛑 [CIRCUIT BREAKER] Completed ${activeSniperEngine.snipesExecutedCount} of ${activeSniperEngine.maxSnipesLimit} allowed snipes. Auto-disarmed.`);
      broadcastToClients({
        type: 'circuit_breaker_paused',
        executed: activeSniperEngine.snipesExecutedCount,
        limit: activeSniperEngine.maxSnipesLimit
      });
    }

  } catch (err) {
    if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokenId);
    activeSniperEngine.snipedTokenIds.delete(tokenId);
    broadcastSnipeLog(`❌ [ZERO-HOP SNIPE ERROR] Token #${tokenId}: ${err.message}`);
  }
}

/**
 * 🛡️ UNIVERSAL VIP SUBSCRIPTION GUARD & AUTO-DISARM WATCHDOG
 * If the user's validity expires while sniper is armed in memory:
 * Instantly auto-disarms, purges private keys from RAM, clears nonces, and notifies clients.
 */
export function checkAndEnforceUserValidity() {
  if (!activeSniperEngine.isArmed) return true;
  if (!activeSniperEngine.authenticatedUserId) return true;
  if (activeSniperEngine.userEmail && activeSniperEngine.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase()) return true;

  if (activeSniperEngine.userValidUntil) {
    const exp = new Date(activeSniperEngine.userValidUntil).getTime();
    if (Date.now() >= exp) {
      console.log(`⏳ [SNIPER AUTO-DISARM] User VIP subscription expired (${activeSniperEngine.userValidUntil}). Auto-disarming sniper...`);
      activeSniperEngine.isArmed = false;
      activeSniperEngine.walletSigner = null;
      activeSniperEngine.buyerPrivateKey = '';
      if (activeSniperEngine.workerPool && activeSniperEngine.workerPool.length > 0) {
        activeSniperEngine.workerPool.forEach(w => { delete w.privateKey; w.signer = null; });
      }
      walletNonceMap.clear();
      broadcastSnipeLog(`⏳ [AUTO-DISARMED] VIP subscription expired! Background sniper engine stopped.`);
      broadcastToClients({
        type: 'sniper_disarmed',
        reason: 'subscription_expired'
      });
      return false;
    }
  }
  return true;
}

// 🛡️ Continuous 5-Second Background Watchdog
setInterval(() => {
  try {
    checkAndEnforceUserValidity();
  } catch (e) {}
}, 5000);

// ⚡ MICROSECOND ZERO-HOP SNIPER TRIGGER EVALUATOR (ALL 4 RULES ENFORCED)
export async function evaluateAndSnipe(parsed, incomingSlug, tTriggerStart = performance.now()) {
  if (!parsed || !parsed.tokenId) return;
  const itemSlug = (parsed.slug || incomingSlug || '').toLowerCase();

  if (!activeSniperEngine.isArmed) return;
  if (!checkAndEnforceUserValidity()) return;
  if (activeSniperEngine.slug !== '*' && activeSniperEngine.slug !== itemSlug) return;

  // 🛡️ Circuit Breaker guard
  if (activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit) {
    activeSniperEngine.isArmed = false;
    return;
  }

  const tokenIdStr = String(parsed.tokenId);
  if (activeSniperEngine.snipedTokenIds.has(tokenIdStr)) return;

  const orderHash = parsed.orderHash || parsed.protocolData?.orderHash;
  if (orderHash && activeSniperEngine.invalidOrderHashes && activeSniperEngine.invalidOrderHashes.has(orderHash)) return;

  // 🛡️ VALID SEAPORT ORDER GUARD: Skip incomplete listings that lack both orderHash and parameters
  const hasOrderHash = Boolean(orderHash && orderHash.length > 10);
  const hasProtocolParams = Boolean(parsed.protocolData?.parameters && parsed.protocolData?.signature);
  if (!hasOrderHash && !hasProtocolParams) {
    return; // Wait until order hash or protocol data is populated by OpenSea
  }

  let triggered = false;
  let reason = '';

  // 🎯 RULE 4: SPECIFIC TOKEN ID TRAP (HIGHEST PRIORITY)
  const isTokenIdActive = activeSniperEngine.ruleStates?.tokenId !== undefined
    ? Boolean(activeSniperEngine.ruleStates.tokenId)
    : Boolean(activeSniperEngine.specificTokenIds && activeSniperEngine.specificTokenIds.size > 0);
  const cleanTokenId = String(parsed.tokenId || '').trim().replace(/[^0-9]/g, '');
  if (isTokenIdActive && cleanTokenId && activeSniperEngine.specificTokenIds && activeSniperEngine.specificTokenIds.has(cleanTokenId)) {
    const maxEth = activeSniperEngine.specificTokenMaxEth > 0
      ? activeSniperEngine.specificTokenMaxEth
      : (activeSniperEngine.maxFloorEth > 0 ? activeSniperEngine.maxFloorEth : Infinity);
    if (parsed.price <= maxEth) {
      triggered = true;
      reason = `🎯 Target Token #${cleanTokenId}: ${parsed.price} ETH <= Cap ${maxEth === Infinity ? 'Market' : maxEth + ' ETH'}`;
    }
  }

  // 👑 RULE 3: RARE TRAIT HUNTER (PRIORITY 2 - MULTI-TRAIT & DYNAMIC RESOLUTION)
  const isTraitActive = activeSniperEngine.ruleStates?.trait !== undefined
    ? Boolean(activeSniperEngine.ruleStates.trait)
    : Boolean((activeSniperEngine.traitFilters && activeSniperEngine.traitFilters.length > 0) || activeSniperEngine.traitFilter);
  if (!triggered && isTraitActive && (activeSniperEngine.traitFilter || (activeSniperEngine.traitFilters && activeSniperEngine.traitFilters.length > 0))) {
    const maxEth = activeSniperEngine.traitMaxEth > 0
      ? activeSniperEngine.traitMaxEth
      : (activeSniperEngine.traitFilter?.maxEth > 0
          ? activeSniperEngine.traitFilter.maxEth
          : (activeSniperEngine.maxFloorEth > 0 ? activeSniperEngine.maxFloorEth : Infinity));
    if (parsed.price <= maxEth) {
      const filters = (activeSniperEngine.traitFilters && activeSniperEngine.traitFilters.length > 0)
        ? activeSniperEngine.traitFilters
        : (activeSniperEngine.traitFilter ? [activeSniperEngine.traitFilter] : []);

      let matchedFilterName = '';

      // ⚡ FAST PATH 1: 0.0ms INSTANT RAM TRAIT INDEX MATCH
      const instantRamMatch = filters.some(f => {
        if (rarityEngine.hasTraitSync(parsed.tokenId, f.traitType, f.traitValue)) {
          matchedFilterName = `${f.traitType || 'Any'}: ${f.traitValue}`;
          return true;
        }
        return false;
      });

      if (instantRamMatch) {
        triggered = true;
        reason = `👑 Trait Match [${matchedFilterName}]: ${parsed.price} ETH <= Cap ${maxEth === Infinity ? 'Market' : maxEth + ' ETH'} (⚡ 0ms RAM Index)`;
      } else {
        // FAST PATH 2: Check traits from parsed event or cached token info
        let itemTraits = parsed.traits || parsed.rawEvent?.payload?.item?.metadata?.traits || parsed.rawEvent?.payload?.item?.traits || [];
        if (!itemTraits || itemTraits.length === 0) {
          const cachedInfo = rarityEngine.getTokenInfoSync(parsed.tokenId);
          if (cachedInfo?.traits && cachedInfo.traits.length > 0) {
            itemTraits = cachedInfo.traits;
          } else {
            // 🔥 NON-BLOCKING: Fire background fetch, don't delay trigger pipeline
            const streamContract = parsed.contractAddress || rarityEngine.contractAddress;
            const streamChain = parsed.chain || rarityEngine.chain || 'robinhood';
            rarityEngine.fetchTokenRarity(parsed.tokenId, streamChain, streamContract).catch(() => {});
            // Traits will be in RAM on next event for this token
          }
        }

        const match = filters.some(f => {
          const targetType = (f.traitType || '').trim().toLowerCase();
          const targetVal = (f.traitValue || '').trim().toLowerCase();
          const found = itemTraits.some(t => {
            const tType = String(t.trait_type || t.traitType || t.type || '').trim().toLowerCase();
            const tVal = String(t.value !== undefined ? t.value : (t.val !== undefined ? t.val : '')).trim().toLowerCase();
            return (!targetType || tType === targetType) && (!targetVal || tVal === targetVal);
          });
          if (found) {
            matchedFilterName = `${f.traitType || 'Any'}: ${f.traitValue}`;
            return true;
          }
          return false;
        });

        if (match) {
          triggered = true;
          reason = `👑 Trait Match [${matchedFilterName}]: ${parsed.price} ETH <= Cap ${maxEth === Infinity ? 'Market' : maxEth + ' ETH'}`;
        }
      }
    }
  }

  // ⚡ RULE 1: FLOOR UNDERPRICE TRAP (PRIORITY 3)
  if (!triggered && activeSniperEngine.ruleStates?.floor && activeSniperEngine.maxFloorEth > 0) {
    if (parsed.price <= activeSniperEngine.maxFloorEth) {
      triggered = true;
      reason = `⚡ Floor Fat-Finger: ${parsed.price} ETH <= Target ${activeSniperEngine.maxFloorEth} ETH`;
    }
  }

  // 👑 RULE 2: TOP RARITY RANK SNIPE (PRIORITY 4) — 0.01ms INSTANT RANK CHECK
  const maxRareCap = activeSniperEngine.maxRareEth > 0
    ? activeSniperEngine.maxRareEth
    : (activeSniperEngine.maxFloorEth > 0 ? activeSniperEngine.maxFloorEth : 0);
  if (!triggered && activeSniperEngine.ruleStates?.rarity && maxRareCap > 0) {
    let rank = rarityEngine.getRaritySync(parsed.tokenId);

    // ⚡ INSTANT FALLBACK: DynamicRarityCalculator IC-based estimated rank (0.01ms, ZERO API calls)
    if (rank === null && dynamicRarityCalc.isReady && parsed.traits?.length > 0) {
      const { estimatedRank } = dynamicRarityCalc.scoreAndEstimateRank(parsed.tokenId, parsed.traits);
      if (estimatedRank > 0) rank = estimatedRank;
    }

    // ⚡ SHORT-TIMEOUT RANK FETCH: 200ms max (Vercel US → OpenSea US = ~50ms)
    if (rank === null) {
      const streamContract = parsed.contractAddress || rarityEngine.contractAddress;
      const streamChain = parsed.chain || rarityEngine.chain || 'robinhood';
      try {
        const resolved = await Promise.race([
          rarityEngine.fetchTokenRarity(parsed.tokenId, streamChain, streamContract),
          new Promise((_, rej) => setTimeout(() => rej('timeout'), 800))
        ]);
        if (resolved?.rank > 0) rank = resolved.rank;
      } catch {} // Timeout — proceed without rank, backend stream-js will retry later
    }

    if (rank && rank <= activeSniperEngine.maxRareRank && parsed.price <= maxRareCap) {
      triggered = true;
      reason = `👑 Top Rarity #${rank} at ${parsed.price} ETH <= Target ${maxRareCap} ETH`;
    }
  }

  if (triggered) {
    console.log(`🎯 [SNIPER TRIGGERED] ${reason} on #${parsed.tokenId}`);
    executeZeroHopSnipe(parsed, reason, tTriggerStart);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// POST /api/snipe/arm
router.post('/snipe/arm', async (req, res) => {
  const {
    slug,
    triggerMode,
    maxFloorEth,
    maxRareRank,
    maxRareEth,
    gasSpeed,
    customGas,
    buyerPrivateKey,
    buyerName,
    workers,
    workerStrategy,
    maxSnipesLimit,
    dryRun,
    specificTokenIds,
    specificTokenMaxEth,
    traitFilter,
    traitFilters,
    traitMaxEth,
    ruleStates,
    userId
  } = req.body;

  let armedDbUser = null;
  // License & Subscription Verification Guard
  if (userId) {
    try {
      armedDbUser = await dbGetUserById(userId);
      if (armedDbUser) {
        if (armedDbUser.is_banned) {
          return res.status(403).json({ success: false, error: '🚫 Account suspended by Administrator.' });
        }
        if (armedDbUser.valid_until && new Date(armedDbUser.valid_until) < new Date() && armedDbUser.email !== OWNER_EMAIL) {
          return res.status(403).json({ success: false, error: `⏳ VIP Validity expired on ${new Date(armedDbUser.valid_until).toLocaleDateString()}. Please renew.` });
        }
      }
    } catch (e) {}
  }

  if (!buyerPrivateKey && !dryRun) {
    return res.status(400).json({ success: false, error: 'Buyer wallet private key is required' });
  }

  try {
    const provider = seaportExecutor.providers[0];
    let signer = null;
    let buyerAddress = '0x0000000000000000000000000000000000000001';

    if (buyerPrivateKey) {
      const cleanPk = buyerPrivateKey.trim();
      signer = new ethers.Wallet(cleanPk, provider);
      buyerAddress = signer.address;
    }

    // Build worker pool for multi-worker strategy
    const workerPool = [];
    if (Array.isArray(workers) && workers.length > 0) {
      workers.forEach(w => {
        if (w.privateKey) {
          try {
            const s = new ethers.Wallet(w.privateKey.trim(), provider);
            workerPool.push({
              signer: s,
              address: s.address,
              name: w.name || 'Worker',
              privateKey: w.privateKey.trim()
            });
          } catch(e) {}
        }
      });
    }
    if (workerPool.length === 0 && signer) {
      workerPool.push({ signer, address: buyerAddress, name: buyerName || 'Worker', privateKey: buyerPrivateKey });
    }

    // Parse specific token IDs set with regex split and full sanitization
    const tokenSet = new Set();
    if (specificTokenIds) {
      const items = Array.isArray(specificTokenIds) 
        ? specificTokenIds 
        : String(specificTokenIds).split(/[\s,]+/);
      items.forEach(id => {
        const clean = String(id).trim().replace(/[^0-9]/g, '');
        if (clean) tokenSet.add(clean);
      });
    }

    activeSniperEngine.isArmed = true;
    activeSniperEngine.armedTimestamp = Date.now();
    activeSniperEngine.slug = (slug || '*').trim().toLowerCase();
    activeSniperEngine.triggerMode = triggerMode || 'both';
    activeSniperEngine.maxFloorEth = parseFloat(maxFloorEth) || 0;
    activeSniperEngine.maxRareRank = parseInt(maxRareRank, 10) || 1200;
    activeSniperEngine.maxRareEth = parseFloat(maxRareEth) || 0;
    activeSniperEngine.gasSpeed = gasSpeed || 'turbo';
    activeSniperEngine.customGas = customGas || null;
    activeSniperEngine.buyerPrivateKey = buyerPrivateKey || '';
    activeSniperEngine.buyerAddress = buyerAddress;
    activeSniperEngine.buyerName = buyerName || 'Worker';
    activeSniperEngine.walletSigner = signer;
    activeSniperEngine.snipedTokenIds = new Set();
    activeSniperEngine.invalidOrderHashes = new Set();
    activeSniperEngine.pendingSnipes = new Set();

    activeSniperEngine.maxSnipesLimit = (maxSnipesLimit !== undefined && maxSnipesLimit !== null) ? parseInt(maxSnipesLimit, 10) : 1;
    activeSniperEngine.snipesExecutedCount = 0;
    activeSniperEngine.specificTokenIds = tokenSet;
    activeSniperEngine.specificTokenMaxEth = parseFloat(specificTokenMaxEth) || 0;
    activeSniperEngine.traitFilter = (traitFilter && (traitFilter.traitType || traitFilter.traitValue)) ? {
      traitType: (traitFilter.traitType || '').trim(),
      traitValue: (traitFilter.traitValue || '').trim(),
      maxEth: parseFloat(traitFilter.maxEth) || 0
    } : null;
    activeSniperEngine.traitFilters = Array.isArray(traitFilters) ? traitFilters.map(f => ({
      traitType: String(f.traitType || '').trim(),
      traitValue: String(f.traitValue || '').trim()
    })).filter(f => f.traitType || f.traitValue) : [];
    activeSniperEngine.traitMaxEth = parseFloat(traitMaxEth) || (traitFilter?.maxEth ? parseFloat(traitFilter.maxEth) : 0);
    activeSniperEngine.dryRun = !!dryRun;
    activeSniperEngine.workerStrategy = workerStrategy || 'single';
    activeSniperEngine.workerPool = workerPool;
    activeSniperEngine.workerIndex = 0;
    activeSniperEngine.ruleStates = {
      floor: ruleStates?.floor !== false,
      rarity: ruleStates?.rarity !== false,
      trait: !!ruleStates?.trait || (Array.isArray(traitFilters) && traitFilters.length > 0) || !!traitFilter,
      tokenId: !!ruleStates?.tokenId || (tokenSet.size > 0)
    };
    activeSniperEngine.authenticatedUserId = userId || null;
    activeSniperEngine.userValidUntil = armedDbUser ? armedDbUser.valid_until : null;
    activeSniperEngine.userEmail = armedDbUser ? armedDbUser.email : '';

    console.log(`🎯 ⚡ [SNIPER ARMED - 8-FEATURE PRO ENGINE]`);
    console.log(`   Target Slug: "${activeSniperEngine.slug}" | Mode: ${activeSniperEngine.dryRun ? '🧪 PAPER SNIPE (SIMULATED)' : '⚡ LIVE MAINNET'}`);
    console.log(`   Limit: ${activeSniperEngine.maxSnipesLimit === 0 ? 'Unlimited' : activeSniperEngine.maxSnipesLimit + ' Snipes'} | Workers: ${workerPool.length} (${activeSniperEngine.workerStrategy})`);
    console.log(`   Rules: Floor=${activeSniperEngine.ruleStates.floor} | Rarity=${activeSniperEngine.ruleStates.rarity} | Trait=${activeSniperEngine.ruleStates.trait} | TokenTrap=${activeSniperEngine.ruleStates.tokenId}`);

    if (activeSniperEngine.slug && activeSniperEngine.slug !== '*') {
      subscribeSlugToOpenSea(activeSniperEngine.slug);
    }

    // ⚡ PRE-WARM ATOMIC NONCES & RPC SOCKETS IN RAM
    seaportExecutor.preWarmConnections().catch(() => {});
    const activeProvider = seaportExecutor.providers[0];
    if (activeProvider && Array.isArray(workerPool)) {
      for (const w of workerPool) {
        if (w.address) {
          activeProvider.getTransactionCount(w.address, 'pending').then(n => {
            walletNonceMap.set(w.address, n);
            console.log(`⚡ [RAM NONCE PRE-WARMED] ${w.name || 'Worker'} (${w.address.slice(0, 6)}...): Nonce ${n} locked in RAM`);
          }).catch(() => {});
        }
      }
    }

    res.json({
      success: true,
      message: 'Ultra-Fast 8-Feature Sniper Engine ARMED in Node.js backend memory',
      buyerAddress: buyerAddress,
      targetSlug: activeSniperEngine.slug,
      isDryRun: activeSniperEngine.dryRun,
      workersLoaded: workerPool.length,
      maxLimit: activeSniperEngine.maxSnipesLimit
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/snipe/telemetry
router.get('/snipe/telemetry', (req, res) => {
  res.json({
    success: true,
    isArmed: activeSniperEngine.isArmed,
    snipesExecutedCount: activeSniperEngine.snipesExecutedCount,
    maxSnipesLimit: activeSniperEngine.maxSnipesLimit,
    dryRun: activeSniperEngine.dryRun,
    targetSlug: activeSniperEngine.slug,
    workerStrategy: activeSniperEngine.workerStrategy,
    workersCount: activeSniperEngine.workerPool ? activeSniperEngine.workerPool.length : 1,
    ruleStates: activeSniperEngine.ruleStates,
    activeCollectionStats: activeCollectionStats,
    timestamp: Date.now()
  });
});

// POST /api/snipe/disarm
router.post('/snipe/disarm', (req, res) => {
  activeSniperEngine.isArmed = false;
  activeSniperEngine.walletSigner = null;
  activeSniperEngine.buyerPrivateKey = '';
  if (activeSniperEngine.workerPool && activeSniperEngine.workerPool.length > 0) {
    activeSniperEngine.workerPool.forEach(w => { delete w.privateKey; w.signer = null; });
  }
  walletNonceMap.clear();
  console.log(`⏸ [SNIPER V2 DISARMED] Keys purged from RAM.`);
  res.json({ success: true, message: 'Sniper Engine Disarmed & Keys Purged' });
});

// POST /api/snipe/buy
router.post('/snipe/buy', async (req, res) => {
  const { buyerPrivateKey, protocolData, orderHash, tokenId, gasSpeed, workerIndex } = req.body;

  let signer = null;
  let buyerAddress = '';
  const provider = seaportExecutor.providers[0];

  if (activeSniperEngine.workerPool && activeSniperEngine.workerPool.length > 0) {
    const idx = (typeof workerIndex === 'number' && workerIndex < activeSniperEngine.workerPool.length) ? workerIndex : 0;
    const worker = activeSniperEngine.workerPool[idx];
    if (worker && worker.signer) {
      signer = worker.signer;
      buyerAddress = worker.address || signer.address;
    }
  }

  if (!signer && buyerPrivateKey) {
    signer = new ethers.Wallet(buyerPrivateKey, provider);
    buyerAddress = signer.address;
  }

  if (!signer) {
    return res.status(400).json({ success: false, error: 'No armed worker wallet available. Arm the sniper first or provide a buyer key.' });
  }

  const tokIdStr = String(tokenId || '');
  if (!activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes = new Set();
  if (!activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds = new Set();

  if (tokIdStr) {
    if (activeSniperEngine.pendingSnipes.has(tokIdStr) || activeSniperEngine.snipedTokenIds.has(tokIdStr)) {
      return res.json({
        success: true,
        alreadyProcessing: true,
        message: `Token #${tokIdStr} is already being processed by zero-hop engine.`
      });
    }
    // 🛡️ ATOMIC SYNCHRONOUS LOCK: Claim token in RAM immediately to block concurrent backend dispatch
    activeSniperEngine.pendingSnipes.add(tokIdStr);
    activeSniperEngine.snipedTokenIds.add(tokIdStr);
  }

  try {
    const handleSnipeSuccess = (txHash, blockNumber) => {
      if (tokIdStr && activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
      if (tokenId) activeSniperEngine.snipedTokenIds.add(String(tokenId));
      activeSniperEngine.snipesExecutedCount++;

      const isCircuitBreakerHit = activeSniperEngine.maxSnipesLimit > 0 && activeSniperEngine.snipesExecutedCount >= activeSniperEngine.maxSnipesLimit;
      if (isCircuitBreakerHit) {
        activeSniperEngine.isArmed = false;
        broadcastSnipeLog(`🛑 [CIRCUIT BREAKER] Completed ${activeSniperEngine.snipesExecutedCount} of ${activeSniperEngine.maxSnipesLimit} allowed snipes. Auto-disarmed.`);
        broadcastToClients({
          type: 'circuit_breaker_paused',
          executed: activeSniperEngine.snipesExecutedCount,
          limit: activeSniperEngine.maxSnipesLimit
        });
      }

      return {
        isCircuitBreakerHit,
        snipesExecuted: activeSniperEngine.snipesExecutedCount,
        maxLimit: activeSniperEngine.maxSnipesLimit
      };
    };

    // 1. Direct Seaport protocol_data execution if provided
    if (protocolData?.parameters && protocolData?.signature) {
      const txObj = seaportExecutor.buildSeaportTransaction(protocolData, buyerAddress, gasSpeed || 'turbo');
      const tx = await signer.sendTransaction(txObj);

      // 🛡️ Permanent atomic lock so neither frontend nor backend double-snipes
      if (tokIdStr) activeSniperEngine.snipedTokenIds.add(tokIdStr);

      const cbStatus = handleSnipeSuccess(tx.hash, null);

      // Background confirmation tracking
      tx.wait(1).then(receipt => {
        if (receipt) {
          broadcastSnipeLog(`🎉 [ON-CHAIN CONFIRMED] Block #${receipt.blockNumber}! Token #${tokenId} secured!`);
          broadcastToClients({
            type: 'zero_hop_snipe_confirmed',
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            tokenId
          });
        }
      }).catch(() => {});

      return res.json({
        success: true,
        txHash: tx.hash,
        mempoolAccepted: true,
        buyer: buyerAddress,
        tokenId,
        circuitBreakerHit: cbStatus.isCircuitBreakerHit,
        executedCount: cbStatus.snipesExecuted,
        maxLimit: cbStatus.maxLimit
      });
    }

    // 2. Fallback to OpenSea Fulfillment API using 24/7 API Shop
    const hashToFulfill = orderHash || protocolData?.orderHash;
    if (hashToFulfill) {
      const fulRes = await fetchSeaportFulfillmentWithShop(hashToFulfill, 'robinhood', buyerAddress, tokenId);
      if (!fulRes.success) {
        if (fulRes.isDeadOrder) {
          if (hashToFulfill && activeSniperEngine.invalidOrderHashes) {
            activeSniperEngine.invalidOrderHashes.add(hashToFulfill);
          }
          if (tokenId && activeSniperEngine.snipedTokenIds) {
            activeSniperEngine.snipedTokenIds.add(String(tokenId));
          }
        } else {
          if (tokIdStr) {
            if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
            if (activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds.delete(tokIdStr);
          }
        }
        return res.status(400).json({
          success: false,
          isDeadOrder: fulRes.isDeadOrder,
          error: `OpenSea Fulfillment API: ${fulRes.error}`
        });
      }

      if (fulRes.data?.fulfillment_data?.transaction) {
        const txData = fulRes.data.fulfillment_data.transaction;
        const fnName = txData.function.split('(')[0];
        let calldata = seaportExecutor.seaportInterface.encodeFunctionData(fnName, [txData.input_data.parameters]);
        if (txData.calldata_suffix) calldata += txData.calldata_suffix.replace('0x', '');

        const txObj = {
          to: txData.to,
          data: calldata,
          value: BigInt(txData.value || '0'),
          gasLimit: 260000n,
          gasPrice: (seaportExecutor.cachedBaseFee * 235n) / 100n,
          type: 0
        };

        const tx = await signer.sendTransaction(txObj);
        
        if (tokIdStr) activeSniperEngine.snipedTokenIds.add(tokIdStr);
        const cbStatus = handleSnipeSuccess(tx.hash, null);

        tx.wait(1).then(receipt => {
          if (receipt) {
            broadcastSnipeLog(`🎉 [ON-CHAIN CONFIRMED] Block #${receipt.blockNumber}! Token #${tokenId} secured!`);
            broadcastToClients({
              type: 'zero_hop_snipe_confirmed',
              txHash: tx.hash,
              blockNumber: receipt.blockNumber,
              tokenId
            });
          }
        }).catch(() => {});

        return res.json({
          success: true,
          txHash: tx.hash,
          mempoolAccepted: true,
          buyer: buyerAddress,
          tokenId,
          circuitBreakerHit: cbStatus.isCircuitBreakerHit,
          executedCount: cbStatus.snipesExecuted,
          maxLimit: cbStatus.maxLimit
        });
      }
    }

    if (tokIdStr) {
      if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
      if (activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds.delete(tokIdStr);
    }
    return res.status(400).json({ success: false, error: 'Missing protocol order data or order hash' });
  } catch (err) {
    if (tokIdStr) {
      if (activeSniperEngine.pendingSnipes) activeSniperEngine.pendingSnipes.delete(tokIdStr);
      if (activeSniperEngine.snipedTokenIds) activeSniperEngine.snipedTokenIds.delete(tokIdStr);
    }
    const errDetail = err.response?.data?.errors?.join(', ') || err.response?.data?.detail || err.message;
    return res.status(500).json({ success: false, error: errDetail });
  }
});

// ⚡ POST /api/snipe/evaluate — INSTANT FRONTEND-TO-BACKEND TRIGGER RELAY
// Frontend direct WebSocket detects listing ~3s BEFORE backend @opensea/stream-js.
// This endpoint lets frontend instantly relay the parsed listing for sub-ms evaluation.
router.post('/snipe/evaluate', async (req, res) => {
  if (!activeSniperEngine.isArmed) return res.json({ triggered: false, reason: 'not_armed' });
  const parsed = req.body;
  if (!parsed || !parsed.tokenId) return res.json({ triggered: false, reason: 'no_data' });
  const tStart = performance.now();
  await evaluateAndSnipe(parsed, (parsed.slug || '').toLowerCase(), tStart);
  res.json({ triggered: true, tokenId: parsed.tokenId, evaluateMs: (performance.now() - tStart).toFixed(2) });
});

export default router;
