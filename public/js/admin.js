/* ══════════════════════════════════════════════════════════════
   🛡️ AERO-SNIPER V2: MASTER OWNER ADMIN CONSOLE
   ══════════════════════════════════════════════════════════════ */

    function openAdminModal() {
      const isOwnerAdmin = currentUser && (currentUser.role === 'admin' || currentUser.email === 'jainbharat666@gmail.com');
      if (!isOwnerAdmin) {
        showToast('Master Admin access restricted to platform owner!', true);
        return;
      }
      const m = document.getElementById('admin-panel-modal');
      if (m) m.classList.remove('hidden');
      document.body.style.overflow = 'hidden';

      // Clear search query so all registered members are displayed by default
      const searchInp = document.getElementById('admin-user-search');
      if (searchInp) {
        searchInp.value = '';
        const clearBtn = document.getElementById('admin-search-clear-btn');
        if (clearBtn) clearBtn.classList.add('hidden');
      }
      currentAdminUserFilter = 'all';
      setAdminUserFilter('all');

      refreshAdminData();
      loadAdminFleetData();

      // Proactive anti-autofill purges in case browser injects credentials into search box
      setTimeout(purgeAutofilledEmail, 50);
      setTimeout(purgeAutofilledEmail, 200);
      setTimeout(purgeAutofilledEmail, 500);
      setTimeout(purgeAutofilledEmail, 1000);
      setTimeout(purgeAutofilledEmail, 2000);
      setTimeout(purgeAutofilledEmail, 3000);
    }

    function closeAdminModal() {
      const m = document.getElementById('admin-panel-modal');
      if (m) m.classList.add('hidden');
      document.body.style.overflow = '';
    }

    function switchAdminTab(tab) {
      activeAdminTab = tab;
      const tabUsers = document.getElementById('admin-tab-btn-users');
      const tabInvites = document.getElementById('admin-tab-btn-invites');
      const tabFleet = document.getElementById('admin-tab-btn-fleet');
      const tabTele = document.getElementById('admin-tab-btn-telemetry');

      const viewUsers = document.getElementById('admin-view-users');
      const viewInvites = document.getElementById('admin-view-invites');
      const viewFleet = document.getElementById('admin-view-fleet');
      const viewTele = document.getElementById('admin-view-telemetry');

      const activeCls = 'px-4 py-1.5 rounded-xl bg-white text-indigo-600 font-bold shadow-sm transition-all flex items-center gap-1.5';
      const inactiveCls = 'px-4 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 font-bold transition-all flex items-center gap-1.5';

      if (tabUsers) tabUsers.className = tab === 'users' ? activeCls : inactiveCls;
      if (tabInvites) tabInvites.className = tab === 'invites' ? activeCls : inactiveCls;
      if (tabFleet) tabFleet.className = tab === 'fleet' ? activeCls : inactiveCls;
      if (tabTele) tabTele.className = tab === 'telemetry' ? activeCls : inactiveCls;

      if (viewUsers) viewUsers.classList.toggle('hidden', tab !== 'users');
      if (viewInvites) viewInvites.classList.toggle('hidden', tab !== 'invites');
      if (viewFleet) viewFleet.classList.toggle('hidden', tab !== 'fleet');
      if (viewTele) viewTele.classList.toggle('hidden', tab !== 'telemetry');

      if (tab === 'fleet') {
        loadAdminFleetData();
      }
    }

    async function refreshAdminData() {
      if (!sessionToken) return;
      try {
        const [uRes, iRes] = await Promise.all([
          fetch('/api/users', { headers: { 'Authorization': `Bearer ${sessionToken}` } }),
          fetch('/api/invites', { headers: { 'Authorization': `Bearer ${sessionToken}` } })
        ]);

        const uData = await uRes.json();
        const iData = await iRes.json();

        if (uData.success) {
          allAdminUsers = uData.users || [];
          purgeAutofilledEmail();
          filterAdminUsers();
          const cntEl = document.getElementById('admin-user-count');
          const teleCntEl = document.getElementById('tele-users-count');
          if (cntEl) cntEl.innerText = allAdminUsers.length;
          if (teleCntEl) teleCntEl.innerText = allAdminUsers.length;
        }

        if (iData.success) {
          allAdminInvites = iData.invites || [];
          renderAdminInvites(allAdminInvites);
          const cntEl = document.getElementById('admin-invite-count');
          const teleCntEl = document.getElementById('tele-invites-count');
          if (cntEl) cntEl.innerText = allAdminInvites.length;
          if (teleCntEl) teleCntEl.innerText = allAdminInvites.filter(i => i.is_active).length;
        }

        showToast('Admin data refreshed');
      } catch(e) {
        showToast('Failed to refresh admin data: ' + e.message, true);
      }
    }

    function setAdminUserFilter(filter) {
      currentAdminUserFilter = filter;
      ['all', 'active', 'expired', 'exhausted', 'banned'].forEach(f => {
        const btn = document.getElementById(`uf-btn-${f}`);
        if (btn) {
          if (f === filter) {
            btn.className = 'px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 font-bold border border-indigo-200 shadow-sm';
          } else {
            btn.className = 'px-2.5 py-1 rounded-lg text-slate-600 hover:text-slate-900 font-medium transition-colors';
          }
        }
      });
      filterAdminUsers();
    }

    function filterAdminUsers() {
      const searchEl = document.getElementById('admin-user-search');
      const query = (searchEl?.value || '').toLowerCase().trim();
      const clearBtn = document.getElementById('admin-search-clear-btn');
      if (clearBtn) {
        clearBtn.classList.toggle('hidden', !query);
      }
      const filter = currentAdminUserFilter;

      const filtered = allAdminUsers.filter(u => {
        const matchesQuery = !query || 
          (u.email && u.email.toLowerCase().includes(query)) ||
          (u.id && u.id.toLowerCase().includes(query)) ||
          (u.invite_code_used && u.invite_code_used.toLowerCase().includes(query)) ||
          (u.invite_code && u.invite_code.toLowerCase().includes(query));
        
        if (!matchesQuery) return false;
        
        const isBanned = !!u.is_banned;
        const isExpiredTime = u.valid_until && new Date(u.valid_until).getTime() <= Date.now();
        const fMax = u.max_snipes_allowed !== undefined ? parseInt(u.max_snipes_allowed) : 0;
        const fUsed = u.snipes_used !== undefined ? u.snipes_used : (u.total_snipes || 0);
        const isExhaustedQuota = fMax > 0 && fUsed >= fMax;

        if (filter === 'active') return !isBanned && !isExpiredTime && !isExhaustedQuota;
        if (filter === 'expired') return isExpiredTime;
        if (filter === 'exhausted') return isExhaustedQuota;
        if (filter === 'banned') return isBanned;
        return true;
      });

      renderAdminUsers(filtered);
    }

    function clearAdminUserSearch() {
      const searchEl = document.getElementById('admin-user-search');
      if (searchEl) {
        searchEl.value = '';
      }
      filterAdminUsers();
    }

    function renderAdminUsers(users) {
      const tbody = document.getElementById('admin-users-tbody');
      if (!tbody) return;

      if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 font-sans">No users matching filter found.</td></tr>`;
        return;
      }

      tbody.innerHTML = users.map(u => {
        const isOwner = u.email === 'jainbharat666@gmail.com';
        const isBanned = !!u.is_banned;
        const uidShort = u.id ? u.id.substring(0, 8) : '--';
        
        let validStr = '<span class="text-indigo-700 font-bold">Lifetime</span>';
        if (u.valid_until) {
          const expDate = new Date(u.valid_until);
          const diffDays = Math.ceil((expDate - Date.now()) / (1000 * 60 * 60 * 24));
          validStr = diffDays > 0 ? `<span class="text-slate-800 font-bold">${diffDays}d</span> <span class="text-slate-400 font-normal">(${expDate.toLocaleDateString()})</span>` : `<span class="text-rose-600 font-bold">Expired</span>`;
        }

        const uMax = u.max_snipes_allowed !== undefined ? parseInt(u.max_snipes_allowed) : 0;
        const uUsed = u.snipes_used !== undefined ? u.snipes_used : (u.total_snipes || 0);
        const uRem = uMax > 0 ? Math.max(0, uMax - uUsed) : null;
        const quotaStr = (uMax === 0)
          ? '<span class="text-emerald-700 font-bold">∞ Unlimited</span>'
          : (uRem > 0 ? `<span class="text-purple-700 font-bold">${uRem} left</span> <span class="text-slate-500 font-normal">(${uUsed}/${uMax})</span>` : `<span class="text-rose-600 font-bold">0 left (${uUsed}/${uMax} Exhausted)</span>`);
        const statusBadge = isBanned 
          ? `<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-rose-50 text-rose-700 border border-rose-200">SUSPENDED</span>`
          : `<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">ACTIVE</span>`;

        return `
          <tr class="hover:bg-slate-50 transition-colors">
            <td class="py-2.5 px-3">
              <div class="font-black text-slate-900">${u.email}</div>
              <div class="text-[10px] text-slate-500 font-mono-code">UID: ${uidShort}</div>
            </td>
            <td class="py-2.5 px-3">
              <div class="font-bold text-indigo-700">${u.role || 'user'}</div>
              <div class="text-[10px] text-slate-500">${u.invite_code || 'Direct'}</div>
            </td>
            <td class="py-2.5 px-3">${validStr}</td>
            <td class="py-2.5 px-3">
              <div class="font-black">${quotaStr}</div>
              <div class="text-[10px] text-slate-500">Used: ${u.snipes_used || u.total_snipes || 0}</div>
            </td>
            <td class="py-2.5 px-3">${statusBadge}</td>
            <td class="py-2.5 px-3 text-right">
              ${isOwner ? `<span class="text-[10px] text-slate-500 font-bold italic">Master Owner</span>` : `
                <div class="flex items-center justify-end gap-1.5">
                  <button onclick="adminExtendValidity('${u.id}', 30)" title="Add +30 Days" class="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-[10px] font-black border border-indigo-200 shadow-sm transition-colors">+30d</button>
                  <button onclick="adminExtendSnipes('${u.id}', 10)" title="Add +10 Snipes" class="px-2 py-1 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-lg text-[10px] font-black border border-purple-200 shadow-sm transition-colors">+10🎯</button>
                  <button onclick="adminToggleBan('${u.id}')" title="${isBanned ? 'Unban' : 'Suspend'}" class="px-2 py-1 ${isBanned ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200' : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200'} rounded-lg text-[10px] font-black border shadow-sm transition-colors">
                    ${isBanned ? 'Unban' : 'Suspend'}
                  </button>
                  <button onclick="adminDeleteUser('${u.id}')" title="Delete User" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[10px] font-black border border-rose-200 shadow-sm transition-colors">✕</button>
                </div>
              `}
            </td>
          </tr>
        `;
      }).join('');
    }

    function renderAdminInvites(invites) {
      const tbody = document.getElementById('admin-invites-tbody');
      if (!tbody) return;

      if (!invites || invites.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 font-sans">No invite keys created yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = invites.map(inv => {
        const inviteCode = inv.invite_code || inv.code || '—';
        const isActive = inv.is_active !== false;
        const usesStr = `${inv.used_count || 0} / ${inv.max_uses || 1}`;
        const maxSnipes = inv.max_snipes_limit !== undefined ? inv.max_snipes_limit : (inv.snipes_quota !== undefined ? inv.snipes_quota : 0);
        const snipesStr = (maxSnipes === 0 || !maxSnipes) ? '<span class="text-emerald-700 font-bold">∞ Unlimited</span>' : `<span class="text-purple-700 font-bold">${maxSnipes}</span>`;
        const targetId = inv.id || inviteCode;

        return `
          <tr class="hover:bg-slate-50 transition-colors">
            <td class="py-2.5 px-3">
              <span class="font-black text-indigo-700 bg-indigo-50 px-2 py-1 rounded-md border border-indigo-200">${inviteCode}</span>
            </td>
            <td class="py-2.5 px-3 font-bold text-slate-800">${inv.validity_days || 30} Days</td>
            <td class="py-2.5 px-3">${snipesStr}</td>
            <td class="py-2.5 px-3 font-mono-code text-slate-600 font-bold">${usesStr}</td>
            <td class="py-2.5 px-3">
              <span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}">
                ${isActive ? 'ACTIVE' : 'DISABLED'}
              </span>
            </td>
            <td class="py-2.5 px-3 text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button onclick="adminToggleInvite('${targetId}', ${!isActive})" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold border border-slate-200 shadow-sm transition-colors">
                  ${isActive ? 'Disable' : 'Enable'}
                </button>
                <button onclick="adminDeleteInvite('${targetId}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[10px] font-bold border border-rose-200 shadow-sm transition-colors">
                  ✕
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    function generateDiceInviteCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let rand = '';
      for (let i = 0; i < 8; i++) {
        rand += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      const codeInput = document.getElementById('gen-invite-code');
      if (codeInput) codeInput.value = 'SNIPER-' + rand;
      playBeep(600, 'triangle', 0.1);
    }

    function setQuickInviteDays(days) {
      const d = document.getElementById('gen-invite-days');
      if (d) d.value = days;
    }

    function setQuickInviteSnipes(snipes) {
      const s = document.getElementById('gen-invite-snipes');
      if (s) s.value = snipes;
    }

    async function handleCreateInviteSubmit(event) {
      event.preventDefault();
      const code = document.getElementById('gen-invite-code')?.value?.trim().toUpperCase();
      const validity_days = parseInt(document.getElementById('gen-invite-days')?.value, 10) || 30;
      const snipes_quota = parseInt(document.getElementById('gen-invite-snipes')?.value, 10) || 0;
      const max_uses = parseInt(document.getElementById('gen-invite-uses')?.value, 10) || 1;

      if (!code) return;

      try {
        const res = await fetch('/api/invites/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ code, validity_days, snipes_quota, max_uses })
        });
        const d = await res.json();
        if (d.success) {
          showToast(`VIP Invite Key ${code} minted!`);
          document.getElementById('gen-invite-code').value = '';
          refreshAdminData();
        } else {
          showToast(d.error || 'Failed to mint code', true);
        }
      } catch(e) { showToast(e.message, true); }
    }

    async function adminExtendValidity(userId, days) {
      try {
        const res = await fetch('/api/users/extend-validity', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ userId, days })
        });
        const d = await res.json();
        if (d.success) {
          showToast(`Added +${days} days to user!`);
          refreshAdminData();
        } else {
          showToast(d.error || 'Failed', true);
        }
      } catch(e) { showToast(e.message, true); }
    }

    async function adminExtendSnipes(userId, count) {
      try {
        const res = await fetch('/api/users/extend-snipes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ userId, count })
        });
        const d = await res.json();
        if (d.success) {
          showToast(`Added +${count} snipes to user!`);
          refreshAdminData();
        } else {
          showToast(d.error || 'Failed', true);
        }
      } catch(e) { showToast(e.message, true); }
    }

    async function adminToggleBan(userId) {
      try {
        const res = await fetch('/api/users/toggle-ban', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ userId })
        });
        const d = await res.json();
        if (d.success) {
          showToast(d.message || 'User status updated');
          refreshAdminData();
        } else {
          showToast(d.error || 'Failed', true);
        }
      } catch(e) { showToast(e.message, true); }
    }

    async function adminDeleteUser(userId) {
      const ok = await showCustomConfirm('Are you sure you want to permanently delete this user and wipe their cloud data?', 'Delete User Account', { isDanger: true, confirmText: 'Delete User' });
      if (!ok) return;
      try {
        const res = await fetch('/api/users/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ userId, user_id: userId, id: userId })
        });
        const d = await res.json();
        if (d.success) {
          showToast('User deleted permanently');
          allAdminUsers = allAdminUsers.filter(u => u.id !== userId && u.user_id !== userId && u.email !== userId);
          filterAdminUsers();
          refreshAdminData();
        } else {
          showToast(d.error || 'Failed to delete user', true);
        }
      } catch(e) { showToast(e.message, true); }
    }

    async function adminToggleInvite(inviteId, isActive) {
      try {
        const res = await fetch('/api/invites/toggle', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ inviteId, isActive })
        });
        const d = await res.json();
        if (d.success) {
          showToast(d.message || 'Invite code updated');
          refreshAdminData();
        } else {
          showToast(d.error || 'Failed', true);
        }
      } catch(e) { showToast(e.message, true); }
    }

    async function adminDeleteInvite(inviteId) {
      const ok = await showCustomConfirm('Are you sure you want to permanently delete this invite key?', 'Delete Invite Key', { isDanger: true, confirmText: 'Delete Key' });
      if (!ok) return;
      try {
        const res = await fetch('/api/invites/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ inviteId })
        });
        const d = await res.json();
        if (d.success) {
          showToast('Invite code deleted');
          refreshAdminData();
        } else {
          showToast(d.error || 'Failed', true);
        }
      } catch(e) { showToast(e.message, true); }
    }

    // --- 8. MANAGED FLEET RPC CLUSTER (ADMIN CONSOLE TAB 3) ---
    async function loadAdminFleetData() {
      if (!sessionToken) return;
      try {
        const res = await fetch('/api/fleet-rpcs', {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await res.json();
        if (data.success) {
          allAdminFleetRpcs = data.fleetRpcs || [];
          renderAdminFleetTable(allAdminFleetRpcs);
        }
      } catch(e) {
        console.warn('Failed to load fleet RPCs:', e);
      }
    }

    function renderAdminFleetTable(fleetList) {
      const tbody = document.getElementById('admin-fleet-tbody');
      if (!tbody) return;
      if (!fleetList || fleetList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 font-sans">No fleet RPCs configured in cluster.</td></tr>`;
        return;
      }
      tbody.innerHTML = fleetList.map(r => {
        const isActive = r.isActive !== false && r.is_active !== false;
        return `
          <tr class="hover:bg-slate-50 transition-colors">
            <td class="py-2.5 px-3">
              <span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold">${r.network || r.network_key || 'robinhood'}</span>
            </td>
            <td class="py-2.5 px-3 font-bold text-slate-900">${r.name}</td>
            <td class="py-2.5 px-3 font-mono-code text-slate-500 max-w-[200px] truncate" title="${r.url}">${r.url}</td>
            <td class="py-2.5 px-3" id="fleet-ping-${r.id}">
              <span class="px-2 py-0.5 rounded-lg text-[9px] font-black border ${r.pingMs && r.pingMs < 150 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}">${r.pingMs ? r.pingMs + ' MS' : '--'}</span>
            </td>
            <td class="py-2.5 px-3">
              <button onclick="toggleFleetRpcActive('${r.id}', ${!isActive})" class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}">
                ${isActive ? '● ACTIVE' : '○ DISABLED'}
              </button>
            </td>
            <td class="py-2.5 px-3 text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button onclick="pingSingleFleetRpc('${r.id}', '${r.url}')" class="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-[10px] font-bold border border-amber-200 shadow-sm transition-colors" title="Ping Node">
                  <i class="fa-solid fa-bolt"></i>
                </button>
                <button onclick="deleteFleetRpc('${r.id}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[10px] font-bold border border-rose-200 shadow-sm transition-colors" title="Delete Node">
                  ✕
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    async function handleAddFleetRpcSubmit(event) {
      event.preventDefault();
      const name = document.getElementById('fleet-rpc-name')?.value?.trim();
      const network = document.getElementById('fleet-rpc-network')?.value || 'robinhood';
      const url = document.getElementById('fleet-rpc-url')?.value?.trim();
      if (!name || !url) return;

      try {
        const res = await fetch('/api/fleet-rpcs/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ rpc: { name, network, url, isActive: true } })
        });
        const d = await res.json();
        if (d.success) {
          showToast('Fleet RPC added to global cluster!');
          document.getElementById('fleet-rpc-name').value = '';
          document.getElementById('fleet-rpc-url').value = '';
          loadAdminFleetData();
        } else {
          showToast(d.error || 'Failed to add fleet RPC', true);
        }
      } catch(e) {
        showToast('Failed to add fleet RPC: ' + e.message, true);
      }
    }

    async function toggleFleetRpcActive(id, active) {
      try {
        const res = await fetch('/api/fleet-rpcs/toggle', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ id, active })
        });
        const d = await res.json();
        if (d.success) {
          showToast('Fleet RPC status updated');
          loadAdminFleetData();
        } else {
          showToast(d.error || 'Failed to toggle status', true);
        }
      } catch(e) {
        showToast(e.message, true);
      }
    }

    async function deleteFleetRpc(id) {
      const ok = await showCustomConfirm('Are you sure you want to remove this node from the global cluster?', 'Remove Cluster Node', { isDanger: true, confirmText: 'Remove Node' });
      if (!ok) return;
      try {
        const res = await fetch('/api/fleet-rpcs/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ id })
        });
        const d = await res.json();
        if (d.success) {
          showToast('Fleet RPC removed');
          loadAdminFleetData();
        } else {
          showToast(d.error || 'Failed to delete', true);
        }
      } catch(e) {
        showToast(e.message, true);
      }
    }

    async function testFleetRpcLatencies() {
      if (!allAdminFleetRpcs || allAdminFleetRpcs.length === 0) return;
      showToast('Benchmarking global fleet RPC cluster...');
      for (const rpc of allAdminFleetRpcs) {
        pingSingleFleetRpc(rpc.id, rpc.url);
      }
    }

    async function pingSingleFleetRpc(id, url) {
      const cell = document.getElementById(`fleet-ping-${id}`);
      if (cell) cell.innerHTML = `<span class="text-[9px] text-amber-600 font-bold animate-pulse">Pinging...</span>`;
      const t0 = performance.now();
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const lat = Math.round(performance.now() - t0);
        if (cell) {
          cell.innerHTML = `<span class="px-2 py-0.5 rounded-lg text-[9px] font-black border ${lat < 150 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}">${lat} MS</span>`;
        }
      } catch(e) {
        if (cell) {
          cell.innerHTML = `<span class="px-2 py-0.5 rounded-lg text-[9px] font-black bg-rose-50 text-rose-600 border border-rose-200">TIMEOUT</span>`;
        }
      }
    }

    // --- 9. LEGACY ALIASES FOR BACKWARD COMPATIBILITY ---