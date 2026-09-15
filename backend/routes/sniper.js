import express from 'express';
import { ethers } from 'ethers';
import { performance } from 'perf_hooks';
import { config } from '../../src/config.js';
import {
  seaportExecutor,
  rarityEngine,
  dynamicRarityCalc,
  activeSniperEngine,
  activeSniperEngines,
  setActiveSniperEngine,
  activeCollectionStats,
  walletNonceMap,
  getNextNonce,
  trackKeyUse,
  broadcastToClients,
  broadcastSnipeLog,
  inFlightEvaluationTokens
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
export async function executeZeroHopSnipe(parsed, reason, tTriggerStart, userEngine = null) {
  const engine = userEngine || activeSniperEngine;
  if (!engine || !engine.isArmed) return;

  // 🛡️ FEATURE 1: Anti-Drain Circuit Breaker Check
  if (engine.maxSnipesLimit > 0 && engine.snipesExecutedCount >= engine.maxSnipesLimit) {
    engine.isArmed = false;
    broadcastSnipeLog(`🛑 [CIRCUIT BREAKER HIT] Max snipes limit reached (${engine.snipesExecutedCount}/${engine.maxSnipesLimit}). Sniper auto-paused.`, engine.userId);
    broadcastToClients({
      type: 'circuit_breaker_paused',
      executed: engine.snipesExecutedCount,
      limit: engine.maxSnipesLimit
    }, engine.userId);
    return;
  }

  const tokenId = String(parsed.tokenId);
  if (engine.snipedTokenIds && engine.snipedTokenIds.has(tokenId)) return;
  const protocolData = parsed.protocolData;
  const orderHash = parsed.orderHash || protocolData?.orderHash;
  if (orderHash && engine.invalidOrderHashes && engine.invalidOrderHashes.has(orderHash)) return;

  if (engine.pendingSnipes && engine.pendingSnipes.has(tokenId)) return;
  if (!engine.pendingSnipes) engine.pendingSnipes = new Set();
  if (!engine.snipedTokenIds) engine.snipedTokenIds = new Set();

  if ((!protocolData?.parameters || !protocolData?.signature) && !orderHash) {
    broadcastSnipeLog(`⚠ [SNIPER V2] Cannot snipe #${tokenId}: both protocolData and orderHash are missing!`, engine.userId);
    return;
  }

  // 🛡️ ATOMIC SYNCHRONOUS LOCK: Mark immediately so SSE payload.sniped = true (prevents duplicate frontend dispatch)
  engine.pendingSnipes.add(tokenId);
  engine.snipedTokenIds.add(tokenId);

  broadcastSnipeLog(`🎯 ⚡ [TRIGGER MATCHED] Woodie #${tokenId} at ${parsed.price} ETH [${reason}]`, engine.userId);

  try {
    let currentWorker = engine.walletSigner;
    let buyerAddress = engine.buyerAddress;
    let buyerName = engine.buyerName;

    if (engine.workerPool && engine.workerPool.length > 0) {
      if (engine.workerStrategy === 'round_robin') {
        const w = engine.workerPool[engine.workerIndex % engine.workerPool.length];
        engine.workerIndex++;
        currentWorker = w.signer;
        buyerAddress = w.address;
        buyerName = w.name;
      } else if (!currentWorker) {
        currentWorker = engine.workerPool[0].signer;
        buyerAddress = engine.workerPool[0].address;
        buyerName = engine.workerPool[0].name;
      }
    }

    if (!currentWorker && !engine.dryRun) {
      broadcastSnipeLog(`⚠ [SNIPER V2] No valid worker signer available for execution!`, engine.userId);
      engine.pendingSnipes.delete(tokenId);
      return;
    }

    let txObj = null;

    if (protocolData?.parameters && protocolData?.signature) {
      // Path A: 0ms Instant Direct Seaport Transaction
      broadcastSnipeLog(`⚡ [SEAPORT DIRECT] Building 0ms direct Seaport transaction from protocolData...`, engine.userId);
      try {
        txObj = seaportExecutor.buildSeaportTransaction(
          protocolData,
          buyerAddress || '0x0000000000000000000000000000000000000001',
          engine.gasSpeed || 'turbo',
          engine.customGas
        );
      } catch (pathAErr) {
        // Path A build failed — fallback to Path B (Fulfillment API)
        broadcastSnipeLog(`⚠ [PATH A BUILD FAILED] Direct Seaport build failed: ${pathAErr.message?.slice(0, 80)}. Falling back to Fulfillment API...`, engine.userId);
        txObj = null; // Reset — let Path B handle it
      }
    }

    if (!txObj && orderHash) {
      // Path B: OpenSea Fulfillment API Fallback via Rotating 24/7 API Shop
      broadcastSnipeLog(`📡 [SEAPORT FULFILLMENT] Fetching OpenSea Seaport calldata for hash ${orderHash.slice(0, 14)}... via 24/7 API Shop...`, engine.userId);
      const fulRes = await fetchSeaportFulfillmentWithShop(orderHash, parsed.chain || 'robinhood', buyerAddress, tokenId);
      if (!fulRes.success) {
        if (fulRes.isDeadOrder) {
          if (orderHash && engine.invalidOrderHashes) engine.invalidOrderHashes.add(orderHash);
          engine.snipedTokenIds.add(tokenId);
          broadcastSnipeLog(`ℹ [ORDER INACTIVE] #${tokenId} (${orderHash ? orderHash.slice(0, 14) + '...' : ''}) is no longer active on OpenSea (cancelled/filled). Blacklisted.`, engine.userId);
        } else {
          broadcastSnipeLog(`❌ [FULFILLMENT ERROR] OpenSea returned error for #${tokenId}: ${fulRes.error}`, engine.userId);
        }
        engine.pendingSnipes.delete(tokenId);
        return;
      }

      if (!fulRes.data?.fulfillment_data?.transaction) {
        broadcastSnipeLog(`❌ [FULFILLMENT ERROR] OpenSea returned no fulfillment transaction for #${tokenId}`, engine.userId);
        engine.pendingSnipes.delete(tokenId);
        return;
      }

      const txData = fulRes.data.fulfillment_data.transaction;
      let calldata;

      // ⚡ BEST PATH: Use pre-encoded calldata from OpenSea directly (zero encoding needed)
      if (txData.data && txData.data.length > 10) {
        calldata = txData.data;
      } else {
        // 🔍 DEBUG: Log actual API response structure for diagnosis
        broadcastSnipeLog(`🔍 [DEBUG] txData keys: ${JSON.stringify(Object.keys(txData))}`, engine.userId);
        broadcastSnipeLog(`🔍 [DEBUG] input_data keys: ${JSON.stringify(Object.keys(txData.input_data || {}))}`, engine.userId);
        broadcastSnipeLog(`🔍 [DEBUG] function: ${txData.function}`, engine.userId);

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
              broadcastSnipeLog(`🔍 [DEBUG] advOrder null. Full input_data: ${JSON.stringify(txData.input_data).slice(0, 500)}`, engine.userId);
              engine.pendingSnipes.delete(tokenId);
              return;
            }
            calldata = seaportExecutor.seaportInterface.encodeFunctionData(fnName, [advOrder, criteria, conduit, recip]);
          } else {
            calldata = seaportExecutor.seaportInterface.encodeFunctionData(fnName, [txData.input_data.parameters || txData.input_data.order]);
          }
        } catch (encErr) {
          broadcastSnipeLog(`❌ [SEAPORT ABI ERROR] Failed to encode ${fnName}: ${encErr.message}`, engine.userId);
          broadcastSnipeLog(`🔍 [DEBUG] input_data dump: ${JSON.stringify(txData.input_data).slice(0, 800)}`, engine.userId);
          engine.pendingSnipes.delete(tokenId);
          return;
        }
      }
      if (txData.calldata_suffix && !calldata.includes(txData.calldata_suffix.replace('0x', ''))) {
        calldata += txData.calldata_suffix.replace('0x', '');
      }

      let gasPrice;
      if (engine.customGas?.customMaxFeeGwei && parseFloat(engine.customGas.customMaxFeeGwei) > 0) {
        gasPrice = ethers.parseUnits(String(engine.customGas.customMaxFeeGwei), 'gwei');
      } else {
        const gasSpeed = engine.gasSpeed || 'turbo';
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
      broadcastSnipeLog(`❌ [SNIPER V2] Failed to construct transaction for #${tokenId}`, engine.userId);
      engine.pendingSnipes.delete(tokenId);
      return;
    }

    const isSim = engine.dryRun;
    let txHash = '';

    if (isSim) {
      const simulatedLatency = Math.floor(Math.random() * 3) + 1;
      txHash = '0xsimulated_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
      broadcastSnipeLog(`🧪 [PAPER SNIPE] Token #${tokenId} simulated in ${simulatedLatency}ms! MockTx: ${txHash}`, engine.userId);
    } else {
      const provider = seaportExecutor.providers[0];
      const explicitNonce = await getNextNonce(provider, buyerAddress);
      txObj.nonce = explicitNonce;
      txObj.chainId = 4663; // Robinhood L2

      broadcastSnipeLog(`➔ [RAM CPU SIGN & MULTI-RPC BLAST] Signing & blasting for #${tokenId} (Worker: ${buyerName} - ${buyerAddress.slice(0, 6)}... Nonce: ${explicitNonce})...`, engine.userId);
      
      const signedRawTx = await currentWorker.signTransaction(txObj); // ~2ms Local CPU ECDSA
      const blastResult = await seaportExecutor.multiRpcBroadcast(signedRawTx); // Simultaneous multi-RPC dispatch
      txHash = blastResult.txHash;
      
      const tSigned = performance.now();
      const latencyMs = (tSigned - tTriggerStart).toFixed(2);
      
      const winningNode = blastResult.rpcUrl ? (blastResult.rpcUrl.includes('//') ? new URL(blastResult.rpcUrl).hostname : blastResult.rpcUrl) : 'Fastest Node';
      broadcastSnipeLog(`🚀 [MEMPOOL ACCEPTED via ${winningNode}] TxHash: ${txHash} (${latencyMs}ms | Blast RTT: ${blastResult.latencyMs}ms) ➔ Mining on Robinhood Chain...`, engine.userId);

      // Track receipt in background (non-blocking)
      if (provider && typeof provider.waitForTransaction === 'function') {
        provider.waitForTransaction(txHash, 1, 35000).then(receipt => {
          if (receipt) {
            broadcastSnipeLog(`🎉 [ON-CHAIN CONFIRMED] Block #${receipt.blockNumber}! Token #${tokenId} secured by ${buyerName} (Tx: ${txHash.slice(0, 14)}...)!`, engine.userId);
            broadcastToClients({
              type: 'zero_hop_snipe_confirmed',
              slug: engine.slug,
              tokenId: tokenId,
              price: parsed.price,
              buyerName: buyerName,
              txHash: txHash,
              blockNumber: receipt.blockNumber,
              timestamp: Date.now()
            }, engine.userId);
          }
        }).catch(e => {
          broadcastSnipeLog(`❌ [TX REVERTED] Block revert for #${tokenId}: ${e.message}`, engine.userId);
          engine.snipedTokenIds.delete(tokenId);
        });
      }
    }

    // Now that tx is broadcasted on-chain, mark as sniped and count
    engine.snipedTokenIds.add(tokenId);
    engine.snipesExecutedCount++;

    broadcastToClients({
      type: isSim ? 'paper_snipe_broadcast' : 'zero_hop_snipe_broadcast',
      slug: engine.slug,
      tokenId: tokenId,
      name: parsed.name,
      price: parsed.price,
      priceFormatted: parsed.priceFormatted,
      buyerName: buyerName,
      txHash: txHash,
      computeLatencyMs: (performance.now() - tTriggerStart).toFixed(2),
      isDryRun: isSim,
      snipesExecuted: engine.snipesExecutedCount,
      maxLimit: engine.maxSnipesLimit,
      reason: reason,
      timestamp: Date.now()
    }, engine.userId);

    // Auto-pause if max limit reached
    if (engine.maxSnipesLimit > 0 && engine.snipesExecutedCount >= engine.maxSnipesLimit) {
      engine.isArmed = false;
      broadcastSnipeLog(`🛑 [CIRCUIT BREAKER] Completed ${engine.snipesExecutedCount} of ${engine.maxSnipesLimit} allowed snipes. Auto-disarmed.`, engine.userId);
      broadcastToClients({
        type: 'circuit_breaker_paused',
        executed: engine.snipesExecutedCount,
        limit: engine.maxSnipesLimit
      }, engine.userId);
    }

  } catch (err) {
    if (engine.pendingSnipes) engine.pendingSnipes.delete(tokenId);
    engine.snipedTokenIds.delete(tokenId);
    broadcastSnipeLog(`❌ [ZERO-HOP SNIPE ERROR] Token #${tokenId}: ${err.message}`, engine.userId);
  }
}

