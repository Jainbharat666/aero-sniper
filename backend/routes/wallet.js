import express from 'express';
import { ethers } from 'ethers';
import { seaportExecutor, cachedEthPrice } from '../state.js';
import { apiClient } from '../openSeaClient.js';
import { userAuthMiddleware } from '../db.js';

const router = express.Router();

// POST /api/wallets/balances
router.post('/wallets/balances', async (req, res) => {
  const { addresses } = req.body;
  if (!addresses || !Array.isArray(addresses)) {
    return res.status(400).json({ success: false, error: 'addresses array required' });
  }

  const rpcUrl = seaportExecutor.rpcs[0];
  const results = {};

  await Promise.all(addresses.map(async (addr) => {
    if (!addr || !addr.startsWith('0x') || addr.length !== 42) return;
    try {
      const rpcRes = await apiClient.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [addr.trim(), 'latest']
      });
      if (rpcRes.data?.result) {
        const balWei = BigInt(rpcRes.data.result);
        const ethStr = ethers.formatEther(balWei);
        const ethNum = parseFloat(ethStr);
        results[addr.trim()] = {
          balanceWei: balWei.toString(),
          balanceEth: ethNum,
          balanceEthStr: ethStr,
          balanceUsd: ethNum * cachedEthPrice,
          formatted: `${ethStr} ETH`
        };
      }
    } catch (e) {
      results[addr.trim()] = { balanceWei: '0', balanceEth: 0, balanceEthStr: '0.0', balanceUsd: 0, formatted: '0.000000 ETH' };
    }
  }));

  res.json({ success: true, balances: results });
});

// POST /api/wallet/fund
router.post('/wallet/fund', userAuthMiddleware, async (req, res) => {
  const { masterPrivateKey, workers, amountEth } = req.body;
  if (!masterPrivateKey || !Array.isArray(workers) || workers.length === 0 || !amountEth) {
    return res.status(400).json({ success: false, error: 'Missing required funding parameters' });
  }

  const provider = seaportExecutor.providers[0];
  try {
    const masterSigner = new ethers.Wallet(masterPrivateKey, provider);
    const masterAddress = masterSigner.address;
    const masterBalWei = await provider.getBalance(masterAddress);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 25000000n;
    const defaultGasLimit = 30000n;
    const estGasPerTx = defaultGasLimit * gasPrice;
    const sendAmountWei = ethers.parseEther(amountEth.toString());
    const totalNeededWei = (sendAmountWei + estGasPerTx) * BigInt(workers.length);

    if (masterBalWei < totalNeededWei) {
      return res.status(400).json({
        success: false,
        error: `Insufficient Master Treasury balance. Available: ${ethers.formatEther(masterBalWei)} ETH | Needed: ${ethers.formatEther(totalNeededWei)} ETH`
      });
    }

    let nonce = await provider.getTransactionCount(masterAddress, 'pending');
    const txResults = [];

    for (const w of workers) {
      try {
        const txReq = {
          to: w.address,
          value: sendAmountWei,
          gasLimit: defaultGasLimit,
          nonce: nonce++,
          gasPrice: gasPrice,
          type: 0
        };
        const tx = await masterSigner.sendTransaction(txReq);
        txResults.push({ address: w.address, name: w.name, txHash: tx.hash, success: true });
      } catch (txErr) {
        txResults.push({ address: w.address, name: w.name, error: txErr.message, success: false });
      }
    }

    res.json({
      success: txResults.some(t => t.success),
      fundedCount: txResults.filter(t => t.success).length,
      totalCount: workers.length,
      txResults
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/wallet/sweep
router.post('/wallet/sweep', userAuthMiddleware, async (req, res) => {
  const { masterAddress, workers } = req.body;
  if (!masterAddress || !Array.isArray(workers) || workers.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing masterAddress or workers array' });
  }

  const provider = seaportExecutor.providers[0];
  try {
    const block = await provider.getBlock('latest');
    const feeData = await provider.getFeeData();
    const liveGasPrice = block?.baseFeePerGas || feeData.gasPrice || 20200000n;
    const exactTransferGasLimit = 21225n;
    const exactGasCostWei = exactTransferGasLimit * liveGasPrice;

    const sweepResults = [];
    let totalSweptWei = 0n;

    for (const w of workers) {
      if (!w.privateKey) continue;
      try {
        const workerSigner = new ethers.Wallet(w.privateKey, provider);
        const balWei = await provider.getBalance(workerSigner.address);

        if (balWei > exactGasCostWei) {
          const sendWei = balWei - exactGasCostWei;
          const txReq = {
            to: masterAddress.trim(),
            value: sendWei,
            gasLimit: exactTransferGasLimit,
            gasPrice: liveGasPrice,
            type: 0
          };
          const tx = await workerSigner.sendTransaction(txReq);
          sweepResults.push({
            address: workerSigner.address,
            name: w.name,
            sweptEth: ethers.formatEther(sendWei),
            txHash: tx.hash,
            success: true
          });
          totalSweptWei += sendWei;
        } else {
          sweepResults.push({
            address: workerSigner.address,
            name: w.name,
            balEth: ethers.formatEther(balWei),
            reason: 'Balance is below network gas fee',
            success: false
          });
        }
      } catch (wErr) {
        sweepResults.push({
          address: w.address,
          name: w.name,
          error: wErr.message,
          success: false
        });
      }
    }

    res.json({
      success: sweepResults.some(s => s.success),
      sweptCount: sweepResults.filter(s => s.success).length,
      totalSweptEth: ethers.formatEther(totalSweptWei),
      liveGasGwei: ethers.formatUnits(liveGasPrice, 'gwei'),
      sweepResults
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/wallet/send
router.post('/wallet/send', userAuthMiddleware, async (req, res) => {
  const { fromPrivateKey, toAddress, amountEth } = req.body;
  if (!fromPrivateKey || !toAddress || !amountEth) {
    return res.status(400).json({ success: false, error: 'Missing transfer parameters' });
  }

  const provider = seaportExecutor.providers[0];
  try {
    const signer = new ethers.Wallet(fromPrivateKey, provider);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 25000000n;
    const sendWei = ethers.parseEther(amountEth.toString());

    const tx = await signer.sendTransaction({
      to: toAddress,
      value: sendWei,
      gasLimit: 30000n,
      gasPrice: gasPrice,
      type: 0
    });

    res.json({ success: true, txHash: tx.hash, from: signer.address, to: toAddress, amountEth });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
