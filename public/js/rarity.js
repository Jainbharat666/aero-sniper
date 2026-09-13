/* ══════════════════════════════════════════════════════════════
   👑 AERO-SNIPER V2: HIGH-SPEED BATCH RARITY RESOLVER
   ══════════════════════════════════════════════════════════════ */

    // ─── HIGH-SPEED BATCH RARITY RESOLVER (CLIENT-SIDE) ───────────────────────
    let rankResolveTimer = null;
    const requestedRarityTokensSet = new Set(); // 🛡️ Deduplicate requested tokens to avoid 429 rate-limit flood
    function debouncedResolveMissingRanks(tokenIds) {
      if (rankResolveTimer) clearTimeout(rankResolveTimer);
      rankResolveTimer = setTimeout(async () => {
        if (!currentScannedProject || !Array.isArray(tokenIds) || tokenIds.length === 0) return;
        const unrequested = tokenIds.filter(id => id && !requestedRarityTokensSet.has(String(id)));
        if (unrequested.length === 0) return;
        unrequested.forEach(id => requestedRarityTokensSet.add(String(id)));

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
            Object.entries(data.rarities).forEach(([id, info]) => {
              if (info) {
                const stored = liveListingsStore.find(i => String(i.tokenId) === String(id));
                if (stored) {
                  if (info.rank != null) stored.rarityRank = info.rank;
                  if (info.name) stored.name = info.name;
                  if (info.image) stored.image = info.image;
                }
                const row = document.querySelector(`tr[data-token="${id}"]`);
                if (row) {
                  if (info.rank != null) {
                    row.setAttribute('data-rank', info.rank);
                    const rankCell = row.querySelector('td:nth-child(3)');
                    if (rankCell) {
                      const numRank = Number(info.rank);
                      const rankBadge = numRank <= 500
                        ? `<span class="px-2 py-0.5 rounded-lg bg-pink-100 text-pink-800 border border-pink-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                        : numRank <= 1200
                        ? `<span class="px-2 py-0.5 rounded-lg bg-cyan-100 text-cyan-800 border border-cyan-300 font-black text-xs">#${numRank.toLocaleString()}</span>`
                        : `<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-bold text-xs">#${numRank.toLocaleString()}</span>`;
                      rankCell.innerHTML = rankBadge;
                    }
                  } else {
                    const rankCell = row.querySelector('td:nth-child(3)');
                    if (rankCell && rankCell.innerText.includes('N/A')) {
                      rankCell.innerHTML = `<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-400 text-xs">#Unranked</span>`;
                    }
                  }
                  if (info.name) {
                    const nameEl = row.querySelector('td:nth-child(1) span.font-black');
                    if (nameEl) nameEl.innerText = info.name;
                  }
                  if (info.image) {
                    const imgEl = row.querySelector('td:nth-child(1) img');
                    if (imgEl) imgEl.src = info.image;
                  }
                }
              }
            });
            let rareCount = 0;
            liveListingsStore.forEach(i => {
              if (i.rarityRank && i.rarityRank <= 1200) rareCount++;
            });
            const rareEl = document.getElementById('count-rare');
            if (rareEl) rareEl.innerText = rareCount;
          }
        } catch(e) {}
      }, 200);
    }