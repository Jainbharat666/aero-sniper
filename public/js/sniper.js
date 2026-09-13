/* ══════════════════════════════════════════════════════════════
   🎯 AERO-SNIPER V2: MASTER SNIPER ENGINE & TRIGGER RULES
   ══════════════════════════════════════════════════════════════ */

    function setGas(preset) {
      activeGasPreset = preset;
      persistState();
      ['safe', 'turbo', 'surge', 'hyped'].forEach(p => {
        const btn = document.getElementById(`gas-${p}`);
        if (btn) {
          btn.className = 'py-1 px-1 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 flex flex-col items-center hover:bg-slate-100 transition-all';
        }
      });
      const active = document.getElementById(`gas-${preset}`);
      if (active) {
        if (preset === 'hyped') {
          active.className = 'py-1 px-1 rounded-xl bg-gradient-to-r from-amber-500 to-rose-600 text-white font-black shadow-md flex flex-col items-center';
        } else {
          active.className = 'py-1 px-1 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-sm flex flex-col items-center';
        }
      }
      playBeep(700, 'sine', 0.08);
    }

    function toggleCustomGas() {
      isCustomGasOpen = !isCustomGasOpen;
      const row = document.getElementById('row-custom-gas');
      const btn = document.getElementById('btn-custom-gas-toggle');
      if (row && btn) {
        if (isCustomGasOpen) {
          row.classList.remove('hidden');
          btn.innerText = '✕ Close Gwei';
          activeGasPreset = 'custom';
        } else {
          row.classList.add('hidden');
          btn.innerText = '⚙️ Custom Gwei';
          setGas('turbo');
        }
      }
    }

    function toggleSniperMaster() {
      if (!currentScannedProject) {
        showToast('Please scan a collection first before arming sniper!', true);
        return;
      }

      if (!isArmed) {
        if (!currentUser) {
          showToast('⚡ VIP Member Login Required to Arm Sniper Engine!', true);
          openAuthModal('login');
          return;
        }

        const isOwnerAdmin = currentUser.role === 'admin' || currentUser.email === 'jainbharat666@gmail.com';
        if (!isOwnerAdmin) {
          // Check Validity Expiration
          if (currentUser.valid_until && new Date(currentUser.valid_until).getTime() < Date.now()) {
            showToast('⚠️ VIP Access Expired! Please redeem a renewal key in your profile.', true);
            openUserProfileModal('renew');
            return;
          }
          // Check Snipes Quota
          const maxAllowed = currentUser.max_snipes_allowed !== undefined ? parseInt(currentUser.max_snipes_allowed) : 0;
          const used = currentUser.snipes_used !== undefined ? currentUser.snipes_used : (currentUser.total_snipes || 0);
          if (maxAllowed > 0 && used >= maxAllowed) {
            showToast(`⚠️ Snipes Quota Limit of ${maxAllowed} reached! Please redeem a renewal voucher in profile.`, true);
            openUserProfileModal('renew');
            return;
          }
        }
      }
      
      const activeWorkers = walletFleet.filter((w, i) => i !== masterWalletIndex && w.selected);
      if (activeWorkers.length === 0 && !isDryRun) {
        showToast('Please add & select at least 1 sniper worker wallet!', true);
        switchTab('wallets');
        return;
      }

      isArmed = !isArmed;
      const btn = document.getElementById('btn-master-action');

      if (isArmed) {
        snipesExecutedCount = 0;
        clientArmedTimestamp = Date.now();
        clientDeadOrdersSet.clear();
        const bgGrad = isDryRun 
          ? 'bg-gradient-to-r from-purple-600 via-indigo-600 to-pink-600 shadow-purple-500/25'
          : 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600 shadow-emerald-500/25';
        btn.className = `w-full py-3 px-4 rounded-2xl ${bgGrad} text-white font-black text-xs shadow-lg flex items-center justify-center gap-2 transition-all animate-pulse`;
        btn.innerHTML = isDryRun 
          ? `<i class="fa-solid fa-flask fa-spin text-sm"></i> 🧪 PAPER SNIPER ARMED &amp; SIMULATING (CLICK TO PAUSE)`
          : `<i class="fa-solid fa-crosshairs fa-spin text-sm"></i> ⚡ SNIPER ARMED &amp; HUNTING (CLICK TO PAUSE)`;
        playBeep(950, 'sine', 0.15);
        logConsole(`Sniper Engine ARMED (${isDryRun ? '🧪 PAPER SIMULATION' : '⚡ LIVE MAINNET'}) for "${currentScannedProject.name}" using ${activeWorkers.length} worker wallets (${activeWorkerStrategy}).`);
        showToast(`Sniper Engine ARMED (${isDryRun ? 'Paper Snipe Mode' : activeWorkers.length + ' Workers Active'})`);

        // 🚀 SYNC TO ZERO-HOP 8-FEATURE BACKEND ENGINE
        const buyer = activeWorkers[0] || { privateKey: '', name: 'PaperSimWorker' };
        const workersPayload = activeWorkers.map(w => ({
          privateKey: w.privateKey,
          name: w.name,
          address: w.address
        }));

        const rawTokenIds = (document.getElementById('param-token-ids')?.value || '').trim();
        if (rawTokenIds) {
          activeRuleStates.tokenId = true;
          refreshSingleRuleSwitchUI('tokenId');
        }
        if (selectedTraitFilters && selectedTraitFilters.length > 0) {
          activeRuleStates.trait = true;
          refreshSingleRuleSwitchUI('trait');
        }

        const armHeaders = { 'Content-Type': 'application/json' };
        if (sessionToken) {
          armHeaders['Authorization'] = `Bearer ${sessionToken}`;
        }

        fetch('/api/snipe/arm', {
          method: 'POST',
          headers: armHeaders,
          body: JSON.stringify({
            userId: currentUser?.id,
            slug: currentScannedProject.slug,
            triggerMode: activeTriggerMode,
            maxFloorEth: parseFloat(document.getElementById('param-floor-eth')?.value) || 0,
            maxRareRank: parseInt(document.getElementById('param-rare-rank')?.value, 10) || 1200,
            maxRareEth: parseFloat(document.getElementById('param-rare-eth')?.value) || 0,
            gasSpeed: activeGasPreset,
            customGas: (activeGasPreset === 'custom') ? {
              customPriorityFeeGwei: parseFloat(document.getElementById('param-custom-priority-fee')?.value) || 0,
              customMaxFeeGwei: parseFloat(document.getElementById('param-custom-max-fee')?.value) || 0
            } : null,
            buyerPrivateKey: buyer.privateKey,
            buyerName: buyer.name,
            workers: workersPayload,
            workerStrategy: activeWorkerStrategy,
            maxSnipesLimit: activeMaxSnipesLimit,
            dryRun: isDryRun,
            specificTokenIds: document.getElementById('param-token-ids')?.value || '',
            specificTokenMaxEth: parseFloat(document.getElementById('param-token-max-eth')?.value) || 0,
            traitFilter: selectedTraitFilters[0] ? {
              traitType: selectedTraitFilters[0].traitType,
              traitValue: selectedTraitFilters[0].traitValue,
              maxEth: parseFloat(document.getElementById('param-trait-max-eth')?.value) || 0
            } : null,
            traitFilters: selectedTraitFilters,
            traitMaxEth: parseFloat(document.getElementById('param-trait-max-eth')?.value) || 0,
            ruleStates: activeRuleStates
          })
        }).then(r => r.json()).then(d => {
          if (d.success) {
            logConsole(`⚡ [ZERO-HOP BACKEND ACTIVE] Pre-warmed Signer pool (${d.workersLoaded} workers) & multi-RPC blast ready. Mode: ${d.isDryRun ? 'Paper Simulation' : 'Live'}.`);
          } else {
            showToast(d.error || 'Failed to arm sniper', true);
            logConsole(`❌ [ARM REJECTED] ${d.error || 'Failed to arm sniper'}`);
            isArmed = false;
            clientArmedTimestamp = 0;
            btn.className = 'w-full py-3 px-4 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-xs shadow-md flex items-center justify-center gap-2 transition-all';
            btn.innerHTML = isDryRun
              ? `<i class="fa-solid fa-flask text-sm"></i> ARM PAPER SNIPER (SIMULATED - 0 ETH)`
              : `<i class="fa-solid fa-crosshairs text-sm"></i> ARM AUTO-SNIPER (MAINNET LIVE)`;
          }
        }).catch((err) => {
          showToast('Arming error: ' + (err.message || 'Connection failed'), true);
        });

      } else {
        snipesExecutedCount = 0;
        clientArmedTimestamp = 0;
        btn.className = 'w-full py-3 px-4 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-black text-xs shadow-md flex items-center justify-center gap-2 transition-all cursor-pointer';
        btn.innerHTML = isDryRun
          ? `<i class="fa-solid fa-flask text-sm"></i> ARM PAPER SNIPER (SIMULATED - 0 ETH)`
          : `<i class="fa-solid fa-crosshairs text-sm"></i> ARM AUTO-SNIPER (MAINNET LIVE)`;
        playBeep(440, 'triangle', 0.15);
        logConsole(`Sniper Engine PAUSED by user.`);
        showToast('Sniper Engine PAUSED');

        fetch('/api/snipe/disarm', { method: 'POST' }).catch(() => {});
      }
    }

    // Legacy duplicate filter functions removed — unified in reactive store-based renderRealListings below


    function copyContractAddress() {
      if (currentScannedProject && currentScannedProject.contractAddress) {
        navigator.clipboard.writeText(currentScannedProject.contractAddress);
        showToast('Contract address copied!');
      }
    }

    function purgeDataForCleanShare() {
      localStorage.clear();
      rpcFleet = JSON.parse(JSON.stringify(DEFAULT_RPC_FLEET));
      walletFleet = [];
      masterWalletIndex = null;
      clearScannedCollection();
      renderWalletFleetUI();
      renderRpcFleet();
      fetchOpenSeaKeys();
      logConsole(`🧹 Clean Share Mode Activated: All custom local storage, wallets & credentials purged.`);
      showToast('Clean Share Mode: All local data purged!');
    }

    function exportFullProfile() {
      const profile = {
        app: 'NFT Sniper Premium',
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        walletFleet,
        masterWalletIndex,
        rpcFleet,
        rpcStrategy: currentRpcStrategy,
        blastTarget: activeBlastTarget,
        triggerMode: activeTriggerMode,
        gasPreset: activeGasPreset
      };

      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(profile, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `sniper_profile_${Date.now()}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      showToast('Profile JSON exported successfully');
    }

    function importFullProfile(event) {
      const file = event.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const p = JSON.parse(e.target.result);
          if (p.walletFleet && Array.isArray(p.walletFleet)) {
            walletFleet = p.walletFleet;
            if (p.masterWalletIndex !== undefined) masterWalletIndex = p.masterWalletIndex;
            if (p.rpcFleet && Array.isArray(p.rpcFleet)) rpcFleet = p.rpcFleet;
            if (p.rpcStrategy) setRpcStrategy(p.rpcStrategy);
            if (p.blastTarget) setBlastTarget(p.blastTarget);
            if (p.triggerMode) setTriggerMode(p.triggerMode);
            if (p.gasPreset) setGas(p.gasPreset);
            persistState();
            renderWalletFleetUI();
            renderRpcFleet();
            fetchOpenSeaKeys();
            refreshAllBalances();
            showToast('Profile imported successfully!');
          }
        } catch(err) {
          showToast('Failed to parse JSON file!', true);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }


    function triggerSnipeCheer(tokenId, priceEth, buyerName, txHash) {
      try {
        if (typeof confetti === 'function') {
          confetti({ particleCount: 80, spread: 80, origin: { y: 0.5 } });
          setTimeout(() => confetti({ particleCount: 60, angle: 60, spread: 55, origin: { x: 0, y: 0.7 } }), 180);
          setTimeout(() => confetti({ particleCount: 60, angle: 120, spread: 55, origin: { x: 1, y: 0.7 } }), 360);
        }
        playBeep(900, 'sine', 0.1);
        setTimeout(() => playBeep(1200, 'sine', 0.15), 120);
        setTimeout(() => playBeep(1600, 'sine', 0.25), 260);

        const banner = document.getElementById('snipe-celebration-banner');
        const title = document.getElementById('snipe-cheer-title');
        const sub = document.getElementById('snipe-cheer-sub');
        if (banner) {
          if (title) title.innerText = `Token #${tokenId} bought for ${formatEthDynamic(priceEth)}!`;
          if (sub) sub.innerText = `Purchased by ${buyerName || 'Worker'} • Tx: ${txHash ? txHash.slice(0, 14) + '...' : 'Confirmed'}`;
          banner.classList.remove('-translate-y-36', 'opacity-0');
          banner.classList.add('translate-y-0', 'opacity-100');
          setTimeout(() => {
            banner.classList.remove('translate-y-0', 'opacity-100');
            banner.classList.add('-translate-y-36', 'opacity-0');
          }, 4500);
        }
      } catch(e) {}
    }

    function checkSniperTriggers(listings) {
      if (!isArmed || !currentScannedProject || !Array.isArray(listings)) return;
      if (activeMaxSnipesLimit > 0 && snipesExecutedCount >= activeMaxSnipesLimit) return;

      const maxFloorEth = parseFloat(document.getElementById('param-floor-eth')?.value) || 0;
      const maxRareRank = parseInt(document.getElementById('param-rare-rank')?.value, 10) || 1200;
      const maxRareEth = parseFloat(document.getElementById('param-rare-eth')?.value) || 0;
      const targetTokenIdsRaw = document.getElementById('param-token-ids')?.value || '';

      listings.forEach(item => {
        if (!item || !item.price || item.sniped) return;
        const tokId = String(item.tokenId);
        if (clientBoughtTokens.has(tokId)) return;

        const itemHash = item.orderHash || item.protocolData?.orderHash;
        if (itemHash && typeof clientDeadOrdersSet !== 'undefined' && clientDeadOrdersSet.has(itemHash)) return;

        // 🛡️ CRITICAL GUARD: Must have orderHash or protocolData before evaluating!
        const hasOrderHash = Boolean(itemHash && itemHash.length > 10);
        const hasProtocolParams = Boolean(item.protocolData?.parameters && item.protocolData?.signature);
        if (!hasOrderHash && !hasProtocolParams) {
          return; // Skip items without orderHash / Seaport signature
        }

        // 🛡️ CRITICAL GUARD: Only auto-snipe fresh listings that occurred AFTER the sniper was armed
        const minArmTime = clientArmedTimestamp ? (clientArmedTimestamp - 5000) : Date.now();
        const itemTs = item.eventTimestamp ? Number(item.eventTimestamp) : Date.now();
        const isAfterArm = itemTs >= minArmTime;
        const isFresh = (item.ageSeconds || 0) <= 30;
        if (!isAfterArm || !isFresh) {
          return; // Skip historical listings loaded during initial scan!
        }

        let triggered = false;
        let reason = '';

        // 🎯 PRIORITY 1: TARGET TOKEN ID TRAP
        const targetTokenSet = new Set(
          String(targetTokenIdsRaw)
            .split(/[\s,]+/)
            .map(s => s.replace(/[^0-9]/g, ''))
            .filter(Boolean)
        );
        const isTokenTrapActive = (typeof activeRuleStates !== 'undefined')
          ? (activeRuleStates.tokenId || targetTokenSet.size > 0)
          : targetTokenSet.size > 0;
        const cleanId = String(item.tokenId || '').trim().replace(/[^0-9]/g, '');
        const tokenMaxEth = parseFloat(document.getElementById('param-token-max-eth')?.value) || 0;
        const effectiveTokenCap = tokenMaxEth > 0 ? tokenMaxEth : (maxFloorEth > 0 ? maxFloorEth : Infinity);

        if (isTokenTrapActive && cleanId && targetTokenSet.has(cleanId)) {
          if (item.price <= effectiveTokenCap) {
            triggered = true;
            reason = `🎯 Target Token #${cleanId}: ${item.price} ETH <= Cap ${effectiveTokenCap === Infinity ? 'Market' : effectiveTokenCap + ' ETH'}`;
          }
        }

        // 👑 PRIORITY 2: RARE TRAIT HUNTER
        const isTraitActive = (typeof activeRuleStates !== 'undefined') ? activeRuleStates.trait : false;
        if (!triggered && isTraitActive && selectedTraitFilters && selectedTraitFilters.length > 0) {
          const traitMaxEth = parseFloat(document.getElementById('param-trait-max-eth')?.value) || 0;
          const effectiveTraitCap = traitMaxEth > 0 ? traitMaxEth : (maxFloorEth > 0 ? maxFloorEth : Infinity);
          if (item.price <= effectiveTraitCap) {
            let itemTraits = item.traits || [];
            if ((!itemTraits || itemTraits.length === 0) && typeof liveListingsStore !== 'undefined') {
              const cached = liveListingsStore.find(i => String(i.tokenId) === String(cleanId));
              if (cached?.traits?.length > 0) itemTraits = cached.traits;
            }
            const matchesTrait = selectedTraitFilters.some(f => {
              const targetType = (f.traitType || '').trim().toLowerCase();
              const targetVal = (f.traitValue || '').trim().toLowerCase();
              return itemTraits.some(t => {
                const tType = String(t.trait_type || t.traitType || t.type || '').trim().toLowerCase();
                const tVal = String(t.value !== undefined ? t.value : (t.val !== undefined ? t.val : '')).trim().toLowerCase();
                const typeMatch = !targetType || tType === targetType;
                const valMatch = !targetVal || tVal === targetVal;
                return typeMatch && valMatch;
              });
            });
            if (matchesTrait) {
              triggered = true;
              reason = `👑 Rare Trait Match at ${item.price} ETH <= Cap ${effectiveTraitCap === Infinity ? 'Market' : effectiveTraitCap + ' ETH'}`;
            }
          }
        }

        // ⚡ PRIORITY 3: FLOOR UNDERPRICE TRAP
        const isFloorActive = (typeof activeRuleStates !== 'undefined') ? activeRuleStates.floor : (activeTriggerMode === 'floor' || activeTriggerMode === 'both');
        if (!triggered && isFloorActive && maxFloorEth > 0) {
          if (item.price <= maxFloorEth) {
            triggered = true;
            reason = `Floor Fat-Finger: ${item.price} ETH <= Target ${maxFloorEth} ETH`;
          }
        }

        // 💎 PRIORITY 4: TOP RARITY RANK SNIPE
        const isRarityActive = (typeof activeRuleStates !== 'undefined') ? activeRuleStates.rarity : (activeTriggerMode === 'rarity' || activeTriggerMode === 'both');
        const effectiveRareCap = maxRareEth > 0 ? maxRareEth : (maxFloorEth > 0 ? maxFloorEth : 0);
        if (!triggered && isRarityActive && effectiveRareCap > 0) {
          if (item.rarityRank && item.rarityRank <= maxRareRank && item.price <= effectiveRareCap) {
            triggered = true;
            reason = `Top Rarity #${item.rarityRank} at ${item.price} ETH <= Target ${effectiveRareCap} ETH`;
          }
        }

        if (triggered && !item.sniped) {
          item.sniped = true;
          clientBoughtTokens.add(tokId);
          playBeep(980, 'sine', 0.2);
          
          const activeWorkers = walletFleet.filter((w, i) => i !== masterWalletIndex && w.selected !== false);
          const buyer = activeWorkers[0] || walletFleet.find((w, i) => i !== masterWalletIndex) || walletFleet[0];

          if (!buyer) {
            logConsole(`⚠ [SNIPER PAUSED] Trigger matched [${reason}], but no worker wallets are loaded!`);
            showToast('No worker wallet found!', true);
            return;
          }

          // 0ms Zero-Latency In-Memory Balance Guard
          const reqEth = parseFloat(item.price) || 0;
          if ((buyer.balanceEth || 0) < reqEth) {
            logConsole(`❌ [INSUFFICIENT FUNDS] Worker [${buyer.name}] cached balance (${(buyer.balanceEth || 0).toFixed(6)} ETH) < Required ${reqEth} ETH. Snipe paused!`);
            showToast(`Worker balance too low: ${(buyer.balanceEth || 0).toFixed(6)} ETH`, true);
            return;
          }

          logConsole(`🎯 🚨 TRIGGER MATCHED! [${reason}]`);
          logConsole(`⚡ [ZERO-LATENCY TURBO] Worker [${buyer.name}] broadcasting Seaport fulfillment for #${item.tokenId}...`);

          fetch('/api/snipe/buy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              buyerPrivateKey: buyer.privateKey,
              protocolData: item.protocolData,
              orderHash: item.orderHash,
              priceEth: item.price,
              tokenId: item.tokenId
            })
          }).then(async (res) => {
            const data = await res.json();
            if (data.success) {
              if (data.alreadyProcessing) {
                // Zero-hop backend engine already processed this token in RAM
                return;
              }
              snipesExecutedCount++;
              logConsole(`🎉 BUY MINED ON-CHAIN: Token #${item.tokenId} confirmed in Block #${data.blockNumber} (TxHash: ${data.txHash.slice(0, 14)}...)!`);
              showToast(`NFT #${item.tokenId} bought successfully by ${buyer.name}!`);
              triggerSnipeCheer(item.tokenId, item.price, buyer.name, data.txHash);
              refreshAllBalances();

              const isLimitHit = (activeMaxSnipesLimit > 0 && snipesExecutedCount >= activeMaxSnipesLimit) || data.circuitBreakerHit;
              if (isLimitHit) {
                handleClientCircuitBreakerHit(data.executedCount || snipesExecutedCount, data.maxLimit || activeMaxSnipesLimit);
              }
            } else {
              // Dead order detection
              if (data.isDeadOrder || /not valid|not found|cancelled|expired/i.test(data.error || '')) {
                item.sniped = true;
                item.isDeadOrder = true;
                if (itemHash && typeof clientDeadOrdersSet !== 'undefined') clientDeadOrdersSet.add(itemHash);
                const row = document.querySelector(`tr[data-token="${item.tokenId}"]`);
                if (row) {
                  row.style.opacity = '0.4';
                  const rowBtn = row.querySelector('button');
                  if (rowBtn) {
                    rowBtn.disabled = true;
                    rowBtn.innerText = 'INACTIVE';
                    rowBtn.className = 'px-3 py-1 text-[10px] font-bold rounded-lg bg-slate-700 text-slate-400 cursor-not-allowed';
                  }
                }
                logConsole(`ℹ [ORDER INACTIVE] #${item.tokenId} is no longer valid on OpenSea. Skipping.`);
              } else {
                // If backend already broadcasted and RPC returned already known/nonce used, ignore gracefully
                if (/already known|nonce too low/i.test(data.error || '')) {
                  return;
                }
                item.sniped = false;
                clientBoughtTokens.delete(tokId);
                logConsole(`❌ ON-CHAIN BUY FAILED: ${data.error || 'Transaction reverted'}`);
                showToast(data.error || 'Snipe failed on-chain', true);
              }
            }
          }).catch((err) => {
            item.sniped = false;
            clientBoughtTokens.delete(tokId);
            logConsole(`❌ ON-CHAIN SNIPE ERROR: ${err.message}`);
            showToast(`Snipe error: ${err.message}`, true);
          });
        }
      });
    }

    async function executeManualBuy(tokenId, price) {
      const activeWorkers = walletFleet.filter((w, i) => i !== masterWalletIndex && w.selected);
      const buyer = activeWorkers[0];

      if (!buyer) {
        showToast('Please select at least 1 sniper worker wallet in Wallets Fleet tab!', true);
        switchTab('wallets');
        return;
      }

      playBeep(900, 'sine', 0.1);
      const provider = getEthersProvider();
      const cleanBuyerAddr = sanitizeAddress(buyer.address);

      try {
        const balWei = await provider.getBalance(cleanBuyerAddr);
        const balEth = parseFloat(ethers.formatEther(balWei));
        const reqEth = parseFloat(price) || 0;
        const feeData = await getSafeFeeData();
        const estSnipeGasWei = 180000n * feeData.gasPrice;
        const priceWei = ethers.parseEther(String(price));
        const totalNeededWei = priceWei + estSnipeGasWei;

        if (balWei < totalNeededWei) {
          const totalNeededEth = ethers.formatEther(totalNeededWei);
          logConsole(`❌ [INSUFFICIENT FUNDS] Worker [${buyer.name}] has ${balEth.toFixed(6)} ETH | Required: ~${totalNeededEth} ETH (Price: ${reqEth} ETH + Gas). Cannot buy!`);
          showToast(`Worker needs ~${totalNeededEth} ETH (Price + Gas)`, true);
          return;
        }

        logConsole(`🛒 Manual Buy triggered for Token #${tokenId} at ${price} ETH from Worker [${buyer.name}]...`);
        logConsole(`⚡ Broadcasting real Seaport purchase on Robinhood Chain...`);

        const targetItem = liveListingsStore.find(i => String(i.tokenId) === String(tokenId));
        const protocolData = targetItem ? (targetItem.protocolData || targetItem.rawEvent?.payload?.protocol_data) : null;
        const orderHash = targetItem ? targetItem.orderHash : null;

        const res = await fetch('/api/snipe/buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            buyerPrivateKey: buyer.privateKey,
            protocolData: protocolData,
            orderHash: orderHash,
            priceEth: price,
            tokenId: tokenId
          })
        });

        const data = await res.json();
        if (data.success) {
          logConsole(`🎉 BUY MINED ON-CHAIN: Order for Token #${tokenId} successfully confirmed (TxHash: ${data.txHash.slice(0, 14)}...)!`);
          showToast(`Buy confirmed for #${tokenId} by ${buyer.name}!`);
          triggerSnipeCheer(tokenId, price, buyer.name, data.txHash);
          refreshAllBalances();

          if (isArmed) {
            snipesExecutedCount++;
            const isLimitHit = (activeMaxSnipesLimit > 0 && snipesExecutedCount >= activeMaxSnipesLimit) || data.circuitBreakerHit;
            if (isLimitHit) {
              handleClientCircuitBreakerHit(data.executedCount || snipesExecutedCount, data.maxLimit || activeMaxSnipesLimit);
            }
          }
        } else {
          if (data.isDeadOrder || /not valid|not found|cancelled|expired/i.test(data.error || '')) {
            if (orderHash) clientDeadOrdersSet.add(orderHash);
            const row = document.querySelector(`tr[data-token="${tokenId}"]`);
            if (row) {
              row.style.opacity = '0.4';
              const rowBtn = row.querySelector('button');
              if (rowBtn) {
                rowBtn.disabled = true;
                rowBtn.innerText = 'INACTIVE';
                rowBtn.className = 'px-3 py-1 text-[10px] font-bold rounded-lg bg-slate-700 text-slate-400 cursor-not-allowed';
              }
            }
            logConsole(`ℹ [ORDER INACTIVE] Token #${tokenId} is no longer active on OpenSea (cancelled or bought).`);
            showToast(`Order #${tokenId} is no longer active`, true);
          } else {
            logConsole(`❌ ON-CHAIN BUY FAILED: ${data.error || 'Transaction reverted'}`);
            showToast(data.error || 'Buy failed on-chain', true);
          }
        }
      } catch (err) {
        logConsole(`❌ BUY ERROR: ${err.message}`);
        showToast(`Buy error: ${err.message}`, true);
      }
    }


    function setTriggerMode(mode) {
      activeTriggerMode = mode;
      persistState();

      const btnFloor = document.getElementById('mode-btn-floor');
      const btnRarity = document.getElementById('mode-btn-rarity');
      const btnBoth = document.getElementById('mode-btn-both');
      const btnPro = document.getElementById('mode-btn-pro');

      [btnFloor, btnRarity, btnBoth, btnPro].forEach(b => {
        if (b) b.className = 'flex-1 py-1 rounded-xl text-slate-600 hover:text-slate-900 flex items-center justify-center gap-1 transition-all text-[10px]';
      });

      const hasTokens = Boolean(document.getElementById('param-token-ids')?.value?.trim());
      const hasTraits = Boolean(selectedTraitFilters && selectedTraitFilters.length > 0);

      if (mode === 'floor') {
        if (btnFloor) btnFloor.className = 'flex-1 py-1 rounded-xl bg-amber-600 text-white font-black shadow-md flex items-center justify-center gap-1 transition-all text-[10px]';
        activeRuleStates.floor = true;
        activeRuleStates.rarity = false;
        activeRuleStates.trait = hasTraits;
        activeRuleStates.tokenId = hasTokens;
        showToast('Mode: Floor Underprice Only');
      } else if (mode === 'rarity') {
        if (btnRarity) btnRarity.className = 'flex-1 py-1 rounded-xl bg-purple-600 text-white font-black shadow-md flex items-center justify-center gap-1 transition-all text-[10px]';
        activeRuleStates.floor = false;
        activeRuleStates.rarity = true;
        activeRuleStates.trait = hasTraits;
        activeRuleStates.tokenId = hasTokens;
        showToast('Mode: Top Rarity Only');
      } else if (mode === 'both') {
        if (btnBoth) btnBoth.className = 'flex-1 py-1 rounded-xl bg-gradient-to-r from-amber-500 via-rose-500 to-purple-600 text-white font-black shadow-md flex items-center justify-center gap-1 transition-all text-[10px]';
        activeRuleStates.floor = true;
        activeRuleStates.rarity = true;
        activeRuleStates.trait = hasTraits;
        activeRuleStates.tokenId = hasTokens;
        showToast('Mode: Dual (Floor + Rarity)');
      } else if (mode === 'pro') {
        if (btnPro) btnPro.className = 'flex-1 py-1 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white font-black shadow-md flex items-center justify-center gap-1 transition-all text-[10px]';
        activeRuleStates.floor = true;
        activeRuleStates.rarity = true;
        activeRuleStates.trait = true;
        activeRuleStates.tokenId = true;
        showToast('Mode: Pro Mode (All 4 Rules Enabled)');
      }

      refreshAllRuleSwitchesUI();
      updateLiveRadar();
      playBeep(850, 'sine', 0.08);
    }

    // ─── 8 ADVANCED FEATURES UI CONTROLLERS ───
    function togglePaperSnipe() {
      isDryRun = !isDryRun;
      const btn = document.getElementById('btn-paper-snipe');
      const label = document.getElementById('label-paper-snipe');
      const statusBadge = document.getElementById('badge-mainnet-status');
      const armBtn = document.getElementById('btn-master-action');

      if (isDryRun) {
        if (btn) btn.className = 'px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-purple-600 text-white border border-purple-500 shadow-sm flex items-center gap-1';
        if (label) { label.innerText = 'ON'; label.className = 'text-yellow-300 font-black'; }
        if (statusBadge) {
          statusBadge.className = 'text-[9px] font-black uppercase bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full border border-purple-300';
          statusBadge.innerText = '🧪 PAPER SIM';
        }
        if (armBtn && !isArmed) {
          armBtn.innerHTML = '<i class="fa-solid fa-flask text-sm"></i> ARM PAPER SNIPER (SIMULATED - 0 ETH)';
        }
        showToast('🧪 Paper Snipe Simulation ACTIVATED: Real execution logic with 0 ETH spent!');
      } else {
        if (btn) btn.className = 'px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200 transition-all flex items-center gap-1';
        if (label) { label.innerText = 'OFF'; label.className = 'text-slate-500 font-bold'; }
        if (statusBadge) {
          statusBadge.className = 'text-[9px] font-black uppercase bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-200';
          statusBadge.innerText = '100% Real';
        }
        if (armBtn && !isArmed) {
          armBtn.innerHTML = '<i class="fa-solid fa-crosshairs text-sm"></i> ARM AUTO-SNIPER (MAINNET LIVE)';
        }
        showToast('⚡ Live Mainnet Mode ACTIVATED: Real on-chain purchases.');
      }
      playBeep(780, 'sine', 0.08);
      persistState();
    }

    function toggleRuleState(ruleName) {
      activeRuleStates[ruleName] = !activeRuleStates[ruleName];
      refreshSingleRuleSwitchUI(ruleName);
      updateLiveRadar();
      persistState();
      playBeep(activeRuleStates[ruleName] ? 820 : 450, 'sine', 0.06);
    }

    function handleTokenIdInput(val) {
      const hasValue = Boolean(val && String(val).trim());
      if (hasValue) {
        activeRuleStates.tokenId = true;
      }
      refreshSingleRuleSwitchUI('tokenId');
      updateLiveRadar();
      persistState();
    }

    function refreshSingleRuleSwitchUI(ruleName) {
      const sw = document.getElementById(`switch-rule-${ruleName}`);
      const body = document.getElementById(`body-rule-${ruleName}`);
      const dot = document.getElementById(`dot-rule-${ruleName}`);
      const isActive = activeRuleStates[ruleName];

      if (sw) {
        const isDay = document.body.classList.contains('day-mode');
        if (isActive) {
          sw.innerText = '● ACTIVE';
          if (ruleName === 'floor') sw.className = isDay ? 'text-[9px] font-black uppercase bg-amber-100 text-amber-900 px-2.5 py-0.5 rounded-full border border-amber-300 hover:bg-amber-200 transition-all cursor-pointer' : 'text-[9px] font-black uppercase bg-amber-500/20 text-amber-300 px-2.5 py-0.5 rounded-full border border-amber-500/50 hover:bg-amber-500/30 transition-all cursor-pointer shadow-[0_0_8px_rgba(245,158,11,0.25)]';
          else if (ruleName === 'rarity') sw.className = isDay ? 'text-[9px] font-black uppercase bg-purple-100 text-purple-900 px-2.5 py-0.5 rounded-full border border-purple-300 hover:bg-purple-200 transition-all cursor-pointer' : 'text-[9px] font-black uppercase bg-purple-500/20 text-purple-300 px-2.5 py-0.5 rounded-full border border-purple-500/50 hover:bg-purple-500/30 transition-all cursor-pointer shadow-[0_0_8px_rgba(168,85,247,0.25)]';
          else if (ruleName === 'trait') sw.className = isDay ? 'text-[9px] font-black uppercase bg-pink-100 text-pink-900 px-2.5 py-0.5 rounded-full border border-pink-300 hover:bg-pink-200 transition-all cursor-pointer' : 'text-[9px] font-black uppercase bg-pink-500/20 text-pink-300 px-2.5 py-0.5 rounded-full border border-pink-500/50 hover:bg-pink-500/30 transition-all cursor-pointer shadow-[0_0_8px_rgba(236,72,153,0.25)]';
          else if (ruleName === 'tokenId') sw.className = isDay ? 'text-[9px] font-black uppercase bg-cyan-100 text-cyan-900 px-2.5 py-0.5 rounded-full border border-cyan-300 hover:bg-cyan-200 transition-all cursor-pointer' : 'text-[9px] font-black uppercase bg-cyan-500/20 text-cyan-300 px-2.5 py-0.5 rounded-full border border-cyan-500/50 hover:bg-cyan-500/30 transition-all cursor-pointer shadow-[0_0_8px_rgba(6,182,212,0.25)]';
        } else {
          sw.innerText = 'PAUSED';
          sw.className = isDay ? 'text-[9px] font-bold uppercase bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full border border-slate-300 hover:bg-slate-200 transition-all cursor-pointer' : 'text-[9px] font-bold uppercase bg-slate-800 text-slate-300 px-2.5 py-0.5 rounded-full border border-slate-700 hover:bg-slate-700 transition-all cursor-pointer';
        }
      }

      if (dot) {
        if (isActive) {
          dot.innerText = '●';
          if (ruleName === 'floor') dot.className = 'text-yellow-300 font-black';
          else if (ruleName === 'rarity') dot.className = 'text-purple-600 font-black';
          else if (ruleName === 'trait') dot.className = 'text-pink-600 font-black';
          else if (ruleName === 'tokenId') dot.className = 'text-cyan-600 font-black';
        } else {
          dot.innerText = '○';
          dot.className = 'text-slate-400 font-black';
        }
      }

      if (body) {
        if (isActive) body.classList.remove('rule-dimmed');
        else body.classList.add('rule-dimmed');
      }

      updateBentoValues();
    }
    let currentRuleDeck = 'floor';

    function switchRuleDeck(deckName) {
      currentRuleDeck = deckName;
      
      const decks = ['floor', 'rarity', 'trait', 'tokenId', 'bento'];
      decks.forEach(d => {
        const view = document.getElementById(`deck-view-${d}`);
        const btn = document.getElementById(`deck-btn-${d}`);
        if (view) view.classList.add('hidden');
        if (btn) {
          const isDk = !document.body.classList.contains('day-mode');
          if (d === 'floor') btn.className = 'flex-1 py-1 rounded-lg ' + (isDk ? 'text-slate-400 hover:text-amber-300' : 'text-slate-600 hover:text-amber-800') + ' font-bold flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
          else if (d === 'rarity') btn.className = 'flex-1 py-1 rounded-lg ' + (isDk ? 'text-slate-400 hover:text-purple-300' : 'text-slate-600 hover:text-purple-800') + ' font-bold flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
          else if (d === 'trait') btn.className = 'flex-1 py-1 rounded-lg ' + (isDk ? 'text-slate-400 hover:text-pink-300' : 'text-slate-600 hover:text-pink-800') + ' font-bold flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
          else if (d === 'tokenId') btn.className = 'flex-1 py-1 rounded-lg ' + (isDk ? 'text-slate-400 hover:text-cyan-300' : 'text-slate-600 hover:text-cyan-800') + ' font-bold flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
          else if (d === 'bento') btn.className = 'py-1 px-2 rounded-lg ' + (isDk ? 'text-slate-400 hover:text-indigo-300' : 'text-slate-600 hover:text-indigo-800') + ' font-bold flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
        }
      });

      const activeView = document.getElementById(`deck-view-${deckName}`);
      const activeBtn = document.getElementById(`deck-btn-${deckName}`);
      if (activeView) activeView.classList.remove('hidden');
      if (activeBtn) {
        if (deckName === 'floor') activeBtn.className = 'flex-1 py-1 rounded-lg bg-amber-600 text-white font-black shadow-sm flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
        else if (deckName === 'rarity') activeBtn.className = 'flex-1 py-1 rounded-lg bg-purple-600 text-white font-black shadow-sm flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
        else if (deckName === 'trait') activeBtn.className = 'flex-1 py-1 rounded-lg bg-pink-600 text-white font-black shadow-sm flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
        else if (deckName === 'tokenId') activeBtn.className = 'flex-1 py-1 rounded-lg bg-cyan-600 text-white font-black shadow-sm flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
        else if (deckName === 'bento') activeBtn.className = 'py-1 px-2 rounded-lg bg-indigo-600 text-white font-black shadow-sm flex items-center justify-center gap-1 transition-all text-[10px] cursor-pointer';
      }

      updateBentoValues();
      playBeep(850, 'sine', 0.05);
    }

    function updateBentoValues() {
      const bFloor = document.getElementById('bento-val-floor');
      const pFloor = document.getElementById('param-floor-eth');
      if (bFloor && pFloor) bFloor.innerText = pFloor.value || '0';

      const bRank = document.getElementById('bento-val-rare-rank');
      const pRank = document.getElementById('param-rare-rank');
      if (bRank && pRank) bRank.innerText = pRank.value || '1200';

      const bEth = document.getElementById('bento-val-rare-eth');
      const pEth = document.getElementById('param-rare-eth');
      if (bEth && pEth) bEth.innerText = pEth.value || '0';

      const bTrait = document.getElementById('bento-val-trait');
      if (bTrait) {
        if (typeof selectedTraitFilters !== 'undefined' && selectedTraitFilters.length > 0) {
          bTrait.innerText = selectedTraitFilters.length === 1
            ? `${selectedTraitFilters[0].traitType}: ${selectedTraitFilters[0].traitValue}`
            : `${selectedTraitFilters.length} Traits Targeted`;
        } else {
          bTrait.innerText = 'God Traits / 1/1s';
        }
      }

      const bTk = document.getElementById('bento-val-token');
      const tIds = document.getElementById('param-token-ids')?.value;
      if (bTk) {
        if (tIds) bTk.innerText = `IDs: ${tIds.slice(0, 14)}`;
        else bTk.innerText = 'Specific Token IDs';
      }

      // Update bento switches
      const swFloor = document.getElementById('bento-sw-floor');
      if (swFloor) {
        swFloor.innerText = activeRuleStates.floor ? '● ON' : 'OFF';
        swFloor.className = activeRuleStates.floor ? 'text-[8px] font-black px-1.5 py-0.2 rounded-full bg-amber-200 text-amber-900 cursor-pointer' : 'text-[8px] font-bold px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-600 cursor-pointer';
      }

      const swRare = document.getElementById('bento-sw-rarity');
      if (swRare) {
        swRare.innerText = activeRuleStates.rarity ? '● ON' : 'OFF';
        swRare.className = activeRuleStates.rarity ? 'text-[8px] font-black px-1.5 py-0.2 rounded-full bg-purple-200 text-purple-900 cursor-pointer' : 'text-[8px] font-bold px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-600 cursor-pointer';
      }

      const swTrait = document.getElementById('bento-sw-trait');
      if (swTrait) {
        swTrait.innerText = activeRuleStates.trait ? '● ON' : 'OFF';
        swTrait.className = activeRuleStates.trait ? 'text-[8px] font-black px-1.5 py-0.2 rounded-full bg-pink-200 text-pink-900 cursor-pointer' : 'text-[8px] font-bold px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-600 cursor-pointer';
      }

      const swTk = document.getElementById('bento-sw-tokenId');
      if (swTk) {
        swTk.innerText = activeRuleStates.tokenId ? '● ON' : 'OFF';
        swTk.className = activeRuleStates.tokenId ? 'text-[8px] font-black px-1.5 py-0.2 rounded-full bg-cyan-200 text-cyan-900 cursor-pointer' : 'text-[8px] font-bold px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-600 cursor-pointer';
      }
    }


    function refreshAllRuleSwitchesUI() {
      ['floor', 'rarity', 'trait', 'tokenId'].forEach(r => refreshSingleRuleSwitchUI(r));
    }

    function setCircuitBreakerLimit(val) {
      activeMaxSnipesLimit = parseInt(val, 10);
      showToast(`Anti-Drain Circuit Breaker: ${activeMaxSnipesLimit === 0 ? 'Unlimited Snipes' : 'Auto-Pause after ' + activeMaxSnipesLimit + ' snipe(s)'}`);
      persistState();
    }

    function setWorkerStrategy(strat) {
      activeWorkerStrategy = strat;
      showToast(`Execution Strategy: ${strat === 'round_robin' ? 'Alternate Round-Robin' : strat === 'parallel_blitz' ? 'Parallel Blitz' : 'Single Worker'}`);
      persistState();
    }

    function updateLiveRadar() {
      const radarDist = document.getElementById('radar-floor-dist');
      const radarCount = document.getElementById('radar-qualifying-count');
      if (!radarDist || !radarCount) return;

      const floorTargetEth = parseFloat(document.getElementById('param-floor-eth')?.value) || 0;
      if (currentFloorEth > 0 && floorTargetEth > 0) {
        const diffPercent = (((floorTargetEth - currentFloorEth) / currentFloorEth) * 100).toFixed(1);
        radarDist.innerText = `🎯 ${diffPercent >= 0 ? '+' : ''}${diffPercent}% vs Floor (${floorTargetEth} ETH)`;
      } else {
        radarDist.innerText = '🎯 Target Range Ready';
      }

      // Count listings currently matching active rules
      let inRangeCount = 0;
      const rareTargetRank = parseInt(document.getElementById('param-rare-rank')?.value, 10) || 1200;
      const rareTargetEth = parseFloat(document.getElementById('param-rare-eth')?.value) || 0;
      const targetTokenIdsStr = document.getElementById('param-token-ids')?.value || '';
      const radarTokenSet = new Set(targetTokenIdsStr.split(/[\s,]+/).map(s => s.replace(/[^0-9]/g, '')).filter(Boolean));
      const tokenCap = parseFloat(document.getElementById('param-token-max-eth')?.value) || (floorTargetEth > 0 ? floorTargetEth : Infinity);

      liveListingsStore.forEach(item => {
        let match = false;
        const cleanId = String(item.tokenId || '').trim().replace(/[^0-9]/g, '');
        if (activeRuleStates.floor && floorTargetEth > 0 && item.price <= floorTargetEth) match = true;
        if (!match && activeRuleStates.rarity && rareTargetEth > 0 && item.rarityRank && item.rarityRank <= rareTargetRank && item.price <= rareTargetEth) match = true;
        if (!match && (activeRuleStates.tokenId || radarTokenSet.size > 0) && cleanId && radarTokenSet.has(cleanId) && item.price <= tokenCap) match = true;
        if (match) inRangeCount++;
      });

      radarCount.innerText = `${inRangeCount} in range`;
      if (inRangeCount > 0) {
        radarCount.className = 'bg-emerald-900/90 px-2 py-0.5 rounded border border-emerald-500 text-emerald-200 font-black animate-pulse';
      } else {
        radarCount.className = 'bg-indigo-900/80 px-2 py-0.5 rounded border border-indigo-700 text-indigo-200 font-bold';
      }
    }

    function logConsole(msg) {
      const nowStr = new Date().toLocaleTimeString() + '.' + String(Date.now() % 1000).padStart(3, '0');
      const html = `<div><span class="text-slate-500">[${nowStr}]</span> ${msg}</div>`;
      
      const c1 = document.getElementById('console-logs');
      if (c1) {
        c1.insertAdjacentHTML('beforeend', html);
        while (c1.children.length > 300) {
          c1.removeChild(c1.firstElementChild);
        }
        c1.scrollTop = c1.scrollHeight;
      }

      const c2 = document.getElementById('wallet-console-logs');
      if (c2) {
        c2.insertAdjacentHTML('beforeend', html);
        while (c2.children.length > 300) {
          c2.removeChild(c2.firstElementChild);
        }
        c2.scrollTop = c2.scrollHeight;
      }
    }

    function copyConsoleLogs() {
      const c = document.getElementById('console-logs');
      if (c) {
        navigator.clipboard.writeText(c.innerText);
        showToast('Console logs copied to clipboard!');
      }
    }

    function clearConsoleLogs() {
      const c = document.getElementById('console-logs');
      if (c) c.innerHTML = '';
      loggedStreamTokensSet.clear();
      showToast('Console cleared');
    }

    function copyWalletConsoleLogs() {
      const c = document.getElementById('wallet-console-logs');
      if (c) {
        navigator.clipboard.writeText(c.innerText);
        showToast('Fleet console logs copied!');
      }
    }

    function clearWalletConsoleLogs() {
      const c = document.getElementById('wallet-console-logs');
      if (c) c.innerHTML = '';
      showToast('Fleet console cleared');
    }

    // ─── RESTORE 8 ADVANCED FEATURES FROM LOCALSTORAGE ───
    try {
      const savedPaper = localStorage.getItem('sniper_paper_mode');
      if (savedPaper === 'true') {
        isDryRun = false;
        togglePaperSnipe();
      }
      const savedLimit = localStorage.getItem('sniper_circuit_limit');
      if (savedLimit !== null) {
        activeMaxSnipesLimit = parseInt(savedLimit, 10);
        const sel = document.getElementById('select-circuit-breaker');
        if (sel) sel.value = String(activeMaxSnipesLimit);
      }
      const savedStrat = localStorage.getItem('sniper_worker_strategy');
      if (savedStrat) {
        activeWorkerStrategy = savedStrat;
        const sel = document.getElementById('select-worker-strategy');
        if (sel) sel.value = savedStrat;
      }
      const savedRules = localStorage.getItem('sniper_rule_states');
      if (savedRules) {
        activeRuleStates = Object.assign(activeRuleStates, JSON.parse(savedRules));
        refreshAllRuleSwitchesUI();
      }
      const tType = localStorage.getItem('sniper_trait_type');
      if (tType && document.getElementById('param-trait-type')) document.getElementById('param-trait-type').value = tType;
      const tVal = localStorage.getItem('sniper_trait_val');
      if (tVal && document.getElementById('param-trait-val')) document.getElementById('param-trait-val').value = tVal;
      const tEth = localStorage.getItem('sniper_trait_eth');
      if (tEth && document.getElementById('param-trait-max-eth')) document.getElementById('param-trait-max-eth').value = tEth;
      const tIds = localStorage.getItem('sniper_token_ids');
      if (tIds && document.getElementById('param-token-ids')) document.getElementById('param-token-ids').value = tIds;
      const tTkEth = localStorage.getItem('sniper_token_eth');
      if (tTkEth && document.getElementById('param-token-max-eth')) document.getElementById('param-token-max-eth').value = tTkEth;
      const cP = localStorage.getItem('sniper_custom_priority');
      if (cP && document.getElementById('param-custom-priority-fee')) document.getElementById('param-custom-priority-fee').value = cP;
      const cM = localStorage.getItem('sniper_custom_max');
      if (cM && document.getElementById('param-custom-max-fee')) document.getElementById('param-custom-max-fee').value = cM;
    } catch(e) {}
