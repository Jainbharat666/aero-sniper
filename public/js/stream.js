/* ══════════════════════════════════════════════════════════════
   📡 AERO-SNIPER V2: LIVE STREAM, SSE FIREHOSE & LISTINGS
   ══════════════════════════════════════════════════════════════ */

    function setStreamFilter(filter) {
      activeStreamFilter = filter;
      ['all', 'underfloor', 'rare', 'sniped'].forEach(f => {
        const btn = document.getElementById(`flt-${f}`);
        if (btn) {
          if (f === filter) {
            btn.className = 'flt-btn px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold shadow-sm';
          } else {
            btn.className = 'flt-btn px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 font-bold hover:bg-slate-100';
          }
        }
      });
      renderRealListings(liveListingsStore);
    }

    function sortStreamTable(sortVal) {
      activeStreamSort = sortVal || 'latest';
      renderRealListings(liveListingsStore);
    }

    function filterStreamTable() {
      const inputEl = document.getElementById('stream-search');
      streamSearchQuery = inputEl ? inputEl.value.trim().toLowerCase() : '';
      renderRealListings(liveListingsStore);
    }

    function createListingRowElement(item, isNewArrival = false) {
      const isUnderfloor = item.price <= currentFloorEth;
      const tr = document.createElement('tr');
      tr.className = `listing-row ${item.sniped ? 'bg-emerald-50/80' : 'hover:bg-slate-50'} ${isNewArrival ? 'flash-green' : ''} transition-colors`;
      tr.setAttribute('data-token', item.tokenId || '0');
      tr.setAttribute('data-price', item.price || 0);
      tr.setAttribute('data-rank', item.rarityRank || 9999);
      tr.setAttribute('data-sniped', item.sniped || false);

      const imgHtml = item.image 
        ? `<img src="${item.image}" class="w-8 h-8 rounded-xl object-cover border border-slate-200 shadow-sm shrink-0" alt="#${item.tokenId}">`
        : `<div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-black text-white text-xs shadow-sm shrink-0">🎨</div>`;

      const tokStr = String(item.tokenId || '');
      const regRank = (window.rarityRegistry && window.rarityRegistry.get(tokStr)) ? window.rarityRegistry.get(tokStr) : null;
      if (regRank && (!item.rarityRank || Number(item.rarityRank) <= 0)) {
        item.rarityRank = regRank;
      } else if (item.rarityRank && Number(item.rarityRank) > 0 && window.rarityRegistry) {
        window.rarityRegistry.set(tokStr, Number(item.rarityRank));
      }

      const hasRank = item.rarityRank != null && !isNaN(item.rarityRank) && Number(item.rarityRank) > 0;
      const numRank = hasRank ? Number(item.rarityRank) : null;

      const rankBadge = !hasRank
        ? `<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-500 font-bold text-xs">Rank #N/A</span>`
        : numRank <= 500
        ? `<span class="px-2 py-0.5 rounded-lg bg-pink-100 text-pink-800 border border-pink-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
        : numRank <= 1200
        ? `<span class="px-2 py-0.5 rounded-lg bg-cyan-100 text-cyan-800 border border-cyan-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
        : `<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-bold text-xs">#${numRank.toLocaleString()}</span>`;

      const ts = item.eventTimestamp ? (typeof item.eventTimestamp === 'number' ? item.eventTimestamp : new Date(item.eventTimestamp).getTime()) : Date.now();
      const contract = item.contractAddress || (currentScannedProject ? currentScannedProject.contractAddress : '');
      const chain = (item.chain || (currentScannedProject ? currentScannedProject.chain : 'robinhood')).toLowerCase();
      const openSeaUrl = (contract && item.tokenId)
        ? `https://opensea.io/assets/${chain}/${contract}/${item.tokenId}`
        : `https://opensea.io/collection/${currentScannedProject?.slug || 'ntrpygenesis'}`;

      tr.innerHTML = `
        <td class="py-2.5 px-2 flex items-center gap-2 token-image-container">
          ${imgHtml}
          <div class="min-w-0">
            <a href="${openSeaUrl}" target="_blank" rel="noopener noreferrer" class="font-black text-slate-900 hover:text-indigo-600 transition-colors text-xs flex items-center gap-1 group/link truncate" title="View #${item.tokenId} on OpenSea">
              <span class="token-name-label">${item.name || '#' + item.tokenId}</span>
              <i class="fa-solid fa-arrow-up-right-from-square text-[9px] text-slate-300 group-hover/link:text-indigo-500 transition-colors shrink-0"></i>
            </a>
            <span class="text-[9px] text-slate-400 font-mono-code block truncate">${item.seller ? 'By ' + item.seller : ''}</span>
          </div>
        </td>
        <td class="py-2.5 px-2">
          <span class="font-black ${isUnderfloor ? 'text-emerald-600' : 'text-slate-900'} text-xs">${item.priceFormatted || formatEthPrecise(item.price)}</span>
          <p class="text-[9px] text-slate-500 font-bold row-usd-price" data-eth="${item.price}">${(item.price * currentLiveEthPrice).toFixed(2)} USD</p>
        </td>
        <td class="py-2.5 px-2 token-rank-cell">
          ${rankBadge}
        </td>
        <td class="py-2.5 px-2 text-slate-500 text-xs live-timer" data-timestamp="${ts}">${formatAgeTime(ts)}</td>
        <td class="py-2.5 px-2 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <a href="${openSeaUrl}" target="_blank" rel="noopener noreferrer" title="Open #${item.tokenId} on OpenSea" class="w-7 h-7 rounded-xl bg-slate-100 hover:bg-sky-500 hover:text-white text-slate-600 flex items-center justify-center transition-all shadow-sm border border-slate-200/80 group/os">
              <i class="fa-solid fa-arrow-up-right-from-square text-[10px] group-hover/os:scale-110 transition-transform"></i>
            </a>
            ${item.sniped ? '<span class="px-2.5 py-1 rounded-xl bg-emerald-500 text-white font-black text-[10px]">🚨 SNIPED</span>' : `<button onclick="executeManualBuy('${item.tokenId}', ${item.price})" class="px-3 py-1 rounded-xl bg-slate-900 hover:bg-indigo-600 text-white font-black text-xs transition-all shadow-sm">Buy</button>`}
          </div>
        </td>
      `;
      return tr;
    }



    function renderRealListings(listings) {
      if (listings && Array.isArray(listings)) liveListingsStore = listings;
      const tbody = document.getElementById('listings-tbody');
      document.getElementById('stream-status-pill').innerText = '⏱️ Live Firehose Active';

      if (!liveListingsStore || liveListingsStore.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" class="py-12 text-center text-slate-400 font-mono-code text-xs">
              <div class="flex flex-col items-center justify-center space-y-1.5">
                <span class="w-2 h-2 rounded-full bg-emerald-500 pulse-ring"></span>
                <p class="font-bold text-slate-700 text-xs">Live Firehose Stream Connected</p>
                <p class="text-[11px] text-slate-400">Listening for new listings on OpenSea... None currently open below target.</p>
              </div>
            </td>
          </tr>
        `;
        document.getElementById('count-all').innerText = '0';
        document.getElementById('count-underfloor').innerText = '0';
        document.getElementById('count-rare').innerText = '0';
        document.getElementById('count-sniped').innerText = '0';
        return;
      }

      // 1. Calculate badge counts across all items
      let underfloorCount = 0;
      let rareCount = 0;
      let snipedCount = 0;

      liveListingsStore.forEach(item => {
        if (item.price <= currentFloorEth) underfloorCount++;
        const rank = (item.rarityRank != null && !isNaN(item.rarityRank)) ? Number(item.rarityRank) : null;
        if (rank && rank <= 1200) rareCount++;
        if (item.sniped) snipedCount++;
      });

      document.getElementById('count-all').innerText = liveListingsStore.length;
      document.getElementById('count-underfloor').innerText = underfloorCount;
      document.getElementById('count-rare').innerText = rareCount;
      document.getElementById('count-sniped').innerText = snipedCount;

      // 2. Filter listings based on active filter & search query
      let filtered = [...liveListingsStore];

      if (activeStreamFilter === 'underfloor') {
        filtered = filtered.filter(item => item.price <= currentFloorEth);
      } else if (activeStreamFilter === 'rare') {
        filtered = filtered.filter(item => {
          const rank = (item.rarityRank != null && !isNaN(item.rarityRank)) ? Number(item.rarityRank) : null;
          return rank && rank <= 1200;
        });
      } else if (activeStreamFilter === 'sniped') {
        filtered = filtered.filter(item => item.sniped);
      }

      if (streamSearchQuery) {
        filtered = filtered.filter(item => {
          const name = (item.name || '').toLowerCase();
          const token = String(item.tokenId || '');
          return name.includes(streamSearchQuery) || token.includes(streamSearchQuery);
        });
      }

      // 3. Sort listings strictly according to activeStreamSort
      if (activeStreamSort === 'price_asc') {
        filtered.sort((a, b) => a.price - b.price);
      } else if (activeStreamSort === 'rank_asc') {
        filtered.sort((a, b) => {
          const rA = (a.rarityRank != null && !isNaN(a.rarityRank) && Number(a.rarityRank) > 0) ? Number(a.rarityRank) : 999999;
          const rB = (b.rarityRank != null && !isNaN(b.rarityRank) && Number(b.rarityRank) > 0) ? Number(b.rarityRank) : 999999;
          return rA - rB;
        });
      } else {
        // Default 'latest': Most recent first (descending timestamp: 1s ago > 30m ago > 4h ago)
        filtered.sort((a, b) => {
          const tsA = a.eventTimestamp ? (typeof a.eventTimestamp === 'number' ? a.eventTimestamp : new Date(a.eventTimestamp).getTime()) : 0;
          const tsB = b.eventTimestamp ? (typeof b.eventTimestamp === 'number' ? b.eventTimestamp : new Date(b.eventTimestamp).getTime()) : 0;
          return tsB - tsA;
        });
      }

      // 4. Render Table Rows
      tbody.innerHTML = '';
      if (filtered.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" class="py-8 text-center text-slate-400 font-mono-code text-xs">
              No listings match the current filter.
            </td>
          </tr>
        `;
        return;
      }

      filtered.forEach(item => {
        try {
          const tr = createListingRowElement(item, false);
          tbody.appendChild(tr);
        } catch(rowErr) {}
      });

      // Auto-resolve missing ranks if any token arrived with null/N/A and not yet requested
      const missingTokenIds = liveListingsStore
        .filter(item => (!item.rarityRank || isNaN(item.rarityRank) || Number(item.rarityRank) <= 0) && item.tokenId && !requestedRarityTokensSet.has(String(item.tokenId)))
        .slice(0, 15)
        .map(i => String(i.tokenId));

      if (missingTokenIds.length > 0 && currentScannedProject) {
        debouncedResolveMissingRanks(missingTokenIds);
      }
    }

    let streamEventSource = null;
    const loggedStreamTokensSet = new Set(); // 🛡️ Ensure each token is logged to console ONLY ONCE per session
    const clientBoughtTokens = new Set(); // 🛡️ Atomic token deduplication set (prevents duplicate buys across backend & client)

    // 🛑 UNIVERSAL RULEBOOK: Master Client Circuit Breaker Lock
    function handleClientCircuitBreakerHit(executed, limit) {
      isArmed = false;
      clientArmedTimestamp = 0;
      snipesExecutedCount = executed || snipesExecutedCount || 1;
      playBeep(320, 'sawtooth', 0.3);
      const btn = document.getElementById('btn-master-action');
      if (btn) {
        btn.className = 'w-full py-3 px-4 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-black text-xs shadow-lg shadow-rose-500/25 flex items-center justify-center gap-2 transition-all cursor-pointer';
        btn.innerHTML = `<i class="fa-solid fa-hand text-sm"></i> 🛑 CIRCUIT BREAKER HIT (${snipesExecutedCount}/${limit || activeMaxSnipesLimit}) - CLICK TO RESET`;
      }
      logConsole(`🛑 [CIRCUIT BREAKER HIT] Reached max buy limit (${snipesExecutedCount}/${limit || activeMaxSnipesLimit} snipes). Sniper auto-paused.`);
      showToast(`🛑 Circuit Breaker: Auto-paused after ${snipesExecutedCount} snipe(s)!`, true);
      fetch('/api/snipe/disarm', { method: 'POST' }).catch(() => {});
    }

    let directPhoenixWs = null;
    let directPhoenixHbInterval = null;
    let directPhoenixReconnectTimer = null;
    let activePhoenixSlug = null;

    function handleIncomingDelisting(tokenId) {
      if (!tokenId) return;
      const tokStr = String(tokenId);
      const delIdx = liveListingsStore.findIndex(i => String(i.tokenId) === tokStr);
      if (delIdx !== -1) {
        const wasFloor = (liveListingsStore[delIdx].price === currentFloorEth);
        liveListingsStore.splice(delIdx, 1);
        const tr = document.querySelector(`tr[data-token="${tokStr}"]`);
        if (tr) tr.remove();

        if (wasFloor && liveListingsStore.length > 0) {
          const newFloor = Math.min(...liveListingsStore.map(l => l.price));
          if (newFloor > 0) {
            currentFloorEth = newFloor;
            document.getElementById('proj-floor-eth').innerText = formatEthPrecise(currentFloorEth);
            document.getElementById('proj-floor-usd').innerText = `~$${(currentFloorEth * currentLiveEthPrice).toFixed(2)} USD`;
            updateLiveRadar();
            updateBentoValues();
          }
        }
      }
    }

    function handleIncomingListingItem(payload) {
      if (!payload || !payload.tokenId) return;
      if (payload.price <= currentFloorEth || (payload.rarityRank && payload.rarityRank <= 1200)) {
        playBeep(920, 'sine', 0.05);
      }

      // Live sync of Floor Price if new listing is cheaper
      if (payload.price > 0 && (payload.price < currentFloorEth || currentFloorEth === 0)) {
        currentFloorEth = payload.price;
        document.getElementById('proj-floor-eth').innerText = formatEthPrecise(currentFloorEth);
        document.getElementById('proj-floor-usd').innerText = `~$${(currentFloorEth * currentLiveEthPrice).toFixed(2)} USD`;
        updateLiveRadar();
        updateBentoValues();
      }

      // Live sync of Contract Auto-Detector total listed count
      if (currentScannedProject && (!payload.slug || payload.slug === currentScannedProject.slug)) {
        if (payload.liveListedCount !== undefined && payload.liveListedCount !== null) {
          currentScannedProject.listedCount = payload.liveListedCount;
        } else {
          currentScannedProject.listedCount = (currentScannedProject.listedCount || 0) + 1;
        }
        document.getElementById('proj-listed').innerText = `${currentScannedProject.listedCount} Listed`;
        if (currentScannedProject.totalSupply > 0) {
          const pct = ((currentScannedProject.listedCount / currentScannedProject.totalSupply) * 100).toFixed(1);
          document.getElementById('proj-listed-sub').innerText = `${pct}% of Supply`;
        }
      }

      const tokStr = String(payload.tokenId || '');
      const existingIdx = liveListingsStore.findIndex(i => String(i.tokenId) === tokStr);
      let isPriceChangeOrNew = true;
      if (existingIdx !== -1) {
        const oldItem = liveListingsStore[existingIdx];
        // 🛡️ CRITICAL INVARIANT: NEVER DEMOTE A RESOLVED RANK TO NULL OR N/A
        const regRank = (window.rarityRegistry && window.rarityRegistry.get(tokStr)) ? window.rarityRegistry.get(tokStr) : null;
        const resolvedRank = regRank
          || (oldItem.rarityRank != null && !isNaN(oldItem.rarityRank) && Number(oldItem.rarityRank) > 0 ? Number(oldItem.rarityRank) : null)
          || (payload.rarityRank != null && !isNaN(payload.rarityRank) && Number(payload.rarityRank) > 0 ? Number(payload.rarityRank) : null);
        if (resolvedRank && window.rarityRegistry) {
          window.rarityRegistry.set(tokStr, Number(resolvedRank));
        }
        const resolvedImage = payload.image || payload.imageUrl || oldItem.image || oldItem.imageUrl || '';
        const resolvedName = (payload.name && !payload.name.startsWith('#')) ? payload.name : (oldItem.name || payload.name);

        if (Math.abs(oldItem.price - payload.price) < 0.0000001) {
          isPriceChangeOrNew = false;
          Object.assign(oldItem, payload);
          if (resolvedRank != null) oldItem.rarityRank = resolvedRank;
          if (resolvedImage) { oldItem.image = resolvedImage; oldItem.imageUrl = resolvedImage; }
          if (resolvedName) oldItem.name = resolvedName;

          // In-place DOM update for existing row without wiping table
          const existingRow = document.querySelector(`tr[data-token="${payload.tokenId}"]`);
          if (existingRow) {
            // 👑 1. ISOLATED RANK UPDATE (Only if valid positive rank!)
            if (resolvedRank != null && Number(resolvedRank) > 0) {
              existingRow.setAttribute('data-rank', resolvedRank);
              const rankCell = existingRow.querySelector('.token-rank-cell') || existingRow.querySelector('td:nth-child(3)');
              if (rankCell) {
                const numRank = Number(resolvedRank);
                const rankBadge = numRank <= 500
                  ? `<span class="px-2 py-0.5 rounded-lg bg-pink-100 text-pink-800 border border-pink-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                  : numRank <= 1200
                  ? `<span class="px-2 py-0.5 rounded-lg bg-cyan-100 text-cyan-800 border border-cyan-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                  : `<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-bold text-xs">#${numRank.toLocaleString()}</span>`;
                rankCell.innerHTML = rankBadge;
              }
            }

            // 🖼️ 2. ISOLATED IMAGE UPDATE
            if (resolvedImage) {
              const imgContainer = existingRow.querySelector('.token-image-container') || existingRow.querySelector('td:nth-child(1)');
              if (imgContainer) {
                const img = imgContainer.querySelector('img');
                if (img) {
                  img.src = resolvedImage;
                } else {
                  const placeholder = imgContainer.querySelector('div.bg-gradient-to-tr');
                  if (placeholder) {
                    placeholder.outerHTML = `<img src="${resolvedImage}" class="w-8 h-8 rounded-xl object-cover border border-slate-200 shadow-sm shrink-0" alt="#${payload.tokenId}">`;
                  }
                }
              }
            }

            // 🏷️ 3. ISOLATED NAME UPDATE
            if (resolvedName && !resolvedName.startsWith('#')) {
              const nameEl = existingRow.querySelector('.token-name-label') || existingRow.querySelector('td:nth-child(1) a span');
              if (nameEl) nameEl.innerText = resolvedName;
            }
          }
        } else {
          payload.rarityRank = resolvedRank;
          if (resolvedImage) { payload.image = resolvedImage; payload.imageUrl = resolvedImage; }
          if (resolvedName) payload.name = resolvedName;
          liveListingsStore.splice(existingIdx, 1);
          liveListingsStore.unshift(payload);
        }
      } else {
        liveListingsStore.unshift(payload);
      }

      // Cap array to 500 items
      if (liveListingsStore.length > 500) {
        liveListingsStore.length = 500;
      }

      let underfloorCount = 0;
      let rareCount = 0;
      let snipedCount = 0;
      liveListingsStore.forEach(i => {
        if (i.price <= currentFloorEth) underfloorCount++;
        if (i.rarityRank && i.rarityRank <= 1200) rareCount++;
        if (i.sniped) snipedCount++;
      });
      document.getElementById('count-all').innerText = liveListingsStore.length;
      document.getElementById('count-underfloor').innerText = underfloorCount;
      document.getElementById('count-rare').innerText = rareCount;
      document.getElementById('count-sniped').innerText = snipedCount;

      const tbody = document.getElementById('listings-tbody');
      const passesFilter = (activeStreamFilter === 'all') ||
        (activeStreamFilter === 'underfloor' && payload.price <= currentFloorEth) ||
        (activeStreamFilter === 'rare' && payload.rarityRank && payload.rarityRank <= 1200) ||
        (activeStreamFilter === 'sniped' && payload.sniped);

      // Prepend or re-render row
      if (isPriceChangeOrNew) {
        if (tbody && activeStreamSort === 'latest' && passesFilter && !streamSearchQuery) {
          const placeholder = document.getElementById('empty-stream-placeholder');
          if (placeholder) placeholder.remove();

          const existingRow = tbody.querySelector(`tr[data-token="${payload.tokenId}"]`);
          if (existingRow) existingRow.remove();

          const tr = createListingRowElement(payload, true);
          tbody.insertBefore(tr, tbody.firstChild);

          if (tbody.children.length > 150) {
            tbody.removeChild(tbody.lastChild);
          }
        } else {
          renderRealListings(liveListingsStore);
        }
      }

      const tokIdStr = String(payload.tokenId);
      if (!loggedStreamTokensSet.has(tokIdStr)) {
        loggedStreamTokensSet.add(tokIdStr);
        logConsole(`⚡ [STREAM] ${payload.name || '#' + tokIdStr} listed at ${payload.priceFormatted} (Rank #${payload.rarityRank || 'N/A'})`);
      }

      // Evaluate trigger if armed
      if (isArmed && !payload.sniped && !clientBoughtTokens.has(tokIdStr)) {
        checkSniperTriggers([payload]);
      }
    }

    async function connectDirectOpenSeaStream(slug) {
      if (!slug) return;
      activePhoenixSlug = slug.toLowerCase();

      if (directPhoenixWs) {
        try { directPhoenixWs.close(); } catch(e) {}
        directPhoenixWs = null;
      }
      if (directPhoenixHbInterval) {
        clearInterval(directPhoenixHbInterval);
        directPhoenixHbInterval = null;
      }
      if (directPhoenixReconnectTimer) {
        clearTimeout(directPhoenixReconnectTimer);
        directPhoenixReconnectTimer = null;
      }

      let streamApiKey = currentScannedProject?.streamKey;
      if (!streamApiKey) {
        try {
          const cfgRes = await fetch('/api/stream/ws-config');
          if (cfgRes.ok) {
            const cfgData = await cfgRes.json();
            if (cfgData.success && cfgData.streamKey) {
              streamApiKey = cfgData.streamKey;
            }
          }
        } catch(e) {}
      }
      if (!streamApiKey) {
        streamApiKey = '840e6b17791d415db3c98657fbc71979';
      }

      try {
        const wsUrl = `wss://stream-api.opensea.io/socket/websocket?token=${streamApiKey}&vsn=2.0.0`;
        const ws = new WebSocket(wsUrl);
        directPhoenixWs = ws;

        ws.onopen = () => {
          const joinMsg = JSON.stringify(["1", "1", `collection:${activePhoenixSlug}`, "phx_join", {}]);
          ws.send(joinMsg);

          const pill = document.getElementById('stream-status-pill');
          if (pill) {
            pill.innerText = '⚡ Direct OpenSea Stream (0ms)';
            pill.className = 'text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-300 px-2 py-0.5 rounded-full font-mono-code';
          }

          directPhoenixHbInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify([null, String(Date.now()), "phoenix", "heartbeat", {}]));
            }
          }, 20000);
        };

        ws.onmessage = (event) => {
          try {
            const raw = JSON.parse(event.data);
            if (!Array.isArray(raw)) return;
            const [joinRef, ref, topic, eventName, payload] = raw;

            if (eventName === 'phx_reply' && payload?.status === 'ok') {
              logConsole(`⚡ [DIRECT WS ACTIVE] Connected to OpenSea Laser Grid for "${activePhoenixSlug}" (0ms Direct Push)`);
              return;
            }

            if (eventName === 'item_listed') {
              const p = payload?.payload || payload;
              if (p && p.item) {
                const nftIdParts = (p.item.nft_id || '').split('/');
                const chain = (nftIdParts[0] || p.chain || 'robinhood').toLowerCase();
                const contractAddress = (nftIdParts[1] || '').toLowerCase();
                const tokenId = nftIdParts[2] || p.item.metadata?.identifier || '';
                if (tokenId) {
                  const decimals = p.payment_token?.decimals || 18;
                  const basePriceBig = BigInt(p.base_price || '0');
                  const divisor = 10n ** BigInt(decimals);
                  const priceEth = Number(basePriceBig) / Number(divisor);
                  if (priceEth > 0) {
                    const eventTime = p.event_timestamp ? new Date(p.event_timestamp).getTime() : Date.now();
                    const incomingItem = {
                      tokenId: String(tokenId),
                      name: p.item.metadata?.name || `#${tokenId}`,
                      image: p.item.metadata?.image_url || '',
                      imageUrl: p.item.metadata?.image_url || '',
                      traits: p.item.metadata?.traits || p.item?.traits || [],
                      price: priceEth,
                      priceFormatted: formatEthPrecise(priceEth),
                      priceUsd: parseFloat((priceEth * currentLiveEthPrice).toFixed(2)),
                      rarityRank: null,
                      seller: p.maker?.address ? `${p.maker.address.slice(0, 6)}...${p.maker.address.slice(-4)}` : '',
                      sellerFull: p.maker?.address || '',
                      orderHash: p.order_hash || '',
                      ageSeconds: 0,
                      eventTimestamp: eventTime,
                      protocolData: p.protocol_data || null,
                      contractAddress: contractAddress || currentScannedProject?.contractAddress || '',
                      chain: chain,
                      slug: (p.collection?.slug || activePhoenixSlug).toLowerCase(),
                      sniped: false
                    };

                    const cached = liveListingsStore.find(i => String(i.tokenId) === String(tokenId));
                    if (cached && cached.rarityRank) incomingItem.rarityRank = cached.rarityRank;
                    if (cached && cached.traits && (!incomingItem.traits || incomingItem.traits.length === 0)) incomingItem.traits = cached.traits;

                    handleIncomingListingItem(incomingItem);
                  }
                }
              }
            } else if (eventName === 'item_cancelled' || eventName === 'item_sold') {
              const p = payload?.payload || payload;
              const nftIdParts = (p?.item?.nft_id || '').split('/');
              const tokenId = nftIdParts[2] || '';
              if (tokenId) {
                handleIncomingDelisting(tokenId);
              }
            }
          } catch(err) {}
        };

        ws.onerror = (err) => {
          console.warn('[DIRECT WS] WebSocket error:', err);
        };

        ws.onclose = () => {
          if (directPhoenixHbInterval) clearInterval(directPhoenixHbInterval);
          if (currentScannedProject && currentScannedProject.slug === activePhoenixSlug) {
            directPhoenixReconnectTimer = setTimeout(() => {
              connectDirectOpenSeaStream(activePhoenixSlug);
            }, 2000);
          }
        };
      } catch(err) {
        console.warn('[DIRECT WS] Failed to connect:', err);
      }
    }

    function startRealTimeWebSocketStream(slug) {
      // Connect direct browser-to-OpenSea Phoenix WebSocket
      connectDirectOpenSeaStream(slug);

      if (streamEventSource) {
        streamEventSource.close();
        streamEventSource = null;
      }

      const streamUrl = `/api/stream/events?slug=${encodeURIComponent(slug)}`;
      streamEventSource = new EventSource(streamUrl);

      streamEventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);

          if (payload.type === 'snipe_log') {
            logConsole(payload.message);
            return;
          }

          if (payload.type === 'zero_hop_snipe_broadcast' || payload.type === 'paper_snipe_broadcast') {
            const isSim = (payload.type === 'paper_snipe_broadcast');
            playBeep(isSim ? 880 : 980, 'sine', 0.2);
            logConsole(`${isSim ? '🧪 [PAPER SNIPE SIMULATED]' : '🎯 ⚡ [ZERO-HOP DIRECT SNIPE]'} #${payload.name || payload.tokenId} triggered [${payload.reason || 'Rule Match'}] in ${payload.computeLatencyMs}ms ➔ TxHash: ${payload.txHash.slice(0, 14)}...!`);
            showToast(isSim ? `🧪 Paper Snipe Hit Token #${payload.tokenId} (Simulated)!` : `🚀 Mainnet Snipe broadcasted in ${payload.computeLatencyMs}ms!`);
            
            const item = liveListingsStore.find(i => String(i.tokenId) === String(payload.tokenId));
            if (item) item.sniped = true;
            clientBoughtTokens.add(String(payload.tokenId));
            
            const existingRow = document.querySelector(`tr[data-token="${payload.tokenId}"]`);
            if (existingRow) {
              existingRow.classList.add(isSim ? 'bg-purple-50/90' : 'bg-emerald-50/90');
              const actionCell = existingRow.querySelector('td:last-child');
              if (actionCell) {
                actionCell.innerHTML = isSim
                  ? '<span class="px-2.5 py-1 rounded-xl bg-purple-600 text-white font-black text-[10px]">🧪 SIMULATED</span>'
                  : '<span class="px-2.5 py-1 rounded-xl bg-emerald-500 text-white font-black text-[10px]">🚨 SNIPED</span>';
              }
            } else {
              renderRealListings(liveListingsStore);
            }

            if (isSim) {
              triggerSnipeCheer(payload.tokenId, payload.price, payload.buyerName || 'PaperTrader', payload.txHash);
            }
          } else if (payload.type === 'delisting') {
            if (currentScannedProject && (!payload.slug || payload.slug === currentScannedProject.slug)) {
              if (payload.liveListedCount !== undefined && payload.liveListedCount !== null) {
                currentScannedProject.listedCount = payload.liveListedCount;
              } else {
                currentScannedProject.listedCount = Math.max(0, (currentScannedProject.listedCount || 1) - 1);
              }
              document.getElementById('proj-listed').innerText = `${currentScannedProject.listedCount} Listed`;
              if (currentScannedProject.totalSupply > 0) {
                const pct = ((currentScannedProject.listedCount / currentScannedProject.totalSupply) * 100).toFixed(1);
                document.getElementById('proj-listed-sub').innerText = `${pct}% of Supply`;
              }
            }
            handleIncomingDelisting(payload.tokenId);
          } else if (payload.type === 'stats_sync' || payload.type === 'count_sync') {
            if (currentScannedProject && (!payload.slug || payload.slug === currentScannedProject.slug)) {
              if (payload.liveListedCount !== undefined && payload.liveListedCount !== null) {
                currentScannedProject.listedCount = payload.liveListedCount;
                document.getElementById('proj-listed').innerText = currentScannedProject.listedCount + ' Listed';
                if (currentScannedProject.totalSupply > 0) {
                  const pct = ((currentScannedProject.listedCount / currentScannedProject.totalSupply) * 100).toFixed(1);
                  document.getElementById('proj-listed-sub').innerText = pct + '% of Supply';
                }
              }
              if (payload.liveFloorEth !== undefined && payload.liveFloorEth !== null && payload.liveFloorEth > 0) {
                currentFloorEth = payload.liveFloorEth;
                document.getElementById('proj-floor-eth').innerText = formatEthPrecise(currentFloorEth);
                const usd = payload.liveFloorUsd || (currentFloorEth * currentLiveEthPrice);
                document.getElementById('proj-floor-usd').innerText = `~$${usd.toFixed(2)} USD`;
                updateLiveRadar();
                updateBentoValues();
              }
            }
          } else if (payload.type === 'circuit_breaker_paused') {
            handleClientCircuitBreakerHit(payload.executed, payload.limit);
          } else if (payload.type === 'zero_hop_snipe_confirmed') {
            logConsole(`🎉 [ZERO-HOP BUY CONFIRMED] Token #${payload.tokenId} confirmed in Block #${payload.blockNumber} (Tx: ${payload.txHash.slice(0, 14)}...)!`);
            showToast(`🎉 NFT #${payload.tokenId} bought successfully by ${payload.buyerName}!`);
            triggerSnipeCheer(payload.tokenId, payload.price, payload.buyerName, payload.txHash);
            refreshAllBalances();
          } else if (payload.type === 'zero_hop_snipe_failed') {
            playBeep(320, 'sawtooth', 0.2);
            logConsole(`❌ [SNIPE TX FAILED] Token #${payload.tokenId} — ${payload.error || 'Reverted on-chain'} (Tx: ${payload.txHash ? payload.txHash.slice(0, 14) + '...' : 'N/A'})`);
            showToast(`❌ Snipe failed for #${payload.tokenId}: ${payload.error || 'Transaction reverted'}`, true);
          } else if (payload.type === 'rank_update' && payload.tokenId) {
            const tokStr = String(payload.tokenId);
            // 👑 1. ISOLATED RANK UPDATE (Only if valid positive rank!)
            if (payload.rarityRank != null && Number(payload.rarityRank) > 0) {
              const numRank = Number(payload.rarityRank);
              if (window.rarityRegistry) window.rarityRegistry.set(tokStr, numRank);
              const item = liveListingsStore.find(i => String(i.tokenId) === tokStr);
              if (item) item.rarityRank = numRank;
              const existingRow = document.querySelector(`tr[data-token="${tokStr}"]`);
              if (existingRow) {
                existingRow.setAttribute('data-rank', numRank);
                const rankCell = existingRow.querySelector('.token-rank-cell') || existingRow.querySelector('td:nth-child(3)');
                if (rankCell) {
                  const rankBadge = numRank <= 500
                    ? `<span class="px-2 py-0.5 rounded-lg bg-pink-100 text-pink-800 border border-pink-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                    : numRank <= 1200
                    ? `<span class="px-2 py-0.5 rounded-lg bg-cyan-100 text-cyan-800 border border-cyan-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                    : `<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-bold text-xs">#${numRank.toLocaleString()}</span>`;
                  rankCell.innerHTML = rankBadge;
                }
              }
            }
          } else if (payload.type === 'metadata_update' && payload.tokenId) {
            const tokStr = String(payload.tokenId);
            const item = liveListingsStore.find(i => String(i.tokenId) === tokStr);
            const existingRow = document.querySelector(`tr[data-token="${tokStr}"]`);

            // 🖼️ ISOLATED IMAGE UPDATE (Touches image ONLY, never rank!)
            if (payload.image) {
              if (item) { item.image = payload.image; item.imageUrl = payload.image; }
              if (existingRow) {
                const imgContainer = existingRow.querySelector('.token-image-container') || existingRow.querySelector('td:nth-child(1)');
                if (imgContainer) {
                  const img = imgContainer.querySelector('img');
                  if (img) {
                    if (img.src !== payload.image) img.src = payload.image;
                  } else {
                    const placeholder = imgContainer.querySelector('div.bg-gradient-to-tr');
                    if (placeholder) {
                      placeholder.outerHTML = `<img src="${payload.image}" class="w-8 h-8 rounded-xl object-cover border border-slate-200 shadow-sm shrink-0" alt="#${tokStr}">`;
                    }
                  }
                }
              }
            }

            // 🏷️ ISOLATED NAME UPDATE (Touches name ONLY, never rank!)
            if (payload.name && !payload.name.startsWith('#')) {
              if (item) item.name = payload.name;
              if (existingRow) {
                const nameEl = existingRow.querySelector('.token-name-label') || existingRow.querySelector('td:nth-child(1) a span');
                if (nameEl) nameEl.innerText = payload.name;
              }
            }
          } else if (payload.type === 'listing' && payload.tokenId) {
            handleIncomingListingItem(payload);
          }
        } catch(e) {}
      };

      streamEventSource.onerror = () => {};
    }

    function startLiveListingsPoller(slug) {
      startRealTimeWebSocketStream(slug);

      if (livePollerInterval) clearInterval(livePollerInterval);
      livePollerInterval = setInterval(async () => {
        if (!currentScannedProject || currentScannedProject.slug !== slug) return;
        try {
          const res = await fetch(`/api/listings/live?slug=${slug}`);
          if (res.ok) {
            const data = await res.json();
            if (data.success && Array.isArray(data.listings) && data.listings.length > 0) {
              let hasNewItems = false;
              data.listings.forEach(incoming => {
                const incomingTokenIdStr = String(incoming.tokenId || '');
                if (!incomingTokenIdStr || incomingTokenIdStr === '0') return;

                const idx = liveListingsStore.findIndex(i => String(i.tokenId) === incomingTokenIdStr);
                const regRank = (window.rarityRegistry && window.rarityRegistry.get(incomingTokenIdStr)) ? window.rarityRegistry.get(incomingTokenIdStr) : null;
                if (idx === -1) {
                  if (regRank) incoming.rarityRank = regRank;
                  else if (incoming.rarityRank && Number(incoming.rarityRank) > 0 && window.rarityRegistry) {
                    window.rarityRegistry.set(incomingTokenIdStr, Number(incoming.rarityRank));
                  }
                  liveListingsStore.push(incoming);
                  hasNewItems = true;
                } else {
                  const existing = liveListingsStore[idx];
                  // 🛡️ CRITICAL PRESERVATION: Known rank is permanent and immutable
                  const finalRank = regRank || (existing.rarityRank && Number(existing.rarityRank) > 0 ? existing.rarityRank : null) || (incoming.rarityRank && Number(incoming.rarityRank) > 0 ? incoming.rarityRank : null);
                  if (finalRank != null && Number(finalRank) > 0) {
                    const numRank = Number(finalRank);
                    existing.rarityRank = numRank;
                    incoming.rarityRank = numRank;
                    if (window.rarityRegistry) window.rarityRegistry.set(incomingTokenIdStr, numRank);
                    // Update DOM row in place if rank was not already displayed
                    const row = document.querySelector(`tr[data-token="${incomingTokenIdStr}"]`);
                    if (row) {
                      row.setAttribute('data-rank', numRank);
                      const rankCell = row.querySelector('.token-rank-cell') || row.querySelector('td:nth-child(3)');
                      if (rankCell && (!rankCell.innerHTML.includes('#' + numRank.toLocaleString()))) {
                        const rankBadge = numRank <= 500
                          ? `<span class="px-2 py-0.5 rounded-lg bg-pink-100 text-pink-800 border border-pink-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                          : numRank <= 1200
                          ? `<span class="px-2 py-0.5 rounded-lg bg-cyan-100 text-cyan-800 border border-cyan-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                          : `<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-bold text-xs">#${numRank.toLocaleString()}</span>`;
                        rankCell.innerHTML = rankBadge;
                      }
                    }
                  }

                  // Update image in place: STRICTLY touches image ONLY, NEVER touches rank!
                  const newImg = incoming.image || incoming.imageUrl;
                  if (newImg && (!existing.image || existing.image.length === 0)) {
                    existing.image = newImg;
                    existing.imageUrl = newImg;
                    const row = document.querySelector(`tr[data-token="${incomingTokenIdStr}"]`);
                    if (row) {
                      const container = row.querySelector('.token-image-container') || row.querySelector('td:nth-child(1)');
                      if (container) {
                        const img = container.querySelector('img');
                        if (img) {
                          if (img.src !== newImg) img.src = newImg;
                        } else {
                          const placeholder = container.querySelector('div.bg-gradient-to-tr');
                          if (placeholder) {
                            placeholder.outerHTML = `<img src="${newImg}" class="w-8 h-8 rounded-xl object-cover border border-slate-200 shadow-sm shrink-0" alt="#${incomingTokenIdStr}">`;
                          }
                        }
                      }
                    }
                  }
                }
              });

              // Only re-render if completely new listings arrived
              if (hasNewItems) {
                renderRealListings(liveListingsStore);
              }
              if (isArmed) {
                checkSniperTriggers(data.listings);
              }
            }
          }
        } catch(e) {}
      }, 1500);
    }
