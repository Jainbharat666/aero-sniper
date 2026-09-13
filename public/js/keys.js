/* ══════════════════════════════════════════════════════════════
   🔑 AERO-SNIPER V2: OPENSEA 6-KEY FLEET OPERATIONS
   ══════════════════════════════════════════════════════════════ */

    // ================= OPENSEA API FLEET OPERATIONS =================
    async function fetchOpenSeaKeys() {
      try {
        const headers = {};
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
        const res = await fetch('/api/opensea/keys', { headers });
        const data = await res.json();
        if (data && data.success) {
          openseaKeysData = data.keys || [];
          const countEl = document.getElementById('opensea-keys-count');
          if (countEl) countEl.innerText = data.totalKeys;
          const tabCountEl = document.getElementById('tab-opensea-count');
          if (tabCountEl) tabCountEl.innerText = data.totalKeys;
          const callsEl = document.getElementById('stat-opensea-total-calls');
          if (callsEl) callsEl.innerText = `${data.totalRequests || 0} Calls`;
          renderOpenSeaKeysList();
        }
      } catch (err) {
        console.error('[OpenSea Fleet Fetch Error]:', err);
      }
    }

    function renderOpenSeaKeysList() {
      const container = document.getElementById('opensea-keys-list');
      if (!container) return;

      container.innerHTML = '';
      if (!openseaKeysData || openseaKeysData.length === 0) {
        container.innerHTML = `
          <div class="p-6 text-center text-slate-400 font-mono-code text-xs">
            <i class="fa-solid fa-triangle-exclamation text-amber-500 mb-1 block text-base"></i>
            No OpenSea API keys found in pool.
          </div>`;
        return;
      }

      openseaKeysData.forEach((k, idx) => {
        const item = document.createElement('div');
        item.className = 'p-2.5 sm:px-3.5 sm:py-2.5 rounded-2xl border border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 transition-all hover:bg-white hover:shadow-sm';
        
        let roleBadge = '';
        if (k.role === 'stream' || idx === 0) {
          roleBadge = '<span class="px-2 py-0.5 rounded-lg bg-purple-600 text-white font-black text-[9px] uppercase tracking-wider">⚡ 24/7 STREAM KEY</span>';
        } else if (k.role === 'fulfillment') {
          roleBadge = '<span class="px-2 py-0.5 rounded-lg bg-emerald-600 text-white font-black text-[9px] uppercase tracking-wider">💎 FULFILLMENT</span>';
        } else if (k.role === 'rarity') {
          roleBadge = '<span class="px-2 py-0.5 rounded-lg bg-pink-600 text-white font-black text-[9px] uppercase tracking-wider">👑 RARITY INGESTION</span>';
        } else if (k.role === 'floor') {
          roleBadge = '<span class="px-2 py-0.5 rounded-lg bg-cyan-600 text-white font-black text-[9px] uppercase tracking-wider">📊 FLOOR POLLER</span>';
        } else if (k.role === 'scanner') {
          roleBadge = '<span class="px-2 py-0.5 rounded-lg bg-amber-600 text-white font-black text-[9px] uppercase tracking-wider">🔍 RAPID SCANNER</span>';
        } else {
          roleBadge = '<span class="px-2 py-0.5 rounded-lg bg-indigo-600 text-white font-black text-[9px] uppercase tracking-wider">🛡️ BACKUP RELAY</span>';
        }

        const isOk = k.status && k.status.includes('200');
        const statusBadge = `<span class="px-2 py-0.5 rounded-lg ${isOk ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-rose-100 text-rose-800 border border-rose-300'} font-black text-[10px]" id="opensea-status-${idx}">
          ● ${k.status} (${k.lastPingMs || 0}ms)
        </span>`;

        const deleteBtn = (idx > 0) ? `
          <button onclick="deleteOpenSeaKey('${k.key}')" class="px-2.5 py-1 bg-white hover:bg-rose-50 text-rose-600 font-bold text-xs rounded-xl border border-rose-200 transition-all shadow-sm" title="Remove Key from Pool">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        ` : '';

        item.innerHTML = `
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-black text-xs text-slate-900">${k.label}</span>
              ${roleBadge}
              ${statusBadge}
            </div>
            <div class="flex items-center gap-2 text-xs font-mono-code flex-wrap">
              <span class="text-slate-500 font-semibold text-[10px]">KEY:</span>
              <span class="opensea-key-badge font-mono text-[11px] font-bold text-slate-800 select-all bg-white px-2 py-0.5 rounded-lg border border-slate-200 shadow-sm">${k.key}</span>
              <span class="text-slate-400">•</span>
              <span class="text-[10px] text-slate-500">Calls: <strong class="text-indigo-600 font-bold">${k.requestsServed || 0}</strong></span>
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <button onclick="testSingleOpenSeaKey('${k.key}', ${idx})" class="px-2.5 py-1 bg-white hover:bg-indigo-50 text-indigo-700 font-bold text-xs rounded-xl border border-indigo-200 transition-all shadow-sm" title="Test Key">
              <i class="fa-solid fa-bolt text-indigo-600"></i> Test
            </button>
            <button onclick="copyOpenSeaKey('${k.key}')" class="px-2.5 py-1 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs rounded-xl border border-slate-200 transition-all shadow-sm" title="Copy Key">
              <i class="fa-regular fa-copy"></i> Copy
            </button>
            ${deleteBtn}
          </div>
        `;
        container.appendChild(item);
      });
    }

    async function testSingleOpenSeaKey(key, idx) {
      playBeep(800, 'sine', 0.08);
      const statusEl = document.getElementById(`opensea-status-${idx}`);
      if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-indigo-600"></i> Testing...`;

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
        const res = await fetch('/api/opensea/test-key', {
          method: 'POST',
          headers,
          body: JSON.stringify({ apiKey: key })
        });
        const data = await res.json();
        
        if (data.success) {
          logConsole(`✔ OpenSea Key [${data.masked || data.apiKey}] Verified: ${data.latencyMs}ms latency (Target: ${data.collectionChecked}).`);
          showToast(`Key Valid: ${data.latencyMs}ms (${data.status})`);
        } else {
          logConsole(`✖ OpenSea Key [${data.masked || data.apiKey}] Test Failed: ${data.status}`);
          showToast(`Key Error: ${data.status}`, true);
        }
      } catch(e) {
        showToast('Key test request failed', true);
      } finally {
        fetchOpenSeaKeys();
      }
    }

    async function testAllOpenSeaKeys() {
      const btn = document.getElementById('btn-test-opensea-all');
      if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-purple-600"></i> Testing Keys...`;
      playBeep(900, 'sine', 0.15);
      logConsole(`⚡ Testing all configured OpenSea API Keys in pool...`);
      showToast('Testing all OpenSea API keys...');

      for (let i = 0; i < openseaKeysData.length; i++) {
        const k = openseaKeysData[i];
        await testSingleOpenSeaKey(k.key, i);
      }
      logConsole(`✔ OpenSea API Key validation completed.`);
      showToast('All OpenSea API Keys Tested!');
      if (btn) {
        btn.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-600"></i> <span class="text-emerald-700 font-black">All Tested!</span>`;
        setTimeout(() => {
          btn.innerHTML = `<i class="fa-solid fa-bolt text-indigo-600"></i> Test All Keys`;
        }, 1800);
      }
    }

    function copyOpenSeaKey(key) {
      if (!key) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(key).then(() => {
          playBeep(950, 'sine', 0.08);
          showToast('OpenSea API Key copied to clipboard!');
        }).catch(() => {
          fallbackCopyText(key);
        });
      } else {
        fallbackCopyText(key);
      }
    }

    function fallbackCopyText(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        playBeep(950, 'sine', 0.08);
        showToast('OpenSea API Key copied to clipboard!');
      } catch (err) {
        showToast('Could not copy key', true);
      }
      document.body.removeChild(ta);
    }

    async function addCustomOpenSeaKey() {
      const label = (document.getElementById('new-opensea-label').value || '').trim();
      const key = (document.getElementById('new-opensea-key').value || '').trim();

      if (!key || key.length < 10) {
        showToast('Please enter a valid OpenSea API Key (min 10 chars)!', true);
        return;
      }

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
        const res = await fetch('/api/opensea/add-key', {
          method: 'POST',
          headers,
          body: JSON.stringify({ apiKey: key, label })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('new-opensea-label').value = '';
          document.getElementById('new-opensea-key').value = '';
          fetchOpenSeaKeys();
          playBeep(920, 'sine', 0.1);
          logConsole(`✔ Added new OpenSea API Key [${key.slice(0, 6)}...${key.slice(-4)}] to pool.`);
          showToast('OpenSea API Key Added to Pool!');
        } else {
          showToast(data.error || 'Failed to add API key', true);
        }
      } catch(e) {
        showToast('Failed to add API key', true);
      }
    }

    async function deleteOpenSeaKey(key) {
      if (!confirm(`Are you sure you want to remove this OpenSea API Key from the active pool?\n\nKey: ${key}`)) return;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
        const res = await fetch('/api/opensea/delete-key', {
          method: 'POST',
          headers,
          body: JSON.stringify({ apiKey: key })
        });
        const data = await res.json();
        if (data.success) {
          fetchOpenSeaKeys();
          playBeep(850, 'sine', 0.1);
          logConsole(`✔ OpenSea API Key removed from pool.`);
          showToast('OpenSea API Key Removed');
        } else {
          showToast(data.error || 'Failed to remove API key', true);
        }
      } catch(e) {
        showToast('Error removing API key', true);
      }
    }
