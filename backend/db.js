import axios from 'axios';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

export const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://fjxarhcisasyvomfgtxl.supabase.co').replace(/\/$/, '');
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

export const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
};

export const OWNER_EMAIL = 'jainbharat666@gmail.com';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { success: false, error: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const BCRYPT_ROUNDS = 10;
export function hashPassword(pwd) {
  return bcrypt.hashSync(String(pwd), BCRYPT_ROUNDS);
}
export function verifyPassword(pwd, hash) {
  if (hash && hash.startsWith('$2')) {
    return bcrypt.compareSync(String(pwd), hash);
  }
  const sha256 = crypto.createHash('sha256').update(String(pwd)).digest('hex');
  return sha256 === hash;
}

export async function dbGetUsers() {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_users?select=*&order=created_at.desc`, { headers: supabaseHeaders, timeout: 8000 });
    return res.data || [];
  } catch (e) {
    console.error('[Sniper DB - GetUsers]:', e.response?.data || e.message);
    return [];
  }
}

export async function dbGetUserByEmail(email) {
  try {
    const clean = (email || '').trim().toLowerCase();
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_users?email=ilike.${encodeURIComponent(clean)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    console.error('[Sniper DB - GetUserByEmail]:', e.response?.data || e.message);
    return null;
  }
}

export async function dbGetUserById(id) {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_users?id=eq.${encodeURIComponent(id)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    return null;
  }
}

export async function dbUpsertUser(userObj) {
  try {
    const res = await axios.post(`${SUPABASE_URL}/rest/v1/sniper_users?on_conflict=id`, userObj, {
      headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
      timeout: 8000
    });
    return (res.data && res.data.length > 0) ? res.data[0] : userObj;
  } catch (e) {
    console.error('[Sniper DB - UpsertUser]:', e.response?.data || e.message);
    throw e;
  }
}

export async function dbUpdateUser(userId, updates) {
  try {
    const res = await axios.patch(`${SUPABASE_URL}/rest/v1/sniper_users?id=eq.${encodeURIComponent(userId)}`, updates, {
      headers: supabaseHeaders,
      timeout: 8000
    });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    console.error('[Sniper DB - UpdateUser]:', e.response?.data || e.message);
    return null;
  }
}

export async function dbDeleteUser(userId) {
  try {
    await axios.delete(`${SUPABASE_URL}/rest/v1/sniper_users?id=eq.${encodeURIComponent(userId)}`, { headers: supabaseHeaders, timeout: 8000 });
    return true;
  } catch (e) {
    console.error('[Sniper DB - DeleteUser]:', e.response?.data || e.message);
    return false;
  }
}

export async function dbRecordUserSnipe(userIdOrEmail, count = 1) {
  try {
    let user = await dbGetUserById(userIdOrEmail);
    if (!user) user = await dbGetUserByEmail(userIdOrEmail);
    if (user) {
      const updatedTotal = (user.total_snipes || 0) + count;
      const updates = {
        total_snipes: updatedTotal,
        snipes_used: (user.snipes_used || 0) + count,
        last_active_at: new Date().toISOString()
      };
      if (user.snipes_remaining !== null && user.snipes_remaining !== undefined && user.snipes_remaining > 0) {
        updates.snipes_remaining = Math.max(0, user.snipes_remaining - count);
      }
      await dbUpdateUser(user.id, updates);
      console.log(`🎯 [SNIPER DB] Snipe recorded for ${user.email}! New Total: ${updatedTotal}`);
      return updatedTotal;
    }
  } catch (e) {
    console.error('[Sniper DB - RecordSnipe Error]:', e.message);
  }
  return null;
}

export async function dbGetInvites() {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_invites?select=*&order=created_at.desc`, { headers: supabaseHeaders, timeout: 8000 });
    return res.data || [];
  } catch (e) {
    console.error('[Sniper DB - GetInvites]:', e.response?.data || e.message);
    return [];
  }
}

export async function dbGetInviteByCode(code) {
  try {
    const clean = (code || '').trim().toUpperCase();
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_invites?invite_code=ilike.${encodeURIComponent(clean)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0] : null;
  } catch (e) {
    console.error('[Sniper DB - GetInviteByCode]:', e.response?.data || e.message);
    return null;
  }
}

export async function dbUpsertInvite(inviteObj) {
  try {
    const res = await axios.post(`${SUPABASE_URL}/rest/v1/sniper_invites?on_conflict=invite_code`, inviteObj, {
      headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
      timeout: 8000
    });
    return (res.data && res.data.length > 0) ? res.data[0] : inviteObj;
  } catch (e) {
    console.error('[Sniper DB - UpsertInvite]:', e.response?.data || e.message);
    throw e;
  }
}

export async function dbUpdateInvite(inviteIdOrCode, updates) {
  try {
    const val = String(inviteIdOrCode || '').trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    const filter = isUuid ? `id=eq.${encodeURIComponent(val)}` : `invite_code=ilike.${encodeURIComponent(val)}`;
    const res = await axios.patch(
      `${SUPABASE_URL}/rest/v1/sniper_invites?${filter}`,
      updates,
      { headers: supabaseHeaders, timeout: 8000 }
    );
    return (res.data && res.data.length > 0) ? res.data[0] : updates;
  } catch (e) {
    console.error('[Sniper DB - UpdateInvite]:', e.response?.data || e.message);
    return null;
  }
}

