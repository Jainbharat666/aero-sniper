import express from 'express';
import { config } from '../../src/config.js';
import { openseaKeyStats, trackKeyUse } from '../state.js';
import { apiClient } from '../openSeaClient.js';

const router = express.Router();

// GET /api/opensea/keys
router.get('/opensea/keys', (req, res) => {
  const keys = config.opensea.apiKeys;
  const list = keys.map((k, i) => {
    const stat = openseaKeyStats[k] || { label: `Key #${i + 1}`, role: 'extra', count: 0, lastPingMs: 100, status: '200 OK' };
    return {
      key: k,
      rawKey: k,
      masked: `${k.slice(0, 6)}••••••••••••${k.slice(-4)}`,
      label: stat.label,
      role: stat.role,
      requestsServed: stat.count,
      lastPingMs: stat.lastPingMs,
      status: stat.status,
      isStreamKey: (i === 0)
    };
  });

  const totalRequests = Object.values(openseaKeyStats).reduce((acc, s) => acc + s.count, 0);

  res.json({
    success: true,
    totalKeys: keys.length,
    totalRequests,
    strategy: '6-Key Role-Specialized Laser Grid',
    keys: list
  });
});

// POST /api/opensea/add-key
router.post('/opensea/add-key', (req, res) => {
  const { apiKey, label } = req.body || {};
  const key = (apiKey || '').trim();
  if (!key || key.length < 10) {
    return res.status(400).json({ success: false, error: 'Valid OpenSea API Key is required (minimum 10 characters)' });
  }
  if (config.opensea.apiKeys.includes(key)) {
    return res.status(400).json({ success: false, error: 'This OpenSea API Key is already in the active pool' });
  }

  if (typeof config.opensea.addApiKey === 'function') {
    config.opensea.addApiKey(key);
  } else {
    config.opensea.apiKeys.push(key);
  }

  const keyIndex = config.opensea.apiKeys.length;
  openseaKeyStats[key] = {
    label: label && label.trim() ? label.trim() : `Key #${keyIndex} (Custom)`,
    role: 'extra',
    count: 0,
    lastPingMs: 100,
    status: 'Ready'
  };

  return res.json({
    success: true,
    message: 'API Key successfully added to active laser pool',
    totalKeys: config.opensea.apiKeys.length
  });
});

// POST /api/opensea/delete-key
router.post('/api/opensea/delete-key', (req, res) => {
  const { apiKey } = req.body || {};
  const key = (apiKey || '').trim();
  if (!key) {
    return res.status(400).json({ success: false, error: 'API key is required' });
  }

  const idx = config.opensea.apiKeys.indexOf(key);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Key not found in pool' });
  }
  if (idx === 0) {
    return res.status(400).json({ success: false, error: 'Primary 24/7 WebSocket Stream Key (Key #1) cannot be removed' });
  }

  if (typeof config.opensea.removeApiKey === 'function') {
    config.opensea.removeApiKey(key);
  } else {
    config.opensea.apiKeys.splice(idx, 1);
  }
  delete openseaKeyStats[key];

  return res.json({
    success: true,
    message: 'Key successfully removed from pool',
    totalKeys: config.opensea.apiKeys.length
  });
});

// Also support /opensea/delete-key without /api prefix (router is mounted at /api)
router.post('/opensea/delete-key', (req, res) => {
  const { apiKey } = req.body || {};
  const key = (apiKey || '').trim();
  if (!key) {
    return res.status(400).json({ success: false, error: 'API key is required' });
  }

  const idx = config.opensea.apiKeys.indexOf(key);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Key not found in pool' });
  }
  if (idx === 0) {
    return res.status(400).json({ success: false, error: 'Primary 24/7 WebSocket Stream Key (Key #1) cannot be removed' });
  }

  if (typeof config.opensea.removeApiKey === 'function') {
    config.opensea.removeApiKey(key);
  } else {
    config.opensea.apiKeys.splice(idx, 1);
  }
  delete openseaKeyStats[key];

  return res.json({
    success: true,
    message: 'Key successfully removed from pool',
    totalKeys: config.opensea.apiKeys.length
  });
});

// POST /api/opensea/test-key
router.post('/opensea/test-key', async (req, res) => {
  const { apiKey } = req.body;
  const targetKey = apiKey || config.opensea.getNextRestKey();
  const t0 = Date.now();

  try {
    const apiRes = await apiClient.get(`${config.opensea.restApiBase}/collections/rhmachines`, {
      headers: { 'X-API-KEY': targetKey, 'Accept': 'application/json' },
      timeout: 5000
    });
    const latency = Date.now() - t0;
    trackKeyUse(targetKey, latency, '200 OK');

    res.json({
      success: true,
      apiKey: targetKey,
      masked: `${targetKey.slice(0, 8)}...${targetKey.slice(-4)}`,
      latencyMs: latency,
      status: '200 OK (Live & Operational)',
      collectionChecked: apiRes.data?.name || 'rhmachines'
    });
  } catch (err) {
    const latency = Date.now() - t0;
    const statusCode = err.response?.status || 'Network Error';
    trackKeyUse(targetKey, latency, `${statusCode} Error`);

    res.json({
      success: false,
      apiKey: targetKey,
      masked: `${targetKey.slice(0, 8)}...${targetKey.slice(-4)}`,
      latencyMs: latency,
      status: `${statusCode} Error`,
      error: err.response?.data?.detail || err.message
    });
  }
});

export default router;
