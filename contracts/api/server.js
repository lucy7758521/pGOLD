const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const deployed = require('../deployed_hardhat.json');

const app = express();
app.use(cors());
app.use(express.json());

// ── 配置 ──────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const PORT    = process.env.PORT    || 3001;

const provider = new ethers.JsonRpcProvider(RPC_URL);

const ADDRS = deployed.addresses;

// ── ABI ───────────────────────────────────────────────────
const SWAP_ABI = [
  'function buy(uint256,uint256,uint256) returns (uint256)',
  'function sell(uint256,uint256,uint256) returns (uint256)',
  'function getArbitrageInfo(uint256,uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getBuyQuote(uint256) view returns (uint256,uint256)',
  'function getSellQuote(uint256) view returns (uint256,uint256)',
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function getPrice() view returns (uint256)',
  'function getStats() view returns (uint256,uint256,uint256,uint256)',
];

const TREASURY_ABI = [
  'function goldPriceUSD() view returns (uint256)',
];

const swap     = new ethers.Contract(ADDRS.PGOLDSwap, SWAP_ABI, provider);
const treasury = new ethers.Contract(ADDRS.Treasury,  TREASURY_ABI, provider);

// ── 工具 ──────────────────────────────────────────────────
function fmt6(v)  { return ethers.formatUnits(v, 6); }
function fmt8(v)  { return ethers.formatUnits(v, 8); }
function fmt18(v) { return ethers.formatEther(v); }

function wrap(res, fn) {
  fn().then(data => res.json({ ok: true, data }))
     .catch(err  => res.status(500).json({ ok: false, error: err.message }));
}

// ── 路由 ──────────────────────────────────────────────────

// GET /api/pool — 池子完整状态
app.get('/api/pool', (req, res) => wrap(res, async () => {
  const [ru, rp, k, ammP, oracleP, floorBps, vol, fees, count] = await swap.getPoolInfo();
  return {
    reserveUSDC:    fmt6(ru),
    reservePGOLD:   fmt18(rp),
    k:              k.toString(),
    ammPrice:       fmt8(ammP),
    oraclePrice:    fmt8(oracleP),
    priceFloorBps:  Number(floorBps),
    priceFloorPct:  (Number(floorBps) / 100).toFixed(1) + '%',
    priceDiffPct:   ammP > 0 && oracleP > 0
                      ? (((Number(ammP) - Number(oracleP)) / Number(oracleP)) * 100).toFixed(4) + '%'
                      : 'N/A',
    totalVolumeUSDC: fmt6(vol),
    totalFees:       fmt6(fees),
    totalSwaps:      Number(count),
  };
}));

// GET /api/price — 价格快览
app.get('/api/price', (req, res) => wrap(res, async () => {
  const [ammP, oracleP] = await Promise.all([swap.getPrice(), treasury.goldPriceUSD()]);
  return {
    ammPrice:    fmt8(ammP),
    oraclePrice: fmt8(oracleP),
    unit:        'USDC/pGOLD (8 decimals normalized)',
  };
}));

// GET /api/quote/buy?usdc=100 — 买入报价
app.get('/api/quote/buy', (req, res) => wrap(res, async () => {
  const usdc = req.query.usdc;
  if (!usdc) throw new Error('Missing param: usdc');
  const usdcWei = ethers.parseUnits(usdc, 6);
  const [pgoldOut, fee] = await swap.getBuyQuote(usdcWei);
  return {
    usdcIn:   usdc,
    pgoldOut: fmt18(pgoldOut),
    fee:      fmt6(fee),
    price:    pgoldOut > 0n ? (Number(ethers.parseUnits(usdc, 6)) / Number(pgoldOut) * 1e12).toFixed(8) : '0',
  };
}));

// GET /api/quote/sell?pgold=1 — 卖出报价
app.get('/api/quote/sell', (req, res) => wrap(res, async () => {
  const pgold = req.query.pgold;
  if (!pgold) throw new Error('Missing param: pgold');
  const pgoldWei = ethers.parseEther(pgold);
  const [usdcOut, fee] = await swap.getSellQuote(pgoldWei);
  return {
    pgoldIn:  pgold,
    usdcOut:  fmt6(usdcOut),
    fee:      fmt6(fee),
    price:    pgoldWei > 0n ? ((Number(usdcOut) + Number(fee)) / Number(pgoldWei) * 1e12).toFixed(8) : '0',
  };
}));

// GET /api/arbitrage?usdc=100&pgold=1 — 套利分析
app.get('/api/arbitrage', (req, res) => wrap(res, async () => {
  const usdc  = req.query.usdc  || '0';
  const pgold = req.query.pgold || '0';
  const usdcWei  = ethers.parseUnits(usdc,  6);
  const pgoldWei = ethers.parseEther(pgold);
  const [buyOut, buyFee, sellOut, sellFee, oracleP, ammP] =
    await swap.getArbitrageInfo(usdcWei, pgoldWei);
  const spread = ammP > 0n && oracleP > 0n
    ? (((Number(ammP) - Number(oracleP)) / Number(oracleP)) * 100).toFixed(4)
    : '0';
  return {
    buy:  { usdcIn: usdc, pgoldOut: fmt18(buyOut), fee: fmt6(buyFee) },
    sell: { pgoldIn: pgold, usdcOut: fmt6(sellOut), fee: fmt6(sellFee) },
    ammPrice:    fmt8(ammP),
    oraclePrice: fmt8(oracleP),
    spreadPct:   spread + '%',
    arbitrageOpportunity: Math.abs(parseFloat(spread)) > 1.5,
  };
}));

// GET /api/reserves — 储备量
app.get('/api/reserves', (req, res) => wrap(res, async () => {
  const [usdc, pgold, k] = await swap.getReserves();
  return { reserveUSDC: fmt6(usdc), reservePGOLD: fmt18(pgold), k: k.toString() };
}));

// GET /api/stats — 累计统计
app.get('/api/stats', (req, res) => wrap(res, async () => {
  const [vol, fees, swaps, lastP] = await swap.getStats();
  return {
    totalVolumeUSDC: fmt6(vol),
    totalFees:       fmt6(fees),
    totalSwaps:      Number(swaps),
    lastPrice:       fmt8(lastP),
  };
}));

// GET /api/health — 服务健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, rpc: RPC_URL, swap: ADDRS.PGOLDSwap, treasury: ADDRS.Treasury });
});

// ── 启动 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`pGOLD Swap API running on http://localhost:${PORT}`);
  console.log(`  Swap:     ${ADDRS.PGOLDSwap}`);
  console.log(`  Treasury: ${ADDRS.Treasury}`);
  console.log(`  RPC:      ${RPC_URL}`);
});
