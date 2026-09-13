import express from 'express';
import { rarityEngine } from '../state.js';

const router = express.Router();

// GET /api/token/rarity
router.get('/token/rarity', async (req, res) => {
  const tokenId = req.query.tokenId;
  const chain = req.query.chain || rarityEngine.chain || 'robinhood';
  const contract = req.query.contract || rarityEngine.contractAddress;
  if (!tokenId) return res.status(400).json({ success: false, error: 'tokenId required' });
  try {
    const info = await rarityEngine.resolveRarity(tokenId, chain, contract);
    res.json({ success: true, info });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/tokens/rarity-batch
router.post('/tokens/rarity-batch', async (req, res) => {
  const { tokenIds, chain, contractAddress, slug } = req.body || {};
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    return res.json({ success: true, rarities: {} });
  }
  try {
    const rarities = await rarityEngine.batchFetchRarities(
      tokenIds,
      chain || rarityEngine.chain,
      contractAddress || rarityEngine.contractAddress,
      slug || rarityEngine.collectionSlug
    );
    res.json({ success: true, rarities });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
