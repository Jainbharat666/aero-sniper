/* ══════════════════════════════════════════════════════════════
   ⚙️ AERO-SNIPER V2: GLOBAL CONFIGURATION & CORE UTILITIES
   ══════════════════════════════════════════════════════════════ */

    // ================= 🛡️ CUSTOM IN-APP CONFIRMATION SYSTEM (ZERO BROWSER POPUPS) =================
    let confirmResolver = null;

    function showCustomConfirm(message, title = 'Confirmation Required', options = {}) {
      return new Promise((resolve) => {
        confirmResolver = resolve;
        const modal = document.getElementById('custom-confirm-modal');
        const elTitle = document.getElementById('custom-confirm-title');
        const elMsg = document.getElementById('custom-confirm-message');
        const elIconBox = document.getElementById('custom-confirm-icon-box');
        const elIcon = document.getElementById('custom-confirm-icon');
        const btnOk = document.getElementById('custom-confirm-btn-ok');
        const btnCancel = document.getElementById('custom-confirm-btn-cancel');

        if (elTitle) elTitle.innerText = title;
        if (elMsg) elMsg.innerText = message;

        const isDanger = options.isDanger !== false;
        if (btnOk) {
          btnOk.innerText = options.confirmText || (isDanger ? 'Delete / Proceed' : 'Confirm');
          btnOk.className = isDanger 
            ? 'flex-1 py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-black text-xs transition-all shadow-md shadow-rose-600/20 cursor-pointer'
            : 'flex-1 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs transition-all shadow-md shadow-indigo-600/20 cursor-pointer';
        }
        if (btnCancel) {
          btnCancel.innerText = options.cancelText || 'Cancel';
        }

        if (elIconBox && elIcon) {
          if (isDanger) {
            elIconBox.className = 'w-14 h-14 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center text-2xl mx-auto shadow-sm';
            elIcon.className = 'fa-solid fa-triangle-exclamation';
          } else {
            elIconBox.className = 'w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-600 flex items-center justify-center text-2xl mx-auto shadow-sm';
            elIcon.className = 'fa-solid fa-circle-question';
          }
        }

        if (modal) modal.classList.remove('hidden');
      });
    }

    function closeCustomConfirm(result = false) {
      const modal = document.getElementById('custom-confirm-modal');
      if (modal) modal.classList.add('hidden');
      if (typeof confirmResolver === 'function') {
        const res = confirmResolver;
        confirmResolver = null;
        res(result);
      }
    }

    // Bulletproof: Override native window.confirm so NO browser dialog ever appears
    window.confirm = function(msg) {
      console.warn('[Custom Confirm]: Native confirm blocked:', msg);
      return false;
    };

    // ================= VIP AUTHENTICATION & SINGLE-DEVICE SESSION STATE =================
    let currentUser = null;
    let sessionToken = localStorage.getItem('sniper_token') || null;
    try {
      const savedUser = localStorage.getItem('sniper_user');
      if (savedUser) currentUser = JSON.parse(savedUser);
    } catch(e) {}

    let activeAuthTab = 'login';
    let activeAdminTab = 'users';
    let allAdminUsers = [];
    let allAdminInvites = [];

    let currentLiveEthPrice = 2451.65;
    let currentFloorEth = 0;
    let activeFloorPercentPreset = 20;
    let activeRarityMultiplier = 1.25;
    let activeBlastTarget = 'top3';
    let activeTriggerMode = 'both';
    let activeGasPreset = 'turbo';
    let audioEnabled = true;
    let isArmed = false;
    let clientArmedTimestamp = 0;
    let clientDeadOrdersSet = new Set();

    // ─── 8 ADVANCED FEATURES CLIENT-SIDE STATE ───
    let isDryRun = false;              // Feature 4: Paper Snipe Mode (0 ETH spent)
    let activeMaxSnipesLimit = 1;       // Feature 1: Anti-Drain Circuit Breaker
    let snipesExecutedCount = 0;
    let activeWorkerStrategy = 'single';// Feature 6: 'single', 'round_robin', 'parallel_blitz'
    let isCustomGasOpen = false;        // Feature 5: Custom Gwei input row toggle
    let activeRuleStates = {            // Feature 8: Individual ON/OFF Rule Switches
      floor: true,
      rarity: true,
      trait: false,
      tokenId: false
    };
    let activeFilter = 'all';
    let currentTab = 'dashboard';
    let currentRpcStrategy = 'blast';
    let currentScannedProject = null;
    let liveListingsStore = [];
    let livePollerInterval = null;
    let genCount = 5;
    let activeModalWalletIndex = null;
    let isCheckingPings = false;
    let isCheckingStability = false;
    let openseaKeysData = [];
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
