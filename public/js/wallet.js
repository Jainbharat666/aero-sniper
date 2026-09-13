/* ══════════════════════════════════════════════════════════════
   💼 AERO-SNIPER V2: MULTI-WORKER FLEET & TREASURY OPERATIONS
   ══════════════════════════════════════════════════════════════ */

    // ================= MULTI-WALLET FLEET OPERATIONS =================
    function setGenCount(cnt) {
      genCount = cnt;
      document.getElementById('gen-count-num').innerText = cnt;
      [1, 5, 10, 20, 50].forEach(n => {
        const btn = document.getElementById(`gc-${n}`);
        if (n === cnt) {
          btn.className = 'gen-cnt-btn py-1 rounded-xl bg-indigo-600 text-white shadow-sm transition-colors';
        } else {
          btn.className = 'gen-cnt-btn py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 transition-colors';
        }
      });
      playBeep(700, 'sine', 0.05);
    }

    function generateWallets() {
      playBeep(900, 'sine', 0.15);
      const newWallets = [];
      const backupLines = [];

      for (let i = 0; i < genCount; i++) {
        const w = ethers.Wallet.createRandom();
        const idx = walletFleet.length + i + 1;
        const walletObj = {
          id: 'w-' + Date.now() + '-' + i,
          name: `Wallet #${idx}`,
          address: w.address,
          privateKey: w.privateKey,
          balanceEth: 0,
          balanceUsd: 0,
          selected: true,
          status: 'UNFUNDED'
        };

        newWallets.push(walletObj);
        backupLines.push(`${walletObj.name} | Address: ${walletObj.address} | PrivateKey: ${walletObj.privateKey}`);
      }

      walletFleet = walletFleet.concat(newWallets);
      if (masterWalletIndex === null && walletFleet.length > 0) masterWalletIndex = 0;

      persistState();
      renderWalletFleetUI();
      refreshAllBalances();

      logConsole(`✨ Generated ${newWallets.length} fresh EVM wallets with CSPRNG cryptography.`);
      showToast(`Generated & added ${newWallets.length} wallets!`);

      if (document.getElementById('chk-auto-download-txt').checked) {
        const blob = new Blob([backupLines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sniper_wallets_backup_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }

    // ─── 100% AEROMINT V3 COMPATIBLE WALLET IMPORTER & EXPORTER ──────────────
    function parseAndLoadKeys(customText = null) {
      const val = (typeof customText === 'string' ? customText : document.getElementById('import-keys-input').value).trim();
      if (!val) {
        showToast('Please paste or select private keys first!', true);
        return 0;
      }

      // Check if input is AeroMint JSON universal backup or sniper JSON
      if (val.startsWith('{') || val.startsWith('[')) {
        try {
          const parsed = JSON.parse(val);
          let rawList = [];
          if (Array.isArray(parsed)) {
            rawList = parsed;
          } else if (parsed.activeWallets && Array.isArray(parsed.activeWallets)) {
            rawList = parsed.activeWallets;
          } else if (parsed.wallets && Array.isArray(parsed.wallets)) {
            rawList = parsed.wallets;
          }

          if (rawList.length > 0) {
            let jsonCount = 0;
            rawList.forEach((item) => {
              const pk = typeof item === 'string' ? item : (item.privateKey || item.pk || '');
              let cleanPk = pk ? pk.trim() : '';
              if (!cleanPk.startsWith('0x') && cleanPk.length === 64) cleanPk = '0x' + cleanPk;
              if (/^0x[a-fA-F0-9]{64}$/.test(cleanPk)) {
                try {
                  const w = new ethers.Wallet(cleanPk);
                  const exists = walletFleet.some(wf => wf.address.toLowerCase() === w.address.toLowerCase());
                  if (!exists) {
                    const isM = (typeof item === 'object' && (item.isMaster || (item.name && item.name.includes('Master'))));
                    const newEntry = {
                      id: 'w-' + Date.now() + '-' + jsonCount,
                      name: (typeof item === 'object' && item.name) ? item.name : `Wallet #${walletFleet.length + 1}`,
                      address: w.address,
                      privateKey: cleanPk,
                      balanceEth: 0,
                      balanceUsd: 0,
                      selected: !isM,
                      status: 'UNFUNDED'
                    };
                    if (isM) {
                      walletFleet.unshift(newEntry);
                      masterWalletIndex = 0;
                    } else {
                      walletFleet.push(newEntry);
                    }
                    jsonCount++;
                  }
                } catch(e) {}
              }
            });

            if (jsonCount > 0) {
              if (masterWalletIndex === null && walletFleet.length > 0) masterWalletIndex = 0;
              const inputEl = document.getElementById('import-keys-input');
              if (inputEl) inputEl.value = '';
              if (currentUser && currentUser.id) setCloudVaultEnabledLocally(currentUser.id, true);
              persistState();
              syncUserVaultToCloud(true);
              renderWalletFleetUI();
              refreshAllBalances();
              playBeep(900, 'sine', 0.1);
              logConsole(`✔ [AEROMINT JSON] Imported ${jsonCount} wallets into active fleet.`);
              showToast(`Imported ${jsonCount} wallets from AeroMint JSON & synced to Cloud!`);
              return jsonCount;
            }
          }
        } catch(e) {}
      }

      // Universal line-by-line parser (handles AeroMint TXT backups, CSV, or raw key lists)
      const lines = val.split('\n').map(l => l.trim()).filter(Boolean);
      let count = 0;
      let currentSection = 'WORKER';

      lines.forEach((line) => {
        // Skip decorative header lines
        if (line.startsWith('===') || line.startsWith('---') || line.startsWith('Export Date:') || 
            line.startsWith('Total Wallets:') || line.startsWith('Network:') || 
            line.startsWith('SECURITY WARNING:')) {
          return;
        }

        if (line.includes('[👑 MASTER') || line.includes('[MASTER') || line.toLowerCase().includes('master funding')) {
          currentSection = 'MASTER';
          return;
        }
        if (line.includes('[⚡ WORKER') || line.includes('[WORKER')) {
          currentSection = 'WORKER';
          return;
        }
        if (line.includes('RAW PRIVATE KEYS LIST')) {
          currentSection = 'RAW';
          return;
        }

        const isMasterLine = (currentSection === 'MASTER') || line.includes('[👑 MASTER') || line.includes('[MASTER]') || line.toLowerCase().includes('master funding');
        let cleanKey = line;

        // CSV parsing: Index,Role,Name,Address,PrivateKey
        if (line.includes(',')) {
          const parts = line.split(',');
          for (const p of parts) {
            const stripped = p.replace(/["'\s]/g, '');
            if (/^0x[a-fA-F0-9]{64}$/.test(stripped) || /^[a-fA-F0-9]{64}$/.test(stripped)) {
              cleanKey = stripped;
              break;
            }
          }
        }

        // Support AeroMint format: "Private Key: 0x..." (with space) or "PrivateKey: 0x..."
        if (cleanKey.includes('Private Key:')) {
          cleanKey = cleanKey.split('Private Key:')[1].trim();
        } else if (cleanKey.includes('PrivateKey:')) {
          cleanKey = cleanKey.split('PrivateKey:')[1].trim();
        } else if (cleanKey.includes('privateKey":')) {
          cleanKey = cleanKey.split('privateKey":')[1].replace(/["',]/g, '').trim();
        }

        // Extract 64-hex or 66-hex
        if (cleanKey.includes('0x')) {
          const match = cleanKey.match(/0x[a-fA-F0-9]{64}/);
          if (match) cleanKey = match[0];
        } else if (/^[a-fA-F0-9]{64}$/.test(cleanKey)) {
          cleanKey = '0x' + cleanKey;
        }

        if (/^0x[a-fA-F0-9]{64}$/.test(cleanKey)) {
          try {
            const w = new ethers.Wallet(cleanKey);
            const exists = walletFleet.some(wf => wf.address.toLowerCase() === w.address.toLowerCase());
            if (!exists) {
              const idx = walletFleet.length + 1;
              const newWallet = {
                id: 'w-' + Date.now() + '-' + count,
                name: isMasterLine ? '👑 Master Treasury' : `Wallet #${idx}`,
                address: w.address,
                privateKey: cleanKey,
                balanceEth: 0,
                balanceUsd: 0,
                selected: !isMasterLine,
                status: 'UNFUNDED'
              };
              if (isMasterLine) {
                walletFleet.unshift(newWallet);
                masterWalletIndex = 0;
              } else {
                walletFleet.push(newWallet);
              }
              count++;
            }
          } catch(e) {}
        }
      });

      if (count > 0) {
        if (masterWalletIndex === null && walletFleet.length > 0) masterWalletIndex = 0;
        const inputEl = document.getElementById('import-keys-input');
        if (inputEl) inputEl.value = '';
        if (currentUser && currentUser.id) setCloudVaultEnabledLocally(currentUser.id, true);
        persistState();
        syncUserVaultToCloud(true);
        renderWalletFleetUI();
        refreshAllBalances();
        playBeep(900, 'sine', 0.1);
        logConsole(`✔ [AEROMINT TXT] Imported & loaded ${count} wallets into active fleet.`);
        showToast(`Imported ${count} wallets & synced to Cloud!`);
      } else if (!customText) {
        showToast('No valid private keys found in input!', true);
      }
      return count;
    }

    // 1-Click File Importer (AeroMint TXT, JSON, CSV, .aero)
    function importWalletFleetFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const content = e.target.result;
          const loaded = parseAndLoadKeys(content);
          if (loaded > 0) {
            logConsole(`🎉 [FILE IMPORT] Loaded ${loaded} wallets from: ${file.name}`);
            showToast(`Loaded ${loaded} wallets from ${file.name}!`);
          } else {
            showToast('No valid keys found in uploaded file!', true);
          }
        } catch(err) {
          showToast(`Failed to read file: ${err.message}`, true);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    // AeroMint V3 100% Identical Plaintext TXT Exporter
    function exportTxtBackup() {
      if (walletFleet.length === 0) {
        showToast('No wallets to export!', true);
        return;
      }
      const timestamp = new Date().toLocaleString();
      let content = '================================================================================\n';
      content += '                AEROMINT BOT - WALLET FLEET SECURE BACKUP FILE                   \n';
      content += '================================================================================\n';
      content += `Export Date:   ${timestamp}\n`;
      content += `Total Wallets: ${walletFleet.length}\n`;
      content += 'Network:       Robinhood Chain Mainnet (Chain ID: 4663)\n';
      content += 'SECURITY WARNING: Keep this backup file completely private and secure!\n';
      content += '================================================================================\n\n';

      const master = (masterWalletIndex !== null && walletFleet[masterWalletIndex]) ? walletFleet[masterWalletIndex] : null;
      if (master) {
        content += '[👑 MASTER FUNDING & TREASURY WALLET]\n';
        content += `Name:        ${master.name || 'Master Treasury Wallet'}\n`;
        content += `Address:     ${master.address}\n`;
        content += `Private Key: ${master.privateKey}\n`;
        content += `Balance:     ${master.balanceEth || 0} ETH\n`;
        content += '--------------------------------------------------------------------------------\n\n';
      }

      content += '[⚡ WORKER SUB-WALLETS FLEET]\n';
      const workers = walletFleet.filter((w, idx) => idx !== masterWalletIndex);
      workers.forEach((w, idx) => {
        content += `Wallet #${idx + 1} (${w.name || 'Worker'}):\n`;
        content += `  Address:     ${w.address}\n`;
        content += `  Private Key: ${w.privateKey}\n`;
        content += `  Balance:     ${w.balanceEth || 0} ETH\n\n`;
      });

      content += '================================================================================\n';
      content += 'RAW PRIVATE KEYS LIST (Copy-paste friendly for bulk import / scripts):\n';
      content += '================================================================================\n';
      walletFleet.forEach(w => {
        content += `${w.privateKey}\n`;
      });
      content += '================================================================================\n';

      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aeromint_wallets_backup_${walletFleet.length}wallets_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      playBeep(920, 'sine', 0.08);
      logConsole(`✔ Exported ${walletFleet.length} wallets in AeroMint V3 Plaintext format.`);
      showToast('Wallets exported in AeroMint V3 TXT format!');
    }

    function copyAllKeys() {
      if (walletFleet.length === 0) return;
      navigator.clipboard.writeText(walletFleet.map(w => w.privateKey).join('\n'));
      showToast('All private keys copied!');
    }

    function handleSelectMaster(val) {
      masterWalletIndex = (val === '' || val === null) ? null : parseInt(val, 10);
      persistState();
      renderWalletFleetUI();
      playBeep(850, 'sine', 0.08);
      if (masterWalletIndex !== null && walletFleet[masterWalletIndex]) {
        showToast(`Master: ${walletFleet[masterWalletIndex].name}`);
      }
    }

    function setMasterWallet(index) {
      masterWalletIndex = index;
      persistState();
      renderWalletFleetUI();
      playBeep(900, 'sine', 0.1);
      showToast(`Master Treasury: ${walletFleet[index].name}`);
    }

    function deleteWallet(index) {
      const removed = walletFleet[index];
      walletFleet.splice(index, 1);
      if (masterWalletIndex === index) {
        masterWalletIndex = walletFleet.length > 0 ? 0 : null;
      } else if (masterWalletIndex > index) {
        masterWalletIndex--;
      }
      persistState();
      syncUserVaultToCloud(true);
      renderWalletFleetUI();
      showToast(`Deleted ${removed.name}`);
    }

    async function clearAllWallets() {
      const ok = await showCustomConfirm('Are you sure you want to clear ALL wallets from the fleet?\nMake sure you have downloaded a .txt, .json or .csv backup before proceeding!', 'Clear Entire Fleet', { isDanger: true, confirmText: 'Clear All Wallets' });
      if (!ok) return;
      walletFleet = [];
      masterWalletIndex = null;
      persistState();
      renderWalletFleetUI();
      showToast('All fleet wallets cleared');
    }

    function toggleWalletSelection(index, isChecked) {
      if (walletFleet[index]) {
        walletFleet[index].selected = isChecked;
        persistState();
        updateSelectedWorkerCount();
      }
    }

    function selectAllWallets(selectAll) {
      walletFleet.forEach((w, i) => {
        if (i !== masterWalletIndex) {
          w.selected = selectAll;
        } else {
          w.selected = false;
        }
      });
      persistState();
      renderWalletFleetUI();
      updateSelectedWorkerCount();
    }

    function selectTopN(n) {
      walletFleet.forEach((w, i) => {
        w.selected = (i !== masterWalletIndex && i < n);
      });
      persistState();
      renderWalletFleetUI();
      updateSelectedWorkerCount();
    }

    function selectUnfundedOnly() {
      walletFleet.forEach((w, i) => {
        w.selected = (i !== masterWalletIndex && w.balanceEth < 0.0001);
      });
      persistState();
      renderWalletFleetUI();
      updateSelectedWorkerCount();
    }

    function updateSelectedWorkerCount() {
      const activeWorkers = walletFleet.filter((w, i) => i !== masterWalletIndex && w.selected);
      const selEl = document.getElementById('selected-sniper-count');
      if (selEl) selEl.innerText = activeWorkers.length;
      const fundEl = document.getElementById('fund-target-count');
      if (fundEl) fundEl.innerText = activeWorkers.length;
    }

    function formatEthDynamic(val) {
      if (!val || val === 0) return '0.000000 ETH';
      if (val < 0.0001) return `${val.toFixed(8)} ETH`;
      if (val < 0.01) return `${val.toFixed(6)} ETH`;
      return `${val.toFixed(4)} ETH`;
    }

    function formatUsdDynamic(val) {
      if (!val || val === 0) return '$0.00';
      if (val < 0.01) return `$${val.toFixed(6)}`;
      return `$${val.toFixed(2)}`;
    }

    function sanitizeAddress(addr) {
      if (!addr) return '';
      try {
        return ethers.getAddress(addr.trim().toLowerCase());
      } catch (e) {
        return addr.trim();
      }
    }

    function sanitizePrivateKey(pk) {
      if (!pk) return '';
      let s = pk.trim();
      if (!s.startsWith('0x')) s = '0x' + s;
      return s;
    }

    function getOrderedRpcUrls() {
      const list = [];
      const primary = rpcFleet.find(r => r.isPrimary);
      if (primary && primary.url) list.push(primary.url);
      
      const official = 'https://rpc.mainnet.chain.robinhood.com';
      if (!list.includes(official)) list.push(official);

      rpcFleet.forEach(r => {
        if (r.url && !list.includes(r.url)) list.push(r.url);
      });

      if (list.length === 0) list.push(official);
      return list;
    }

    function getEthersProvider(preferredUrl = null) {
      const url = preferredUrl || (rpcFleet.find(r => r.isPrimary)?.url) || 'https://rpc.mainnet.chain.robinhood.com';
      return new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
    }

    // Execute any blockchain call with automatic instant failover to other RPCs
    async function executeRpcWithFallback(callFn) {
      const urls = getOrderedRpcUrls();
      let lastErr = null;
      for (const url of urls) {
        try {
          const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
          const res = await callFn(provider);
          return res;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('All RPC endpoints failed');
    }

    async function getSafeBalance(address) {
      const cleanAddr = sanitizeAddress(address);
      return await executeRpcWithFallback(async (provider) => {
        return await provider.getBalance(cleanAddr);
      });
    }

    async function getSafeFeeData() {
      const provider = getEthersProvider();
      try {
        const [block, fee] = await Promise.all([
          provider.getBlock('latest').catch(() => null),
          provider.getFeeData().catch(() => null)
        ]);
        const baseFee = block?.baseFeePerGas || fee?.gasPrice || 22000000n;
        // Dynamic +35% Turbo buffer on baseFee so transaction never gets rejected by sequencer when base fee ticks up
        const safeGasPrice = (baseFee * 135n) / 100n;
        return {
          gasPrice: safeGasPrice,
          baseFee: baseFee
        };
      } catch (e) {
        return {
          gasPrice: 32000000n,
          baseFee: 22000000n
        };
      }
    }

    function handleFundUsdInput(usdVal) {
      const usd = parseFloat(usdVal);
      if (!isNaN(usd) && usd >= 0 && currentLiveEthPrice > 0) {
        const eth = usd / currentLiveEthPrice;
        document.getElementById('input-fund-amount').value = eth < 0.0001 ? eth.toFixed(8) : eth.toFixed(6);
      } else {
        document.getElementById('input-fund-amount').value = '';
      }
    }

    function handleFundEthInput(ethVal) {
      const eth = parseFloat(ethVal);
      if (!isNaN(eth) && eth >= 0 && currentLiveEthPrice > 0) {
        const usd = eth * currentLiveEthPrice;
        document.getElementById('input-fund-usd').value = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
      } else {
        document.getElementById('input-fund-usd').value = '';
      }
    }

    function setFundUsdPreset(usdAmount) {
      document.getElementById('input-fund-usd').value = usdAmount;
      handleFundUsdInput(usdAmount);
      playBeep(750, 'sine', 0.05);
    }

    function setFundPercentPreset(percent) {
      if (masterWalletIndex === null || !walletFleet[masterWalletIndex]) {
        showToast('Please select a Master Treasury Wallet first!', true);
        return;
      }
      const master = walletFleet[masterWalletIndex];
      const targetWorkers = walletFleet.filter((w, i) => i !== masterWalletIndex && w.selected);
      const targetCount = Math.max(1, targetWorkers.length);
      
      const masterBalEth = master.balanceEth || 0;
      // Reserve gas buffer
      const availableBal = Math.max(0, masterBalEth - (0.000001 * targetCount));
      const totalEthToSend = (availableBal * (percent / 100));
      const ethPerWorker = totalEthToSend / targetCount;

      const finalEth = Math.max(0, ethPerWorker);
      document.getElementById('input-fund-amount').value = finalEth < 0.0001 ? finalEth.toFixed(8) : finalEth.toFixed(6);
      handleFundEthInput(finalEth);
      playBeep(800, 'sine', 0.05);
      showToast(`Master Preset: ${percent}% (${(finalEth * currentLiveEthPrice).toFixed(4)} USD per worker)`);
    }

    function handleModalSendUsdInput(usdVal) {
      const usd = parseFloat(usdVal);
      if (!isNaN(usd) && usd >= 0 && currentLiveEthPrice > 0) {
        const eth = usd / currentLiveEthPrice;
        document.getElementById('modal-send-amount').value = eth < 0.0001 ? eth.toFixed(8) : eth.toFixed(6);
      } else {
        document.getElementById('modal-send-amount').value = '';
      }
    }

    function handleModalSendEthInput(ethVal) {
      const eth = parseFloat(ethVal);
      if (!isNaN(eth) && eth >= 0 && currentLiveEthPrice > 0) {
        const usd = eth * currentLiveEthPrice;
        document.getElementById('modal-send-usd').value = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
      } else {
        document.getElementById('modal-send-usd').value = '';
      }
    }

    async function setSendModalPercent(percent) {
      if (activeSendWalletIndex === null || !walletFleet[activeSendWalletIndex]) return;
      const sender = walletFleet[activeSendWalletIndex];
      playBeep(780, 'sine', 0.05);

      try {
        const balWei = await getSafeBalance(sender.address);
        const feeData = await getSafeFeeData();
        const gasPrice = feeData.gasPrice || 20200000n;
        const gasCostWei = 25000n * gasPrice;

        if (balWei <= gasCostWei) {
          document.getElementById('modal-send-amount').value = '0';
          handleModalSendEthInput(0);
          showToast('Balance too low to cover transfer gas', true);
          return;
        }

        const maxSendWei = balWei - gasCostWei;
        if (percent === 100) {
          const maxEthStr = ethers.formatEther(maxSendWei);
          document.getElementById('modal-send-amount').value = maxEthStr;
          handleModalSendEthInput(parseFloat(maxEthStr));
        } else {
          const sendWei = (maxSendWei * BigInt(percent)) / 100n;
          const sendEthStr = ethers.formatEther(sendWei);
          const sendFloat = parseFloat(sendEthStr);
          document.getElementById('modal-send-amount').value = sendFloat < 0.0001 ? sendFloat.toFixed(8) : sendFloat.toFixed(6);
          handleModalSendEthInput(sendFloat);
        }
      } catch(e) {
        const balEth = sender.balanceEth || 0;
        const gasEst = 0.00000055;
        const maxSafeEth = Math.max(0, balEth - gasEst);
        const sendEth = maxSafeEth * (percent / 100);
        document.getElementById('modal-send-amount').value = sendEth < 0.0001 ? sendEth.toFixed(8) : sendEth.toFixed(6);
        handleModalSendEthInput(sendEth);
      }
    }

    function setFundPreset(usdAmount) {
      setFundUsdPreset(usdAmount);
    }

    const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
    const MULTICALL3_ABI = [
      'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'
    ];
    const ERC721_SWEEP_ABI = [
      'function balanceOf(address owner) external view returns (uint256)',
      'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
      'function ownerOf(uint256 tokenId) external view returns (address)',
      'function safeTransferFrom(address from, address to, uint256 tokenId) external',
      'function transferFrom(address from, address to, uint256 tokenId) external'
    ];


    // ─── CUSTOM RPC EXPORT & IMPORT (AEROMINT SUITE) ───────────────────────────
    // ─── 100% AEROMINT V3 COMPATIBLE CUSTOM RPC EXPORT & IMPORT ──────────────
    function exportRpcFleetJson() {
      if (!rpcFleet || rpcFleet.length === 0) {
        showToast('No custom RPC endpoints to export!', true);
        return;
      }
      const isOwnerAdmin = currentUser && (currentUser.role === 'admin' || currentUser.email === 'jainbharat666@gmail.com');
      const filteredFleet = isOwnerAdmin ? rpcFleet : rpcFleet.filter(r => !r.isFleet && r.id !== 'sys-rpc-admin-cluster' && !String(r.id).startsWith('fleet-') && (r.isCustom || r.url?.includes('rpc.mainnet.chain.robinhood.com')));

      const backupData = {
        app: 'AeroMint Premium',
        type: 'RPC_BACKUP',
        network: 'robinhood',
        timestamp: new Date().toISOString(),
        rpcMode: currentRpcStrategy || 'dynamic',
        rpcs: filteredFleet.map(r => ({
          name: r.name,
          url: r.url,
          latency: r.statusStr || (r.pingMs ? r.pingMs + 'ms' : 'Unchecked'),
          active: r.status !== 'offline',
          role: r.isPrimary ? 'primary' : 'custom',
          isFleet: true,
          isCustom: true,
          network: 'robinhood'
        })),
        rpcFleet: filteredFleet.map(r => ({
          id: r.id,
          name: r.name,
          url: r.url,
          isPrimary: !!r.isPrimary,
          pingMs: r.pingMs || 100,
          statusStr: r.statusStr || '100ms',
          status: r.status || 'online'
        }))
      };
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
      const dl = document.createElement('a');
      dl.setAttribute("href", dataStr);
      dl.setAttribute("download", `aeromint_rpcs_robinhood_${Date.now()}.json`);
      document.body.appendChild(dl);
      dl.click();
      dl.remove();
      playBeep(920, 'sine', 0.1);
      logConsole(`✔ Exported ${rpcFleet.length} Custom RPC Endpoints in AeroMint V3 format.`);
      showToast(`Exported ${rpcFleet.length} RPCs in AeroMint V3 format!`);
    }

    function importRpcFleetJson(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const parsed = JSON.parse(e.target.result);
          let list = [];
          if (Array.isArray(parsed)) {
            list = parsed;
          } else if (parsed.rpcs && Array.isArray(parsed.rpcs)) {
            // 🎯 AeroMint V3 RPC Backup format
            list = parsed.rpcs;
          } else if (parsed.rpcFleet && Array.isArray(parsed.rpcFleet)) {
            // 🎯 Sniper V2 format
            list = parsed.rpcFleet;
          } else if (parsed.endpoints && Array.isArray(parsed.endpoints)) {
            list = parsed.endpoints;
          } else {
            throw new Error('Invalid JSON format: missing rpcs array');
          }

          let addedCount = 0;
          list.forEach(item => {
            const url = typeof item === 'string' ? item.trim() : (item.url || '').trim();
            const name = typeof item === 'object' && item.name ? item.name.trim() : `RPC #${rpcFleet.length + 1}`;
            const isPrimary = typeof item === 'object' ? (item.role === 'primary' || !!item.isPrimary) : false;
            if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('ws://') || url.startsWith('wss://'))) {
              const cleanUrl = url.replace(/\/$/, '');
              const exists = rpcFleet.some(r => r.url.toLowerCase().replace(/\/$/, '') === cleanUrl.toLowerCase());
              if (!exists) {
                rpcFleet.push({
                  id: 'rpc-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
                  name: name,
                  url: url,
                  isPrimary: isPrimary,
                  pingMs: 100,
                  statusStr: '100ms',
                  status: 'online'
                });
                addedCount++;
              }
            }
          });

          if (!rpcFleet.some(r => r.isPrimary) && rpcFleet.length > 0) {
            rpcFleet[0].isPrimary = true;
          }

          persistState();
          renderRpcFleet();
          playBeep(950, 'sine', 0.15);
          logConsole(`🎉 Successfully imported ${addedCount} Custom RPC Endpoints (AeroMint compatible).`);
          showToast(`🎉 Imported ${addedCount} Custom RPCs successfully!`);
          pingAllFleet();
        } catch(err) {
          showToast(`Failed to parse RPC file: ${err.message}`, true);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    // ─── MASTER TREASURY DIRECT KEY LOADER (AEROMINT V3) ──────────────────────
    function toggleMasterKeyInput() {
      const c = document.getElementById('master-key-input-container');
      if (c) {
        c.classList.toggle('hidden');
        if (!c.classList.contains('hidden')) {
          document.getElementById('input-direct-master-key').focus();
        }
      }
    }

    function loadDirectMasterKey() {
      const val = document.getElementById('input-direct-master-key').value.trim();
      if (!val) {
        showToast('Please paste a valid Master Private Key!', true);
        return;
      }
      let cleanKey = val;
      if (cleanKey.includes('PrivateKey:')) cleanKey = cleanKey.split('PrivateKey:')[1].trim();
      if (cleanKey.includes('0x')) {
        const m = cleanKey.match(/0x[a-fA-F0-9]{64}/);
        if (m) cleanKey = m[0];
      } else if (/^[a-fA-F0-9]{64}$/.test(cleanKey)) {
        cleanKey = '0x' + cleanKey;
      }

      try {
        const w = new ethers.Wallet(cleanKey);
        let existingIdx = walletFleet.findIndex(wf => wf.address.toLowerCase() === w.address.toLowerCase());
        if (existingIdx !== -1) {
          masterWalletIndex = existingIdx;
          walletFleet[existingIdx].privateKey = cleanKey;
        } else {
          walletFleet.unshift({
            id: 'w-master-' + Date.now(),
            name: '👑 Master Treasury',
            address: w.address,
            privateKey: cleanKey,
            balanceEth: 0,
            balanceUsd: 0,
            selected: false,
            status: 'READY'
          });
          masterWalletIndex = 0;
        }
        document.getElementById('input-direct-master-key').value = '';
        toggleMasterKeyInput();
        persistState();
        renderWalletFleetUI();
        refreshAllBalances();
        playBeep(950, 'sine', 0.15);
        logConsole(`👑 [MASTER SET] ${w.address.slice(0, 6)}...${w.address.slice(-4)} loaded as Master Treasury Vault.`);
        showToast(`Master Treasury Vault Loaded! (${w.address.slice(0, 6)}...)`);
      } catch(err) {
        showToast('Invalid Private Key format!', true);
      }
    }

    // ─── 1-CLICK EXACT SNIPER COST FLEET FUNDING (AEROMINT V3) ────────────────
    async function fundWorkersExactSniperCost() {
      if (masterWalletIndex === null || !walletFleet[masterWalletIndex]) {
        showToast('Please designate a Master Treasury Wallet first!', true);
        return;
      }
      const workers = walletFleet.filter((w, i) => i !== masterWalletIndex && w.selected);
      if (workers.length === 0) {
        showToast('No sniper worker sub-wallets selected!', true);
        return;
      }

      let targetEth = 0.035;
      const paramFloor = parseFloat(document.getElementById('param-floor-eth')?.value);
      const paramRare = parseFloat(document.getElementById('param-rare-eth')?.value);
      if (paramFloor && paramFloor > 0) targetEth = paramFloor;
      else if (paramRare && paramRare > 0) targetEth = paramRare;

      // Add 0.0008 ETH gas buffer per snipe
      const exactCostPerWorker = targetEth + 0.0008;
      const exactCostStr = exactCostPerWorker.toFixed(6);

      document.getElementById('input-fund-amount').value = exactCostStr;
      handleFundEthInput(exactCostStr);

      playBeep(880, 'sine', 0.08);
      logConsole(`🎯 [EXACT COST CALCULATED] Set ${exactCostStr} ETH per worker (Target Price: ${targetEth} ETH + 0.0008 ETH gas buffer).`);
      showToast(`Set funding: ${exactCostStr} ETH per worker`);

      const ok = await showCustomConfirm(`Fund all ${workers.length} selected workers with exact sniper cost (${exactCostStr} ETH each)? Total: ${(exactCostPerWorker * workers.length).toFixed(6)} ETH.`, 'Fund Worker Fleet', { isDanger: false, confirmText: 'Fund Workers' });
      if (ok) {
        executeFundWorkers();
      }
    }

    // ─── SWEEP SINGLE WORKER TO MASTER (AEROMINT V3) ──────────────────────────
    async function sweepSingleWorker(index) {
      if (masterWalletIndex === null || !walletFleet[masterWalletIndex]) {
        showToast('Please designate a Master Treasury Wallet first!', true);
        return;
      }
      const master = walletFleet[masterWalletIndex];
      const worker = walletFleet[index];
      if (!worker || !worker.privateKey) return;

      const masterAddr = sanitizeAddress(master.address);
      const workerAddr = sanitizeAddress(worker.address);
      const workerPk = sanitizePrivateKey(worker.privateKey);

      playBeep(880, 'sine', 0.1);
      logConsole(`🧹 Sweeping single worker [${worker.name}] (${workerAddr.slice(0, 6)}...) ➔ Master Treasury...`);
      showToast(`Sweeping ${worker.name} ➔ Master...`);

      try {
        const provider = getEthersProvider();
        const feeData = await getSafeFeeData();
        const gasPrice = feeData.gasPrice;
        const gasLimit = 25000n;
        const exactGasCost = gasLimit * gasPrice;

        const balWei = await provider.getBalance(workerAddr);
        if (balWei <= exactGasCost) {
          showToast(`Balance (${ethers.formatEther(balWei)} ETH) is below network gas fee!`, true);
          return;
        }

        const sweepValue = balWei - exactGasCost;
        const workerSigner = new ethers.Wallet(workerPk, provider);
        const tx = await workerSigner.sendTransaction({
          to: masterAddr,
          value: sweepValue,
          gasLimit: gasLimit,
          gasPrice: gasPrice,
          type: 0
        });

        logConsole(`✔ SWEEP BROADCAST: [${worker.name}] TxHash: ${tx.hash.slice(0, 14)}...`);
        showToast(`Swept ${ethers.formatEther(sweepValue)} ETH from ${worker.name}!`);

        worker.balanceEth = 0;
        worker.balanceWei = '0';
        worker.balanceUsd = 0;
        worker.status = 'UNFUNDED';
        renderWalletFleetUI();
        persistState();

        tx.wait(1).then(() => {
          logConsole(`🎉 CONFIRMED: [${worker.name}] swept cleanly to Master (0 Dust)!`);
          playBeep(980, 'sine', 0.15);
          showToast(`🎉 ${worker.name} swept cleanly!`);
          refreshAllBalances();
        }).catch(() => {});
      } catch(err) {
        showToast(`Sweep failed: ${err.message}`, true);
      }
    }

    // ─── MULTI-FORMAT WALLET EXPORTERS (JSON / CSV / TXT) ─────────────────────
    function exportJsonBackup() {
      if (walletFleet.length === 0) {
        showToast('No wallets to export!', true);
        return;
      }
      const master = (masterWalletIndex !== null && walletFleet[masterWalletIndex]) ? walletFleet[masterWalletIndex] : null;
      const backupData = {
        app: 'AeroMint Premium',
        version: '3.0',
        type: 'WALLET_FLEET_BACKUP',
        network: 'robinhood',
        timestamp: new Date().toISOString(),
        masterWallet: master ? master.address : null,
        activeWallets: walletFleet.map((w, i) => ({
          index: i + 1,
          name: w.name,
          address: w.address,
          privateKey: w.privateKey,
          balance: w.balanceEth ? String(w.balanceEth) : '0.00000',
          isMaster: (i === masterWalletIndex)
        })),
        wallets: walletFleet.map((w, i) => ({
          name: w.name,
          address: w.address,
          privateKey: w.privateKey,
          isMaster: (i === masterWalletIndex)
        }))
      };
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
      const dl = document.createElement('a');
      dl.setAttribute("href", dataStr);
      dl.setAttribute("download", `aeromint_wallets_backup_${walletFleet.length}wallets_${Date.now()}.json`);
      document.body.appendChild(dl);
      dl.click();
      dl.remove();
      playBeep(920, 'sine', 0.08);
      logConsole(`✔ Exported ${walletFleet.length} wallets in AeroMint V3 JSON format.`);
      showToast(`Exported ${walletFleet.length} wallets to AeroMint JSON!`);
    }

    function exportCsvBackup() {
      if (walletFleet.length === 0) {
        showToast('No wallets to export!', true);
        return;
      }
      let csv = 'Index,Role,Name,Address,PrivateKey\n';
      walletFleet.forEach((w, i) => {
        const role = (i === masterWalletIndex) ? 'MASTER' : 'WORKER';
        csv += `${i + 1},${role},"${w.name}","${w.address}","${w.privateKey}"\n`;
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const dl = document.createElement('a');
      dl.href = URL.createObjectURL(blob);
      dl.download = `sniper_wallets_${Date.now()}.csv`;
      document.body.appendChild(dl);
      dl.click();
      dl.remove();
      playBeep(920, 'sine', 0.08);
      showToast(`Exported ${walletFleet.length} wallets to .csv!`);
    }

    async function executeFundWorkers() {
      if (masterWalletIndex === null || !walletFleet[masterWalletIndex]) {
        showToast('Please designate a Master Treasury Wallet first!', true);
        return;
      }

      const master = walletFleet[masterWalletIndex];
      const masterAddr = sanitizeAddress(master.address);
      const masterPk = sanitizePrivateKey(master.privateKey);
      const targetWorkers = walletFleet.filter((w, i) => i !== masterWalletIndex && w.selected);
      
      if (targetWorkers.length === 0) {
        showToast('No sniper worker wallets selected for funding!', true);
        return;
      }

      const amountEthStr = document.getElementById('input-fund-amount').value.trim();
      const amountEth = parseFloat(amountEthStr) || 0;
      if (amountEth <= 0) {
        showToast('Please enter a valid ETH amount to fund!', true);
        return;
      }

      playBeep(920, 'sine', 0.2);
      logConsole(`⚡ [MASTER FUND] Treasury (${masterAddr.slice(0, 6)}...${masterAddr.slice(-4)}) funding ${targetWorkers.length} workers with ${amountEthStr} ETH each...`);
      showToast(`Funding ${targetWorkers.length} workers on-chain...`);

      const btnFund = document.getElementById('btn-fund-workers');
      if (btnFund) {
        btnFund.innerHTML = `<i class="fa-solid fa-paper-plane fa-bounce text-white"></i> Funding Workers...`;
      }

      try {
        const provider = getEthersProvider();
        const feeData = await getSafeFeeData();
        const gasPrice = feeData.gasPrice;
        const txGasLimit = 30000n;
        const gasCostPerTx = txGasLimit * gasPrice;

        const masterBalWei = await provider.getBalance(masterAddr);
        let sendAmountWei = ethers.parseEther(amountEthStr);
        const totalNeededWei = (sendAmountWei + gasCostPerTx) * BigInt(targetWorkers.length);

        if (masterBalWei < totalNeededWei) {
          const availableForFunding = masterBalWei > (gasCostPerTx * BigInt(targetWorkers.length)) 
            ? masterBalWei - (gasCostPerTx * BigInt(targetWorkers.length))
            : 0n;

          if (availableForFunding > 0n) {
            const adjustedPerWorkerWei = availableForFunding / BigInt(targetWorkers.length);
            if (adjustedPerWorkerWei > 0n) {
              sendAmountWei = adjustedPerWorkerWei;
              logConsole(`  ⚡ Auto-adjusted funding amount to ${ethers.formatEther(sendAmountWei)} ETH per worker (Master has ${ethers.formatEther(masterBalWei)} ETH).`);
            } else {
              throw new Error(`Master balance too low to cover transaction gas (${ethers.formatEther(gasCostPerTx * BigInt(targetWorkers.length))} ETH required).`);
            }
          } else {
            const availEth = ethers.formatEther(masterBalWei);
            const needEth = ethers.formatEther(totalNeededWei);
            logConsole(`❌ [INSUFFICIENT BALANCE] Master (${masterAddr.slice(0, 6)}...) has ${availEth} ETH | Required: ${needEth} ETH.`);
            showToast(`Master insufficient: ${availEth} ETH available (Needs ${needEth} ETH)`, true);
            if (btnFund) btnFund.innerHTML = `<i class="fa-solid fa-paper-plane text-[10px]"></i> Send to Selected (<span id="fund-target-count">${targetWorkers.length}</span>) Workers`;
            return;
          }
        }

        const masterSigner = new ethers.Wallet(masterPk, provider);
        let fundedCount = 0;

        // Check if Multicall3 is available on this chain for 1-transaction batch funding
        let usedMulticall3 = false;
        if (targetWorkers.length > 1) {
          try {
            const code = await provider.getCode(MULTICALL3_ADDRESS);
            if (code && code !== '0x' && code.length > 10) {
              const totalBatchValue = sendAmountWei * BigInt(targetWorkers.length);
              logConsole(`⚡ [ATOMIC MULTICALL3] Firing 1-Transaction Batch Funding to ${targetWorkers.length} workers...`);
              
              const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, masterSigner);
              const calls = targetWorkers.map(w => ({
                target: sanitizeAddress(w.address),
                allowFailure: false,
                value: sendAmountWei,
                callData: '0x'
              }));

              const tx = await multicall.aggregate3Value(calls, {
                value: totalBatchValue,
                gasPrice: gasPrice
              });

              logConsole(`✔ MULTICALL3 BROADCAST: TxHash: ${tx.hash.slice(0, 14)}... (1 Atomic TX)`);
              fundedCount = targetWorkers.length;
              usedMulticall3 = true;

              // Optimistic instant UI update
              try {
                const addedEth = parseFloat(ethers.formatEther(sendAmountWei));
                targetWorkers.forEach(worker => {
                  worker.balanceEth = (worker.balanceEth || 0) + addedEth;
                  worker.balanceWei = (BigInt(worker.balanceWei || '0') + sendAmountWei).toString();
                  worker.balanceUsd = worker.balanceEth * currentLiveEthPrice;
                  worker.status = 'READY';
                });
                master.balanceEth = Math.max(0, (master.balanceEth || 0) - (addedEth * targetWorkers.length));
                master.balanceUsd = master.balanceEth * currentLiveEthPrice;
                renderWalletFleetUI();
                persistState();
              } catch(e) {}

              tx.wait(1).then(() => {
                logConsole(`🎉 [ATOMIC CONFIRMED] All ${targetWorkers.length} workers funded in 1 block!`);
                refreshAllBalances();
              }).catch(() => {});
            }
          } catch(mErr) {
            logConsole(`ℹ Multicall3 fallback to sequential: ${mErr.message}`);
            usedMulticall3 = false;
          }
        }

        // Sequential fallback if not multicall3 or single worker
        if (!usedMulticall3) {
          let nonce = await provider.getTransactionCount(masterAddr, 'latest');
          for (const worker of targetWorkers) {
            try {
              const targetAddr = sanitizeAddress(worker.address);
              logConsole(`  ➔ Broadcasting ${ethers.formatEther(sendAmountWei)} ETH ➔ [${worker.name}] (${targetAddr.slice(0, 6)}...)...`);
              const tx = await masterSigner.sendTransaction({
                to: targetAddr,
                value: sendAmountWei,
                gasLimit: txGasLimit,
                gasPrice: gasPrice,
                type: 0,
                nonce: nonce++
              });
              logConsole(`  ✔ TX BROADCAST: [${worker.name}] TxHash: ${tx.hash.slice(0, 14)}...`);
              fundedCount++;

              // Optimistic instant UI update
              try {
                const addedEth = parseFloat(ethers.formatEther(sendAmountWei));
                worker.balanceEth = (worker.balanceEth || 0) + addedEth;
                worker.balanceWei = (BigInt(worker.balanceWei || '0') + sendAmountWei).toString();
                worker.balanceUsd = worker.balanceEth * currentLiveEthPrice;
                worker.status = 'READY';
                master.balanceEth = Math.max(0, (master.balanceEth || 0) - addedEth);
                master.balanceUsd = master.balanceEth * currentLiveEthPrice;
                renderWalletFleetUI();
                persistState();
              } catch(e) {}

              tx.wait(1).then(() => {
                logConsole(`  🎉 CONFIRMED: ${ethers.formatEther(sendAmountWei)} ETH arrived in [${worker.name}]!`);
                refreshAllBalances();
              }).catch(() => {});
            } catch (txErr) {
              logConsole(`  ⚠ Transfer to ${worker.name} failed: ${txErr.message}`);
            }
          }
        }

        playBeep(950, 'sine', 0.15);
        showToast(`Dispatched funding for ${fundedCount}/${targetWorkers.length} workers!`);
        if (btnFund) {
          btnFund.innerHTML = `<i class="fa-solid fa-circle-check text-white"></i> ✔ Dispatched (${fundedCount} Workers)!`;
          setTimeout(() => {
            btnFund.innerHTML = `<i class="fa-solid fa-paper-plane text-[10px]"></i> Send to Selected (<span id="fund-target-count">${targetWorkers.length}</span>) Workers`;
          }, 2000);
        }
        setTimeout(refreshAllBalances, 1200);

      } catch (err) {
        logConsole(`❌ Master Funding error: ${err.message}`);
        showToast(`Funding failed: ${err.message}`, true);
        if (btnFund) btnFund.innerHTML = `<i class="fa-solid fa-paper-plane text-[10px]"></i> Send to Selected (<span id="fund-target-count">${targetWorkers.length}</span>) Workers`;
      }
    }
    window.executeFundWorkers = executeFundWorkers;
    window.fundWorkerFleet = executeFundWorkers;

    async function executeSweepToMaster() {
      const ok = await showCustomConfirm('Are you sure you want to sweep 100% of remaining ETH from ALL worker wallets back into the Master Treasury?', 'Sweep Worker Funds', { isDanger: false, confirmText: 'Sweep ETH' });
      if (!ok) return;
      if (masterWalletIndex === null || !walletFleet[masterWalletIndex]) {
        showToast('Please designate a Master Treasury Wallet first!', true);
        return;
      }

      const master = walletFleet[masterWalletIndex];
      const masterAddr = sanitizeAddress(master.address);
      const workers = walletFleet.filter((w, i) => i !== masterWalletIndex);

      if (workers.length === 0) {
        showToast('No worker wallets available to sweep!', true);
        return;
      }

      playBeep(880, 'sine', 0.2);
      logConsole(`🧹 [100% ZERO-DUST SWEEP] Scanning real-time Robinhood Chain L2 gas & sweeping all workers ➔ Master Treasury (${masterAddr.slice(0, 6)}...${masterAddr.slice(-4)})...`);
      showToast('Sweeping 100% of worker funds (Zero Dust) to Master...');

      const btnSweep = document.getElementById('btn-sweep-master');
      if (btnSweep) {
        btnSweep.innerHTML = `<i class="fa-solid fa-broom fa-bounce text-amber-400"></i> Sweeping Workers ➔ Master...`;
      }

      try {
        const provider = getEthersProvider();
        const feeData = await getSafeFeeData();
        const gasPrice = feeData.gasPrice;
        const exactTransferGasLimit = 25000n;
        const exactGasCost = exactTransferGasLimit * gasPrice;

        logConsole(`⚡ [LIVE GAS SCANNED] Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} Gwei | Tx Gas: 25,000 Units (${ethers.formatEther(exactGasCost)} ETH)`);

        let sweptCount = 0;
        let totalSweptWei = 0n;

        // Process workers in concurrent batches of 4 for maximum speed
        const BATCH_SIZE = 4;
        for (let i = 0; i < workers.length; i += BATCH_SIZE) {
          const batch = workers.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (worker) => {
            if (!worker.privateKey) return;
            const workerAddr = sanitizeAddress(worker.address);
            const workerPk = sanitizePrivateKey(worker.privateKey);

            try {
              const balWei = await provider.getBalance(workerAddr);
              if (balWei === 0n) {
                worker.balanceEth = 0;
                worker.balanceWei = '0';
                worker.balanceUsd = 0;
                worker.status = 'UNFUNDED';
                renderWalletFleetUI();
                logConsole(`  ℹ [${worker.name}] (${workerAddr.slice(0, 6)}...) is already at 0.000000 ETH.`);
                return;
              }

              if (balWei > exactGasCost) {
                const sweepValue = balWei - exactGasCost;
                const sendEthStr = ethers.formatEther(sweepValue);

                logConsole(`  ➔ Sweeping ${sendEthStr} ETH from [${worker.name}] ➔ Master (Leaves EXACT 0.00000000 ETH)...`);

                const workerSigner = new ethers.Wallet(workerPk, provider);
                const tx = await workerSigner.sendTransaction({
                  to: masterAddr,
                  value: sweepValue,
                  gasLimit: exactTransferGasLimit,
                  gasPrice: gasPrice,
                  type: 0
                });

                logConsole(`  ✔ SWEEP BROADCAST: [${worker.name}] TxHash: ${tx.hash.slice(0, 14)}...`);
                sweptCount++;
                totalSweptWei += sweepValue;

                // Optimistic instant UI update
                const sweptEthNum = parseFloat(sendEthStr);
                worker.balanceEth = 0;
                worker.balanceWei = '0';
                worker.balanceUsd = 0;
                worker.status = 'UNFUNDED';
                master.balanceEth = (master.balanceEth || 0) + sweptEthNum;
                master.balanceUsd = master.balanceEth * currentLiveEthPrice;
                renderWalletFleetUI();
                persistState();

                tx.wait(1).then(() => {
                  logConsole(`  🎉 CONFIRMED: [${worker.name}] swept cleanly! Remaining balance is now EXACT 0.000000 ETH.`);
                  refreshAllBalances();
                }).catch(() => {});
              } else {
                const balEthStr = ethers.formatEther(balWei);
                logConsole(`  ℹ [${worker.name}] Balance (${balEthStr} ETH) is lower than tx gas fee (${ethers.formatEther(exactGasCost)} ETH).`);
              }
            } catch (wErr) {
              logConsole(`  ⚠ Sweep from ${worker.name} failed: ${wErr.message}`);
            }
          }));
        }

        if (sweptCount > 0) {
          playBeep(950, 'sine', 0.15);
          const totalSweptEth = ethers.formatEther(totalSweptWei);
          logConsole(`🎉 ZERO-DUST SWEEP COMPLETE: Swept total ${totalSweptEth} ETH from ${sweptCount} workers ➔ Master! Workers zeroed out.`);
          showToast(`Swept ${totalSweptEth} ETH to Master! (0 Dust)`, false);
          if (btnSweep) {
            btnSweep.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-400"></i> <span class="text-emerald-300">🎉 Swept Cleanly! (0 Dust)</span>`;
            setTimeout(() => {
              btnSweep.innerHTML = `<i class="fa-solid fa-broom text-amber-400"></i> Sweep All Worker ETH ➔ Master Treasury`;
            }, 2000);
          }
          setTimeout(refreshAllBalances, 1200);
        } else {
          showToast('All worker wallets are currently at 0.000000 ETH (Empty).', true);
          if (btnSweep) {
            btnSweep.innerHTML = `<i class="fa-solid fa-broom text-amber-400"></i> Sweep All Worker ETH ➔ Master Treasury`;
          }
        }

      } catch (err) {
        logConsole(`❌ Sweep error: ${err.message}`);
        showToast(`Sweep failed: ${err.message}`, true);
        if (btnSweep) {
          btnSweep.innerHTML = `<i class="fa-solid fa-broom text-amber-400"></i> Sweep All Worker ETH ➔ Master Treasury`;
        }
      }
    }

    async function executeSweepAllNftsToVault(nftContractAddress = null) {
      if (masterWalletIndex === null || !walletFleet[masterWalletIndex]) {
        showToast('Please designate a Master Vault Wallet first!', true);
        return;
      }
      const vaultDestination = sanitizeAddress(walletFleet[masterWalletIndex].address);
      const workers = walletFleet.filter((w, i) => i !== masterWalletIndex);
      const contractAddr = nftContractAddress || activeCollectionContract;

      if (!contractAddr || !contractAddr.startsWith('0x') || contractAddr.length !== 42) {
        showToast('Please enter or select a valid NFT Contract address!', true);
        return;
      }

      logConsole(`🖼 [NFT SWEEPER] Checking ${workers.length} workers for NFTs from contract ${contractAddr.slice(0, 8)}... ➔ Vault (${vaultDestination.slice(0, 6)}...)`);
      showToast('Scanning and sweeping worker NFTs to Vault...');

      const provider = getEthersProvider();
      let sweptNfts = 0;

      for (const w of workers) {
        if (!w.privateKey) continue;
        const workerAddr = sanitizeAddress(w.address);
        try {
          const signer = new ethers.Wallet(sanitizePrivateKey(w.privateKey), provider);
          const nftContract = new ethers.Contract(contractAddr, ERC721_SWEEP_ABI, signer);
          const balance = await nftContract.balanceOf(workerAddr);
          const count = Number(balance);

          if (count > 0) {
            logConsole(`  Found ${count} NFT(s) in [${w.name}]. Sweeping to Vault...`);
            for (let i = 0; i < count; i++) {
              try {
                let tokenId = null;
                try {
                  tokenId = await nftContract.tokenOfOwnerByIndex(workerAddr, 0);
                } catch(e) {
                  // If not enumerable, skip to next
                }

                if (tokenId !== null) {
                  const tx = await nftContract.safeTransferFrom(workerAddr, vaultDestination, tokenId);
                  logConsole(`  ✔ Swept NFT #${tokenId} from [${w.name}] ➔ Vault (TX: ${tx.hash.slice(0, 14)}...)`);
                  sweptNfts++;
                  await tx.wait(1);
                }
              } catch(tErr) {
                logConsole(`  ⚠ NFT transfer failed for ${w.name}: ${tErr.message}`);
              }
            }
          }
        } catch(err) {
          // Token query skip
        }
      }

      if (sweptNfts > 0) {
        logConsole(`🎉 Swept total ${sweptNfts} NFT(s) from worker fleet to Master Vault!`);
        showToast(`Swept ${sweptNfts} NFT(s) to Master Vault!`);
      } else {
        showToast('No NFTs found in worker wallets to sweep.');
      }
    }

    let isRefreshingBalances = false;

    async function refreshAllBalances(manualClick = false) {
      if (!currentUser || !sessionToken) return;
      if (isRefreshingBalances && !manualClick) return;
      const btn = document.getElementById('btn-refresh-balances');
      if (manualClick && btn) {
        btn.innerHTML = `<i class="fa-solid fa-arrows-rotate fa-spin text-indigo-600"></i> Refreshing...`;
        playBeep(850, 'sine', 0.08);
      }
      if (walletFleet.length === 0) {
        if (manualClick && btn) {
          setTimeout(() => {
            btn.innerHTML = `<i class="fa-solid fa-rotate text-indigo-600"></i> Refresh`;
          }, 600);
        }
        return;
      }
      isRefreshingBalances = true;
      try {
        await Promise.all(walletFleet.map(async (w) => {
          try {
            const balWei = await getSafeBalance(w.address);
            const ethStr = ethers.formatEther(balWei);
            const ethNum = parseFloat(ethStr);
            w.balanceWei = balWei.toString();
            w.balanceEth = ethNum;
            w.balanceEthStr = ethStr;
            w.balanceUsd = (ethNum * currentLiveEthPrice);
            w.status = balWei > 0n ? 'READY' : 'UNFUNDED';
          } catch(e) {}
        }));

        persistState();
        renderWalletFleetUI();

        if (manualClick && btn) {
          btn.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-600"></i> <span class="text-emerald-700 font-black">Refreshed!</span>`;
          showToast('✔ Balances refreshed on-chain!');
          setTimeout(() => {
            btn.innerHTML = `<i class="fa-solid fa-rotate text-indigo-600"></i> Refresh`;
          }, 1200);
        }
      } catch(e) {
        if (manualClick && btn) {
          btn.innerHTML = `<i class="fa-solid fa-rotate text-indigo-600"></i> Refresh`;
        }
      } finally {
        isRefreshingBalances = false;
      }
    }
    setInterval(refreshAllBalances, 4000);

    function renderWalletFleetUI() {
      const tbody = document.getElementById('wallet-fleet-tbody');
      const selectMasterEl = document.getElementById('select-master-wallet');
      const totalCountEl = document.getElementById('fleet-total-count');
      const tabCountEl = document.getElementById('tab-wallet-count');

      if (totalCountEl) totalCountEl.innerText = walletFleet.length;
      if (tabCountEl) tabCountEl.innerText = walletFleet.length;

      // Update Master Select dropdown
      if (selectMasterEl) {
        selectMasterEl.innerHTML = '<option value="">-- No Master Wallet Assigned --</option>';
        walletFleet.forEach((w, i) => {
          const opt = document.createElement('option');
          opt.value = i;
          opt.innerText = `${w.name} (${w.address.slice(0, 6)}...${w.address.slice(-4)}) - ${formatEthDynamic(w.balanceEth)}`;
          if (i === masterWalletIndex) opt.selected = true;
          selectMasterEl.appendChild(opt);
        });
      }

      // Update Treasury Card
      const tEth = document.getElementById('treasury-eth-bal');
      const tUsd = document.getElementById('treasury-usd-bal');
      const dStatus = document.getElementById('dash-master-status');
      const dAddr = document.getElementById('dash-master-address');
      const dBal = document.getElementById('dash-master-bal');

      if (masterWalletIndex !== null && walletFleet[masterWalletIndex]) {
        const master = walletFleet[masterWalletIndex];
        if (tEth) tEth.innerText = formatEthDynamic(master.balanceEth);
        if (tUsd) tUsd.innerText = `~${formatUsdDynamic(master.balanceUsd)} USD`;
        if (dStatus) {
          dStatus.innerText = 'ACTIVE';
          dStatus.className = 'text-[8px] font-black uppercase px-1.5 py-0.2 rounded bg-amber-200 text-amber-900';
        }
        if (dAddr) dAddr.innerText = `${master.address.slice(0, 6)}...${master.address.slice(-4)}`;
        if (dBal) dBal.innerText = `${formatEthDynamic(master.balanceEth)} (${formatUsdDynamic(master.balanceUsd)})`;
      } else {
        if (tEth) tEth.innerText = '0.000000 ETH';
        if (tUsd) tUsd.innerText = '~$0.00 USD';
        if (dStatus) {
          dStatus.innerText = 'NOT SET';
          dStatus.className = 'text-[8px] font-black uppercase px-1.5 py-0.2 rounded bg-slate-200 text-slate-600';
        }
        if (dAddr) dAddr.innerText = 'No Master Selected';
        if (dBal) dBal.innerText = '0.000000 ETH ($0.00)';
      }

      // Update Dashboard Worker Summary
      const workers = walletFleet.filter((w, i) => i !== masterWalletIndex);
      const activeWorkers = workers.filter(w => w.selected);
      const totalWorkerEth = workers.reduce((acc, w) => acc + (w.balanceEth || 0), 0);
      const totalWorkerUsd = workers.reduce((acc, w) => acc + (w.balanceUsd || 0), 0);

      const dCount = document.getElementById('dash-worker-count');
      const dFleetEth = document.getElementById('dash-fleet-total-eth');
      const dFleetUsd = document.getElementById('dash-fleet-total-usd');

      if (dCount) dCount.innerText = `${activeWorkers.length} ACTIVE`;
      if (dFleetEth) dFleetEth.innerText = formatEthDynamic(totalWorkerEth);
      if (dFleetUsd) dFleetUsd.innerText = `Total Fleet: ~${formatUsdDynamic(totalWorkerUsd)} USD`;

      updateSelectedWorkerCount();

      // Render Table Rows
      if (walletFleet.length === 0) {
        tbody.innerHTML = `
          <tr id="empty-fleet-placeholder">
            <td colspan="7" class="py-16 text-center text-slate-400 font-mono-code text-xs">
              <div class="flex flex-col items-center justify-center space-y-2">
                <div class="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center text-lg">
                  <i class="fa-solid fa-wallet"></i>
                </div>
                <p class="font-bold text-slate-700 text-xs">No wallets added yet</p>
                <p class="text-[11px] text-slate-400 max-w-xs">Use the Auto Wallet Generator on the left or paste your private keys to get started.</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = '';
      walletFleet.forEach((w, i) => {
        const isMaster = (i === masterWalletIndex);
        const tr = document.createElement('tr');
        tr.className = `hover:bg-slate-50 transition-colors ${isMaster ? 'bg-amber-50/40 font-bold' : ''}`;

        const roleBadge = isMaster 
          ? '<span class="px-2 py-0.5 rounded-lg bg-amber-200 text-amber-900 border border-amber-300 font-black text-[10px]">👑 MASTER</span>'
          : '<span class="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-bold text-[10px]">🎯 WORKER</span>';

        const statusBadge = isMaster
          ? '<span class="text-amber-800 text-[10px] font-black">● VAULT</span>'
          : w.status === 'READY'
          ? '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">● READY</span>'
          : '<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-normal text-[10px]">UNFUNDED</span>';

        tr.innerHTML = `
          <td class="py-2.5 px-2.5 whitespace-nowrap">
            <input type="checkbox" ${w.selected && !isMaster ? 'checked' : ''} ${isMaster ? 'disabled' : ''} onchange="toggleWalletSelection(${i}, this.checked)" class="w-3.5 h-3.5 text-indigo-600 rounded cursor-pointer">
          </td>
          <td class="py-2.5 px-2 font-black text-slate-900 text-xs whitespace-nowrap">
            ${w.name}
          </td>
          <td class="py-2.5 px-2 whitespace-nowrap">
            <div class="flex items-center gap-1.5">
              <span class="text-slate-700 font-mono-code">${w.address.slice(0, 6)}...${w.address.slice(-4)}</span>
              <i class="fa-regular fa-copy text-slate-400 hover:text-slate-800 cursor-pointer text-xs" title="Copy Address" onclick="copyAddress('${w.address}')"></i>
            </div>
          </td>
          <td class="py-2.5 px-2 whitespace-nowrap">
            <span class="font-black ${w.balanceEth > 0 ? 'text-emerald-700' : 'text-slate-500'} text-xs">${formatEthDynamic(w.balanceEth)}</span>
            <span class="text-[10px] text-slate-400 block">${formatUsdDynamic(w.balanceUsd)}</span>
          </td>
          <td class="py-2.5 px-2 whitespace-nowrap">
            ${roleBadge}
          </td>
          <td class="py-2.5 px-2 whitespace-nowrap">
            ${statusBadge}
          </td>
          <td class="py-2.5 px-2 text-right whitespace-nowrap">
            <div class="flex items-center justify-end gap-1 whitespace-nowrap">
              <button onclick="openSendEthModal(${i})" class="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-bold text-[10px] rounded-lg border border-emerald-200 transition-colors flex items-center gap-1 shrink-0" title="Send ETH to any address">
                <i class="fa-solid fa-paper-plane text-[9px] text-emerald-600"></i> Send
              </button>
              ${!isMaster ? `<button onclick="sweepSingleWorker(${i})" class="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold text-[10px] rounded-lg border border-amber-200 transition-colors flex items-center gap-1 shrink-0" title="Sweep this worker to Master"><i class="fa-solid fa-broom text-[9px] text-amber-600"></i> Sweep</button>` : ''}
              ${!isMaster ? `<button onclick="setMasterWallet(${i})" class="px-2 py-1 bg-purple-50 hover:bg-purple-100 text-purple-900 font-bold text-[10px] rounded-lg border border-purple-200 transition-colors flex items-center gap-1 shrink-0" title="Set as Master Treasury"><i class="fa-solid fa-crown text-[9px] text-purple-600"></i> Master</button>` : ''}
              <button onclick="openWalletKeyModal(${i})" class="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[10px] rounded-lg border border-slate-200 transition-colors flex items-center gap-1 shrink-0" title="View Key / Rename"><i class="fa-solid fa-gear text-[10px]"></i></button>
              <button onclick="deleteWallet(${i})" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-[10px] rounded-lg border border-rose-200 transition-colors flex items-center gap-1 shrink-0" title="Delete Wallet"><i class="fa-regular fa-trash-can text-[10px]"></i></button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    function copyAddress(addr) {
      navigator.clipboard.writeText(addr);
      showToast('Address copied to clipboard!');
    }

    function openWalletKeyModal(index) {
      activeModalWalletIndex = index;
      const w = walletFleet[index];
      if (!w) return;

      document.getElementById('modal-wallet-title').innerText = `${w.name} Credentials`;
      document.getElementById('modal-wallet-name').value = w.name;
      document.getElementById('modal-wallet-address').value = w.address;
      document.getElementById('modal-wallet-key').value = w.privateKey;
      document.getElementById('modal-wallet-key').type = 'password';
      document.getElementById('modal-eye-icon').className = 'fa-regular fa-eye';

      const modal = document.getElementById('wallet-modal');
      modal.classList.remove('hidden');
      setTimeout(() => modal.classList.remove('opacity-0'), 10);
      playBeep(700, 'sine', 0.05);
    }

    function closeWalletModal() {
      const modal = document.getElementById('wallet-modal');
      modal.classList.add('opacity-0');
      setTimeout(() => modal.classList.add('hidden'), 200);
      activeModalWalletIndex = null;
    }

    function toggleModalKeyVisibility() {
      const input = document.getElementById('modal-wallet-key');
      const icon = document.getElementById('modal-eye-icon');
      if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fa-regular fa-eye-slash';
      } else {
        input.type = 'password';
        icon.className = 'fa-regular fa-eye';
      }
    }

    function copyModalKey() {
      const input = document.getElementById('modal-wallet-key');
      navigator.clipboard.writeText(input.value);
      showToast('Private key copied to clipboard!');
    }

    function saveModalWalletName() {
      if (activeModalWalletIndex !== null && walletFleet[activeModalWalletIndex]) {
        const newName = document.getElementById('modal-wallet-name').value.trim();
        if (newName) {
          walletFleet[activeModalWalletIndex].name = newName;
          persistState();
          renderWalletFleetUI();
          showToast('Wallet label updated!');
        }
      }
      closeWalletModal();
    }

    // ================= DIRECT SEND ETH / TRANSFER HANDLERS =================
    let activeSendWalletIndex = null;

    function openSendEthModal(index) {
      activeSendWalletIndex = index;
      const w = walletFleet[index];
      if (!w) return;

      document.getElementById('modal-send-from-name').innerText = `${w.name} (${w.address.slice(0, 6)}...${w.address.slice(-4)})`;
      document.getElementById('modal-send-from-bal').innerText = formatEthDynamic(w.balanceEth);
      document.getElementById('modal-send-to-address').value = '';
      document.getElementById('modal-send-amount').value = '';
      document.getElementById('modal-send-usd').value = '';

      const sel = document.getElementById('modal-send-recipient-select');
      sel.innerHTML = '<option value="">-- Fleet Recipient --</option>';
      walletFleet.forEach((other, oi) => {
        if (oi !== index) {
          const isM = (oi === masterWalletIndex);
          const opt = document.createElement('option');
          opt.value = other.address;
          opt.innerText = `${isM ? '👑 [MASTER] ' : ''}${other.name} (${other.address.slice(0, 6)}...${other.address.slice(-4)}) - ${formatEthDynamic(other.balanceEth)}`;
          sel.appendChild(opt);
        }
      });

      const modal = document.getElementById('send-eth-modal');
      modal.classList.remove('hidden');
      setTimeout(() => modal.classList.remove('opacity-0'), 10);
      playBeep(700, 'sine', 0.05);
    }

    function closeSendEthModal() {
      const modal = document.getElementById('send-eth-modal');
      modal.classList.add('opacity-0');
      setTimeout(() => modal.classList.add('hidden'), 200);
      activeSendWalletIndex = null;
    }

    function handleSendRecipientSelect(addr) {
      if (addr) {
        document.getElementById('modal-send-to-address').value = addr;
      }
    }

    async function setSendMaxAmount() {
      if (activeSendWalletIndex === null || !walletFleet[activeSendWalletIndex]) return;
      const w = walletFleet[activeSendWalletIndex];
      try {
        const balWei = await getSafeBalance(w.address);
        const feeData = await getSafeFeeData();
        const gasPrice = feeData.gasPrice || 20200000n;
        const gasLimit = 25000n;
        const exactGasCost = gasLimit * gasPrice;

        if (balWei > exactGasCost) {
          const maxSendWei = balWei - exactGasCost;
          document.getElementById('modal-send-amount').value = ethers.formatEther(maxSendWei);
          handleModalSendEthInput(parseFloat(ethers.formatEther(maxSendWei)));
        } else {
          document.getElementById('modal-send-amount').value = '0';
          handleModalSendEthInput(0);
        }
      } catch(e) {
        const maxVal = Math.max(0, (w.balanceEth || 0) - 0.00000055);
        document.getElementById('modal-send-amount').value = maxVal < 0.0001 ? maxVal.toFixed(8) : maxVal.toFixed(6);
        handleModalSendEthInput(maxVal);
      }
    }

    async function executeDirectSendEth() {
      if (activeSendWalletIndex === null || !walletFleet[activeSendWalletIndex]) return;
      const sender = walletFleet[activeSendWalletIndex];
      const toAddr = document.getElementById('modal-send-to-address').value.trim();
      const amountStr = document.getElementById('modal-send-amount').value.trim();

      if (!toAddr || !toAddr.startsWith('0x') || toAddr.length !== 42) {
        showToast('Please enter a valid recipient address (0x...)!', true);
        return;
      }

      const amountEth = parseFloat(amountStr) || 0;
      if (amountEth <= 0) {
        showToast('Please enter a valid ETH amount!', true);
        return;
      }

      playBeep(900, 'sine', 0.1);
      logConsole(`📤 [DIRECT TRANSFER] Sending ${amountStr} ETH from [${sender.name}] ➔ ${toAddr}...`);
      showToast('Broadcasting transaction on-chain...');

      const btnSend = document.getElementById('btn-send-eth-modal');
      if (btnSend) btnSend.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-xs"></i> Broadcasting...`;

      try {
        const cleanSenderAddr = sanitizeAddress(sender.address);
        const cleanSenderPk = sanitizePrivateKey(sender.privateKey);
        const provider = getEthersProvider();
        const balWei = await provider.getBalance(cleanSenderAddr);
        const feeData = await getSafeFeeData();
        const gasPrice = feeData.gasPrice;
        const exactGasCost = 25000n * gasPrice;

        let sendValueWei = ethers.parseEther(amountStr);

        // If user is sending total balance (or slight rounding variance), auto-calculate exact max sendable
        if (sendValueWei + exactGasCost > balWei) {
          if (balWei > exactGasCost) {
            sendValueWei = balWei - exactGasCost;
            logConsole(`  ⚡ Auto-adjusted to max sendable amount: ${ethers.formatEther(sendValueWei)} ETH`);
          } else {
            throw new Error(`Insufficient funds for transfer gas (${ethers.formatEther(exactGasCost)} ETH required).`);
          }
        }

        const signer = new ethers.Wallet(cleanSenderPk, provider);
        const tx = await signer.sendTransaction({
          to: toAddr,
          value: sendValueWei,
          gasLimit: 30000n,
          gasPrice: gasPrice,
          type: 0
        });

        logConsole(`✔ TX BROADCAST: Hash ${tx.hash.slice(0, 14)}...`);
        showToast(`Sent ${ethers.formatEther(sendValueWei)} ETH successfully!`);
        closeSendEthModal();

        // Optimistic instant UI update
        const sentEthNum = parseFloat(ethers.formatEther(sendValueWei));
        sender.balanceEth = Math.max(0, (sender.balanceEth || 0) - sentEthNum);
        sender.balanceWei = (balWei > (sendValueWei + exactGasCost) ? balWei - (sendValueWei + exactGasCost) : 0n).toString();
        sender.balanceUsd = sender.balanceEth * currentLiveEthPrice;
        renderWalletFleetUI();
        persistState();

        tx.wait(1).then(() => {
          logConsole(`🎉 CONFIRMED: Transfer of ${ethers.formatEther(sendValueWei)} ETH successfully confirmed!`);
          refreshAllBalances();
        }).catch(() => {});

        setTimeout(refreshAllBalances, 1200);

      } catch(err) {
        if (btnSend) btnSend.innerHTML = `<i class="fa-solid fa-paper-plane text-xs"></i> Send ETH Now`;
        logConsole(`❌ Send failed: ${err.message}`);
        showToast(`Send failed: ${err.message}`, true);
      }
    }

    function switchTab(tabId) {
      const isOwnerAdmin = currentUser && (currentUser.role === 'admin' || currentUser.email === 'jainbharat666@gmail.com');
      if (tabId === 'opensea' && !isOwnerAdmin) {
        showToast('OpenSea API grid is restricted to platform administration', true);
        tabId = 'dashboard';
      }
      currentTab = tabId;
      const vDash = document.getElementById('view-dashboard');
      const vWallets = document.getElementById('view-wallets');
      const vRpc = document.getElementById('view-rpc');
      const vOpenSea = document.getElementById('view-opensea');
      
      const btnDash = document.getElementById('tab-btn-dashboard');
      const btnWallets = document.getElementById('tab-btn-wallets');
      const btnRpc = document.getElementById('tab-btn-rpc');
      const btnOpenSea = document.getElementById('tab-btn-opensea');

      [vDash, vWallets, vRpc, vOpenSea].forEach(v => { if (v) v.classList.add('hidden'); });
      [btnDash, btnWallets, btnRpc].forEach(b => {
        if (b) b.className = 'px-3.5 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-all';
      });

      if (btnOpenSea) {
        if (!isOwnerAdmin) {
          btnOpenSea.className = 'hidden';
        } else {
          btnOpenSea.className = 'px-3.5 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-all';
        }
      }

      if (tabId === 'dashboard') {
        vDash.classList.remove('hidden');
        btnDash.className = 'px-3.5 py-1.5 rounded-xl bg-white text-indigo-600 shadow-sm flex items-center gap-1.5 transition-all';
        grid.onParentResize();
      } else if (tabId === 'wallets') {
        vWallets.classList.remove('hidden');
        btnWallets.className = 'px-3.5 py-1.5 rounded-xl bg-white text-amber-700 shadow-sm flex items-center gap-1.5 transition-all';
        renderWalletFleetUI();
        refreshAllBalances();
      } else if (tabId === 'rpc') {
        vRpc.classList.remove('hidden');
        btnRpc.className = 'px-3.5 py-1.5 rounded-xl bg-white text-indigo-600 shadow-sm flex items-center gap-1.5 transition-all';
        renderRpcFleet();
      } else if (isOwnerAdmin) {
        vOpenSea.classList.remove('hidden');
        btnOpenSea.className = 'px-3.5 py-1.5 rounded-xl bg-white text-purple-700 shadow-sm flex items-center gap-1.5 transition-all';
        fetchOpenSeaKeys();
      }
      playBeep(700, 'sine', 0.05);
    }

    function setBlastTarget(target) {
      activeBlastTarget = target;
      persistState();
      ['top3', 'top5', 'all'].forEach(t => {
        const btn = document.getElementById(`bt-${t}`);
        if (t === target) {
          btn.className = 'px-2 py-0.5 rounded-md bg-indigo-600 text-white font-black shadow-sm';
        } else {
          btn.className = 'px-2 py-0.5 rounded-md bg-white border border-indigo-200 text-indigo-800 font-bold hover:bg-indigo-50';
        }
      });
      playBeep(800, 'sine', 0.05);
      showToast(`Blast Target: ${target.toUpperCase()}`);
    }

    function setRpcStrategy(strategy) {
      currentRpcStrategy = strategy;
      persistState();
      ['blast', 'fastest', 'primary'].forEach(s => {
        const card = document.getElementById(`strat-${s}-card`);
        if (card) {
          if (s === strategy) {
            card.className = 'flex items-start gap-3 p-3.5 rounded-2xl border-2 border-indigo-500 bg-indigo-50/50 cursor-pointer transition-all hover:bg-indigo-50';
          } else {
            card.className = 'flex items-start gap-3 p-3.5 rounded-2xl border border-slate-200 bg-slate-50/70 cursor-pointer transition-all hover:bg-slate-100';
          }
        }
      });

      const statusEl = document.getElementById('fleet-strategy-status');
      if (strategy === 'blast') {
        statusEl.innerText = `Multi-Blast (${rpcFleet.length} Active)`;
        showToast('RPC Strategy: Multi-Blast (Zero Delay) Active');
      } else if (strategy === 'fastest') {
        statusEl.innerText = `Auto-Fastest Routing`;
        showToast('RPC Strategy: Fastest Healthy Auto-Routing Active');
      } else {
        const primaryNode = rpcFleet.find(n => n.isPrimary) || rpcFleet[0];
        statusEl.innerText = `Primary Only (${primaryNode.name})`;
        showToast(`RPC Strategy: Primary Node Only (${primaryNode.name})`);
      }
      playBeep(850, 'sine', 0.08);
    }

    function handleNetworkChange(net) {
      document.getElementById('telemetry-network').innerText = net.toUpperCase();
      showToast(`Network: ${net.toUpperCase()}`);
    }

    function formatEthPrecise(num) {
      const n = parseFloat(num) || 0;
      if (n === 0) return '0.0000 ETH';
      if (n < 0.0001) return `${n.toFixed(6)} ETH`;
      if (n < 0.01) return `${n.toFixed(5)} ETH`;
      return `${n.toFixed(4)} ETH`;
    }

    function formatEthValueInput(num) {
      const n = parseFloat(num) || 0;
      if (n === 0) return '0.0000';
      if (n < 0.0001) return n.toFixed(6);
      if (n < 0.01) return n.toFixed(5);
      return n.toFixed(4);
    }
