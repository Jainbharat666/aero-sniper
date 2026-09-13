/* ══════════════════════════════════════════════════════════════
   🔐 AERO-SNIPER V2: AUTHENTICATION, CRYPTO VAULT & SECURITY
   ══════════════════════════════════════════════════════════════ */

    // ================= 🔒 CLIENT-SIDE WEB CRYPTO VAULT & STORAGE =================
    let walletFleet = [];
    let masterWalletIndex = null;
    let isSavingEncryptedVault = false;

    // Cryptographically secure Web Crypto PBKDF2 + AES-GCM encryption helpers
    async function encryptData(dataObj, secretKey) {
      const enc = new TextEncoder();
      const keyMaterial = await window.crypto.subtle.importKey(
        "raw", enc.encode(secretKey), { name: "PBKDF2" }, false, ["deriveKey"]
      );
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const cryptoKey = await window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 50000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        enc.encode(JSON.stringify(dataObj))
      );
      return JSON.stringify({
        salt: Array.from(salt),
        iv: Array.from(iv),
        data: Array.from(new Uint8Array(encrypted))
      });
    }

    async function decryptData(encryptedJson, secretKey) {
      try {
        const { salt, iv, data } = JSON.parse(encryptedJson);
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
          "raw", enc.encode(secretKey), { name: "PBKDF2" }, false, ["deriveKey"]
        );
        const cryptoKey = await window.crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: new Uint8Array(salt), iterations: 50000, hash: "SHA-256" },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
        const decrypted = await window.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(iv) },
          cryptoKey,
          new Uint8Array(data)
        );
        return JSON.parse(new TextDecoder().decode(decrypted));
      } catch (e) {
        return null;
      }
    }

    function getUserSecretKey(userId) {
      return 'aero_sniper_vault_' + (userId || 'guest') + '_sec';
    }

    // 🛡️ USER-BOUND ENCRYPTED WALLET PERSISTENCE (100% Isolated per Profile)
    async function persistUserWalletsEncrypted() {
      if (!currentUser || !currentUser.id) return;
      if (isSavingEncryptedVault) return;
      isSavingEncryptedVault = true;
      try {
        const uid = currentUser.id;
        const vaultPayload = {
          walletFleet: walletFleet.map(w => ({
            name: w.name,
            address: w.address,
            privateKey: w.privateKey,
            selected: w.selected
          })),
          masterWalletIndex: masterWalletIndex
        };
        const secret = getUserSecretKey(uid);
        const enc = await encryptData(vaultPayload, secret);
        localStorage.setItem(`sniper_u_${uid}_vault_wallets_enc`, enc);

        // Permanently purge unencrypted global keys to prevent any cross-account data leakage
        localStorage.removeItem('sniper_wallet_fleet');
        localStorage.removeItem('sniper_master_wallet_idx');
        localStorage.removeItem(`sniper_user_${uid}_wallets`);
        localStorage.removeItem(`sniper_user_${uid}_master_idx`);
      } catch (e) {
        console.error('[Vault] Encrypted save failed:', e);
      } finally {
        isSavingEncryptedVault = false;
      }
    }

    // ☁️ USER-CONTROLLED CLOUD VAULT (AEROMINT V2 ARCHITECTURE)
    function isCloudVaultEnabled(userId) {
      if (!userId) return false;
      const val = localStorage.getItem('sniper_u_' + userId + '_cloud_vault_enabled');
      if (val === 'false') return false;
      return true; // Default to true for authenticated accounts to sync across devices
    }

    function setCloudVaultEnabledLocally(userId, enabled) {
      if (!userId) return;
      localStorage.setItem('sniper_u_' + userId + '_cloud_vault_enabled', enabled ? 'true' : 'false');
      updateCloudVaultUI(enabled);
    }

    function updateCloudVaultUI(enabled, walletCountOverride, rpcCountOverride, lastSyncOverride) {
      const toggleInput = document.getElementById('prof-vault-toggle-input');
      const toggleBadge = document.getElementById('prof-vault-toggle-badge');
      const statusDesc = document.getElementById('prof-vault-status-desc');

      if (toggleInput) toggleInput.checked = Boolean(enabled);

      if (toggleBadge) {
        if (enabled) {
          toggleBadge.innerText = 'CLOUD ACTIVE';
          toggleBadge.className = 'px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-emerald-100 text-emerald-800 border border-emerald-300';
        } else {
          toggleBadge.innerText = 'LOCAL ONLY';
          toggleBadge.className = 'px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-slate-200 text-slate-700';
        }
      }

      if (statusDesc) {
        if (enabled) {
          statusDesc.innerHTML = '🟢 <strong class="text-emerald-700">Cloud Backup Active:</strong> Wallets are backed up to your private Cloud Vault. You can access and sync them across computers seamlessly.';
        } else {
          statusDesc.innerHTML = '⚪ <strong class="text-slate-800">Local-Only Private Mode:</strong> Wallets are encrypted (AES-GCM) strictly on this device. Turn toggle ON to enable cloud backup across devices.';
        }
      }

      const elWalletsCount = document.getElementById('prof-vault-wallets-count');
      const elRpcsCount = document.getElementById('prof-vault-rpcs-count');
      const elLastSync = document.getElementById('prof-vault-last-sync');

      const wCount = (walletCountOverride !== undefined) ? walletCountOverride : walletFleet.length;
      if (elWalletsCount) elWalletsCount.innerText = wCount;

      if (elRpcsCount) {
        const customCount = (rpcCountOverride !== undefined) ? rpcCountOverride : rpcFleet.filter(r => r.isCustom || (!r.isSystem && !r.isFleet && !isSystemRpcUrl(r.url))).length;
        elRpcsCount.innerText = customCount;
      }
      if (elLastSync) {
        const lastSync = lastSyncOverride || localStorage.getItem('sniper_last_cloud_sync');
        elLastSync.innerText = lastSync ? ('Last synced: ' + lastSync) : 'Last synced: Never';
      }
    }

    async function handleToggleCloudVault(enabled) {
      if (!currentUser || !currentUser.id) return;
      const uid = currentUser.id;
      setCloudVaultEnabledLocally(uid, enabled);

      if (enabled) {
        await syncUserVaultToCloud(true);
        showToast('🔒 Cloud Vault Backup Enabled: Wallets synced to Cloud!', false);
      } else {
        try {
          if (sessionToken) {
            await fetch('/api/user-config', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + sessionToken
              },
              body: JSON.stringify({
                userId: uid,
                cloud_vault_enabled: false
              })
            });
          }
        } catch(e) {}
        showToast('⚪ Switched to Local-Only Mode (Wallets stay on this PC only)', false);
      }
    }

    // ☁️ UNIFIED ATOMIC CLOUD VAULT SYNC (WALLETS + RPCS + SETTINGS IN ONE SINGLE PAYLOAD)
    let isSyncingVaultToCloud = false;
    async function syncUserVaultToCloud(force = false) {
      if (!currentUser || !currentUser.id) return;
      const uid = currentUser.id;
      const isEnabled = isCloudVaultEnabled(uid);
      if (!isEnabled && !force) return;

      if (isSyncingVaultToCloud) return;
      isSyncingVaultToCloud = true;

      try {
        const customOnly = (Array.isArray(rpcFleet) ? rpcFleet : [])
          .filter(r => r.isCustom || (!r.isSystem && !r.isFleet && !isSystemRpcUrl(r.url)))
          .map(r => ({
            id: r.id,
            name: r.name,
            url: r.url,
            isCustom: true,
            isPrimary: Boolean(r.isPrimary),
            pingMs: r.pingMs || 0
          }));

        const cleanWallets = (Array.isArray(walletFleet) ? walletFleet : []).map(w => ({
          name: w.name,
          address: w.address,
          privateKey: w.privateKey,
          selected: w.selected
        }));

        const payloadConfig = {
          walletFleet: cleanWallets,
          wallets: cleanWallets,
          masterWalletIndex: masterWalletIndex,
          custom_rpcs: customOnly,
          cloud_vault_enabled: true,
          activeFloorPercentPreset,
          activeRarityMultiplier,
          activeGasPreset,
          activeWorkerStrategy,
          activeMaxSnipesLimit,
          activeRuleStates,
          timestamp: Date.now()
        };

        const res = await fetch('/api/user-config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(sessionToken ? { 'Authorization': 'Bearer ' + sessionToken } : {})
          },
          body: JSON.stringify({
            userId: uid,
            config: payloadConfig
          })
        });

        if (res.ok) {
          const timeStr = new Date().toLocaleTimeString();
          localStorage.setItem('sniper_last_cloud_sync', timeStr);
          setCloudVaultEnabledLocally(uid, true);
          updateCloudVaultUI(true, cleanWallets.length, customOnly.length, timeStr);
        }
      } catch (e) {
        console.warn('[Cloud Vault Sync] Failed:', e.message);
      } finally {
        isSyncingVaultToCloud = false;
      }
    }

    // Backward-compatibility aliases so no existing calls break
    const syncUserWalletsToCloud = syncUserVaultToCloud;
    const syncUserCustomRpcsToCloud = syncUserVaultToCloud;

    // 🎯 UNIVERSAL INSTANT HYDRATION FROM CLOUD (CROSS-DEVICE / CROSS-CHROME PROFILE SYNC)
    function hydrateFromCloudConfig(cfg) {
      if (!cfg || !currentUser) return;
      const uid = currentUser.id;

      // 1. Vault enabled toggle state from Cloud
      if (cfg.cloud_vault_enabled !== undefined) {
        setCloudVaultEnabledLocally(uid, Boolean(cfg.cloud_vault_enabled));
      } else {
        setCloudVaultEnabledLocally(uid, true);
      }

      // 2. Hydrate Wallets from Cloud (Always restore if cloud has wallets and memory is empty)
      const remoteWallets = cfg.walletFleet || cfg.wallets || cfg.activeWallets;
      if (Array.isArray(remoteWallets) && remoteWallets.length > 0) {
        if (walletFleet.length === 0) {
          walletFleet = remoteWallets;
          masterWalletIndex = typeof cfg.masterWalletIndex === 'number' ? cfg.masterWalletIndex : (walletFleet.length > 0 ? 0 : null);
          persistUserWalletsEncrypted();
          renderWalletFleetUI();
          refreshAllBalances();
        }
      }

      // 3. Hydrate Custom RPCs from Cloud (100% ALWAYS AUTO-SYNCED FOR ALL USERS)
      const remoteCustom = cfg.custom_rpcs || cfg.rpcFleet;
      if (Array.isArray(remoteCustom)) {
        const customOnly = remoteCustom.filter(r => !isSystemRpcUrl(r.url) && !r.isSystem);
        localStorage.setItem('sniper_u_' + currentUser.id + '_custom_rpcs', JSON.stringify(customOnly));
        rpcFleet = assembleUserRpcFleet(DEFAULT_ADMIN_CLUSTER_RPC, customOnly);
        renderRpcFleet();
      }

      // 4. Hydrate Presets & Settings
      if (cfg.activeGasPreset) activeGasPreset = cfg.activeGasPreset;
      if (cfg.activeTriggerMode) activeTriggerMode = cfg.activeTriggerMode;
      if (cfg.activeRuleStates) {
        activeRuleStates = Object.assign(activeRuleStates, cfg.activeRuleStates);
        if (typeof refreshAllRuleSwitchesUI === 'function') refreshAllRuleSwitchesUI();
      }
    }

    async function loadUserScopedWallets() {
      if (!currentUser || !currentUser.id) {
        walletFleet = [];
        masterWalletIndex = null;
        return;
      }
      const uid = currentUser.id;

      // 1. If memory ALREADY has wallets loaded, never wipe them!
      if (Array.isArray(walletFleet) && walletFleet.length > 0) {
        renderWalletFleetUI();
        refreshAllBalances();
        return;
      }

      // 2. Check local encrypted vault
      const encKey = 'sniper_u_' + uid + '_vault_wallets_enc';
      const encData = localStorage.getItem(encKey);

      if (encData) {
        try {
          const secret = getUserSecretKey(uid);
          const decrypted = await decryptData(encData, secret);
          if (decrypted && Array.isArray(decrypted.walletFleet) && decrypted.walletFleet.length > 0) {
            walletFleet = decrypted.walletFleet;
            masterWalletIndex = typeof decrypted.masterWalletIndex === 'number' ? decrypted.masterWalletIndex : null;
            renderWalletFleetUI();
            refreshAllBalances();
            return;
          }
        } catch(e) {
          console.warn('[Vault] Decryption fallback:', e);
        }
      }

      // 3. Legacy scoped key migration (auto-encrypt into isolated vault, then purge plaintext)
      const legacyKey = 'sniper_user_' + uid + '_wallets';
      const legacyFleet = localStorage.getItem(legacyKey);
      if (legacyFleet) {
        try {
          walletFleet = JSON.parse(legacyFleet);
          const legacyMaster = localStorage.getItem('sniper_user_' + uid + '_master_idx');
          masterWalletIndex = (legacyMaster !== null && legacyMaster !== '') ? parseInt(legacyMaster, 10) : null;
          await persistUserWalletsEncrypted();
          localStorage.removeItem(legacyKey);
          localStorage.removeItem('sniper_user_' + uid + '_master_idx');
          renderWalletFleetUI();
          refreshAllBalances();
          syncUserVaultToCloud(true);
          return;
        } catch(e) {}
      }

      // 4. 🎯 IF LOCAL STORAGE IS EMPTY (e.g. Desktop App / Fresh Browser), FETCH CLOUD VAULT:
      try {
        const res = await fetch('/api/user-config?userId=' + encodeURIComponent(uid), {
          headers: { ...(sessionToken ? { 'Authorization': 'Bearer ' + sessionToken } : {}) }
        });
        if (res.ok) {
          const cData = await res.json();
          if (cData.success && cData.config) {
            const cfg = cData.config;
            const remoteWallets = cfg.walletFleet || cfg.wallets;
            if (Array.isArray(remoteWallets) && remoteWallets.length > 0) {
              walletFleet = remoteWallets;
              masterWalletIndex = typeof cfg.masterWalletIndex === 'number' ? cfg.masterWalletIndex : (walletFleet.length > 0 ? 0 : null);
              setCloudVaultEnabledLocally(uid, true);
              await persistUserWalletsEncrypted();
              renderWalletFleetUI();
              refreshAllBalances();
              const timeStr = cfg.timestamp ? new Date(cfg.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
              updateCloudVaultUI(true, remoteWallets.length, (cfg.custom_rpcs || []).length, timeStr);
              return;
            }
          }
        }
      } catch (err) {
        console.warn('[Vault] Cloud wallet fetch fallback:', err.message);
      }

      // 5. Only if absolutely no local or cloud wallets exist:
      if (!walletFleet || walletFleet.length === 0) {
        walletFleet = [];
        masterWalletIndex = null;
        renderWalletFleetUI();
        refreshAllBalances();
      }
    }


    function toggleGateMode() {
      const nextTab = activeGateTab === 'login' ? 'register' : 'login';
      switchGateTab(nextTab);
    }

    function switchGateTab(tab) {
      activeGateTab = tab;
      const inviteGroup = document.getElementById('gate-invite-group');
      const inviteInput = document.getElementById('gate-input-invite');
      const submitText = document.getElementById('gate-submit-text');
      const cardTitle = document.getElementById('gate-card-title');
      const toggleBtn = document.getElementById('gate-toggle-register-btn');
      const toggleLabel = document.getElementById('gate-toggle-register-label');
      const toggleChip = document.getElementById('gate-toggle-register-chip');
      const feedbackBanner = document.getElementById('gate-feedback-banner');
      if (feedbackBanner) feedbackBanner.classList.add('hidden');

      if (tab === 'register') {
        if (inviteGroup) inviteGroup.classList.remove('hidden');
        if (inviteInput) inviteInput.required = true;
        if (submitText) submitText.innerText = 'Activate License & Access';
        if (cardTitle) cardTitle.innerText = 'Activate VIP Access Key';
        if (toggleLabel) toggleLabel.innerText = 'Already have an account? Sign In';
        if (toggleChip) toggleChip.innerText = 'SIGN IN';
      } else {
        if (inviteGroup) inviteGroup.classList.add('hidden');
        if (inviteInput) inviteInput.required = false;
        if (submitText) submitText.innerText = 'VIP ACCESS (SEAPORT 1.6)';
        if (cardTitle) cardTitle.innerText = 'Log in or sign up';
        if (toggleLabel) toggleLabel.innerText = 'Activate VIP License Key';
        if (toggleChip) toggleChip.innerText = 'V2.0 PRO';
      }
    }

    
    // ══════════════════════════════════════════════════════════════
    // ✨ MAGIC DEVELOPER CONSOLE AUTH GATE CONTROLLER
    // ══════════════════════════════════════════════════════════════
    function openGateConsoleModal() {
      const landing = document.getElementById('gate-landing-view');
      const modal = document.getElementById('gate-console-modal');
      if (landing) landing.classList.add('hidden');
      if (modal) modal.classList.remove('hidden');
      document.getElementById('gate-input-email')?.focus();
    }

    function closeGateConsoleModal() {
      const landing = document.getElementById('gate-landing-view');
      const modal = document.getElementById('gate-console-modal');
      if (modal) modal.classList.add('hidden');
      if (landing) landing.classList.remove('hidden');
    }

    function toggleGateRegisterMode() {
      const newMode = (activeGateTab === 'login') ? 'register' : 'login';
      switchGateTab(newMode);
    }

    // Dynamic Real Client IP Telemetry
    async function fetchRealClientIp() {
      const el = document.getElementById('gate-client-ip');
      if (!el) return;
      try {
        const res = await fetch('/api/my-ip');
        const data = await res.json();
        if (data && data.ip && data.ip !== '::1' && data.ip !== '127.0.0.1') {
          el.innerText = data.ip;
          return;
        }
      } catch(e) {}
      try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        if (data && data.ip) {
          el.innerText = data.ip;
        }
      } catch(e) {}
    }

    // Dynamic Real-Time Block Counter Telemetry
    async function fetchRealTimeBlockNum() {
      const el = document.getElementById('gate-block-num');
      if (!el) return;
      try {
        const provider = new ethers.JsonRpcProvider('https://rpc.robinhood.com');
        const block = await provider.getBlockNumber();
        if (block) {
          el.innerText = '#' + block.toLocaleString();
        }
      } catch(e) {}
    }


    function showForgotPasswordHelp() {
      const banner = document.getElementById('gate-feedback-banner');
      if (banner) {
        banner.className = 'p-3 rounded-xl text-xs font-bold bg-violet-950/60 border border-violet-500/50 text-violet-300';
        banner.innerText = 'For password resets or license issues, contact your platform administrator or enter your VIP key during registration.';
        banner.classList.remove('hidden');
      }
    }

    function handleQuickVipDemo() {
      const emailInput = document.getElementById('gate-input-email');
      const passInput = document.getElementById('gate-input-password');
      if (emailInput && !emailInput.value) emailInput.value = 'admin@aerosniper.pro';
      if (passInput && !passInput.value) passInput.value = 'sniper-vip-2026';
      const banner = document.getElementById('gate-feedback-banner');
      if (banner) {
        banner.className = 'p-2.5 rounded-xl text-xs font-semibold bg-violet-950/40 border border-violet-500/30 text-violet-300';
        banner.innerText = 'Credentials autofilled. Click "Log In" or use your assigned account.';
        banner.classList.remove('hidden');
      }
    }

    async function handleGateAuthSubmit(event) {
      event.preventDefault();
      const email = document.getElementById('gate-input-email')?.value?.trim();
      const password = document.getElementById('gate-input-password')?.value;
      const inviteCode = document.getElementById('gate-input-invite')?.value?.trim().toUpperCase();
      const banner = document.getElementById('gate-feedback-banner');
      const btn = document.getElementById('gate-submit-btn');

      if (!email || !password) return;

      if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-70');
      }

      try {
        const endpoint = activeGateTab === 'register' ? '/api/auth/register' : '/api/auth/login';
        const payload = { email, password };
        if (activeGateTab === 'register') payload.invite_code = inviteCode;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          if (banner) {
            banner.className = 'p-3 rounded-xl text-xs font-bold bg-rose-950/60 border border-rose-500/50 text-rose-300';
            banner.innerText = data.error || 'Authentication failed. Please check credentials.';
            banner.classList.remove('hidden');
          }
          playBeep(300, 'sawtooth', 0.2);
          return;
        }

        // Authentication Success!
        currentUser = data.user;
        sessionToken = data.sessionToken || data.token;
        localStorage.setItem('sniper_token', sessionToken);
        localStorage.setItem('sniper_user', JSON.stringify(currentUser));

        // 🎯 INSTANT CLOUD HYDRATION: Hydrate wallets and RPCs immediately from login response!
        if (data.config) {
          hydrateFromCloudConfig(data.config);
        }

        if (banner) {
          banner.className = 'p-3 rounded-xl text-xs font-bold bg-emerald-950/60 border border-emerald-500/50 text-emerald-300';
          banner.innerText = `Welcome ${currentUser.email}! VIP Session Active. Unlocking workspace...`;
          banner.classList.remove('hidden');
        }
        playBeep(880, 'sine', 0.2);

        setTimeout(async () => {
          checkAuthState();
          await Promise.all([
            loadUserScopedWallets(),
            loadUserRpcsAndFleet(currentUser)
          ]);
          showToast(`Welcome ${currentUser.email}! Workspace loaded in <1s with ${walletFleet.length} wallets.`);
        }, 50);

      } catch (err) {
        if (banner) {
          banner.className = 'p-3 rounded-xl text-xs font-bold bg-rose-950/60 border border-rose-500/50 text-rose-300';
          banner.innerText = 'Network error during authentication: ' + err.message;
          banner.classList.remove('hidden');
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove('opacity-70');
        }
      }
    }

    function checkAuthState() {
      const authGate = document.getElementById('auth-gate-screen');
      const appRoot = document.getElementById('authenticated-app');

      if (!currentUser || !sessionToken) {
        document.documentElement.classList.remove('authenticated');
        if (authGate) {
          authGate.classList.remove('hidden');
          authGate.style.display = 'flex';
        }
        if (appRoot) {
          appRoot.classList.add('hidden');
          appRoot.style.display = 'none';
        }
        return false;
      } else {
        document.documentElement.classList.add('authenticated');
        if (authGate) {
          authGate.classList.add('hidden');
          authGate.style.display = 'none';
        }
        if (appRoot) {
          appRoot.classList.remove('hidden');
          appRoot.style.display = 'flex';
        }
        renderAuthHeaderUI();
        loadUserScopedWallets();
        loadUserRpcsAndFleet(currentUser);
        fetchOpenSeaKeys();
        refreshAllBalances();
        updateLiveRadar();
        return true;
      }
    }

    // =========================================================================
    // 👑 100% AEROMINT V2 SAAS ARCHITECTURE INTEGRATION (VIP, CLOUD VAULT & FLEET)
    // =========================================================================

    let profileCountdownTimer = null;
    let activeProfileTab = 'overview';
    let currentAdminUserFilter = 'all';
    let allAdminFleetRpcs = [];

    // --- 1. USERNAV PILL IN HEADER ---
    function purgeAutofilledEmail() {
      const scanInp = document.getElementById('scan-input');
      if (scanInp && (scanInp.value.includes('@') || scanInp.value === currentUser?.email)) {
        scanInp.value = '';
      }
      const streamInp = document.getElementById('stream-search');
      if (streamInp && (streamInp.value.includes('@') || streamInp.value === currentUser?.email)) {
        streamInp.value = '';
      }
      const adminSearchInp = document.getElementById('admin-user-search');
      if (adminSearchInp && (adminSearchInp.value === currentUser?.email || adminSearchInp.value === 'jainbharat666@gmail.com')) {
        adminSearchInp.value = '';
        const clearBtn = document.getElementById('admin-search-clear-btn');
        if (clearBtn) clearBtn.classList.add('hidden');
        if (typeof filterAdminUsers === 'function') filterAdminUsers();
      }
      const genCodeInp = document.getElementById('gen-invite-code');
      if (genCodeInp && (genCodeInp.value.includes('@') || genCodeInp.value === currentUser?.email)) {
        genCodeInp.value = '';
      }
    }

    function renderAuthHeaderUI() {
      purgeAutofilledEmail();
      const container = document.getElementById('header-auth-container');
      if (!container) return;

      if (!currentUser) {
        container.innerHTML = `
          <button onclick="openAuthModal('login')" class="flex items-center gap-1.5 bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:from-indigo-700 hover:to-pink-700 text-white px-3.5 py-1.5 rounded-xl font-mono-code text-xs font-black shadow-md shadow-indigo-500/20 transition-all cursor-pointer">
            <i class="fa-solid fa-bolt text-xs text-amber-300"></i>
            <span>VIP Login</span>
          </button>
        `;
        return;
      }

      const isOwnerAdmin = currentUser.role === 'admin' || currentUser.email === 'jainbharat666@gmail.com';
      
      // Ensure OpenSea tab visibility is locked strictly to admin
      const btnOpenSea = document.getElementById('tab-btn-opensea');
      if (btnOpenSea) btnOpenSea.classList.toggle('hidden', !isOwnerAdmin);

      const roleBadge = isOwnerAdmin 
        ? `<span class="bg-amber-100 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase">👑 ADMIN</span>`
        : `<span class="bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase">⚡ VIP</span>`;
      
      const initial = isOwnerAdmin ? '👑' : (currentUser.email ? currentUser.email.charAt(0).toUpperCase() : 'U');
      const emailShort = currentUser.email && currentUser.email.length > 16 
        ? currentUser.email.substring(0, 14) + '...' 
        : (currentUser.email || 'VIP Member');

      const maxAllowed = currentUser.max_snipes_allowed !== undefined ? parseInt(currentUser.max_snipes_allowed) : 0;
      const used = currentUser.snipes_used !== undefined ? currentUser.snipes_used : (currentUser.total_snipes || 0);
      let remaining = currentUser.snipes_remaining;
      if (remaining === undefined || remaining === null) {
        remaining = maxAllowed > 0 ? Math.max(0, maxAllowed - used) : null;
      }

      let accessMetric = '';
      if (isOwnerAdmin) {
        accessMetric = `<span class="text-[10px] text-amber-700 font-black">👑 Master Access</span>`;
      } else {
        let daysStr = '∞';
        if (currentUser.valid_until) {
          const diff = new Date(currentUser.valid_until).getTime() - Date.now();
          const d = Math.ceil(diff / (1000 * 60 * 60 * 24));
          daysStr = d > 0 ? `${d}d left` : `<span class="text-rose-600 font-black">EXPIRED</span>`;
        }
        let snipesStr = '∞';
        if (maxAllowed > 0) {
          snipesStr = remaining > 0 ? `${remaining} snipes left` : `<span class="text-rose-600 font-black">0 snipes</span>`;
        }
        accessMetric = `<span class="text-[10px] text-slate-500 font-bold">⏳ ${daysStr} • ⚡ ${snipesStr}</span>`;
      }

      container.innerHTML = `
        <div class="flex items-center gap-2">
          ${isOwnerAdmin ? `
            <button onclick="openAdminModal()" class="flex items-center gap-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white px-3 py-1.5 rounded-xl font-mono-code text-xs font-black shadow-md shadow-amber-500/20 transition-all cursor-pointer">
              <i class="fa-solid fa-crown text-xs text-amber-200"></i>
              <span>Admin Console</span>
            </button>
          ` : ''}
          <div onclick="openUserProfileModal('overview')" class="flex items-center gap-2.5 bg-white/90 hover:bg-white border border-slate-200/80 text-slate-800 px-2.5 py-1.5 rounded-2xl font-mono-code text-xs font-bold shadow-sm hover:shadow-md transition-all cursor-pointer select-none">
            <div class="w-6 h-6 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center text-white text-[11px] font-black shadow-sm">
              ${initial}
            </div>
            <div class="flex flex-col text-left leading-tight">
              <div class="flex items-center gap-1.5">
                <span class="font-black text-slate-900">${emailShort}</span>
                ${roleBadge}
              </div>
              <div class="flex items-center gap-1 text-[10px]">
                ${accessMetric}
              </div>
            </div>
            <div class="w-6 h-6 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-800 transition-colors ml-1">
              <i class="fa-solid fa-gear text-[11px]"></i>
            </div>
          </div>
        </div>
      `;
    }

    // --- 2. USER PROFILE & CLOUD VAULT MODAL (5 TABS) ---
    function openUserProfileModal(tab = 'overview') {
      if (!currentUser) {
        openAuthModal('login');
        return;
      }
      const isOwnerAdmin = currentUser.role === 'admin' || currentUser.email === 'jainbharat666@gmail.com';
      
      const elEmail = document.getElementById('prof-modal-email');
      const elUid = document.getElementById('prof-modal-uid');
      const elBadge = document.getElementById('prof-modal-role-badge');
      const elAvatar = document.getElementById('prof-avatar');
      const ownerBtn = document.getElementById('prof-owner-btn-container');

      if (elEmail) elEmail.innerText = currentUser.email;
      if (elUid) elUid.innerText = 'UID: ' + (currentUser.id ? currentUser.id.substring(0, 8) : '--');
      if (elAvatar) elAvatar.innerText = isOwnerAdmin ? '👑' : (currentUser.email ? currentUser.email.charAt(0).toUpperCase() : '👤');
      
      if (elBadge) {
        elBadge.innerText = isOwnerAdmin ? '👑 PLATFORM ADMIN' : (currentUser.plan || 'VIP MEMBER');
        elBadge.className = isOwnerAdmin 
          ? 'px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-amber-500/20 text-amber-300 border border-amber-500/40'
          : 'px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-indigo-500/20 text-indigo-300 border border-indigo-500/40';
      }

      if (ownerBtn) ownerBtn.classList.toggle('hidden', !isOwnerAdmin);

      // Snipes Quota Calculation
      const maxAllowed = currentUser.max_snipes_allowed !== undefined ? parseInt(currentUser.max_snipes_allowed) : 0;
      const used = currentUser.snipes_used !== undefined ? currentUser.snipes_used : (currentUser.total_snipes || 0);
      let rem = currentUser.snipes_remaining;
      if (rem === undefined || rem === null) {
        rem = maxAllowed > 0 ? Math.max(0, maxAllowed - used) : null;
      }
      const quotaLabel = document.getElementById('prof-quota-label');
      const quotaProgress = document.getElementById('prof-quota-progress');
      const quotaRemaining = document.getElementById('prof-quota-remaining');
      const inviteUsed = document.getElementById('prof-invite-used');

      if (maxAllowed > 0) {
        const pct = Math.min(100, Math.round((used / maxAllowed) * 100));
        if (quotaLabel) quotaLabel.innerText = `${used} / ${maxAllowed} Snipes (${pct}%)`;
        if (quotaProgress) quotaProgress.style.width = pct + '%';
        if (quotaRemaining) {
          quotaRemaining.innerHTML = rem > 0 ? `Remaining: ${rem} Snipes` : `<span class="text-rose-600 font-bold">Remaining: 0 Snipes (Exhausted)</span>`;
        }
        if (inviteUsed) inviteUsed.innerText = 'Snipes Completed: ' + used;
      } else {
        if (quotaLabel) quotaLabel.innerText = 'Unlimited Snipes ⚡';
        if (quotaProgress) quotaProgress.style.width = '100%';
        if (quotaRemaining) quotaRemaining.innerText = 'Remaining: Unlimited';
        if (inviteUsed) inviteUsed.innerText = 'Snipes Completed: ' + used;
      }

      // Populate Cloud Vault counters and AeroMint V2 toggle state
      if (currentUser && currentUser.id) {
        refreshCloudVaultStatsFromRemote();
      }

      switchProfileTab(tab);
      startProfileCountdownClock();

      const m = document.getElementById('user-profile-modal');
      if (m) m.classList.remove('hidden');
    }

    async function refreshCloudVaultStatsFromRemote() {
      if (!currentUser || !currentUser.id) return;
      const uid = currentUser.id;
      const isEnabled = isCloudVaultEnabled(uid);
      updateCloudVaultUI(isEnabled);

      try {
        const res = await fetch('/api/user-config?userId=' + encodeURIComponent(uid), {
          headers: { ...(sessionToken ? { 'Authorization': 'Bearer ' + sessionToken } : {}) }
        });
        if (res.ok) {
          const d = await res.json();
          if (d.success && d.config) {
            const cfg = d.config;
            const remoteW = (cfg.walletFleet || cfg.wallets || []).length;
            const remoteR = (cfg.custom_rpcs || []).length;
            const displayW = Math.max(remoteW, walletFleet.length);
            const syncTime = cfg.timestamp ? new Date(cfg.timestamp).toLocaleTimeString() : (cfg.updated_at ? new Date(cfg.updated_at).toLocaleTimeString() : null);
            if (cfg.cloud_vault_enabled !== undefined) {
              setCloudVaultEnabledLocally(uid, Boolean(cfg.cloud_vault_enabled));
            }
            updateCloudVaultUI(isCloudVaultEnabled(uid), displayW, remoteR, syncTime);
          }
        }
      } catch (e) {}
    }

    function closeUserProfileModal() {
      const m = document.getElementById('user-profile-modal');
      if (m) m.classList.add('hidden');
      if (profileCountdownTimer) {
        clearInterval(profileCountdownTimer);
        profileCountdownTimer = null;
      }
    }

    function switchProfileTab(tab) {
      activeProfileTab = tab;
      const tabs = ['overview', 'cloud_vault', 'security', 'renew'];
      tabs.forEach(t => {
        const btn = document.getElementById(`prof-tab-btn-${t}`);
        const view = document.getElementById(`prof-view-${t}`);
        if (btn) {
          if (t === tab) {
            btn.className = 'flex-1 py-1.5 rounded-xl bg-white text-indigo-600 font-bold shadow-sm transition-all text-center';
          } else {
            btn.className = 'flex-1 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 font-bold transition-all text-center';
          }
        }
        if (view) {
          view.classList.toggle('hidden', t !== tab);
        }
      });

      if (tab === 'cloud_vault') {
        if (currentUser && currentUser.id) {
          refreshCloudVaultStatsFromRemote();
        }
      }
    }

    function startProfileCountdownClock() {
      if (profileCountdownTimer) clearInterval(profileCountdownTimer);
      updateProfileClockTick();
      profileCountdownTimer = setInterval(updateProfileClockTick, 1000);
    }

    function updateProfileClockTick() {
      if (!currentUser) return;
      const isOwnerAdmin = currentUser.role === 'admin' || currentUser.email === 'jainbharat666@gmail.com';
      const container = document.getElementById('prof-clock-container');
      const lifetime = document.getElementById('prof-clock-lifetime');
      const lblValid = document.getElementById('prof-valid-until-label');
      const dEl = document.getElementById('prof-clock-days');
      const hEl = document.getElementById('prof-clock-hours');
      const mEl = document.getElementById('prof-clock-mins');
      const sEl = document.getElementById('prof-clock-secs');

      if (isOwnerAdmin) {
        if (container) container.classList.add('hidden');
        if (lifetime) lifetime.classList.remove('hidden');
        if (lblValid) lblValid.innerText = 'Platform Master Owner Account • Permanent Access';
        return;
      }

      if (lifetime) lifetime.classList.add('hidden');
      if (container) container.classList.remove('hidden');

      if (!currentUser.valid_until) {
        if (dEl) dEl.innerText = '∞';
        if (hEl) hEl.innerText = '∞';
        if (mEl) mEl.innerText = '∞';
        if (sEl) sEl.innerText = '∞';
        if (lblValid) lblValid.innerText = 'Unlimited Validity Key (No expiry)';
        return;
      }

      const expDate = new Date(currentUser.valid_until).getTime();
      const diff = expDate - Date.now();

      if (diff <= 0) {
        if (dEl) dEl.innerText = '00';
        if (hEl) hEl.innerText = '00';
        if (mEl) mEl.innerText = '00';
        if (sEl) sEl.innerText = '00';
        if (lblValid) lblValid.innerHTML = '<span class="text-rose-600 font-bold">⚠️ Access Expired! Please redeem renewal key in Renew tab.</span>';
        return;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diff % (1000 * 60)) / 1000);

      if (dEl) dEl.innerText = String(days).padStart(2, '0');
      if (hEl) hEl.innerText = String(hours).padStart(2, '0');
      if (mEl) mEl.innerText = String(mins).padStart(2, '0');
      if (sEl) sEl.innerText = String(secs).padStart(2, '0');
      if (lblValid) lblValid.innerText = `Valid until: ${new Date(currentUser.valid_until).toLocaleString()}`;
    }

    // --- 3. CLOUD VAULT HANDLERS (BACKUP, RESTORE, WIPE - AEROMINT V2 PATTERN) ---
    async function handleCloudVaultBackup() {
      if (!currentUser || !sessionToken) {
        showToast('Please login to backup your vault', true);
        return;
      }
      const uid = currentUser.id;
      setCloudVaultEnabledLocally(uid, true);

      const customOnly = (Array.isArray(rpcFleet) ? rpcFleet : [])
        .filter(r => r.isCustom || (!r.isSystem && !r.isFleet && !isSystemRpcUrl(r.url)))
        .map(r => ({
          id: r.id,
          name: r.name,
          url: r.url,
          isCustom: true,
          isPrimary: Boolean(r.isPrimary),
          pingMs: r.pingMs || 0
        }));

      const cleanWallets = (Array.isArray(walletFleet) ? walletFleet : []).map(w => ({
        name: w.name,
        address: w.address,
        privateKey: w.privateKey,
        selected: w.selected
      }));

      const payloadConfig = {
        walletFleet: cleanWallets,
        wallets: cleanWallets,
        masterWalletIndex,
        custom_rpcs: customOnly,
        cloud_vault_enabled: true,
        activeFloorPercentPreset,
        activeRarityMultiplier,
        activeGasPreset,
        activeWorkerStrategy,
        activeMaxSnipesLimit,
        activeRuleStates,
        timestamp: Date.now()
      };

      try {
        showToast('Securing Cloud Vault...');
        const res = await fetch('/api/user-config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + sessionToken
          },
          body: JSON.stringify({ userId: uid, config: payloadConfig })
        });
        const data = await res.json();
        if (data.success) {
          const timeStr = new Date().toLocaleTimeString();
          localStorage.setItem('sniper_last_cloud_sync', timeStr);
          updateCloudVaultUI(true, cleanWallets.length, customOnly.length, timeStr);
          showToast(`⚡ Cloud Vault Synced: ${cleanWallets.length} Wallets & ${customOnly.length} RPCs Secured!`);
          playBeep(784, 'sine', 0.15);
        } else {
          showToast(data.error || 'Cloud sync failed', true);
        }
      } catch(e) {
        showToast('Vault sync error: ' + e.message, true);
      }
    }

    async function handleCloudVaultRestore() {
      if (!currentUser || !sessionToken) {
        showToast('Please login to restore your vault', true);
        return;
      }
      const uid = currentUser.id;
      try {
        showToast('Fetching Cloud Vault backup...');
        const res = await fetch('/api/user-config?userId=' + encodeURIComponent(uid), {
          headers: { 'Authorization': 'Bearer ' + sessionToken }
        });
        const data = await res.json();
        if (data.success && data.config) {
          const cfg = data.config;
          setCloudVaultEnabledLocally(uid, true);

          const remoteWallets = cfg.walletFleet || cfg.wallets;
          let restoredCount = 0;
          if (Array.isArray(remoteWallets) && remoteWallets.length > 0) {
            walletFleet = remoteWallets;
            if (typeof cfg.masterWalletIndex === 'number') {
              masterWalletIndex = cfg.masterWalletIndex;
            } else if (walletFleet.length > 0) {
              masterWalletIndex = 0;
            }
            await persistUserWalletsEncrypted();
            renderWalletFleetUI();
            refreshAllBalances();
            restoredCount = remoteWallets.length;
          }

          const remoteCustom = cfg.custom_rpcs || cfg.rpcFleet;
          let restoredRpcs = 0;
          if (Array.isArray(remoteCustom)) {
            const customOnly = remoteCustom.filter(r => !isSystemRpcUrl(r.url) && !r.isSystem);
            localStorage.setItem('sniper_u_' + uid + '_custom_rpcs', JSON.stringify(customOnly));
            rpcFleet = assembleUserRpcFleet(DEFAULT_ADMIN_CLUSTER_RPC, customOnly);
            renderRpcFleet();
            restoredRpcs = customOnly.length;
          }

          if (cfg.activeRuleStates) {
            activeRuleStates = Object.assign(activeRuleStates, cfg.activeRuleStates);
            if (typeof refreshAllRuleSwitchesUI === 'function') refreshAllRuleSwitchesUI();
          }

          const timeStr = cfg.timestamp ? new Date(cfg.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
          localStorage.setItem('sniper_last_cloud_sync', timeStr);
          updateCloudVaultUI(true, restoredCount, restoredRpcs, timeStr);
          showToast(`⚡ Restored ${restoredCount} Wallets & ${restoredRpcs} RPCs from Cloud!`);
          playBeep(659, 'sine', 0.15);
        } else {
          showToast('No existing Cloud Vault backup found for this account.', true);
        }
      } catch(e) {
        showToast('Failed to restore vault: ' + e.message, true);
      }
    }

    async function handleCloudVaultWipe() {
      const ok = await showCustomConfirm('Are you sure you want to permanently erase your remote Cloud Vault backup? Local settings will remain.', 'Erase Cloud Vault', { isDanger: true, confirmText: 'Wipe Remote Cloud Data' });
      if (!ok) return;
      if (!currentUser || !sessionToken) return;
      const uid = currentUser.id;
      try {
        const res = await fetch('/api/user-config?userId=' + encodeURIComponent(uid), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + sessionToken }
        });
        const data = await res.json();
        if (data.success) {
          setCloudVaultEnabledLocally(uid, false);
          localStorage.removeItem('sniper_last_cloud_sync');
          updateCloudVaultUI(false, 0, 0, 'Never');
          showToast('Remote Cloud Vault wiped successfully.');
        } else {
          showToast(data.error || 'Failed to wipe cloud data', true);
        }
      } catch(e) {
        showToast('Wipe failed: ' + e.message, true);
      }
    }

    // --- 4. USER CUSTOM RPCS MANAGER ---
    function getUserCustomRpcs() {
      if (!currentUser || !currentUser.id) return [];
      try {
        const saved = localStorage.getItem('sniper_user_' + currentUser.id + '_custom_rpcs');
        return saved ? JSON.parse(saved) : [];
      } catch(e) {
        return [];
      }
    }

    function saveUserCustomRpcs(rpcs) {
      if (!currentUser || !currentUser.id) return;
      localStorage.setItem('sniper_user_' + currentUser.id + '_custom_rpcs', JSON.stringify(rpcs));
    }

    function handleAddUserCustomRpc(event) {
      event.preventDefault();
      const name = document.getElementById('user-rpc-name')?.value?.trim();
      const network = document.getElementById('user-rpc-network')?.value || 'robinhood';
      const url = document.getElementById('user-rpc-url')?.value?.trim();
      if (!name || !url) return;

      const currentCustom = getUserCustomRpcs();
      const newRpc = {
        id: 'user-rpc-' + Date.now(),
        name,
        network,
        url,
        isCustom: true,
        pingMs: 0,
        status: 'online'
      };
      currentCustom.push(newRpc);
      saveUserCustomRpcs(currentCustom);

      if (!rpcFleet.some(r => r.url === url)) {
        rpcFleet.push(newRpc);
        persistState();
        renderRpcFleet();
      }

      document.getElementById('user-rpc-name').value = '';
      document.getElementById('user-rpc-url').value = '';
      renderUserCustomRpcs();
      testUserCustomRpcLatencies();
      showToast('Private Node Added Successfully!');
    }

    function renderUserCustomRpcs() {
      const listEl = document.getElementById('user-rpcs-list');
      const countEl = document.getElementById('user-rpcs-count');
      const vaultCountEl = document.getElementById('prof-vault-rpcs-count');
      const customRpcs = getUserCustomRpcs();

      if (countEl) countEl.innerText = customRpcs.length;
      if (vaultCountEl) vaultCountEl.innerText = customRpcs.length;
      if (!listEl) return;

      if (customRpcs.length === 0) {
        listEl.innerHTML = `<div class="py-4 text-center text-slate-500 text-xs">No private custom RPC nodes added yet.</div>`;
        return;
      }

      listEl.innerHTML = customRpcs.map(r => `
        <div class="py-2.5 px-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2 shadow-sm">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="font-bold text-xs text-slate-900 truncate">${r.name}</span>
              <span class="px-1.5 py-0.5 rounded text-[8px] uppercase bg-indigo-50 text-indigo-700 font-mono-code font-bold border border-indigo-200">${r.network || '4663'}</span>
            </div>
            <div class="text-[10px] text-slate-500 font-mono-code truncate">${r.url}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span id="user-rpc-ping-${r.id}" class="px-2 py-0.5 rounded-lg text-[9px] font-black border ${r.pingMs && r.pingMs < 150 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}">
              ${r.pingMs ? r.pingMs + ' MS' : '--'}
            </span>
            <button onclick="deleteUserCustomRpc('${r.id}')" class="w-6 h-6 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 flex items-center justify-center text-[10px] cursor-pointer font-bold transition-colors">
              ✕
            </button>
          </div>
        </div>
      `).join('');
    }

    function deleteUserCustomRpc(id) {
      let custom = getUserCustomRpcs();
      const deleted = custom.find(r => r.id === id);
      custom = custom.filter(r => r.id !== id);
      saveUserCustomRpcs(custom);
      if (deleted) {
        rpcFleet = rpcFleet.filter(r => r.url !== deleted.url);
        renderRpcFleet();
      }
      persistState();
      renderUserCustomRpcs();
      showToast('Custom Node Removed');
    }

    async function testUserCustomRpcLatencies() {
      const custom = getUserCustomRpcs();
      if (custom.length === 0) return;
      for (const r of custom) {
        const el = document.getElementById(`user-rpc-ping-${r.id}`);
        if (el) el.innerHTML = `<span class="text-amber-600 animate-pulse font-bold">...</span>`;
        const t0 = performance.now();
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3500);
          await fetch(r.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          const lat = Math.round(performance.now() - t0);
          r.pingMs = lat;
          if (el) {
            el.className = `px-2 py-0.5 rounded-lg text-[9px] font-black border ${lat < 150 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`;
            el.innerText = `${lat} MS`;
          }
        } catch(e) {
          if (el) {
            el.className = `px-2 py-0.5 rounded-lg text-[9px] font-black bg-rose-50 text-rose-600 border border-rose-200`;
            el.innerText = 'TIMEOUT';
          }
        }
      }
      saveUserCustomRpcs(custom);
    }

    // --- 5. SECURITY & RENEW HANDLERS ---
    async function handleUserProfileChangePassword(event) {
      event.preventDefault();
      const current_password = document.getElementById('prof-cp-current')?.value;
      const new_password = document.getElementById('prof-cp-new')?.value;
      const confirm_password = document.getElementById('prof-cp-confirm')?.value;

      if (new_password !== confirm_password) {
        showToast('New passwords do not match!', true);
        return;
      }
      if (!new_password || new_password.length < 6) {
        showToast('New password must be at least 6 characters long!', true);
        return;
      }

      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ email: currentUser?.email, oldPassword: current_password, newPassword: new_password })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Password updated successfully!');
          document.getElementById('prof-cp-current').value = '';
          document.getElementById('prof-cp-new').value = '';
          document.getElementById('prof-cp-confirm').value = '';
          playBeep(880, 'sine', 0.2);
        } else {
          showToast(data.error || 'Password update failed', true);
        }
      } catch(e) {
        showToast('Network error: ' + e.message, true);
      }
    }

    async function handleUserProfileRedeemTopup(event) {
      event.preventDefault();
      const code = document.getElementById('prof-topup-code')?.value?.trim().toUpperCase();
      if (!code) return;

      try {
        const res = await fetch('/api/auth/redeem-topup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ email: currentUser?.email, topupCode: code })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || 'VIP Top-up redeemed successfully!');
          if (currentUser) {
            if (data.valid_until) currentUser.valid_until = data.valid_until;
            if (data.snipes_remaining !== undefined) currentUser.snipes_remaining = data.snipes_remaining;
            localStorage.setItem('sniper_user', JSON.stringify(currentUser));
            renderAuthHeaderUI();
          }
          document.getElementById('prof-topup-code').value = '';
          playBeep(880, 'sine', 0.25);
          switchProfileTab('overview');
          updateProfileClockTick();
        } else {
          showToast(data.error || 'Redeem failed', true);
        }
      } catch(e) {
        showToast('Network error: ' + e.message, true);
      }
    }

    // --- 6. AUTHENTICATION & MULTI-TENANT LOGOUT ---
    function openAuthModal(tab = 'login') {
      switchAuthTab(tab);
      const m = document.getElementById('auth-modal');
      if (m) m.classList.remove('hidden');
    }

    function closeAuthModal() {
      const m = document.getElementById('auth-modal');
      if (m) m.classList.add('hidden');
      const banner = document.getElementById('auth-feedback-banner');
      if (banner) {
        banner.classList.add('hidden');
        banner.innerText = '';
      }
    }

    function switchAuthTab(tab) {
      activeAuthTab = tab;
      const tabLogin = document.getElementById('auth-tab-login');
      const tabRegister = document.getElementById('auth-tab-register');
      const inviteGroup = document.getElementById('auth-invite-group');
      const inviteInput = document.getElementById('auth-input-invite');
      const submitText = document.getElementById('auth-submit-text');
      const modalTitle = document.getElementById('auth-modal-title');

      if (tab === 'register') {
        if (tabRegister) tabRegister.className = 'flex-1 py-1.5 rounded-xl bg-white text-indigo-600 shadow-sm transition-all text-center';
        if (tabLogin) tabLogin.className = 'flex-1 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 transition-all text-center';
        if (inviteGroup) inviteGroup.classList.remove('hidden');
        if (inviteInput) inviteInput.required = true;
        if (submitText) submitText.innerText = 'Activate Key & Register';
        if (modalTitle) modalTitle.innerText = 'Activate VIP Access Key';
      } else {
        if (tabLogin) tabLogin.className = 'flex-1 py-1.5 rounded-xl bg-white text-indigo-600 shadow-sm transition-all text-center';
        if (tabRegister) tabRegister.className = 'flex-1 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 transition-all text-center';
        if (inviteGroup) inviteGroup.classList.add('hidden');
        if (inviteInput) inviteInput.required = false;
        if (submitText) submitText.innerText = 'Enter Sniper Dashboard';
        if (modalTitle) modalTitle.innerText = 'VIP Member Authentication';
      }
    }

    function togglePasswordVisibility(inputId) {
      const inp = document.getElementById(inputId);
      if (inp) {
        inp.type = inp.type === 'password' ? 'text' : 'password';
      }
    }

    async function handleAuthSubmit(event) {
      event.preventDefault();
      const email = document.getElementById('auth-input-email')?.value?.trim();
      const password = document.getElementById('auth-input-password')?.value;
      const inviteCode = document.getElementById('auth-input-invite')?.value?.trim().toUpperCase();
      const banner = document.getElementById('auth-feedback-banner');
      const btn = document.getElementById('auth-submit-btn');

      if (!email || !password) return;

      if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-70');
      }

      try {
        const endpoint = activeAuthTab === 'register' ? '/api/auth/register' : '/api/auth/login';
        const payload = { email, password };
        if (activeAuthTab === 'register') payload.invite_code = inviteCode;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          if (banner) {
            banner.className = 'p-2.5 rounded-xl text-xs font-bold bg-rose-50 border border-rose-200 text-rose-700';
            banner.innerText = data.error || 'Authentication failed. Please check credentials.';
            banner.classList.remove('hidden');
          }
          playBeep(300, 'sawtooth', 0.2);
          return;
        }

        currentUser = data.user;
        sessionToken = data.sessionToken || data.token;
        localStorage.setItem('sniper_token', sessionToken);
        localStorage.setItem('sniper_user', JSON.stringify(currentUser));

        // 🎯 INSTANT CLOUD HYDRATION: Hydrate wallets and RPCs immediately from login response!
        if (data.config) {
          hydrateFromCloudConfig(data.config);
        }

        if (banner) {
          banner.className = 'p-2.5 rounded-xl text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-700';
          banner.innerText = `Welcome ${currentUser.email}! VIP Session Active.`;
          banner.classList.remove('hidden');
        }
        playBeep(880, 'sine', 0.2);

        checkAuthState();
        setTimeout(() => {
          closeAuthModal();
          showToast(`Logged in as ${currentUser.email} with ${walletFleet.length} wallets`);
        }, 300);

      } catch (err) {
        if (banner) {
          banner.className = 'p-2.5 rounded-xl text-xs font-bold bg-rose-50 border border-rose-200 text-rose-700';
          banner.innerText = 'Network error during authentication: ' + err.message;
          banner.classList.remove('hidden');
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove('opacity-70');
        }
      }
    }

    function logoutUser() {
      if (Array.isArray(walletFleet)) {
        walletFleet.forEach(w => {
          w.signer = null;
          delete w.privateKey;
        });
      }
      walletFleet = [];
      masterWalletIndex = null;
      rpcFleet = assembleUserRpcFleet(DEFAULT_ADMIN_CLUSTER_RPC, []);

      currentUser = null;
      sessionToken = null;
      localStorage.removeItem('sniper_token');
      localStorage.removeItem('sniper_user');
      localStorage.removeItem('sniper_wallet_fleet');
      localStorage.removeItem('sniper_master_wallet_idx');

      closeUserProfileModal();
      closeAdminModal();
      renderWalletFleetUI();
      renderRpcFleet();
      checkAuthState();
      showToast('Logged out successfully. Memory & keys purged.');
    }

    async function checkAuthHeartbeat() {
      if (!currentUser || !sessionToken) return;

      // Platform Owner is exempt from client heartbeat invalidation (matches AeroMint V2 parity)
      const isOwner = currentUser.email?.toLowerCase() === 'jainbharat666@gmail.com' || currentUser.role === 'admin';
      if (isOwner) return;

      try {
        const res = await fetch(`/api/auth/heartbeat?userId=${encodeURIComponent(currentUser.id || '')}&sessionToken=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(currentUser.email || '')}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!res.ok) {
          // If server is starting up or temporary network hiccup, keep session intact
          return;
        }
        const data = await res.json();
        if (!data.valid) {
          showToast(data.message || 'Session invalidated: Logged in from another device or expired!', true);
          logoutUser();
        }
      } catch(e) {
        // Network offline or server starting up: keep session intact
      }
    }
    setInterval(checkAuthHeartbeat, 25000);

    // --- 7. MASTER OWNER ADMIN CONSOLE (4 TABS) ---