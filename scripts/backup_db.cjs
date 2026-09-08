const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const url = (process.env.SUPABASE_URL || 'https://fjxarhcisasyvomfgtxl.supabase.co').replace(/\/$/, '') + '/rest/v1';
const key = process.env.SUPABASE_KEY || 'sb_publishable_QkC4wXZTz_4m8P9zUuwDjg_mUZA1Vqa';
const headers = { apikey: key, Authorization: 'Bearer ' + key };

async function createBackup() {
  console.log('🔄 Fetching complete database from Supabase Cloud (fjxarhcisasyvomfgtxl)...');
  
  const [usersRes, invitesRes, configsRes, rpcsRes] = await Promise.all([
    axios.get(url + '/sniper_users?select=*&order=created_at.desc', { headers }),
    axios.get(url + '/sniper_invites?select=*&order=created_at.desc', { headers }),
    axios.get(url + '/sniper_user_configs?select=*', { headers }),
    axios.get(url + '/sniper_custom_rpcs?select=*', { headers }).catch(() => ({ data: [] }))
  ]);

  const backupData = {
    timestamp: new Date().toISOString(),
    project: 'Aero-Sniper-V2-DB (fjxarhcisasyvomfgtxl)',
    database: 'Supabase PostgreSQL 24/7 Cloud',
    counts: {
      users: usersRes.data.length,
      invites: invitesRes.data.length,
      user_configs: configsRes.data.length,
      custom_rpcs: rpcsRes.data.length
    },
    tables: {
      sniper_users: usersRes.data,
      sniper_invites: invitesRes.data,
      sniper_user_configs: configsRes.data,
      sniper_custom_rpcs: rpcsRes.data
    }
  };

  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupFileName = 'supabase_complete_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  const backupFilePath = path.join(backupDir, backupFileName);
  const latestFilePath = path.join(backupDir, 'supabase_backup_latest.json');

  fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), 'utf-8');
  fs.writeFileSync(latestFilePath, JSON.stringify(backupData, null, 2), 'utf-8');

  console.log('=============================================================');
  console.log(' ✅ DATABASE BACKUP COMPLETED SUCCESSFULLY!');
  console.log(' 📁 Saved to:', backupFilePath);
  console.log(' 👥 Users backed up:', usersRes.data.length);
  console.log(' 🎫 Invites backed up:', invitesRes.data.length);
  console.log(' 🔐 User Configs & Vaults backed up:', configsRes.data.length);
  console.log(' ⚡ Custom RPCs backed up:', rpcsRes.data.length);
  console.log('=============================================================');
}

createBackup().catch(e => {
  console.error('❌ Backup failed:', e.message);
  process.exit(1);
});
