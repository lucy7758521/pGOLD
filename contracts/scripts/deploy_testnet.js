// pGOLD Protocol V4 — Arbitrum Sepolia 测试网部署脚本
//
// 与 deploy.js（主网）的区别：
//   - 无真实 PAXG：部署 ERC20Mock18 作为测试 PAXG
//   - 无真实 Chainlink：部署 MockChainlinkAggregator 作为 XAU/USD、PAXG/USD
//   - 无真实 Uniswap：部署 MockUniswapRouter
//   - USDC：使用 Arbitrum Sepolia 官方测试代币 (ERC20Mock with 6 decimals)
//
// 用法:
//   npx hardhat run scripts/deploy_testnet.js --network arbitrum-sepolia
//
// 前置条件：
//   .env 文件中设置 PRIVATE_KEY（账户需要 Arbitrum Sepolia ETH，可从 faucets.chain.link/arbitrum-sepolia 获取）

const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance    = await hre.ethers.provider.getBalance(deployer.address);

  console.log("========================================");
  console.log("  pGOLD Protocol V4 — Arbitrum Sepolia");
  console.log("========================================");
  console.log("  Network:", hre.network.name);
  console.log("  ChainId:", hre.network.config.chainId);
  console.log("  Deployer:", deployer.address);
  console.log("  Balance:", hre.ethers.formatEther(balance), "ETH");
  console.log("========================================\n");

  if (balance < hre.ethers.parseEther("0.02")) {
    throw new Error("❌ 余额不足 0.02 ETH，请先从 faucets.chain.link/arbitrum-sepolia 领取测试 ETH");
  }

  const deployed = {};

  // ══════════════════════════════════════════════════
  // Phase 0: Mock 外部依赖（测试网专用）
  // ══════════════════════════════════════════════════
  console.log("═══ Phase 0: Deploy Testnet Mocks ═══\n");

  // Mock USDC (6 decimals)
  const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
  const mockUSDC  = await ERC20Mock.deploy("USD Coin (Test)", "USDC");
  await mockUSDC.waitForDeployment();
  deployed.USDC = await mockUSDC.getAddress();
  console.log("  ✅ Mock USDC:  ", deployed.USDC);

  // Mock PAXG (18 decimals)
  const ERC20Mock18 = await hre.ethers.getContractFactory("ERC20Mock18");
  const mockPAXG    = await ERC20Mock18.deploy("PAX Gold (Test)", "PAXG");
  await mockPAXG.waitForDeployment();
  deployed.PAXG = await mockPAXG.getAddress();
  console.log("  ✅ Mock PAXG:  ", deployed.PAXG);

  // Mock Chainlink XAU/USD = $2,644.00/oz (8 decimals)
  const Aggregator    = await hre.ethers.getContractFactory("MockChainlinkAggregator");
  const mockGoldFeed  = await Aggregator.deploy(264400000000n, 8);
  await mockGoldFeed.waitForDeployment();
  deployed.CHAINLINK_XAU = await mockGoldFeed.getAddress();
  console.log("  ✅ Mock XAU/USD:", deployed.CHAINLINK_XAU, "(2644.00 USD/oz)");

  // Mock Chainlink PAXG/USD = $2,644.00 (8 decimals)
  const mockPAXGFeed = await Aggregator.deploy(264400000000n, 8);
  await mockPAXGFeed.waitForDeployment();
  deployed.CHAINLINK_PAXG = await mockPAXGFeed.getAddress();
  console.log("  ✅ Mock PAXG/USD:", deployed.CHAINLINK_PAXG, "(2644.00 USD)");

  // Mock Uniswap V3 Router (USDC → PAXG at fixed $2644/PAXG)
  const MockRouter = await hre.ethers.getContractFactory("MockUniswapRouter");
  const mockRouter = await MockRouter.deploy(deployed.PAXG, deployed.USDC);
  await mockRouter.waitForDeployment();
  deployed.UNISWAP_ROUTER = await mockRouter.getAddress();
  console.log("  ✅ Mock Router:", deployed.UNISWAP_ROUTER);

  // Seed router with 1M PAXG so it can fulfill swaps
  await mockPAXG.mint(deployed.UNISWAP_ROUTER, hre.ethers.parseEther("1000000"));
  console.log("  ✅ 1,000,000 PAXG minted to MockRouter\n");

  // ══════════════════════════════════════════════════
  // Phase 1: 核心层
  // ══════════════════════════════════════════════════
  console.log("═══ Phase 1: Core Layer ═══\n");

  const ConfigManager = await hre.ethers.getContractFactory("ConfigManager");
  const config        = await ConfigManager.deploy();
  await config.waitForDeployment();
  deployed.ConfigManager = await config.getAddress();
  console.log("  ✅ ConfigManager:", deployed.ConfigManager);

  const PGOLDToken = await hre.ethers.getContractFactory("PGOLDToken");
  const pgold      = await PGOLDToken.deploy();
  await pgold.waitForDeployment();
  deployed.PGOLDToken = await pgold.getAddress();
  console.log("  ✅ PGOLDToken:  ", deployed.PGOLDToken);

  // ══════════════════════════════════════════════════
  // Phase 2: Treasury + FeeRouter
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 2: Treasury + FeeRouter ═══\n");

  const Treasury = await hre.ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(
    deployed.PGOLDToken,
    deployed.ConfigManager,
    deployed.PAXG,
    deployed.USDC,
    deployed.UNISWAP_ROUTER
  );
  await treasury.waitForDeployment();
  deployed.Treasury = await treasury.getAddress();
  console.log("  ✅ Treasury:", deployed.Treasury);

  const MINTER_ROLE = await pgold.MINTER_ROLE();
  await pgold.grantRole(MINTER_ROLE, deployed.Treasury);
  console.log("  ✅ MINTER_ROLE → Treasury");

  const FeeRouter = await hre.ethers.getContractFactory("FeeRouter");
  const feeRouter = await FeeRouter.deploy(deployed.Treasury, deployed.USDC);
  await feeRouter.waitForDeployment();
  deployed.FeeRouter = await feeRouter.getAddress();
  console.log("  ✅ FeeRouter:", deployed.FeeRouter);

  // ══════════════════════════════════════════════════
  // Phase 3: VestingManager + PGOLDSwap
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 3: VestingManager + PGOLDSwap ═══\n");

  const VestingManager = await hre.ethers.getContractFactory("VestingManager");
  const vesting        = await VestingManager.deploy(deployed.PGOLDToken, deployed.Treasury);
  await vesting.waitForDeployment();
  deployed.VestingManager = await vesting.getAddress();
  console.log("  ✅ VestingManager:", deployed.VestingManager);
  await treasury.setMintAuthorized(deployed.VestingManager, true);
  console.log("  ✅ VestingManager authorized for mint");

  const PGOLDSwap = await hre.ethers.getContractFactory("PGOLDSwap");
  const swap      = await PGOLDSwap.deploy(deployed.PGOLDToken, deployed.USDC, deployed.FeeRouter, deployed.Treasury);
  await swap.waitForDeployment();
  deployed.PGOLDSwap = await swap.getAddress();
  console.log("  ✅ PGOLDSwap:", deployed.PGOLDSwap);
  await feeRouter.setSwapContract(deployed.PGOLDSwap);
  console.log("  ✅ FeeRouter.swapContract set");

  // ══════════════════════════════════════════════════
  // Phase 4: 五轨激励合约
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 4: Five-Track Incentives ═══\n");

  // A轨: StakingRewards
  const StakingRewards = await hre.ethers.getContractFactory("StakingRewards");
  const staking        = await StakingRewards.deploy(deployed.PGOLDToken, deployed.Treasury, deployed.ConfigManager);
  await staking.waitForDeployment();
  deployed.StakingRewards = await staking.getAddress();
  console.log("  ✅ StakingRewards (A轨):", deployed.StakingRewards);
  await treasury.setMintAuthorized(deployed.StakingRewards, true);

  // C轨: BurnMining
  const BurnMining = await hre.ethers.getContractFactory("BurnMining");
  const burnMining = await BurnMining.deploy(deployed.PGOLDToken, deployed.ConfigManager, deployed.VestingManager);
  await burnMining.waitForDeployment();
  deployed.BurnMining = await burnMining.getAddress();
  console.log("  ✅ BurnMining (C轨):", deployed.BurnMining);
  await vesting.setAuthorizedCreator(deployed.BurnMining, true);

  // B轨: RankingRewards
  const RankingRewards = await hre.ethers.getContractFactory("RankingRewards");
  const ranking        = await RankingRewards.deploy(deployed.ConfigManager, deployed.VestingManager);
  await ranking.waitForDeployment();
  deployed.RankingRewards = await ranking.getAddress();
  console.log("  ✅ RankingRewards (B轨):", deployed.RankingRewards);
  await vesting.setAuthorizedCreator(deployed.RankingRewards, true);

  // D轨: TeamRewards
  const TeamRewards = await hre.ethers.getContractFactory("TeamRewards");
  const team        = await TeamRewards.deploy(deployed.ConfigManager, deployed.Treasury);
  await team.waitForDeployment();
  deployed.TeamRewards = await team.getAddress();
  console.log("  ✅ TeamRewards (D轨):", deployed.TeamRewards);
  await treasury.setMintAuthorized(deployed.TeamRewards, true);

  // vPGOLD
  const VPGOLD = await hre.ethers.getContractFactory("vPGOLD");
  const vpgold = await VPGOLD.deploy(deployed.PGOLDToken, deployed.VestingManager);
  await vpgold.waitForDeployment();
  deployed.vPGOLD = await vpgold.getAddress();
  console.log("  ✅ vPGOLD:", deployed.vPGOLD);
  await treasury.setMintAuthorized(deployed.vPGOLD, true);

  // E轨: GenesisPool
  const GenesisPool = await hre.ethers.getContractFactory("GenesisPool");
  const genesisPool = await GenesisPool.deploy(deployed.USDC, deployed.PAXG, deployer.address);
  await genesisPool.waitForDeployment();
  deployed.GenesisPool = await genesisPool.getAddress();
  console.log("  ✅ GenesisPool (E轨):", deployed.GenesisPool);

  // ══════════════════════════════════════════════════
  // Phase 5: Oracle + Defense
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 5: Oracle + Defense ═══\n");

  const GoldOracle = await hre.ethers.getContractFactory("GoldOracle");
  const oracle     = await GoldOracle.deploy(deployed.Treasury, deployed.CHAINLINK_XAU, deployed.CHAINLINK_PAXG);
  await oracle.waitForDeployment();
  deployed.GoldOracle = await oracle.getAddress();
  console.log("  ✅ GoldOracle:", deployed.GoldOracle);

  const GOLD_ORACLE_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("GOLD_ORACLE_ROLE"));
  await treasury.grantRole(GOLD_ORACLE_ROLE, deployed.GoldOracle);
  console.log("  ✅ GOLD_ORACLE_ROLE → GoldOracle");

  const PriceDefense = await hre.ethers.getContractFactory("PriceDefense");
  const defense      = await PriceDefense.deploy(deployed.ConfigManager, deployed.Treasury, deployed.PGOLDSwap);
  await defense.waitForDeployment();
  deployed.PriceDefense = await defense.getAddress();
  console.log("  ✅ PriceDefense:", deployed.PriceDefense);

  // ══════════════════════════════════════════════════
  // Phase 6: 后部署关联设置
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 6: Post-deploy Wiring ═══\n");

  // Treasury 授权剩余激励合约
  await treasury.setMintAuthorized(deployed.RankingRewards, true);
  await treasury.setMintAuthorized(deployed.BurnMining, true);

  // GenesisPool 授权 (swap + mint + vesting)
  await treasury.setGenesisPoolAuthorized(deployed.GenesisPool, true);
  await treasury.setMintAuthorized(deployed.GenesisPool, true);
  await vesting.setAuthorizedCreator(deployed.GenesisPool, true);
  console.log("  ✅ GenesisPool authorized (treasury + vesting)");

  // 初始化 GenesisPool ICO（180天窗口）
  await genesisPool.initializeICO(deployed.Treasury, deployed.GoldOracle, deployed.VestingManager);
  console.log("  ✅ GenesisPool ICO initialized (180-day window)");

  // 更新 Oracle 价格（从 MockChainlink 读取 → 写入 Treasury）
  await oracle.updateAll();
  console.log("  ✅ Oracle prices pushed to Treasury");

  // ══════════════════════════════════════════════════
  // 部署完成
  // ══════════════════════════════════════════════════
  console.log("\n========================================");
  console.log("  🎉 Arbitrum Sepolia 部署完成!");
  console.log("========================================");
  console.log("  Network:", hre.network.name, "(chainId:", hre.network.config.chainId + ")");
  console.log("  Deployer:", deployer.address);
  console.log("========================================");
  console.log("\n  [Mocks]");
  console.log("    USDC (Mock):       ", deployed.USDC);
  console.log("    PAXG (Mock):       ", deployed.PAXG);
  console.log("    XAU/USD Feed:      ", deployed.CHAINLINK_XAU);
  console.log("    PAXG/USD Feed:     ", deployed.CHAINLINK_PAXG);
  console.log("    Uniswap Router:    ", deployed.UNISWAP_ROUTER);
  console.log("\n  [Core]");
  console.log("    ConfigManager:     ", deployed.ConfigManager);
  console.log("    PGOLDToken:        ", deployed.PGOLDToken);
  console.log("    Treasury:          ", deployed.Treasury);
  console.log("    FeeRouter:         ", deployed.FeeRouter);
  console.log("    VestingManager:    ", deployed.VestingManager);
  console.log("    PGOLDSwap:         ", deployed.PGOLDSwap);
  console.log("\n  [Incentives]");
  console.log("    StakingRewards (A):", deployed.StakingRewards);
  console.log("    RankingRewards (B):", deployed.RankingRewards);
  console.log("    BurnMining (C):    ", deployed.BurnMining);
  console.log("    TeamRewards (D):   ", deployed.TeamRewards);
  console.log("    GenesisPool (E):   ", deployed.GenesisPool);
  console.log("    VestingManager:    ", deployed.VestingManager);
  console.log("    vPGOLD:            ", deployed.vPGOLD);
  console.log("\n  [Oracle/Defense]");
  console.log("    GoldOracle:        ", deployed.GoldOracle);
  console.log("    PriceDefense:      ", deployed.PriceDefense);
  console.log("\n========================================\n");

  // ── 保存部署清单 ──
  const deployData = {
    network:   hre.network.name,
    chainId:   hre.network.config.chainId,
    deployer:  deployer.address,
    timestamp: new Date().toISOString(),
    notes: "Testnet: all external dependencies are mocks (PAXG, Chainlink, Uniswap)",
    addresses: deployed,
  };

  const deployFile = path.join(__dirname, "..", "deployed_testnet.json");
  fs.writeFileSync(deployFile, JSON.stringify(deployData, null, 2));
  console.log(`  📄 部署清单: ${deployFile}`);

  // ── 自动同步地址到前端文件 ──
  try {
    process.argv.push("--testnet");
    require("./sync_addresses.js");
  } catch(e) {
    console.warn("  ⚠️  sync_addresses.js failed:", e.message);
    console.warn("  手动运行: node scripts/sync_addresses.js --testnet");
  }

  // ── 生成前端 ABI 包 ──
  await exportFrontendBundle(hre, deployed, deployData);
}

