/* ══════════════════════════════════════════════════════════════
   👑 AERO-SNIPER V2: HIGH-SPEED BATCH RARITY RESOLVER (ISOLATED)
   ══════════════════════════════════════════════════════════════ */

    // Retry-aware rarity request map: tokenId → { status, attempts, lastAttempt }
    window.rarityRequestMap = window.rarityRequestMap || new Map();
    window.rarityRegistry = window.rarityRegistry || new Map();
    const MAX_RARITY_RETRIES = 3;
    const RETRY_BACKOFF_MS = [2000, 5000, 15000];

    let rankResolveTimer = null;
    
    // Backward compatibility for stream.js
    Object.defineProperty(window, 'requestedRarityTokensSet', {
      get: () => ({
        has: (id) => {
          const state = window.rarityRequestMap.get(String(id));
          if (!state) return false;
          if (state.status === 'failed' && state.attempts < MAX_RARITY_RETRIES) {
            const backoff = RETRY_BACKOFF_MS[state.attempts - 1] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
            if (Date.now() - state.lastAttempt > backoff) {
              return false;
            }
          }
          return true;
        },
        add: (id) => {
          const state = window.rarityRequestMap.get(String(id)) || { attempts: 0 };
          window.rarityRequestMap.set(String(id), {
            status: 'pending',
            attempts: state.attempts + 1,
            lastAttempt: Date.now()
          });
        },
        clear: () => window.rarityRequestMap.clear()
      }),
      configurable: true
    });
    const requestedRarityTokensSet = window.requestedRarityTokensSet;

    function debouncedResolveMissingRanks(tokenIds) {
      if (rankResolveTimer) clearTimeout(rankResolveTimer);
      rankResolveTimer = setTimeout(async () => {
        if (!currentScannedProject || !Array.isArray(tokenIds) || tokenIds.length === 0) return;
        const unrequested = tokenIds.filter(id => {
          if (!id) return false;
          const state = window.rarityRequestMap.get(String(id));
          if (!state) return true;
          if (state.status === 'failed' && state.attempts < MAX_RARITY_RETRIES) {
            const backoff = RETRY_BACKOFF_MS[state.attempts - 1] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
            return (Date.now() - state.lastAttempt > backoff);
          }
          return false;
        });
        if (unrequested.length === 0) return;
        unrequested.forEach(id => {
          const state = window.rarityRequestMap.get(String(id)) || { attempts: 0 };
          window.rarityRequestMap.set(String(id), {
            status: 'pending',
            attempts: state.attempts + 1,
            lastAttempt: Date.now()
          });
        });

        try {
          const res = await fetch('/api/tokens/rarity-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tokenIds: unrequested,
              slug: currentScannedProject.slug,
              chain: currentScannedProject.chain || 'robinhood',
              contractAddress: currentScannedProject.contractAddress
            })
          });
          const data = await res.json();
          if (data && data.success && data.rarities) {
            unrequested.forEach(id => {
              const state = window.rarityRequestMap.get(String(id));
              if (state) state.status = 'resolved';
            });
            Object.entries(data.rarities).forEach(([id, info]) => {
              if (!info) return;
              const idStr = String(id);
              const stored = liveListingsStore.find(i => String(i.tokenId) === idStr);
              const row = document.querySelector(`tr[data-token="${idStr}"]`);

              // 👑 1. ISOLATED RARITY RANK RESOLVER (Zero crosstalk with images or names)
              // Only updates if a real positive integer rank is present!
              if (info.rank != null && Number(info.rank) > 0) {
                const numRank = Number(info.rank);
                window.rarityRegistry.set(idStr, numRank);
                if (stored) stored.rarityRank = numRank;
                if (row) {
                  row.setAttribute('data-rank', numRank);
                  const rankCell = row.querySelector('.token-rank-cell') || row.querySelector('td:nth-child(3)');
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

              // 🖼️ 2. ISOLATED IMAGE RESOLVER (Modifies image ONLY, NEVER touches rank!)
              if (info.image) {
                if (stored) { stored.image = info.image; stored.imageUrl = info.image; }
                if (row) {
                  const imgContainer = row.querySelector('.token-image-container') || row.querySelector('td:nth-child(1)');
                  if (imgContainer) {
                    const imgEl = imgContainer.querySelector('img');
                    if (imgEl) {
                      if (imgEl.src !== info.image) imgEl.src = info.image;
                    } else {
                      const placeholder = imgContainer.querySelector('div.bg-gradient-to-tr');
                      if (placeholder) {
                        placeholder.outerHTML = `<img src="${info.image}" class="w-8 h-8 rounded-xl object-cover border border-slate-200 shadow-sm shrink-0" alt="#${idStr}">`;
                      }
                    }
                  }
                }
              }

              // 🏷️ 3. ISOLATED NAME RESOLVER (Modifies title ONLY, NEVER touches rank!)
              if (info.name && !info.name.startsWith('#')) {
                if (stored) stored.name = info.name;
                if (row) {
                  const nameEl = row.querySelector('.token-name-label') || row.querySelector('td:nth-child(1) a span');
                  if (nameEl) nameEl.innerText = info.name;
                }
              }
            });

            // Update top rarity badge counter using rarityRegistry
            let rareCount = 0;
            liveListingsStore.forEach(i => {
              const r = (window.rarityRegistry && window.rarityRegistry.get(String(i.tokenId))) || i.rarityRank;
              if (r && r <= 1200) rareCount++;
            });
            const rareEl = document.getElementById('count-rare');
            if (rareEl) rareEl.innerText = rareCount;
          } else {
            throw new Error('Batch failed');
          }
        } catch(e) {
          unrequested.forEach(id => {
            const state = window.rarityRequestMap.get(String(id));
            if (state) state.status = 'failed';
          });
        }
      }, 150);
    }