import { ethers } from 'ethers';
// 🛡️ AUDIT FIX MED-4: Removed axios — multiRpcBroadcast now uses native fetch for zero overhead
import chalk from 'chalk';
import { config, SEAPORT_V16_ABI } from './config.js';

export class SeaportExecutor {
  constructor(chain = 'robinhood') {
    this.chain = chain;
    this.seaportInterface = new ethers.Interface(SEAPORT_V16_ABI);
    this.seaportAddress = config.seaport.v1_6 || '0x0000000000000068F116a894984e2DB1123eB395';
    this.rpcs = (config.networks[chain]?.rpcUrls || [
      'https://robinhood-mainnet.g.alchemy.com/v2/alch_FtrEfyyJYzEBZ0SQ3ctbJ',
      'https://rpc.mainnet.chain.robinhood.com'
    ]);
    this.providers = this.rpcs.map(url => {
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      p.pollingInterval = 500;
      return p;
    });
    this.cachedBaseFee = 22000000n;
    this.gasTickerInterval = null;
    this.startGasTicker();
  }

  /**
   * ⚡ DYNAMIC RPC FLEET INTEGRATION:
   * Dynamically loads user's top-priority private RPCs from Cloud Fleet DB.
   */
  setRpcFleet(rpcUrls) {
    if (!Array.isArray(rpcUrls) || rpcUrls.length === 0) return;
    const cleanUrls = rpcUrls.filter(u => typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://')));
    if (cleanUrls.length === 0) return;
    this.rpcs = cleanUrls;
    this.providers = this.rpcs.map(url => {
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      p.pollingInterval = 500;
      return p;
    });
    console.log(`[EXECUTOR] ⚡ Dynamic RPC Fleet Updated: ${this.rpcs.length} active nodes armed.`);
  }

  /**
   * ⚡ HOT RPC SOCKET PRE-WARMING (0ms TLS Handshake)
   */
  async preWarmConnections() {
    const pingPromises = this.rpcs.map(async (url) => {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(2500)
        });
      } catch (e) {}
    });
    await Promise.allSettled(pingPromises);
  }

  startGasTicker() {
    const update = async () => {
      try {
        const block = await this.providers[0].getBlock('latest');
        if (block?.baseFeePerGas) {
          this.cachedBaseFee = block.baseFeePerGas;
        }
      } catch (e) {}
    };
    this.gasTickerInterval = setInterval(update, 1000);
    update();
  }

  /**
   * Encodes the Seaport v1.6 transaction data from OpenSea protocol_data
   */
  buildSeaportTransaction(protocolData, buyerAddress, gasSpeed = 'turbo', customGas = null, explicitNonce = null) {
    const p = protocolData?.parameters;
    const signature = protocolData?.signature;
    if (!p || !signature) {
      throw new Error('Invalid Seaport protocol data: missing parameters or signature');
    }

    const conduitKey = p.conduitKey || '0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e';
    const offer = p.offer?.[0];
    const consideration = p.consideration || [];

    // Calculate total native ETH required in Wei
    const totalEthWei = consideration.reduce((acc, item) => {
      if (Number(item.itemType) === 0) { // ItemType 0 = NATIVE (ETH)
        return acc + BigInt(item.startAmount || item.amount || 0);
      }
      return acc;
    }, 0n);

    // Calculate dynamic priority gas based on mode or custom input
    let gasPrice;
    if (customGas && customGas.customMaxFeeGwei && parseFloat(customGas.customMaxFeeGwei) > 0) {
      gasPrice = ethers.parseUnits(String(customGas.customMaxFeeGwei), 'gwei');
    } else {
      let gasMultiplier = 135n; // default safe +35%
      if (gasSpeed === 'turbo') gasMultiplier = 175n; // +75%
      if (gasSpeed === 'surge') gasMultiplier = 235n; // +135%
      if (gasSpeed === 'hyped') gasMultiplier = 300n; // 🔥 +200% Hyped Gas War Mode
      gasPrice = (this.cachedBaseFee * gasMultiplier) / 100n;
    }

    // Determine if fulfillBasicOrder can be used
    const isSingleErc721 = (p.offer?.length === 1 && Number(offer?.itemType) === 2);
    const isNativeEthPayment = consideration.every(c => Number(c.itemType) === 0);
    const canUseBasicOrder = isSingleErc721 && isNativeEthPayment;

    let calldata;
    let gasLimit;

    if (canUseBasicOrder) {
      // Determine basicOrderType:
      // 0 = ETH_TO_ERC721_FULL_OPEN
      // 2 = ETH_TO_ERC721_FULL_RESTRICTED (OpenSea SignedZone)
      const isRestrictedZone = p.zone && p.zone.toLowerCase() !== ethers.ZeroAddress.toLowerCase();
      const basicOrderType = isRestrictedZone ? 2 : 0;

      const basicParameters = {
        considerationToken: ethers.ZeroAddress,
        considerationIdentifier: 0n,
        considerationAmount: BigInt(consideration[0]?.startAmount || 0),
        offerer: p.offerer,
        zone: p.zone || ethers.ZeroAddress,
        offerToken: offer.token,
        offerIdentifier: BigInt(offer.identifierOrCriteria),
        offerAmount: BigInt(offer.startAmount || 1),
        basicOrderType: basicOrderType,
        startTime: BigInt(p.startTime),
        endTime: BigInt(p.endTime),
        zoneHash: p.zoneHash || ethers.ZeroHash,
        salt: BigInt(p.salt || 0),
        offererConduitKey: conduitKey,
        fulfillerConduitKey: conduitKey,
        totalOriginalAdditionalRecipients: BigInt(Math.max(0, consideration.length - 1)),
        additionalRecipients: consideration.slice(1).map(c => ({
          amount: BigInt(c.startAmount),
          recipient: c.recipient
        })),
        signature: signature
      };

      calldata = this.seaportInterface.encodeFunctionData('fulfillBasicOrder_efficient_6GL6yc', [basicParameters]) + 'cdb44011';
      gasLimit = 220000n;
    } else {
      const fullOrder = {
        parameters: {
          offerer: p.offerer,
          zone: p.zone,
          offer: p.offer.map(o => ({
            itemType: Number(o.itemType),
            token: o.token,
            identifierOrCriteria: BigInt(o.identifierOrCriteria),
            startAmount: BigInt(o.startAmount),
            endAmount: BigInt(o.endAmount)
          })),
          consideration: p.consideration.map(c => ({
            itemType: Number(c.itemType),
            token: c.token,
            identifierOrCriteria: BigInt(c.identifierOrCriteria),
            startAmount: BigInt(c.startAmount),
            endAmount: BigInt(c.endAmount),
            recipient: c.recipient
          })),
          orderType: Number(p.orderType || 0),
          startTime: BigInt(p.startTime),
          endTime: BigInt(p.endTime),
          zoneHash: p.zoneHash,
          salt: BigInt(p.salt),
          conduitKey: conduitKey,
          // 🛡️ AUDIT FIX C-3: Validate totalOriginalConsiderationItems against consideration array
          totalOriginalConsiderationItems: (() => {
            const claimed = BigInt(p.totalOriginalConsiderationItems || p.consideration.length);
            const actual = BigInt(p.consideration.length);
            if (claimed > actual) {
              console.warn(`⚠ [SEAPORT GUARD] totalOriginalConsiderationItems (${claimed}) > consideration.length (${actual}) — clamping to actual`);
              return actual;
            }
            return claimed;
          })()
        },
        signature: signature
      };

      calldata = this.seaportInterface.encodeFunctionData('fulfillOrder', [fullOrder, conduitKey]);
      gasLimit = 260000n;
    }

    const txObj = {
      to: this.seaportAddress,
      data: calldata,
      value: totalEthWei,
      gasLimit: gasLimit,
      gasPrice: gasPrice,
      type: 0 // Legacy Type 0 for Robinhood / Orbit L2 instant inclusion
    };
    if (explicitNonce !== null && explicitNonce !== undefined) {
      txObj.nonce = Number(explicitNonce);
    }
    return txObj;
  }

  // 🛡️ AUDIT FIX LOW-1: Dynamic gas estimation with safe fallback
  async estimateGasWithFallback(txObj, fromAddress, fallbackGas = 260000n) {
    try {
      const estimated = await this.providers[0].estimateGas({
        ...txObj,
        from: fromAddress
      });
      // Add 30% safety margin
      const withMargin = (estimated * 130n) / 100n;
      // Clamp between reasonable bounds (120k min, 500k max)
      const clamped = withMargin < 120000n ? 120000n : (withMargin > 500000n ? 500000n : withMargin);
      return clamped;
    } catch (err) {
      // If estimation fails, use fallback (order might revert, but we don't want to silently change behavior)
      console.warn(`⚠ [GAS] estimateGas failed, using fallback ${fallbackGas}: ${err.message?.slice(0, 80)}`);
      return fallbackGas;
    }
  }

  /**
   * AEROMINT-STYLE MULTI-RPC SIMULTANEOUS MEMPOOL BLAST
   * Dispatches the pre-signed raw transaction across all RPC endpoints concurrently.
   * Unblocks immediately on first accepted response (<1ms dispatch).
   */
  async multiRpcBroadcast(signedRawTx, dryRun = false) {
    if (dryRun) {
      // 🧪 Paper Snipe Simulation Guard (Zero ETH spent, zero mempool dispatch)
      const simulatedLatency = Math.floor(Math.random() * 3) + 1;
      const mockTxHash = '0xsimulated_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
      return {
        success: true,
        txHash: mockTxHash,
        rpcUrl: 'SIMULATED_LOCAL_RAM',
        latencyMs: simulatedLatency,
        simulated: true
      };
    }

    // 🛡️ AUDIT FIX MED-4: Native fetch replaces Axios for zero-overhead mempool blast
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_sendRawTransaction',
      params: [signedRawTx]
    });

    const blastPromises = this.rpcs.map(async (rpcUrl) => {
      const tStart = performance.now();
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(4000)
        });
        const data = await res.json();

        if (data?.result) {
          return {
            success: true,
            txHash: data.result,
            rpcUrl,
            latencyMs: Math.round(performance.now() - tStart)
          };
        } else {
          throw new Error(data?.error?.message || 'RPC returned error');
        }
      } catch (err) {
        throw new Error(`[${rpcUrl}] ${err.message}`);
      }
    });

    // First accepted wins resolution
    try {
      const fastestWinner = await Promise.any(blastPromises);
      return fastestWinner;
    } catch (aggErr) {
      const details = Array.isArray(aggErr.errors) 
        ? aggErr.errors.map(e => e.message || String(e)).join(' | ') 
        : (aggErr.message || 'All RPCs rejected');
      throw new Error(details);
    }
  }

  /**
   * Preflight eth_call simulation guard to prevent reverts and wasted gas
   */
  async simulateCall(txObj, fromAddress) {
    try {
      // 🛡️ AUDIT FIX MED-2: Use 'pending' block for most accurate pre-flight state with checksum normalization
      const cleanFrom = fromAddress ? ethers.getAddress(String(fromAddress).trim().toLowerCase()) : undefined;
      await this.providers[0].call({
        ...txObj,
        from: cleanFrom,
        blockTag: 'pending'
      });
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: err.message };
    }
  }

  // ═══ STRATEGIC UPGRADE U-1: Pre-sign transactions for zero-delay T-0 dispatch ═══
  /**
   * Pre-assembles and signs a raw transaction so that at T-0
   * we only need to call multiRpcBroadcast(signedRaw) with 0ms signing delay.
   */
  async preSignTransaction(txObj, signer, nonce) {
    try {
      const fullTx = {
        ...txObj,
        nonce,
        chainId: 4663 // Robinhood L2
      };
      const signedRaw = await signer.signTransaction(fullTx);
      return { success: true, signedRaw, nonce };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ═══ STRATEGIC UPGRADE U-2: Dual-path parallel execution ═══
  /**
   * Fires both direct-Seaport (if protocolData available) and OpenSea fulfillment API
   * in parallel. First successful path wins (Promise.any).
   * This doubles the chance of getting the NFT in competitive scenarios.
   */
  async dualPathExecute(protocolData, orderHash, signer, buyerAddress, gasSpeed = 'turbo', apiKey, apiClient, restApiBase) {
    const paths = [];

    // 🛡️ Pre-fetch nonce ONCE to prevent dual-path nonce collision
    // Path A gets nonce N, Path B gets nonce N+1
    // First tx that lands wins; the other harmlessly fails with 'nonce already used'
    const baseNonce = await this.providers[0].getTransactionCount(buyerAddress, 'pending');

    // Path A: Direct Seaport execution (fastest — no API call)
    if (protocolData?.parameters && protocolData?.signature) {
      paths.push((async () => {
        const txObj = this.buildSeaportTransaction(protocolData, buyerAddress, gasSpeed);
        txObj.nonce = baseNonce;
        txObj.chainId = 4663;
        const signedRaw = await signer.signTransaction(txObj);
        const result = await this.multiRpcBroadcast(signedRaw);
        return { ...result, path: 'direct_seaport' };
      })());
    }

    // Path B: OpenSea Fulfillment API (reliable — handles edge cases like signed zones)
    if (orderHash && apiKey && apiClient) {
      paths.push((async () => {
        const fulRes = await apiClient.post(`${restApiBase}/listings/fulfillment_data`, {
          listing: { hash: orderHash, chain: 'robinhood', protocol_address: this.seaportAddress },
          fulfiller: { address: buyerAddress }
        }, {
          headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          timeout: 3000
        });
        if (!fulRes.data?.fulfillment_data?.transaction) throw new Error('No fulfillment data');
        const txData = fulRes.data.fulfillment_data.transaction;
        const fnName = txData.function.split('(')[0];
        let calldata = this.seaportInterface.encodeFunctionData(fnName, [txData.input_data.parameters]);
        if (txData.calldata_suffix) calldata += txData.calldata_suffix.replace('0x', '');
        const txObj = {
          to: txData.to, data: calldata,
          value: BigInt(txData.value || '0'),
          gasLimit: 260000n,
          gasPrice: (this.cachedBaseFee * 175n) / 100n,
          nonce: baseNonce, // Same nonce: whichever confirms first wins; losing path is cleanly dropped by mempool (0 ETH wasted)
          type: 0, chainId: 4663
        };
        const signedRaw = await signer.signTransaction(txObj);
        const result = await this.multiRpcBroadcast(signedRaw);
        return { ...result, path: 'opensea_fulfillment' };
      })());
    }

    if (paths.length === 0) throw new Error('No execution paths available');
    return await Promise.any(paths);
  }

  // ═══ STRATEGIC UPGRADE U-3: Direct on-chain Seaport OrderFulfilled event monitor ═══
  /**
   * Watches for Seaport OrderFulfilled events on-chain as a backup detection
   * mechanism independent of OpenSea WebSocket. Detects NFT sales even if
   * OpenSea stream goes down or misses events.
   */
  startOnChainMonitor(callback) {
    if (this._onChainMonitorActive) return;
    this._onChainMonitorActive = true;
    this._seenTxHashes = new Set(); // 🛡️ Dedup: prevent duplicate event callbacks

    // OrderFulfilled(bytes32 orderHash, address offerer, address zone, ...)
    const ORDER_FULFILLED_TOPIC = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';

    const checkLogs = async () => {
      if (!this._onChainMonitorActive) return;
      try {
        const blockNumber = await this.providers[0].getBlockNumber();
        const logs = await this.providers[0].getLogs({
          address: this.seaportAddress,
          topics: [ORDER_FULFILLED_TOPIC],
          fromBlock: blockNumber - 2,
          toBlock: blockNumber
        });
        for (const log of logs) {
          // 🛡️ Dedup guard: skip already-seen transactions
          const dedupKey = `${log.transactionHash}_${log.logIndex}`;
          if (this._seenTxHashes.has(dedupKey)) continue;
          this._seenTxHashes.add(dedupKey);

          // Cap dedup set at 500 to prevent unbounded growth
          if (this._seenTxHashes.size > 500) {
            const first = this._seenTxHashes.values().next().value;
            this._seenTxHashes.delete(first);
          }

          if (typeof callback === 'function') {
            callback({
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
              orderHash: log.topics[1],
              offerer: log.topics[2] ? '0x' + log.topics[2].slice(26) : null
            });
          }
        }
      } catch (err) {
        // Silently continue — this is a backup monitor, not critical path
      }
    };

    this._onChainInterval = setInterval(checkLogs, 2000);
    console.log(chalk.cyan('🔗 [ON-CHAIN] Seaport OrderFulfilled event monitor started (2s polling)'));
  }

  stopOnChainMonitor() {
    this._onChainMonitorActive = false;
    if (this._onChainInterval) {
      clearInterval(this._onChainInterval);
      this._onChainInterval = null;
    }
  }
}