// ── 导出前端所需的 ABI + 地址包 ──
async function exportFrontendBundle(hre, addresses, meta) {
  const contracts = [
    "PGOLDToken", "Treasury", "ConfigManager", "FeeRouter",
    "VestingManager", "PGOLDSwap", "StakingRewards", "RankingRewards",
    "BurnMining", "TeamRewards", "GenesisPool", "vPGOLD",
    "GoldOracle", "PriceDefense",
  ];

  const abis = {};
  for (const name of contracts) {
    try {
      const artifact = await hre.artifacts.readArtifact(name);
      abis[name] = artifact.abi;
    } catch {
      // mock-only contract, skip
    }
  }

  const bundle = {
    meta: {
      network:   meta.network,
      chainId:   meta.chainId,
      deployer:  meta.deployer,
      timestamp: meta.timestamp,
    },
    addresses: {
      // Core
      pgold:          addresses.PGOLDToken,
      treasury:       addresses.Treasury,
      config:         addresses.ConfigManager,
      feeRouter:      addresses.FeeRouter,
      vesting:        addresses.VestingManager,
      swap:           addresses.PGOLDSwap,
      // Incentives
      staking:        addresses.StakingRewards,
      ranking:        addresses.RankingRewards,
      burnMining:     addresses.BurnMining,
      team:           addresses.TeamRewards,
      genesis:        addresses.GenesisPool,
      vpgold:         addresses.vPGOLD,
      // Oracle/Defense
      oracle:         addresses.GoldOracle,
      defense:        addresses.PriceDefense,
      // Testnet tokens
      usdc:           addresses.USDC,
      paxg:           addresses.PAXG,
    },
    abis,
  };

  // Save alongside the deploy manifest
  const bundlePath = path.join(__dirname, "..", `contracts_${meta.network}.js`);
  fs.writeFileSync(
    bundlePath,
    `// Auto-generated by deploy_testnet.js — ${meta.timestamp}\n// DO NOT EDIT MANUALLY\nexport const CONTRACTS = ${JSON.stringify(bundle, null, 2)};\n`
  );
  console.log(`  📦 前端 ABI 包: ${bundlePath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ 部署失败:", err.message || err);
    if (err.data)        console.error("   data:",        err.data);
    if (err.transaction) console.error("   transaction:", err.transaction);
    process.exit(1);
  });
