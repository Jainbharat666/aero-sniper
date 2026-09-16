import express from 'express';
import axios from 'axios';
import {
  OWNER_EMAIL,
  SUPABASE_URL,
  supabaseHeaders,
  dbGetUsers,
  dbGetUserById,
  dbGetUserByEmail,
  dbUpdateUser,
  dbDeleteUser,
  dbGetUserConfig,
  dbSaveUserConfig,
  dbDeleteUserConfig,
  dbRecordUserSnipe,
  dbGetInvites,
  dbUpsertInvite,
  dbUpdateInvite,
  dbDeleteInvite,
  adminAuthMiddleware,
  userAuthMiddleware
} from '../db.js';

const router = express.Router();

// ─── 1. FETCH ALL REGISTERED USERS WITH TELEGRAM STATUS ─────────────────────
router.get('/users', adminAuthMiddleware, async (req, res) => {
  const users = await dbGetUsers();

  // Enrich with user configs for live Telegram account status
  let configMap = new Map();
  try {
    const configRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config`, {
      headers: supabaseHeaders,
      timeout: 6000
    });
    if (configRes.data && Array.isArray(configRes.data)) {
      configRes.data.forEach(item => {
        if (item.user_id) configMap.set(item.user_id, item.config || {});
      });
    }
  } catch (e) {
    console.warn('[ADMIN GET USERS] Configs fetch failed:', e.message);
  }
  
  if (!users.some(u => u.email === OWNER_EMAIL)) {
    users.unshift({
      id: 'owner_sniper_001',
      email: OWNER_EMAIL,
      role: 'admin',
      invite_code_used: 'MASTER_OWNER_KEY',
      valid_until: new Date(Date.now() + 3650 * 86400000).toISOString(),
      max_snipes_allowed: 0,
      total_snipes: 0,
      is_banned: false,
      created_at: new Date('2026-01-01').toISOString(),
      last_active_at: new Date().toISOString()
    });
  }

  const safeList = users.map(u => {
    const cfg = configMap.get(u.id) || {};
    const tgChatId = cfg.telegram_chat_id || u.telegram_chat_id || null;
    const isTgLinked = !!tgChatId;

    return {
      id: u.id,
      user_id: u.id,
      email: u.email,
      role: u.email === OWNER_EMAIL ? 'admin' : (u.role || 'vip_member'),
      invite_code_used: u.invite_code_used || '—',
      valid_until: u.valid_until,
      max_snipes_allowed: u.max_snipes_allowed || 0,
      total_snipes: u.total_snipes || 0,
      is_banned: Boolean(u.is_banned),
      created_at: u.created_at,
      last_active_at: u.last_active_at,
      // 📱 Telegram Remote Terminal Details
      is_telegram_linked: isTgLinked,
      telegram_chat_id: tgChatId,
      telegram_username: cfg.telegram_username || null,
      telegram_first_name: cfg.telegram_first_name || null,
      telegram_linked_at: cfg.telegram_linked_at || null,
      telegram_link_token: cfg.telegram_link_token || null
    };
  });

  res.json({ success: true, users: safeList });
});

// ─── 1B. ADMIN RESET / UNLINK TELEGRAM ACCESS ───────────────────────────────
router.post('/users/reset-telegram', adminAuthMiddleware, async (req, res) => {
  try {
    const userId = req.body.userId || req.body.user_id || req.body.id;
    if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });

    const user = await dbGetUserById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Clear config
    const currentConfig = (await dbGetUserConfig(user.id)) || {};
    delete currentConfig.telegram_chat_id;
    delete currentConfig.telegram_username;
    delete currentConfig.telegram_first_name;
    delete currentConfig.telegram_linked_at;
    delete currentConfig.telegram_link_token;
    delete currentConfig.telegram_token_expires_at;

    await dbSaveUserConfig(user.id, currentConfig, true);
    await dbUpdateUser(user.id, { telegram_chat_id: null }).catch(() => {});

    console.log(`[Sniper Admin] Telegram link reset by Admin for user: ${user.email} (${user.id})`);
    return res.json({
      success: true,
      message: `Telegram access revoked & reset for ${user.email}. User can now generate a fresh link.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 2. ADJUST VALIDITY (DAYS, HOURS, MINUTES OR LIFETIME) ───────────────────
router.post('/users/extend-validity', adminAuthMiddleware, async (req, res) => {
  try {
    const userId = req.body.userId || req.body.user_id;
    const user = await dbGetUserById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    let newValidUntil;
    if (req.body.set_lifetime) {
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 10);
      newValidUntil = farFuture.toISOString();
    } else if (req.body.valid_until) {
      newValidUntil = new Date(req.body.valid_until).toISOString();
    } else {
      const now = new Date();
      // If user validity is still active in future, add/subtract from it. Otherwise start from now.
      const baseDate = (user.valid_until && new Date(user.valid_until) > now) 
        ? new Date(user.valid_until) 
        : new Date(now);

      const addMinutes = parseInt(req.body.minutes) || 0;
      const addHours = parseInt(req.body.hours) || 0;
      const addDays = parseInt(req.body.days) || 0;

      const totalMsDelta = (addDays * 24 * 60 * 60 * 1000) + (addHours * 60 * 60 * 1000) + (addMinutes * 60 * 1000);
      const targetTime = baseDate.getTime() + totalMsDelta;
      newValidUntil = new Date(targetTime).toISOString();
    }

    const updated = await dbUpdateUser(user.id, { valid_until: newValidUntil });
    if (updated) return res.json({ success: true, valid_until: updated.valid_until });
    return res.status(500).json({ success: false, error: 'Update failed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 4. TOGGLE BAN ────────────────────────────────────────────────────────────
router.post('/users/toggle-ban', adminAuthMiddleware, async (req, res) => {
  try {
    const userId = req.body.userId || req.body.user_id;
    const user = await dbGetUserById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const isBanned = req.body.is_banned !== undefined ? Boolean(req.body.is_banned) : !user.is_banned;
    const updated = await dbUpdateUser(user.id, { is_banned: isBanned });
    if (updated) {
      console.log(`[Sniper DB] User ${updated.email} ban state set to: ${updated.is_banned}`);
      return res.json({ success: true, is_banned: updated.is_banned, message: isBanned ? 'User banned' : 'User unbanned' });
    }
    return res.status(500).json({ success: false, error: 'Update failed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 5. PERMANENTLY DELETE USER ───────────────────────────────────────────────
router.post('/users/delete', adminAuthMiddleware, async (req, res) => {
  try {
    const target = req.body.userId || req.body.user_id || req.body.id || req.body.email;
    if (!target) return res.status(400).json({ success: false, error: 'User ID or email is required' });

    let user = await dbGetUserById(target);
    if (!user) user = await dbGetUserByEmail(target);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    if (user.email === OWNER_EMAIL) {
      return res.status(400).json({ success: false, error: 'Cannot delete platform owner account' });
    }

    const ok = await dbDeleteUser(user.id);
    await dbDeleteUserConfig(user.id);
    if (ok) {
      console.log(`[Sniper DB] Permanently deleted user ${user.email} (${user.id})`);
      return res.json({ success: true, message: 'User deleted permanently' });
    }
    return res.status(500).json({ success: false, error: 'Delete failed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 6. RECORD ON-CHAIN SNIPE OPERATION (AUTHENTICATED) ───────────────────────
router.post('/users/record-snipe', userAuthMiddleware, async (req, res) => {
  try {
    const { user_id, email, count } = req.body;
    const identifier = user_id || email || req.authenticatedUser.id;
    const isOwnerOrAdmin = req.authenticatedUser.role === 'admin' || req.authenticatedUser.email?.toLowerCase() === OWNER_EMAIL;
    if (!isOwnerOrAdmin && req.authenticatedUser.id !== identifier && req.authenticatedUser.email?.toLowerCase() !== String(identifier).toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Unauthorized. You can only record snipes for your own account.' });
    }
    const newTotal = await dbRecordUserSnipe(identifier, parseInt(count) || 1);
    if (newTotal !== null) return res.json({ success: true, total_snipes: newTotal });
    return res.status(404).json({ success: false, error: 'User not found' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 7. FETCH ALL VIP INVITES ─────────────────────────────────────────────────
router.get('/invites', adminAuthMiddleware, async (req, res) => {
  const invites = await dbGetInvites();
  res.json({ success: true, invites });
});

// ─── 8. CREATE DUAL-CONSTRAINT VIP INVITE CODE ────────────────────────────────
router.post('/invites/create', adminAuthMiddleware, async (req, res) => {
  try {
    const code = req.body.code;
    const validityDays = req.body.validityDays || req.body.validity_days || 30;
    const maxSnipesLimit = req.body.maxSnipesLimit !== undefined ? req.body.maxSnipesLimit : (req.body.snipes_quota !== undefined ? req.body.snipes_quota : 0);
    const maxUses = req.body.maxUses || req.body.max_uses || 1;
    if (!code) return res.status(400).json({ success: false, error: 'Code is required' });

    const clean = code.trim().toUpperCase().replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');
    const newInvite = {
      invite_code: clean,
      note: 'VIP Access Key (Admin Generated)',
      validity_days: parseInt(validityDays) || 30,
      max_snipes_limit: parseInt(maxSnipesLimit) || 0,
      max_uses: parseInt(maxUses) || 1,
      used_count: 0,
      is_active: true
    };

    const saved = await dbUpsertInvite(newInvite);
    return res.json({ success: true, invite: saved });
  } catch (err) {
    console.error('[Sniper DB - CreateInvite Error]:', err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
  }
});

// ─── 9. TOGGLE INVITE ACTIVE ──────────────────────────────────────────────────
router.post('/invites/toggle', adminAuthMiddleware, async (req, res) => {
  try {
    const inviteId = req.body.inviteId || req.body.invite_id || req.body.id || req.body.code || req.body.invite_code;
    const isActive = req.body.isActive !== undefined ? req.body.isActive : req.body.is_active;
    if (!inviteId) return res.status(400).json({ success: false, error: 'inviteId is required' });
    const updated = await dbUpdateInvite(inviteId, { is_active: Boolean(isActive) });
    if (updated) return res.json({ success: true, message: 'Invite status updated' });
    return res.status(500).json({ success: false, error: 'Failed to update invite in database' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 10. DELETE INVITE ────────────────────────────────────────────────────────
router.post('/invites/delete', adminAuthMiddleware, async (req, res) => {
  try {
    const inviteId = req.body.inviteId || req.body.invite_id || req.body.id || req.body.code || req.body.invite_code;
    if (!inviteId) return res.status(400).json({ success: false, error: 'inviteId is required' });
    const ok = await dbDeleteInvite(inviteId);
    if (ok) return res.json({ success: true, message: 'Invite deleted successfully' });
    return res.status(500).json({ success: false, error: 'Failed to delete invite from database' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
