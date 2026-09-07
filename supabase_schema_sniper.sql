-- ==============================================================================
-- NFT SNIPER V2 — DEDICATED SUPABASE CLOUD DATABASE SCHEMA
-- Completely isolated from AeroMint tables (Zero cross-app collision)
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/fjxarhcisasyvomfgtxl/sql/new
-- ==============================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. SNIPER USERS TABLE (Accounts, Role, Validity & Snipes Quota)
CREATE TABLE IF NOT EXISTS public.sniper_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'vip_member', -- 'admin' for owner
    invite_code_used TEXT,
    valid_until TIMESTAMPTZ,
    max_snipes_allowed INT DEFAULT 0, -- 0 = unlimited
    total_snipes INT DEFAULT 0,
    is_banned BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. SNIPER INVITES TABLE (VIP Access & Registration Codes)
CREATE TABLE IF NOT EXISTS public.sniper_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invite_code TEXT UNIQUE NOT NULL,
    note TEXT,
    validity_days INT DEFAULT 30,
    max_snipes_limit INT DEFAULT 0, -- 0 = unlimited
    max_uses INT DEFAULT 1,
    used_count INT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. SNIPER USER CONFIGS TABLE (Cloud Vault, Wallets Fleet & Rule Presets)
CREATE TABLE IF NOT EXISTS public.sniper_user_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT UNIQUE NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. SNIPER CUSTOM RPCS TABLE (User-Specific Custom RPC Endpoints)
CREATE TABLE IF NOT EXISTS public.sniper_custom_rpcs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    network_key VARCHAR(64) DEFAULT 'robinhood',
    name VARCHAR(128) NOT NULL,
    url TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Disable Row Level Security (RLS) so backend and client services communicate seamlessly
ALTER TABLE public.sniper_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sniper_invites DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sniper_user_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sniper_custom_rpcs DISABLE ROW LEVEL SECURITY;

-- 7. Indexes for High-Frequency Read Operations
CREATE INDEX IF NOT EXISTS idx_sniper_users_email ON public.sniper_users(email);
CREATE INDEX IF NOT EXISTS idx_sniper_invites_code ON public.sniper_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_sniper_user_configs_uid ON public.sniper_user_configs(user_id);

-- 8. Seed Master VIP Invite Keys (Dual-Constraint: 365 Days, Unlimited Snipes)
INSERT INTO public.sniper_invites (invite_code, note, validity_days, max_snipes_limit, max_uses)
VALUES 
  ('SNIPER-VIP-2026', 'Master VIP Access Key (365 Days, Unlimited Snipes)', 365, 0, 500),
  ('SNIPER-VIP-ACCESS-2026', 'Master VIP Access Key (365 Days, Unlimited Snipes)', 365, 0, 500),
  ('SNIPER-PRO-30D', 'Pro 30-Day Access Key (50 Snipes Quota)', 30, 50, 100)
ON CONFLICT (invite_code) DO NOTHING;

-- 9. Seed Master Platform Owner Account (Lifetime Unlimited Access)
INSERT INTO public.sniper_users (id, email, password_hash, role, invite_code_used, valid_until, max_snipes_allowed, total_snipes, is_banned)
VALUES (
  'owner-sniper-master-001',
  'jainbharat666@gmail.com',
  '$2a$10$ebLREUckjtjZ0ovh4icQHOYliES8L.Qm3Wi4ibUhCovewJ/rSu1b2',
  'admin',
  'ROOT-OWNER',
  '2099-12-31 23:59:59+00',
  0,
  0,
  false
)
ON CONFLICT (email) DO UPDATE SET role = 'admin', valid_until = '2099-12-31 23:59:59+00';

