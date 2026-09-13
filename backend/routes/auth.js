import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import {
  OWNER_EMAIL,
  authLimiter,
  hashPassword,
  verifyPassword,
  dbGetUserByEmail,
  dbGetUserById,
  dbUpsertUser,
  dbUpdateUser,
  dbGetInviteByCode,
  dbUpsertInvite,
  dbUpdateInvite,
  dbGetUserConfig,
  dbSaveUserConfig,
  dbDeleteUserConfig,
  userAuthMiddleware,
  SUPABASE_URL,
  supabaseHeaders
} from '../db.js';

const router = express.Router();

// ─── 0. CLIENT IP DISCOVERY ──────────────────────────────────────────────────
router.get('/my-ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
  res.json({ ip });
});

// ─── 1. USER REGISTRATION (VIP INVITE CODE PROTECTED) ─────────────────────────
router.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, invite_code } = req.body;
    if (!email || !password || !invite_code) {
      return res.status(400).json({ success: false, error: 'Email, password, and VIP invite code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = invite_code.trim().toUpperCase().replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');
    const isOwner = cleanEmail === OWNER_EMAIL;

    // Verify VIP Invite Code in sniper_invites
    let inviteRecord = await dbGetInviteByCode(cleanCode);

    if (!inviteRecord && (cleanCode === 'SNIPER-VIP-2026' || cleanCode === 'SNIPER-VIP-ACCESS-2026' || cleanCode === 'AERO-VIP-ACCESS-2026' || isOwner)) {
      inviteRecord = {
        id: `inv_seed_${Date.now()}`,
        invite_code: cleanCode,
        validity_days: 365,
        max_snipes_limit: 0,
        max_uses: 500,
        used_count: 0,
        is_active: true
      };
      await dbUpsertInvite(inviteRecord).catch(() => {});
    }

    if (!inviteRecord && !isOwner) {
      return res.status(403).json({ success: false, error: '❌ Invalid VIP Invite Code. Access Denied.' });
    }

    if (inviteRecord && !inviteRecord.is_active && !isOwner) {
      return res.status(403).json({ success: false, error: '❌ This VIP Invite Code has been paused/deactivated.' });
    }

    if (inviteRecord && inviteRecord.max_uses && inviteRecord.used_count >= inviteRecord.max_uses && !isOwner) {
      return res.status(403).json({ success: false, error: '❌ This VIP Invite Code has reached its maximum registration limit.' });
    }

    const existingUser = await dbGetUserByEmail(cleanEmail);
    if (existingUser && !isOwner) {
      return res.status(400).json({ success: false, error: '⚠️ This email is already registered. Please go to "VIP Member Login" tab.' });
    }

    // Calculate Subscription Validity
    const validityDays = isOwner ? 3650 : (inviteRecord?.validity_days || 30);
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);

    const newUser = {
      id: existingUser ? existingUser.id : `sniper_u_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      email: cleanEmail,
      password_hash: hashPassword(password),
      role: isOwner ? 'admin' : 'vip_member',
      invite_code_used: cleanCode,
      valid_until: validUntil.toISOString(),
      max_snipes_allowed: isOwner ? 0 : (parseInt(inviteRecord?.max_snipes_limit) || 0),
      total_snipes: existingUser?.total_snipes || 0,
      is_banned: false,
      created_at: existingUser?.created_at || new Date().toISOString(),
      last_active_at: new Date().toISOString()
    };

    await dbUpsertUser(newUser);

    // Consume invite code count
    if (inviteRecord && inviteRecord.id) {
      await dbUpdateInvite(inviteRecord.id, { used_count: (inviteRecord.used_count || 0) + 1 }).catch(() => {});
    }

    // Generate unique single-device active session token
    const sessionToken = `sniper_sess_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    await dbSaveUserConfig(newUser.id, { session_token: sessionToken, last_login_ip: req.ip });

    console.log(`[Sniper DB] Registered new user: ${cleanEmail}`);

    const regAllowed = parseInt(newUser.max_snipes_allowed) || 0;
    const regUsed = newUser.total_snipes || 0;
    const regRem = regAllowed > 0 ? Math.max(0, regAllowed - regUsed) : null;

    const clientSafeUser = {
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      invite_code_used: newUser.invite_code_used,
      valid_until: newUser.valid_until,
      max_snipes_allowed: regAllowed,
      total_snipes: regUsed,
      snipes_used: regUsed,
      snipes_remaining: regRem !== null ? regRem : 0,
      is_banned: newUser.is_banned,
      created_at: newUser.created_at,
      user_metadata: { role: newUser.role, name: cleanEmail.split('@')[0] }
    };
    const userConfig = await dbGetUserConfig(newUser.id);
    return res.json({ success: true, user: clientSafeUser, sessionToken: sessionToken, config: userConfig });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 2. USER LOGIN (WITH SINGLE-DEVICE CONCURRENCY LOCK) ───────────────────────
router.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const isOwner = cleanEmail === OWNER_EMAIL;
    let user = await dbGetUserByEmail(cleanEmail);

    const sessionToken = `sniper_sess_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // 1. Account existence check
    if (!user) {
      if (isOwner) {
        user = {
          id: 'owner-sniper-master-001',
          email: cleanEmail,
          password_hash: hashPassword(password),
          role: 'admin',
          invite_code_used: 'ROOT-OWNER',
          valid_until: '2099-12-31T23:59:59+00:00',
          max_snipes_allowed: 0,
          total_snipes: 0,
          is_banned: false,
          created_at: new Date().toISOString(),
          last_active_at: new Date().toISOString()
        };
        await dbUpsertUser(user);
      } else {
        return res.status(404).json({ success: false, error: '❌ Account not found. Please register with a VIP Invite Code first.' });
      }
    }

    // 2. STRICT PASSWORD VERIFICATION FOR EVERYONE (INCLUDING OWNER!)
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: '❌ Incorrect password. Please try again.' });
    }

    // 3. Auto-upgrade legacy hash if needed
    if (user.password_hash && !user.password_hash.startsWith('$2')) {
      await dbUpdateUser(user.id, { password_hash: hashPassword(password) });
    }

    // 4. Ban check (Owner is never banned)
    if (user.is_banned && !isOwner) {
      return res.status(403).json({ success: false, error: '🚫 Account Suspended. Your access has been deactivated by Administrator.' });
    }

    // 5. Expiry & Quota checks (Exempt for owner)
    if (!isOwner) {
      if (user.valid_until && new Date(user.valid_until) < new Date()) {
        return res.status(403).json({
          success: false,
          error: `⏳ VIP Validity Expired. Your subscription ended on ${new Date(user.valid_until).toLocaleDateString()}. Please contact Admin to renew.`
        });
      }

      if (user.max_snipes_allowed > 0 && user.total_snipes >= user.max_snipes_allowed) {
        return res.status(403).json({
          success: false,
          error: `🎯 Snipes Quota Exhausted. You have completed all ${user.max_snipes_allowed} allocated snipes for this key. Contact Admin to extend quota.`
        });
      }
    }

    // 6. Update last active timestamp ONLY
    await dbUpdateUser(user.id, {
      last_active_at: new Date().toISOString(),
      ...(isOwner ? { role: 'admin', is_banned: false } : {})
    });

    // 7. Single-device concurrency lock: overwrite sessionToken
    await dbSaveUserConfig(user.id, { session_token: sessionToken, last_login_ip: req.ip });
    const userConfig = await dbGetUserConfig(user.id);

    const logAllowed = isOwner ? 0 : (parseInt(user.max_snipes_allowed) || 0);
    const logUsed = user.total_snipes !== undefined ? user.total_snipes : (user.snipes_used || 0);
    const logRem = logAllowed > 0 ? Math.max(0, logAllowed - logUsed) : null;

    const clientSafeUser = {
      id: user.id,
      email: user.email,
      role: isOwner ? 'admin' : (user.role || 'vip_member'),
      invite_code_used: user.invite_code_used,
      valid_until: isOwner ? '2099-12-31T23:59:59+00:00' : user.valid_until,
      max_snipes_allowed: logAllowed,
      total_snipes: logUsed,
      snipes_used: logUsed,
      snipes_remaining: logRem,
      is_banned: false,
      created_at: user.created_at,
      user_metadata: isOwner ? { role: 'admin', name: 'Bharat' } : { role: user.role || 'vip_member', name: cleanEmail.split('@')[0] }
    };

    return res.json({ success: true, user: clientSafeUser, sessionToken: sessionToken, config: userConfig });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 3. REAL-TIME ACTIVE SESSION HEARTBEAT ─────────────────────────────────────
router.get('/auth/heartbeat', async (req, res) => {
  try {
    let { email, userId, sessionToken } = req.query;
    if (!sessionToken && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      sessionToken = req.headers.authorization.split('Bearer ')[1].trim();
    }
    if (!email && !userId && sessionToken) {
      try {
        const configRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>session_token=eq.${encodeURIComponent(sessionToken)}`, {
          headers: supabaseHeaders,
          timeout: 4000
        });
        if (configRes.data && configRes.data.length > 0) {
          userId = configRes.data[0].user_id;
        }
      } catch(e) {}
    }
    if (!email && !userId) return res.status(400).json({ valid: false });

    const cleanEmail = (email || '').trim().toLowerCase();
    const isOwner = cleanEmail === OWNER_EMAIL;
    
    let user = null;
    if (userId) user = await dbGetUserById(userId);
    if (!user && cleanEmail) user = await dbGetUserByEmail(cleanEmail);

    if (!user) {
      return res.json({
        valid: false,
        reason: 'USER_DELETED',
        message: '🚫 Session terminated. User account was deleted by Administrator.'
      });
    }

    if (isOwner) {
      return res.json({
        valid: true,
        valid_until: '2099-12-31T23:59:59+00:00',
        max_snipes_allowed: 0,
        total_snipes: 0,
        is_banned: false,
        role: 'admin'
      });
    }

    if (user.is_banned) {
      return res.json({
        valid: false,
        reason: 'BANNED',
        message: '🚫 Your account has been suspended by Administrator.'
      });
    }

    // Single-device concurrency check
    if (sessionToken && user.id) {
      const config = await dbGetUserConfig(user.id);
      if (config && config.session_token && config.session_token !== sessionToken) {
        return res.json({
          valid: false,
          reason: 'CONCURRENT_LOGIN',
          message: '⚠️ Session Overwritten: Your account was just logged in from another device/browser. Multi-device account sharing is disabled.'
        });
      }
    }

    // Check Time Expiry
    if (user.valid_until && new Date(user.valid_until) < new Date()) {
      return res.json({
        valid: false,
        reason: 'EXPIRED_TIME',
        message: `⏳ Your VIP Time Validity has expired on ${new Date(user.valid_until).toLocaleDateString()}. Contact Admin to renew.`
      });
    }

    // Check Snipes Quota Expiry
    if (user.max_snipes_allowed > 0 && (user.total_snipes || 0) >= user.max_snipes_allowed) {
      return res.json({
        valid: false,
        reason: 'EXPIRED_SNIPES',
        message: `🎯 Snipes Quota Reached! You have used all ${user.max_snipes_allowed}/${user.max_snipes_allowed} snipes allocated to this key.`
      });
    }

    const hbMax = user.max_snipes_allowed !== undefined ? parseInt(user.max_snipes_allowed) : 0;
    const hbUsed = user.total_snipes !== undefined ? user.total_snipes : (user.snipes_used || 0);
    const hbRem = hbMax > 0 ? Math.max(0, hbMax - hbUsed) : null;
    return res.json({
      valid: true,
      valid_until: user.valid_until,
      max_snipes_allowed: hbMax,
      snipes_remaining: hbRem,
      snipes_used: hbUsed,
      total_snipes: hbUsed,
      is_banned: false,
      role: user.role
    });
  } catch (err) {
    console.error('[Sniper Heartbeat Error]:', err.message);
    return res.json({ valid: false, error: 'HEARTBEAT_ERROR', message: 'Unable to verify session. Please retry.' });
  }
});

