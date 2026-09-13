/* ══════════════════════════════════════════════════════════════
   🔍 AERO-SNIPER V2: COLLECTION SCANNER & TRAIT HUNTER
   ══════════════════════════════════════════════════════════════ */

    // ─── DYNAMIC TRAIT HUNTER ENGINE (RULE 3) ──────────────────────────────────
    let currentCollectionTraits = null; // { categories: [], counts: {} }
    let selectedTraitFilters = []; // [{ traitType, traitValue }]

    function populateTraitDropdowns(traitsData) {
      currentCollectionTraits = traitsData;
      const catSelect = document.getElementById('select-trait-category');
      const valSelect = document.getElementById('select-trait-value');
      const badge = document.getElementById('badge-traits-loaded');
      if (!catSelect || !valSelect) return;

      catSelect.innerHTML = '<option value="">-- Select Trait Category --</option>';
      valSelect.innerHTML = '<option value="">-- Pick Category First --</option>';

      if (!traitsData || !traitsData.counts) {
        if (badge) badge.innerText = '0 traits';
        return;
      }

      const cats = traitsData.categories || Object.keys(traitsData.counts);
      if (badge) badge.innerText = cats.length + ' categories';

      cats.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        const numValues = Object.keys(traitsData.counts[cat] || {}).length;
        opt.innerText = cat + ' (' + numValues + ' types)';
        catSelect.appendChild(opt);
      });
    }

    function handleTraitCategoryChange() {
      const catSelect = document.getElementById('select-trait-category');
      const valSelect = document.getElementById('select-trait-value');
      if (!catSelect || !valSelect || !currentCollectionTraits) return;

      const chosenCat = catSelect.value;
      valSelect.innerHTML = '';

      if (!chosenCat || !currentCollectionTraits.counts[chosenCat]) {
        valSelect.innerHTML = '<option value="">-- Pick Category First --</option>';
        return;
      }

      valSelect.innerHTML = '<option value="">-- Select Value --</option>';
      const valuesObj = currentCollectionTraits.counts[chosenCat];
      const totalSup = currentScannedProject?.totalSupply || 10000;

      // Sort by count ascending (rarest first!)
      const sortedEntries = Object.entries(valuesObj).sort((a, b) => a[1] - b[1]);

      sortedEntries.forEach(([val, count]) => {
        const opt = document.createElement('option');
        opt.value = val;
        const pct = ((count / totalSup) * 100).toFixed(1);
        const fire = (count <= 10 || pct < 2) ? ' 🔥 RARE' : '';
        opt.innerText = val + ' (' + count + ' NFTs - ' + pct + '%)' + fire;
        valSelect.appendChild(opt);
      });
    }

    function handleTraitValueChange() {
      const catSelect = document.getElementById('select-trait-category');
      const valSelect = document.getElementById('select-trait-value');
      if (catSelect && valSelect && catSelect.value && valSelect.value) {
        addSelectedTraitChip();
      }
    }

    function addSelectedTraitChip() {
      const catSelect = document.getElementById('select-trait-category');
      const valSelect = document.getElementById('select-trait-value');
      if (!catSelect || !valSelect) return;

      const tType = catSelect.value.trim();
      const tVal = valSelect.value.trim();
      if (!tType || !tVal) {
        showToast('Please select both Trait Type and Trait Value', true);
        return;
      }

      const already = selectedTraitFilters.some(f => f.traitType.toLowerCase() === tType.toLowerCase() && f.traitValue.toLowerCase() === tVal.toLowerCase());
      if (!already) {
        selectedTraitFilters.push({ traitType: tType, traitValue: tVal });
        renderTraitChips();
        if (typeof activeRuleStates !== 'undefined' && !activeRuleStates.trait) {
          toggleRuleState('trait');
        }
        showToast('Added Trait: ' + tType + ' = ' + tVal);
      }
    }

    function removeTraitFilter(idx) {
      selectedTraitFilters.splice(idx, 1);
      renderTraitChips();
    }

    function clearAllTraits() {
      selectedTraitFilters = [];
      renderTraitChips();
    }

    function renderTraitChips() {
      const container = document.getElementById('active-traits-chips');
      const footer = document.getElementById('trait-preview-footer');
      const bentoSummary = document.getElementById('bento-trait-summary');
      if (!container) return;

      if (selectedTraitFilters.length === 0) {
        container.innerHTML = '<span class="text-[9px] text-slate-400 italic">No traits selected (pick from dropdown)</span>';
        if (footer) footer.innerHTML = '<i class="fa-solid fa-bolt text-pink-500"></i> Auto 0.0ms RAM match';
        if (bentoSummary) bentoSummary.innerText = '0 traits targeted';
        return;
      }

      container.innerHTML = '';
      selectedTraitFilters.forEach((f, i) => {
        const chip = document.createElement('span');
        chip.className = 'inline-flex items-center gap-1 bg-pink-100 border border-pink-300 text-pink-900 px-1.5 py-0.2 rounded-full text-[9px] font-bold shadow-xs';
        chip.innerHTML = '<span>' + f.traitType + ': <b class="text-pink-950">' + f.traitValue + '</b></span> <button type="button" onclick="removeTraitFilter(' + i + ')" class="text-pink-600 hover:text-pink-900 font-black ml-0.5 cursor-pointer">✖</button>';
        container.appendChild(chip);
      });

      if (footer) {
        footer.innerHTML = '<span class="text-pink-900 font-bold">' + selectedTraitFilters.length + ' targeted traits</span> • Instant RAM Match';
      }
      if (bentoSummary) {
        bentoSummary.innerText = selectedTraitFilters.length + ' targeted traits';
      }
    }

    function setFloorPercentPreset(percent) {
      activeFloorPercentPreset = percent;
      [10, 20, 50, 80, 90, null].forEach(p => {
        const id = p === null ? 'pct-custom' : `pct-${p}`;
        const btn = document.getElementById(id);
        if (btn) {
          if (p === percent) {
            btn.className = 'pct-btn px-2 py-0.5 rounded-lg bg-amber-600 text-white font-black shadow-sm transition-all';
          } else {
            btn.className = 'pct-btn px-2 py-0.5 rounded-lg bg-white border border-amber-200 text-amber-900 font-bold hover:bg-amber-100 transition-all';
          }
        }
      });

      if (percent !== null && currentFloorEth > 0) {
        const targetEth = currentFloorEth * (1 - (percent / 100));
        document.getElementById('param-floor-eth').value = formatEthValueInput(targetEth);
        document.getElementById('param-floor-usd').value = (targetEth * currentLiveEthPrice).toFixed(2);
        playBeep(750, 'sine', 0.06);
      }
      updateDiscountTag();
    }

    function setRarityRankPreset(rank) {
      [100, 500, 1200].forEach(r => {
        const btn = document.getElementById(`rk-${r}`);
        if (btn) {
          if (r === rank) {
            btn.className = 'rk-btn px-1.5 py-0.5 rounded-lg bg-purple-600 text-white font-black shadow-sm';
          } else {
            btn.className = 'rk-btn px-1.5 py-0.5 rounded-lg bg-white border border-purple-200 text-purple-900 font-bold hover:bg-purple-100';
          }
        }
      });
      document.getElementById('param-rare-rank').value = rank;
      playBeep(800, 'sine', 0.05);
    }

    function setRarityPriceMultiplier(mult) {
      activeRarityMultiplier = mult;
      [100, 125, 150].forEach(m => {
        const btn = document.getElementById(`rpm-${m}`);
        if (btn) {
          const val = m / 100;
          if (val === mult) {
            btn.className = 'rpm-btn px-1.5 py-0.5 rounded-lg bg-purple-600 text-white font-black shadow-sm';
          } else {
            btn.className = 'rpm-btn px-1.5 py-0.5 rounded-lg bg-white border border-purple-200 text-purple-900 font-bold hover:bg-purple-100';
          }
        }
      });

      if (currentFloorEth > 0) {
        const rareTargetEth = currentFloorEth * mult;
        document.getElementById('param-rare-eth').value = formatEthValueInput(rareTargetEth);
        document.getElementById('param-rare-usd').value = (rareTargetEth * currentLiveEthPrice).toFixed(2);
        playBeep(820, 'sine', 0.05);
      }
    }

    function handleEthChange(ethInputEl, targetUsdId) {
      activeFloorPercentPreset = null;
      highlightCustomBtn();

      const ethVal = parseFloat(ethInputEl.value);
      if (!isNaN(ethVal) && ethVal >= 0) {
        const usdVal = (ethVal * currentLiveEthPrice).toFixed(2);
        document.getElementById(targetUsdId).value = usdVal;
      } else {
        document.getElementById(targetUsdId).value = '';
      }
      updateDiscountTag();
    }

    function handleUsdChange(usdInputEl, targetEthId) {
      activeFloorPercentPreset = null;
      highlightCustomBtn();

      const usdVal = parseFloat(usdInputEl.value);
      if (!isNaN(usdVal) && usdVal >= 0 && currentLiveEthPrice > 0) {
        const ethVal = usdVal / currentLiveEthPrice;
        document.getElementById(targetEthId).value = formatEthValueInput(ethVal);
      } else {
        document.getElementById(targetEthId).value = '';
      }
      updateDiscountTag();
    }

    function highlightCustomBtn() {
      [10, 20, 50, 80, 90].forEach(p => {
        const btn = document.getElementById(`pct-${p}`);
        if (btn) btn.className = 'pct-btn px-2 py-0.5 rounded-lg bg-white border border-amber-200 text-amber-900 font-bold hover:bg-amber-100 transition-all';
      });
      const cBtn = document.getElementById('pct-custom');
      if (cBtn) cBtn.className = 'pct-btn px-2 py-0.5 rounded-lg bg-slate-800 text-white font-black shadow-sm transition-all';
    }

    function updateDiscountTag() {
      const targetEth = parseFloat(document.getElementById('param-floor-eth').value) || 0;
      const tagEl = document.getElementById('floor-discount-tag');

      if (targetEth > 0 && currentFloorEth > 0) {
        const diff = ((currentFloorEth - targetEth) / currentFloorEth) * 100;
        const floorFormatted = formatEthPrecise(currentFloorEth);
        if (diff > 0.01) {
          tagEl.innerHTML = `🎯 <span class="text-amber-900 font-black">${diff.toFixed(1)}% Discount Below Floor</span> (${floorFormatted})`;
        } else if (diff < -0.01) {
          tagEl.innerHTML = `⚠️ <span class="text-rose-700 font-black">${Math.abs(diff).toFixed(1)}% Above Floor</span> (${floorFormatted})`;
        } else {
          tagEl.innerHTML = `🎯 <span class="text-amber-900 font-black">Exact Floor Price Match</span> (${floorFormatted})`;
        }
      }
    }

    async function syncLiveEthPrice() {
      try {
        let price = null;
        try {
          const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
          const data = await res.json();
          if (data?.data?.amount) price = parseFloat(data.data.amount);
        } catch(e) {}

        if (price && price > 500) {
          currentLiveEthPrice = price;
          const formatted = `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
          document.getElementById('eth-usd-price').innerText = formatted;

          const container = document.getElementById('eth-price-container');
          container.classList.add('flash-green');
          setTimeout(() => container.classList.remove('flash-green'), 1000);

          recalculateDynamicValues();
        }
      } catch (err) {}
    }

    function recalculateDynamicValues() {
      if (currentScannedProject && currentFloorEth > 0) {
        document.getElementById('proj-floor-usd').innerText = `~$${(currentFloorEth * currentLiveEthPrice).toFixed(2)} USD`;
      }

      if (activeFloorPercentPreset !== null && currentFloorEth > 0) {
        const targetEth = currentFloorEth * (1 - (activeFloorPercentPreset / 100));
        document.getElementById('param-floor-eth').value = formatEthValueInput(targetEth);
        document.getElementById('param-floor-usd').value = (targetEth * currentLiveEthPrice).toFixed(2);
      } else {
        const currentEth = parseFloat(document.getElementById('param-floor-eth').value) || 0;
        if (currentEth > 0) document.getElementById('param-floor-usd').value = (currentEth * currentLiveEthPrice).toFixed(2);
      }

      const rareEth = parseFloat(document.getElementById('param-rare-eth').value) || 0;
      if (rareEth > 0) document.getElementById('param-rare-usd').value = (rareEth * currentLiveEthPrice).toFixed(2);

      document.querySelectorAll('.row-usd-price').forEach(el => {
        const ethVal = parseFloat(el.getAttribute('data-eth')) || 0;
        el.innerText = `$${(ethVal * currentLiveEthPrice).toFixed(2)} USD`;
      });
    }

    setInterval(syncLiveEthPrice, 3500);
    syncLiveEthPrice();

    function updateLiveClock() {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' }) + ' IST';
      document.getElementById('top-live-clock').innerText = timeStr;

      document.querySelectorAll('.live-timer').forEach(el => {
        const ts = parseInt(el.getAttribute('data-timestamp'), 10);
        if (ts && !isNaN(ts)) {
          el.innerText = formatAgeTime(ts);
        }
      });
    }
    setInterval(updateLiveClock, 1000);
    updateLiveClock();

    function playBeep(freq = 880, type = 'sine', duration = 0.15) {
      if (!audioEnabled) return;
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      } catch(e) {}
    }

    function toggleAudio() {
      audioEnabled = !audioEnabled;
      const icon = document.getElementById('audio-icon');
      const textEl = document.getElementById('audio-status-text');
      if (audioEnabled) {
        icon.className = 'fa-solid fa-volume-high text-emerald-600 text-sm';
        textEl.innerText = 'ON';
        textEl.className = 'text-emerald-700';
      } else {
        icon.className = 'fa-solid fa-volume-xmark text-slate-400 text-sm';
        textEl.innerText = 'OFF';
        textEl.className = 'text-slate-400';
      }
    }


    // ================= 100% REAL OPENSEA SCANNER =================
    async function scanProject() {
      const inputEl = document.getElementById('scan-input');
      const val = inputEl.value.trim();

      if (!val) {
        showToast('Please enter an OpenSea URL, slug or contract address!', true);
        return;
      }

      // Clean up previous stream
      if (streamEventSource) {
        streamEventSource.close();
        streamEventSource = null;
      }
      if (livePollerInterval) {
        clearInterval(livePollerInterval);
        livePollerInterval = null;
      }

      loggedStreamTokensSet.clear(); // Reset console token log tracker for new project
      if (window.requestedRarityTokensSet) window.requestedRarityTokensSet.clear(); // Reset rarity requested tokens for new scan
      playBeep(850, 'sine', 0.1);
      logConsole(`🔍 Connecting to OpenSea Instant Scan Engine for: "${val}"...`);
      document.getElementById('btn-scan').innerHTML = `<i class="fa-solid fa-spinner fa-spin text-xs"></i> Scan`;

      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: val })
        });

        const data = await res.json();
        if (data.success) {
          currentScannedProject = data;
          currentFloorEth = data.floorEth || 0.033;

          document.getElementById('proj-name').innerText = data.name;
          document.getElementById('proj-chain-badge').innerText = data.chain;
          document.getElementById('proj-chain-badge').className = 'text-[8px] font-black uppercase bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30';
          document.getElementById('proj-contract').innerText = data.contractAddress.length > 20 ? `${data.contractAddress.slice(0, 8)}...${data.contractAddress.slice(-6)}` : data.contractAddress;
          document.getElementById('proj-copy-icon').classList.remove('hidden');
          
          if (data.image) {
            document.getElementById('proj-avatar').innerHTML = `<img src="${data.image}" class="w-full h-full object-cover rounded-xl" alt="Logo">`;
          } else {
            document.getElementById('proj-avatar').innerText = '🖼️';
          }

          document.getElementById('proj-floor-eth').innerText = formatEthPrecise(currentFloorEth);
          document.getElementById('proj-floor-usd').innerText = `~$${(currentFloorEth * currentLiveEthPrice).toFixed(2)} USD`;
          document.getElementById('proj-supply').innerText = `${data.totalSupply.toLocaleString()} NFTs`;
          document.getElementById('proj-supply-sub').innerText = '100% Minted';
          document.getElementById('proj-listed').innerText = `${data.listedCount} Listed`;
          document.getElementById('proj-listed-sub').innerText = `${((data.listedCount / data.totalSupply) * 100).toFixed(1)}% of Supply`;
          document.getElementById('proj-status-val').innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-ring"></span> Live Stream`;
          document.getElementById('proj-status-val').className = 'text-xs font-black text-emerald-400 flex items-center gap-1';
          document.getElementById('proj-status-sub').innerText = '100% Mainnet Stream';

          setFloorPercentPreset(activeFloorPercentPreset);
          setRarityPriceMultiplier(activeRarityMultiplier);

          // 💎 Populate Dynamic Trait Dropdowns from OpenSea verified data
          if (data.traits && data.traits.counts) {
            populateTraitDropdowns(data.traits);
          } else {
            fetch('/api/collection/traits?slug=' + encodeURIComponent(data.slug))
              .then(r => r.json())
              .then(td => { if (td.success) populateTraitDropdowns(td); })
              .catch(() => {});
          }

          liveListingsStore = data.realListings || [];
          // 🛡️ Pre-seed window.rarityRegistry with verified ranks from scan
          window.rarityRegistry = window.rarityRegistry || new Map();
          if (Array.isArray(liveListingsStore)) {
            liveListingsStore.forEach(item => {
              if (item.tokenId && item.rarityRank && Number(item.rarityRank) > 0) {
                window.rarityRegistry.set(String(item.tokenId), Number(item.rarityRank));
              }
            });
          }
          renderRealListings(liveListingsStore);
          startLiveListingsPoller(data.slug);

          logConsole(`✔ OpenSea Verified Collection: "${data.name}" (${data.chain})`);
          logConsole(`✔ Synced Floor: ${formatEthPrecise(currentFloorEth)} ($${(currentFloorEth * currentLiveEthPrice).toFixed(2)} USD) | Populated ${liveListingsStore.length} real-time floor listings.`);
          showToast(`Target Synced: ${data.name}`);
        } else {
          showToast(data.error || 'Failed to scan collection', true);
          logConsole(`❌ [SCAN ERROR] ${data.error || 'Failed to scan collection'}`);
        }
      } catch (err) {
        showToast('Connection failed while scanning: ' + err.message, true);
        logConsole(`❌ [SCAN NETWORK ERROR] ${err.message}`);
      } finally {
        document.getElementById('btn-scan').innerHTML = `<i class="fa-solid fa-radar text-xs"></i> Scan`;
      }
    }

    let activeStreamSort = 'latest'; // 'latest', 'price_asc', 'rank_asc'
    let activeStreamFilter = 'all';  // 'all', 'underfloor', 'rare', 'sniped'
    let streamSearchQuery = '';


    function clearScannedCollection() {
      if (streamEventSource) {
        streamEventSource.close();
        streamEventSource = null;
      }
      if (livePollerInterval) {
        clearInterval(livePollerInterval);
        livePollerInterval = null;
      }
      
      const oldSlug = currentScannedProject ? currentScannedProject.slug : null;
      currentScannedProject = null;
      liveListingsStore = [];
      if (window.rarityRegistry) window.rarityRegistry.clear();

      if (oldSlug) {
        fetch('/api/stream/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: oldSlug })
        }).catch(() => {});
      }

      document.getElementById('scan-input').value = '';
      document.getElementById('proj-name').innerText = 'No Collection Loaded';
      document.getElementById('proj-chain-badge').innerText = 'IDLE';
      document.getElementById('proj-chain-badge').className = 'text-[8px] font-black uppercase bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded border border-slate-600';
      document.getElementById('proj-contract').innerText = 'Awaiting collection scan...';
      document.getElementById('proj-copy-icon').classList.add('hidden');
      document.getElementById('proj-avatar').innerText = '🔍';
      document.getElementById('proj-floor-eth').innerText = '-- ETH';
      document.getElementById('proj-floor-usd').innerText = '~$0.00 USD';
      document.getElementById('proj-supply').innerText = '-- NFTs';
      document.getElementById('proj-supply-sub').innerText = 'Awaiting Scan';
      document.getElementById('proj-listed').innerText = '-- Listed';
      document.getElementById('proj-listed-sub').innerText = '-- % of Supply';
      document.getElementById('proj-status-val').innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Standby`;
      document.getElementById('proj-status-val').className = 'text-xs font-black text-slate-400 flex items-center gap-1';
      document.getElementById('proj-status-sub').innerText = 'Ready to Target';

      document.getElementById('listings-tbody').innerHTML = `
        <tr id="empty-stream-placeholder">
          <td colspan="5" class="py-16 text-center text-slate-400 font-mono-code text-xs">
            <div class="flex flex-col items-center justify-center space-y-2">
              <div class="w-10 h-10 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 text-lg">
                <i class="fa-solid fa-radar"></i>
              </div>
              <p class="font-bold text-slate-600 text-xs">No collection scanned yet</p>
              <p class="text-[11px] text-slate-400 max-w-xs">Enter a collection URL or slug above to pull real live listings from OpenSea.</p>
            </div>
          </td>
        </tr>
      `;
      document.getElementById('count-all').innerText = '0';
      document.getElementById('count-underfloor').innerText = '0';
      document.getElementById('count-rare').innerText = '0';
      document.getElementById('count-sniped').innerText = '0';
      document.getElementById('stream-status-pill').innerText = '⏱️ Standby';
      logConsole('Target cleared. Bot is in clean standby mode (Old stream disconnected).');
      showToast('Collection target cleared');
    }