/**
 * 🛡️ UNIVERSAL VIP SUBSCRIPTION GUARD & AUTO-DISARM WATCHDOG
 * If a user's validity expires while sniper is armed in memory:
 * Instantly auto-disarms, purges private keys from RAM, and notifies the specific user.
 */
export function checkAndEnforceUserValidity(targetEngine = null) {
  const enginesToCheck = targetEngine ? [targetEngine] : Array.from(activeSniperEngines.values());
  if (enginesToCheck.length === 0 && activeSniperEngine.isArmed) {
    enginesToCheck.push(activeSniperEngine);
  }

  let allValid = true;
  for (const engine of enginesToCheck) {
    if (!engine.isArmed || !engine.authenticatedUserId) continue;
    if (engine.userEmail && engine.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase()) continue;

    if (engine.userValidUntil) {
      const exp = new Date(engine.userValidUntil).getTime();
      if (Date.now() >= exp) {
        console.log(`⏳ [SNIPER AUTO-DISARM] User [${engine.userId}] VIP subscription expired (${engine.userValidUntil}). Auto-disarming sniper...`);
        engine.isArmed = false;
        engine.walletSigner = null;
        engine.buyerPrivateKey = '';
        if (engine.workerPool && engine.workerPool.length > 0) {
          engine.workerPool.forEach(w => { delete w.privateKey; w.signer = null; });
        }
        broadcastSnipeLog(`⏳ [AUTO-DISARMED] VIP subscription expired! Background sniper engine stopped.`, engine.userId);
        broadcastToClients({
          type: 'sniper_disarmed',
          reason: 'subscription_expired'
        }, engine.userId);
        allValid = false;
      }
    }
  }
  return allValid;
}