// ─── 4. CHANGE PASSWORD ───────────────────────────────────────────────────────
router.post('/auth/change-password', async (req, res) => {
  try {
    const email = req.body.email;
    const oldPassword = req.body.oldPassword || req.body.current_password;
    const newPassword = req.body.newPassword || req.body.new_password;
    if (!email || !oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Email, current password, and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await dbGetUserByEmail(cleanEmail);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (!verifyPassword(oldPassword, user.password_hash)) {
      return res.status(401).json({ success: false, error: '❌ Current password is incorrect.' });
    }

    await dbUpdateUser(user.id, {
      password_hash: hashPassword(newPassword)
    });

    console.log(`[Sniper DB] Password changed successfully for: ${cleanEmail}`);
    return res.json({ success: true, message: '✅ Password changed successfully!' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 5. REDEEM TOP-UP / RENEWAL CODE ───────────────────────────────────────────
router.post('/auth/redeem-topup', async (req, res) => {
  try {
    const email = req.body.email;
    const topupCode = req.body.topupCode || req.body.invite_code || req.body.code;
    if (!email || !topupCode) {
      return res.status(400).json({ success: false, error: 'Email and Top-up Code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = topupCode.trim().toUpperCase().replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');

    const codeRecord = await dbGetInviteByCode(cleanCode);
    if (!codeRecord) {
      return res.status(404).json({ success: false, error: '❌ Invalid Top-up / Renewal Code.' });
    }

    if (!codeRecord.is_active) {
      return res.status(403).json({ success: false, error: '❌ This code has been deactivated.' });
    }

    if (codeRecord.max_uses && codeRecord.used_count >= codeRecord.max_uses) {
      return res.status(403).json({ success: false, error: '❌ This top-up code has already reached its redemption limit.' });
    }

    const user = await dbGetUserByEmail(cleanEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    const addDays = codeRecord.validity_days || 30;
    const baseDate = new Date(user.valid_until) > new Date() ? new Date(user.valid_until) : new Date();
    baseDate.setDate(baseDate.getDate() + addDays);
    const newValidUntil = baseDate.toISOString();

    let newMaxSnipes = user.max_snipes_allowed;
    if (codeRecord.max_snipes_limit > 0) {
      newMaxSnipes = (user.max_snipes_allowed || 0) + codeRecord.max_snipes_limit;
    } else if (codeRecord.max_snipes_limit === 0) {
      newMaxSnipes = 0; // unlimited
    }

    await dbUpdateUser(user.id, {
      valid_until: newValidUntil,
      max_snipes_allowed: newMaxSnipes
    });

    if (codeRecord.id) {
      await dbUpdateInvite(codeRecord.id, { used_count: (codeRecord.used_count || 0) + 1 });
    }

    console.log(`[Sniper DB] Top-up applied for ${cleanEmail}: +${addDays}d`);
    return res.json({
      success: true,
      message: `🎉 Top-up applied! Added +${addDays} Days & updated Snipes Quota.`,
      valid_until: newValidUntil,
      max_snipes_allowed: newMaxSnipes
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 6. CLOUD USER CONFIG & WALLET VAULT PERSISTENCE (AUTHENTICATED) ─────────
router.get('/user-config', userAuthMiddleware, async (req, res) => {
  try {
    const targetUserId = req.query.userId || req.authenticatedUser.id;
    const isOwnerOrAdmin = req.authenticatedUser.role === 'admin' || req.authenticatedUser.email?.toLowerCase() === OWNER_EMAIL;
    if (!isOwnerOrAdmin && req.authenticatedUser.id !== targetUserId) {
      return res.status(403).json({ success: false, error: 'Unauthorized. You can only access your own cloud vault.' });
    }
    const config = await dbGetUserConfig(targetUserId);
    return res.json({ success: true, config });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/user-config', userAuthMiddleware, async (req, res) => {
  try {
    const targetUserId = req.body.userId || req.authenticatedUser.id;
    const isOwnerOrAdmin = req.authenticatedUser.role === 'admin' || req.authenticatedUser.email?.toLowerCase() === OWNER_EMAIL;
    if (!isOwnerOrAdmin && req.authenticatedUser.id !== targetUserId) {
      return res.status(403).json({ success: false, error: 'Unauthorized. You can only save to your own cloud vault.' });
    }
    const { userId, config, ...rest } = req.body;
    const payloadToSave = config || rest;
    const saved = await dbSaveUserConfig(targetUserId, payloadToSave);
    return res.json({ success: true, message: 'Cloud Vault config saved successfully.', config: saved });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/user-config', userAuthMiddleware, async (req, res) => {
  try {
    const targetUserId = req.query.userId || req.body?.userId || req.authenticatedUser.id;
    const isOwnerOrAdmin = req.authenticatedUser.role === 'admin' || req.authenticatedUser.email?.toLowerCase() === OWNER_EMAIL;
    if (!isOwnerOrAdmin && req.authenticatedUser.id !== targetUserId) {
      return res.status(403).json({ success: false, error: 'Unauthorized. You can only delete your own cloud vault.' });
    }
    await dbDeleteUserConfig(targetUserId);
    return res.json({ success: true, message: 'Cloud Vault data wiped from server.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