export async function dbDeleteInvite(inviteIdOrCode) {
  try {
    const val = String(inviteIdOrCode || '').trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    const filter = isUuid ? `id=eq.${encodeURIComponent(val)}` : `invite_code=ilike.${encodeURIComponent(val)}`;
    await axios.delete(
      `${SUPABASE_URL}/rest/v1/sniper_invites?${filter}`,
      { headers: supabaseHeaders, timeout: 8000 }
    );
    return true;
  } catch (e) {
    console.error('[Sniper DB - DeleteInvite]:', e.response?.data || e.message);
    return false;
  }
}

export async function dbGetUserConfig(userId) {
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?user_id=eq.${encodeURIComponent(userId)}`, { headers: supabaseHeaders, timeout: 8000 });
    return (res.data && res.data.length > 0) ? res.data[0]?.config : null;
  } catch (e) {
    return null;
  }
}

export async function dbSaveUserConfig(userId, newConfig) {
  try {
    const existing = await dbGetUserConfig(userId);
    if (existing !== null && existing !== undefined) {
      const merged = { ...existing, ...newConfig };

      const existingWallets = existing.walletFleet || existing.wallets;
      const incomingWallets = newConfig.walletFleet !== undefined ? newConfig.walletFleet : newConfig.wallets;

      // Wallet preservation safeguard
      if (
        Array.isArray(existingWallets) && existingWallets.length > 0 &&
        Array.isArray(incomingWallets) && incomingWallets.length === 0 &&
        !newConfig.explicit_wipe
      ) {
        merged.walletFleet = existingWallets;
        merged.wallets = existingWallets;
        if (existing.masterWalletIndex !== undefined && merged.masterWalletIndex === null) {
          merged.masterWalletIndex = existing.masterWalletIndex;
        }
      }

      if (merged.walletFleet && !merged.wallets) merged.wallets = merged.walletFleet;
      if (merged.wallets && !merged.walletFleet) merged.walletFleet = merged.wallets;

      if (
        Array.isArray(existing.custom_rpcs) && existing.custom_rpcs.length > 0 &&
        Array.isArray(newConfig.custom_rpcs) && newConfig.custom_rpcs.length === 0 &&
        !newConfig.explicit_wipe
      ) {
        merged.custom_rpcs = existing.custom_rpcs;
      }

      await axios.patch(`${SUPABASE_URL}/rest/v1/sniper_user_configs?user_id=eq.${encodeURIComponent(userId)}`, {
        config: merged,
        updated_at: new Date().toISOString()
      }, { headers: supabaseHeaders, timeout: 8000 });
      return merged;
    } else {
      const merged = { ...newConfig };
      if (merged.walletFleet && !merged.wallets) merged.wallets = merged.walletFleet;
      if (merged.wallets && !merged.walletFleet) merged.walletFleet = merged.wallets;
      await axios.post(`${SUPABASE_URL}/rest/v1/sniper_user_configs?on_conflict=user_id`, {
        user_id: userId,
        config: merged,
        updated_at: new Date().toISOString()
      }, {
        headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
        timeout: 8000
      });
      return merged;
    }
  } catch (e) {
    console.error('[Sniper DB - SaveUserConfig]:', e.response?.data || e.message);
    return null;
  }
}

export async function dbDeleteUserConfig(userId) {
  try {
    await axios.delete(`${SUPABASE_URL}/rest/v1/sniper_user_configs?user_id=eq.${encodeURIComponent(userId)}`, { headers: supabaseHeaders, timeout: 8000 });
    return true;
  } catch (e) {
    return false;
  }
}

export async function adminAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required. Missing session token.' });
    }
    const sessionToken = authHeader.split('Bearer ')[1].trim();
    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Empty session token.' });
    }

    try {
      const configRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>session_token=eq.${encodeURIComponent(sessionToken)}`, {
        headers: supabaseHeaders,
        timeout: 4000
      });
      const configs = configRes.data;
      if (configs && configs.length > 0) {
        const userId = configs[0].user_id;
        const user = await dbGetUserById(userId);
        if (user && (user.email?.toLowerCase() === OWNER_EMAIL || user.role === 'admin')) {
          req.authenticatedUser = user;
          return next();
        }
      }
    } catch (dbErr) {}

    return res.status(403).json({ success: false, error: 'Admin access required.' });
  } catch (err) {
    console.error('[Sniper Admin Auth Error]:', err.message);
    return res.status(500).json({ success: false, error: 'Authentication check failed.' });
  }
}

export async function userAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required. Missing session token.' });
    }
    const sessionToken = authHeader.split('Bearer ')[1].trim();
    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Empty session token.' });
    }

    try {
      const configRes = await axios.get(`${SUPABASE_URL}/rest/v1/sniper_user_configs?select=user_id,config&config->>session_token=eq.${encodeURIComponent(sessionToken)}`, {
        headers: supabaseHeaders,
        timeout: 4000
      });
      const configs = configRes.data;
      if (configs && configs.length > 0) {
        const userId = configs[0].user_id;
        const user = await dbGetUserById(userId);
        if (user && !user.is_banned) {
          req.authenticatedUser = user;
          return next();
        }
      }
    } catch (dbErr) {}

    return res.status(401).json({ success: false, error: 'Invalid or expired session token. Please log in.' });
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Authentication verification failed.' });
  }
}