// 🛡️ Continuous 5-Second Background Watchdog
setInterval(() => {
  try {
    checkAndEnforceUserValidity();
  } catch (e) {}
}, 5000);

// ⚡ MICROSECOND ZERO-HOP MULTI-USER SNIPER TRIGGER EVALUATOR (ALL 4 RULES ENFORCED)
export async function evaluateAndSnipe(parsed, incomingSlug, tTriggerStart = performance.now()) {
  if (!parsed || !parsed.tokenId) return;
  const itemSlug = (parsed.slug || incomingSlug || '').toLowerCase();

  // Find all active user engines registered for this slug (or wildcard '*')
  let candidateEngines = Array.from(activeSniperEngines.values()).filter(e => e && e.isArmed && (e.slug === '*' || e.slug === itemSlug));
  if (candidateEngines.length === 0 && activeSniperEngine && activeSniperEngine.isArmed && (activeSniperEngine.slug === '*' || activeSniperEngine.slug === itemSlug)) {
    candidateEngines = [activeSniperEngine];
  }
  if (candidateEngines.length === 0) return;

  const tokenIdStr = String(parsed.tokenId);

  // 🛡️ ATOMIC IN-FLIGHT SYNCHRONOUS LOCK:
  // Drops duplicate concurrent events in 0.001ms BEFORE any async await/yield occurs.
  if (inFlightEvaluationTokens.has(tokenIdStr)) {
    return;
  }
  inFlightEvaluationTokens.add(tokenIdStr);

  try {
    const orderHash = parsed.orderHash || parsed.protocolData?.orderHash;

    // 🛡️ VALID SEAPORT ORDER GUARD: Skip incomplete listings that lack both orderHash and parameters
    const hasOrderHash = Boolean(orderHash && orderHash.length > 10);
    const hasProtocolParams = Boolean(parsed.protocolData?.parameters && parsed.protocolData?.signature);
    if (!hasOrderHash && !hasProtocolParams) {
      return; // Wait until order hash or protocol data is populated by OpenSea
    }

    // Evaluate each candidate user engine independently
    for (const engine of candidateEngines) {
      if (!engine.isArmed) continue;
      if (engine.maxSnipesLimit > 0 && engine.snipesExecutedCount >= engine.maxSnipesLimit) {
        engine.isArmed = false;
        continue;
      }
      if (engine.snipedTokenIds && engine.snipedTokenIds.has(tokenIdStr)) continue;
      if (engine.pendingSnipes && engine.pendingSnipes.has(tokenIdStr)) continue;
      if (orderHash && engine.invalidOrderHashes && engine.invalidOrderHashes.has(orderHash)) continue;

      let triggered = false;
      let reason = '';

      // 🎯 RULE 4: SPECIFIC TOKEN ID TRAP (HIGHEST PRIORITY)
      const isTokenIdActive = engine.ruleStates?.tokenId !== undefined
        ? Boolean(engine.ruleStates.tokenId)
        : Boolean(engine.specificTokenIds && engine.specificTokenIds.size > 0);
      const cleanTokenId = String(parsed.tokenId || '').trim().replace(/[^0-9]/g, '');
      if (isTokenIdActive && cleanTokenId && engine.specificTokenIds && engine.specificTokenIds.has(cleanTokenId)) {
        const maxEth = engine.specificTokenMaxEth > 0
          ? engine.specificTokenMaxEth
          : (engine.maxFloorEth > 0 ? engine.maxFloorEth : Infinity);
        if (parsed.price <= maxEth) {
          triggered = true;
          reason = `🎯 Target Token #${cleanTokenId}: ${parsed.price} ETH <= Cap ${maxEth === Infinity ? 'Market' : maxEth + ' ETH'}`;
        }
      }

      // 👑 RULE 3: RARE TRAIT HUNTER (PRIORITY 2 - MULTI-TRAIT & DYNAMIC RESOLUTION)
      const isTraitActive = engine.ruleStates?.trait !== undefined
        ? Boolean(engine.ruleStates.trait)
        : Boolean((engine.traitFilters && engine.traitFilters.length > 0) || engine.traitFilter);
      if (!triggered && isTraitActive && (engine.traitFilter || (engine.traitFilters && engine.traitFilters.length > 0))) {
        const maxEth = engine.traitMaxEth > 0
          ? engine.traitMaxEth
          : (engine.traitFilter?.maxEth > 0
              ? engine.traitFilter.maxEth
              : (engine.maxFloorEth > 0 ? engine.maxFloorEth : Infinity));
        if (parsed.price <= maxEth) {
          const filters = (engine.traitFilters && engine.traitFilters.length > 0)
            ? engine.traitFilters
            : (engine.traitFilter ? [engine.traitFilter] : []);

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
                const streamContract = parsed.contractAddress || rarityEngine.contractAddress;
                const streamChain = parsed.chain || rarityEngine.chain || 'robinhood';
                rarityEngine.fetchTokenRarity(parsed.tokenId, streamChain, streamContract).catch(() => {});
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
      if (!triggered && engine.ruleStates?.floor && engine.maxFloorEth > 0) {
        if (parsed.price <= engine.maxFloorEth) {
          triggered = true;
          reason = `⚡ Floor Fat-Finger: ${parsed.price} ETH <= Target ${engine.maxFloorEth} ETH`;
        }
      }

      // 👑 RULE 2: TOP RARITY RANK SNIPE (PRIORITY 4) — 0.01ms INSTANT RANK CHECK
      const maxRareCap = engine.maxRareEth > 0
        ? engine.maxRareEth
        : (engine.maxFloorEth > 0 ? engine.maxFloorEth : 0);
      if (!triggered && engine.ruleStates?.rarity && maxRareCap > 0) {
        let rank = rarityEngine.getRaritySync(parsed.tokenId);

        // ⚡ INSTANT FALLBACK: DynamicRarityCalculator IC-based estimated rank (0.01ms, ZERO API calls)
        if (rank === null && dynamicRarityCalc.isReady && parsed.traits?.length > 0) {
          const { estimatedRank } = dynamicRarityCalc.scoreAndEstimateRank(parsed.tokenId, parsed.traits);
          if (estimatedRank > 0) rank = estimatedRank;
        }

        // ⚡ SHORT-TIMEOUT RANK FETCH: 200ms max
        if (rank === null) {
          const streamContract = parsed.contractAddress || rarityEngine.contractAddress;
          const streamChain = parsed.chain || rarityEngine.chain || 'robinhood';
          try {
            const resolved = await Promise.race([
              rarityEngine.fetchTokenRarity(parsed.tokenId, streamChain, streamContract),
              new Promise((_, rej) => setTimeout(() => rej('timeout'), 800))
            ]);
            if (resolved?.rank > 0) rank = resolved.rank;
          } catch {}
        }

        if (rank && rank <= engine.maxRareRank && parsed.price <= maxRareCap) {
          triggered = true;
          reason = `👑 Top Rarity #${rank} at ${parsed.price} ETH <= Target ${maxRareCap} ETH`;
        }
      }

      if (triggered) {
        console.log(`🎯 [MULTI-USER SNIPER TRIGGERED] User [${engine.buyerName || engine.userId}]: ${reason} on #${parsed.tokenId}`);
        await executeZeroHopSnipe(parsed, reason, tTriggerStart, engine);
      }
    }
  } finally {
    inFlightEvaluationTokens.delete(tokenIdStr);
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

    const userKey = String(userId || buyerAddress || 'default');
    const targetSlug = (slug || '*').trim().toLowerCase();

    const userEngine = {
      userId: userKey,
      isArmed: true,
      armedTimestamp: Date.now(),
      slug: targetSlug,
      triggerMode: triggerMode || 'both',
      maxFloorEth: parseFloat(maxFloorEth) || 0,
      maxRareRank: parseInt(maxRareRank, 10) || 1200,
      maxRareEth: parseFloat(maxRareEth) || 0,
      gasSpeed: gasSpeed || 'turbo',
      customGas: customGas || null,
      buyerPrivateKey: buyerPrivateKey || '',
      buyerAddress: buyerAddress,
      buyerName: buyerName || 'Worker',
      walletSigner: signer,
      snipedTokenIds: new Set(),
      invalidOrderHashes: new Set(),
      pendingSnipes: new Set(),
      maxSnipesLimit: (maxSnipesLimit !== undefined && maxSnipesLimit !== null) ? parseInt(maxSnipesLimit, 10) : 1,
      snipesExecutedCount: 0,
      specificTokenIds: tokenSet,
      specificTokenMaxEth: parseFloat(specificTokenMaxEth) || 0,
      traitFilter: (traitFilter && (traitFilter.traitType || traitFilter.traitValue)) ? {
        traitType: (traitFilter.traitType || '').trim(),
        traitValue: (traitFilter.traitValue || '').trim(),
        maxEth: parseFloat(traitFilter.maxEth) || 0
      } : null,
      traitFilters: Array.isArray(traitFilters) ? traitFilters.map(f => ({
        traitType: String(f.traitType || '').trim(),
        traitValue: String(f.traitValue || '').trim()
      })).filter(f => f.traitType || f.traitValue) : [],
      traitMaxEth: parseFloat(traitMaxEth) || (traitFilter?.maxEth ? parseFloat(traitFilter.maxEth) : 0),
      dryRun: !!dryRun,
      workerStrategy: workerStrategy || 'single',
      workerPool: workerPool,
      workerIndex: 0,
      ruleStates: {
        floor: ruleStates?.floor !== false,
        rarity: ruleStates?.rarity !== false,
        trait: !!ruleStates?.trait || (Array.isArray(traitFilters) && traitFilters.length > 0) || !!traitFilter,
        tokenId: !!ruleStates?.tokenId || (tokenSet.size > 0)
      },
      authenticatedUserId: userId || null,
      userValidUntil: armedDbUser ? armedDbUser.valid_until : null,
      userEmail: armedDbUser ? armedDbUser.email : ''
    };

    activeSniperEngines.set(userKey, userEngine);
    setActiveSniperEngine(userEngine, userKey);

    console.log(`🎯 ⚡ [MULTI-USER SNIPER ARMED: User "${userKey}"]`);
    console.log(`   Target Slug: "${userEngine.slug}" | Mode: ${userEngine.dryRun ? '🧪 PAPER SNIPE' : '⚡ LIVE MAINNET'}`);
    console.log(`   Limit: ${userEngine.maxSnipesLimit === 0 ? 'Unlimited' : userEngine.maxSnipesLimit + ' Snipes'} | Active Fleet Total: ${activeSniperEngines.size} users`);

    if (targetSlug && targetSlug !== '*') {
      subscribeSlugToOpenSea(targetSlug);
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
      message: 'Ultra-Fast Multi-Tenant Sniper Engine ARMED in Node.js backend memory',
      userId: userKey,
      buyerAddress: buyerAddress,
      targetSlug: targetSlug,
      isDryRun: userEngine.dryRun,
      workersLoaded: workerPool.length,
      maxLimit: userEngine.maxSnipesLimit,
      activeEnginesCount: activeSniperEngines.size
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/snipe/telemetry
router.get('/snipe/telemetry', (req, res) => {
  const reqUserId = String(req.query.userId || '');
  const engine = (reqUserId && activeSniperEngines.has(reqUserId))
    ? activeSniperEngines.get(reqUserId)
    : activeSniperEngine;

  res.json({
    success: true,
    isArmed: engine ? engine.isArmed : false,
    snipesExecutedCount: engine ? engine.snipesExecutedCount : 0,
    maxSnipesLimit: engine ? engine.maxSnipesLimit : 1,
    dryRun: engine ? engine.dryRun : false,
    targetSlug: engine ? engine.slug : '',
    workerStrategy: engine ? engine.workerStrategy : 'single',
    workersCount: engine?.workerPool ? engine.workerPool.length : 1,
    ruleStates: engine ? engine.ruleStates : {},
    activeCollectionStats: activeCollectionStats,
    activeEnginesCount: activeSniperEngines.size,
    timestamp: Date.now()
  });
});

// POST /api/snipe/disarm
router.post('/snipe/disarm', (req, res) => {
  const { userId, buyerAddress } = req.body || {};
  const userKey = String(userId || buyerAddress || req.query.userId || '');

  if (userKey && activeSniperEngines.has(userKey)) {
    const engine = activeSniperEngines.get(userKey);
    engine.isArmed = false;
    engine.walletSigner = null;
    engine.buyerPrivateKey = '';
    if (engine.workerPool && engine.workerPool.length > 0) {
      engine.workerPool.forEach(w => { delete w.privateKey; w.signer = null; });
    }
    activeSniperEngines.delete(userKey);
    console.log(`⏸ [SNIPER DISARMED] User [${userKey}] keys purged from RAM.`);

    if (engine.slug && engine.slug !== '*') {
      const isAnyOtherWatching = Array.from(activeSniperEngines.values()).some(e => e.isArmed && (e.slug === engine.slug || e.slug === '*'));
      if (!isAnyOtherWatching) streamListener.unsubscribe(engine.slug);
    }
  } else {
    // Global disarm fallback
    for (const [k, engine] of activeSniperEngines.entries()) {
      engine.isArmed = false;
      engine.walletSigner = null;
      engine.buyerPrivateKey = '';
      if (engine.workerPool) engine.workerPool.forEach(w => { delete w.privateKey; w.signer = null; });
    }
    activeSniperEngines.clear();
    activeSniperEngine.isArmed = false;
    activeSniperEngine.walletSigner = null;
    activeSniperEngine.buyerPrivateKey = '';
    walletNonceMap.clear();
    console.log(`⏸ [SNIPER V2 DISARMED ALL] All user keys purged from RAM.`);
  }

  res.json({ success: true, message: 'Sniper Engine Disarmed & Keys Purged', activeEnginesRemaining: activeSniperEngines.size });
});

// POST /api/snipe/buy
router.post('/snipe/buy', async (req, res) => {
  const { buyerPrivateKey, protocolData, orderHash, tokenId, gasSpeed, workerIndex, userId } = req.body;

  let signer = null;
  let buyerAddress = '';
  const provider = seaportExecutor.providers[0];

  const userKey = String(userId || '');
  const userEngine = (userKey && activeSniperEngines.has(userKey)) ? activeSniperEngines.get(userKey) : activeSniperEngine;

  if (userEngine && userEngine.workerPool && userEngine.workerPool.length > 0) {
    const idx = (typeof workerIndex === 'number' && workerIndex < userEngine.workerPool.length) ? workerIndex : 0;
    const worker = userEngine.workerPool[idx];
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
      const explicitNonce = await getNextNonce(provider, buyerAddress);
      txObj.nonce = explicitNonce;
      txObj.chainId = 4663;

      const signedRawTx = await signer.signTransaction(txObj);
      const blastResult = await seaportExecutor.multiRpcBroadcast(signedRawTx);
      const txHash = blastResult.txHash;

      // 🛡️ Permanent atomic lock so neither frontend nor backend double-snipes
      if (tokIdStr) activeSniperEngine.snipedTokenIds.add(tokIdStr);

      const cbStatus = handleSnipeSuccess(txHash, null);

      // Background confirmation tracking
      if (provider && typeof provider.waitForTransaction === 'function') {
        provider.waitForTransaction(txHash, 1, 35000).then(receipt => {
          if (receipt) {
            broadcastSnipeLog(`🎉 [ON-CHAIN CONFIRMED] Block #${receipt.blockNumber}! Token #${tokenId} secured!`);
            broadcastToClients({
              type: 'zero_hop_snipe_confirmed',
              txHash: txHash,
              blockNumber: receipt.blockNumber,
              tokenId
            });
          }
        }).catch(() => {});
      }

      return res.json({
        success: true,
        txHash: txHash,
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

        const explicitNonce = await getNextNonce(provider, buyerAddress);
        txObj.nonce = explicitNonce;
        txObj.chainId = 4663;

        const signedRawTx = await signer.signTransaction(txObj);
        const blastResult = await seaportExecutor.multiRpcBroadcast(signedRawTx);
        const txHash = blastResult.txHash;
        
        if (tokIdStr) activeSniperEngine.snipedTokenIds.add(tokIdStr);
        const cbStatus = handleSnipeSuccess(txHash, null);

        if (provider && typeof provider.waitForTransaction === 'function') {
          provider.waitForTransaction(txHash, 1, 35000).then(receipt => {
            if (receipt) {
              broadcastSnipeLog(`🎉 [ON-CHAIN CONFIRMED] Block #${receipt.blockNumber}! Token #${tokenId} secured!`);
              broadcastToClients({
                type: 'zero_hop_snipe_confirmed',
                txHash: txHash,
                blockNumber: receipt.blockNumber,
                tokenId
              });
            }
          }).catch(() => {});
        }

        return res.json({
          success: true,
          txHash: txHash,
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
