/* ══════════════════════════════════════════════════════════════
   🚀 AERO-SNIPER V2: APPLICATION BOOTSTRAP & THEME ENGINE
   ══════════════════════════════════════════════════════════════ */

    // =========================================================================
    // 👑 VIP AUTHENTICATION, HARD AUTH GATE, HEARTBEAT & CLOUD VAULT SYNC
    // =========================================================================

    // 👑 VIP AUTHENTICATION, HARD AUTH GATE, HEARTBEAT & CLOUD VAULT SYNC
    // =========================================================================

    // ☀️/🌙 DAY-NIGHT THEME TOGGLE ENGINE (AEROMINT V2/V3 CIRCULAR RIPPLE TRANSITION)
    let isThemeTransitioning = false;

    function initThemeFromStorage() {
      const saved = localStorage.getItem('sniper_theme_mode') || 'day';
      const toggle = document.getElementById('header-theme-toggle');
      const knobIcon = document.getElementById('theme-knob-icon');
      if (saved === 'night') {
        document.body.classList.remove('day-mode');
        document.body.classList.add('night-mode');
        document.documentElement.classList.remove('day-mode');
        document.documentElement.classList.add('night-mode');
        if (toggle) {
          toggle.className = 'ios-theme-toggle night';
          toggle.title = 'Switch to Day Mode (Light)';
        }
        if (knobIcon) knobIcon.textContent = '🌙';
      } else {
        document.body.classList.remove('night-mode');
        document.body.classList.add('day-mode');
        document.documentElement.classList.remove('night-mode');
        document.documentElement.classList.add('day-mode');
        if (toggle) {
          toggle.className = 'ios-theme-toggle day';
          toggle.title = 'Switch to Night Mode (Dark)';
        }
        if (knobIcon) knobIcon.textContent = '☀️';
      }
      ['floor', 'rarity', 'trait', 'tokenId'].forEach(r => { if (typeof refreshSingleRuleSwitchUI === 'function') refreshSingleRuleSwitchUI(r); });
      if (typeof switchRuleDeck === 'function') switchRuleDeck(currentRuleDeck || 'floor');
    }

    function toggleThemeMode(e) {
      if (typeof playBeep === 'function') playBeep(900, 'sine', 0.05);
      if (isThemeTransitioning) return;

      const isCurrentlyNight = document.body.classList.contains('night-mode');
      const targetTheme = isCurrentlyNight ? 'day' : 'night';

      const applyTheme = () => {
        const toggle = document.getElementById('header-theme-toggle');
        const knobIcon = document.getElementById('theme-knob-icon');
        if (targetTheme === 'night') {
          document.body.classList.remove('day-mode');
          document.body.classList.add('night-mode');
          document.documentElement.classList.remove('day-mode');
          document.documentElement.classList.add('night-mode');
          if (toggle) {
            toggle.className = 'ios-theme-toggle night';
            toggle.title = 'Switch to Day Mode (Light)';
          }
          if (knobIcon) knobIcon.textContent = '🌙';
          localStorage.setItem('sniper_theme_mode', 'night');
        } else {
          document.body.classList.remove('night-mode');
          document.body.classList.add('day-mode');
          document.documentElement.classList.remove('night-mode');
          document.documentElement.classList.add('day-mode');
          if (toggle) {
            toggle.className = 'ios-theme-toggle day';
            toggle.title = 'Switch to Night Mode (Dark)';
          }
          if (knobIcon) knobIcon.textContent = '☀️';
          localStorage.setItem('sniper_theme_mode', 'day');
        }
        ['floor', 'rarity', 'trait', 'tokenId'].forEach(r => { if (typeof refreshSingleRuleSwitchUI === 'function') refreshSingleRuleSwitchUI(r); });
        if (typeof renderRpcFleet === 'function') renderRpcFleet();
        if (typeof renderOpenSeaKeysList === 'function') renderOpenSeaKeysList();
        if (typeof switchRuleDeck === 'function') switchRuleDeck(currentRuleDeck || 'floor');
      };

      if (!document.startViewTransition) {
        applyTheme();
        return;
      }

      const rect = e?.currentTarget?.getBoundingClientRect?.();
      const x = rect ? rect.left + rect.width / 2 : (e?.clientX ?? window.innerWidth - 80);
      const y = rect ? rect.top + rect.height / 2 : (e?.clientY ?? 40);
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );

      isThemeTransitioning = true;
      document.documentElement.classList.add('theme-transitioning');
      try {
        const transition = document.startViewTransition(() => {
          applyTheme();
        });
        transition.ready.then(() => {
          const animation = document.documentElement.animate(
            {
              clipPath: [
                `circle(0px at ${x}px ${y}px)`,
                `circle(${endRadius}px at ${x}px ${y}px)`
              ]
            },
            {
              duration: 450,
              easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
              pseudoElement: '::view-transition-new(root)'
            }
          );
          animation.finished.finally(() => {
            document.documentElement.classList.remove('theme-transitioning');
            isThemeTransitioning = false;
          });
        }).catch(() => {
          document.documentElement.classList.remove('theme-transitioning');
          isThemeTransitioning = false;
        });
      } catch(err) {
        applyTheme();
        document.documentElement.classList.remove('theme-transitioning');
        isThemeTransitioning = false;
      }
    }

    // AUTH GATE TOGGLES & HELPERS
    let activeGateTab = 'login';


    function openChangePasswordModal() {
      openUserProfileModal('security');
    }
    function closeChangePasswordModal() {}
    function openRedeemTopupModal() {
      openUserProfileModal('renew');
    }
    function closeRedeemTopupModal() {}
    async function syncSniperConfigToCloud() {
      await handleCloudVaultBackup();
    }
    async function loadSniperConfigFromCloud(silent = false) {
      await handleCloudVaultRestore();
    }

    // 🛡️ INITIALIZE HARD AUTH GATE (IMPERMEABLE FULL-PAGE VIP ENFORCEMENT)
    initThemeFromStorage();
    fetchRealClientIp();
    fetchRealTimeBlockNum();
    setInterval(fetchRealTimeBlockNum, 6000);
    const isAuthed = checkAuthState();
    if (isAuthed) {
      checkAuthHeartbeat();
      loadUserScopedWallets();
      loadUserRpcsAndFleet(currentUser);
    }