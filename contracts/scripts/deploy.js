// pGOLD Protocol V4 — 五轨完整部署脚本
// 用法:
//   测试网: npx hardhat run scripts/deploy.js --network arbitrum-sepolia
//   主网:   npx hardhat run scripts/deploy.js --network arbitrum
//   本地:   npx hardhat run scripts/deploy.js

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("========================================");
  console.log("  pGOLD Protocol V4 — 五轨部署");
  console.log("========================================");
  console.log("  Network:", hre.network.name);
  console.log("  Deployer:", deployer.address);
  console.log("  Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("========================================\n");

  // ── 外部地址（优先环境变量，后备硬编码） ──
  const USDC_ADDRESS   = process.env.USDC_ADDRESS        || "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const PAXG_ADDRESS   = process.env.PAXG_ADDRESS        || "0x_";  // 部署前必须配置！
  const UNISWAP_ROUTER = process.env.UNISWAP_ROUTER      || "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const GOLD_FEED      = process.env.CHAINLINK_XAU_USD   || "0x_";  // 部署前必须配置！
  const PAXG_FEED      = process.env.CHAINLINK_PAXG_USD  || "0x_";  // 可选，两步模式时不需要
  const PAXG_ETH_FEED  = process.env.CHAINLINK_PAXG_ETH  || "0x_";  // 两步模式：PAXG/ETH
  const ETH_USD_FEED   = process.env.CHAINLINK_ETH_USD   || "0x_";  // 两步模式：ETH/USD
  // 两步模式：Arbitrum 主网无 PAXG/USD 直接 feed，用 PAXG/ETH × ETH/USD 计算
  const USE_TWO_STEP_PAXG = PAXG_ETH_FEED !== "0x_" && ETH_USD_FEED !== "0x_";

  // ⚠️ 部署前守卫检查
  if (hre.network.name !== "hardhat") {
    if (PAXG_ADDRESS === "0x_") {
      throw new Error("❌ PAXG_ADDRESS 未配置！请设置环境变量 PAXG_ADDRESS");
    }
    if (GOLD_FEED === "0x_") {
      throw new Error("❌ CHAINLINK_XAU_USD 未配置！请设置环境变量 CHAINLINK_XAU_USD");
    }
  }

  const deployed = {}; // 部署记录

  // ══════════════════════════════════════════════════
  // Phase 1: 核心层
  // ══════════════════════════════════════════════════
  console.log("═══ Phase 1: Core Layer ═══\n");

  // 1a. ConfigManager
  const ConfigManager = await hre.ethers.getContractFactory("ConfigManager");
  const config = await ConfigManager.deploy();
  await config.waitForDeployment();
  deployed.ConfigManager = await config.getAddress();
  console.log("  ✅ ConfigManager:", deployed.ConfigManager);

  // 1b. PGOLDToken
  const PGOLDToken = await hre.ethers.getContractFactory("PGOLDToken");
  const pgold = await PGOLDToken.deploy();
  await pgold.waitForDeployment();
  deployed.PGOLDToken = await pgold.getAddress();
  console.log("  ✅ PGOLDToken:", deployed.PGOLDToken);

  // ══════════════════════════════════════════════════
  // Phase 2: Treasury + FeeRouter
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 2: Treasury + FeeRouter ═══\n");

  // 2a. Treasury
  const Treasury = await hre.ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(
    deployed.PGOLDToken,
    deployed.ConfigManager,
    PAXG_ADDRESS,
    USDC_ADDRESS,
    UNISWAP_ROUTER
  );
  await treasury.waitForDeployment();
  deployed.Treasury = await treasury.getAddress();
  console.log("  ✅ Treasury:", deployed.Treasury);

  // 授予 Treasury MINTER_ROLE
  const MINTER_ROLE = await pgold.MINTER_ROLE();
  await pgold.grantRole(MINTER_ROLE, deployed.Treasury);
  console.log("  ✅ MINTER_ROLE → Treasury");

  // 2b. FeeRouter
  const FeeRouter = await hre.ethers.getContractFactory("FeeRouter");
  const feeRouter = await FeeRouter.deploy(
    deployed.Treasury,
    USDC_ADDRESS
  );
  await feeRouter.waitForDeployment();
  deployed.FeeRouter = await feeRouter.getAddress();
  console.log("  ✅ FeeRouter:", deployed.FeeRouter);

  // ══════════════════════════════════════════════════
  // Phase 3: VestingManager + PGOLDSwap
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 3: VestingManager + PGOLDSwap ═══\n");

  // 3a. VestingManager
  const VestingManager = await hre.ethers.getContractFactory("VestingManager");
  const vestingManager = await VestingManager.deploy(
    deployed.PGOLDToken,
    deployed.Treasury
  );
  await vestingManager.waitForDeployment();
  deployed.VestingManager = await vestingManager.getAddress();
  console.log("  ✅ VestingManager:", deployed.VestingManager);

  // 授权 VestingManager 调用 Treasury.requestMint
  await treasury.setMintAuthorized(deployed.VestingManager, true);
  console.log("  ✅ VestingManager authorized for mint");

  // 3b. PGOLDSwap
  const PGOLDSwap = await hre.ethers.getContractFactory("PGOLDSwap");
  const swap = await PGOLDSwap.deploy(
    deployed.PGOLDToken,
    USDC_ADDRESS,
    deployed.FeeRouter
  );
  await swap.waitForDeployment();
  deployed.PGOLDSwap = await swap.getAddress();
  console.log("  ✅ PGOLDSwap:", deployed.PGOLDSwap);

  // 绑定 FeeRouter → PGOLDSwap
  await feeRouter.setSwapContract(deployed.PGOLDSwap);
  console.log("  ✅ FeeRouter.swapContract set");

  // ══════════════════════════════════════════════════
  // Phase 4: 五轨激励合约
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 4: Five-Track Incentives ═══\n");

  // 4a. StakingRewards (A轨)
  const StakingRewards = await hre.ethers.getContractFactory("StakingRewards");
  const staking = await StakingRewards.deploy(
    deployed.PGOLDToken,
    deployed.Treasury,
    deployed.ConfigManager
  );
  await staking.waitForDeployment();
  deployed.StakingRewards = await staking.getAddress();
  console.log("  ✅ StakingRewards (A轨):", deployed.StakingRewards);
  await treasury.setMintAuthorized(deployed.StakingRewards, true);

  // 4b. BurnMining (C轨)
  const BurnMining = await hre.ethers.getContractFactory("BurnMining");
  const burnMining = await BurnMining.deploy(
    deployed.PGOLDToken,
    deployed.ConfigManager,
    deployed.VestingManager
  );
  await burnMining.waitForDeployment();
  deployed.BurnMining = await burnMining.getAddress();
  console.log("  ✅ BurnMining (C轨):", deployed.BurnMining);
  await vestingManager.setAuthorizedCreator(deployed.BurnMining, true);

  // 4c. RankingRewards (B轨)
  const RankingRewards = await hre.ethers.getContractFactory("RankingRewards");
  const ranking = await RankingRewards.deploy(
    deployed.ConfigManager,
    deployed.VestingManager
  );
  await ranking.waitForDeployment();
  deployed.RankingRewards = await ranking.getAddress();
  console.log("  ✅ RankingRewards (B轨):", deployed.RankingRewards);
  await vestingManager.setAuthorizedCreator(deployed.RankingRewards, true);

  // 4d. vPGOLD
  const VPGOLD = await hre.ethers.getContractFactory("vPGOLD");
  const vpgold = await VPGOLD.deploy(
    deployed.PGOLDToken,
    deployed.VestingManager
  );
  await vpgold.waitForDeployment();
  deployed.vPGOLD = await vpgold.getAddress();
  console.log("  ✅ vPGOLD:", deployed.vPGOLD);

  // 4e. TeamRewards (D轨)
  const TeamRewards = await hre.ethers.getContractFactory("TeamRewards");
  const team = await TeamRewards.deploy(
    deployed.ConfigManager,
    deployed.Treasury
  );
  await team.waitForDeployment();
  deployed.TeamRewards = await team.getAddress();
  console.log("  ✅ TeamRewards (D轨):", deployed.TeamRewards);
  await treasury.setMintAuthorized(deployed.TeamRewards, true);

  // 4f. GenesisPool (E轨) ★ V4 新增
  const GenesisPool = await hre.ethers.getContractFactory("GenesisPool");
  const genesisPool = await GenesisPool.deploy(
    USDC_ADDRESS,
    PAXG_ADDRESS,
    deployer.address  // admin = deployer (可后续转移给多签)
  );
  await genesisPool.waitForDeployment();
  deployed.GenesisPool = await genesisPool.getAddress();
  console.log("  ✅ GenesisPool (E轨):", deployed.GenesisPool);

  // 初始化 GenesisPool ICO 窗口
  await genesisPool.initializeICO(
    deployed.Treasury,
    "0x_",  // GOLD_ORACLE — 需 Oracle 部署后填入
    deployed.VestingManager
  );
  console.log("  ⚠️  GenesisPool ICO 初始化完成 (Oracle地址待更新)");

  // ══════════════════════════════════════════════════
  // Phase 5: Oracle + Defense
  // ══════════════════════════════════════════════════
  console.log("\n═══ Phase 5: Oracle + Defense ═══\n");

  // 5a. GoldOracle
  const GoldOracle = await hre.ethers.getContractFactory("GoldOracle");
  const oracle = await GoldOracle.deploy(
    deployed.Treasury,
    GOLD_FEED,
    PAXG_FEED
  );
  await oracle.waitForDeployment();
  deployed.GoldOracle = await oracle.getAddress();
  console.log("  ✅ GoldOracle:", deployed.GoldOracle);

  // 主网：配置两步模式 PAXG/ETH × ETH/USD
  if (USE_TWO_STEP_PAXG) {
    await oracle.setTwoStepPAXGFeeds(PAXG_ETH_FEED, ETH_USD_FEED);
    console.log("  ✅ Two-step PAXG price mode: PAXG/ETH ×ETH/USD");
    console.log("     PAXG/ETH feed:", PAXG_ETH_FEED);
    console.log("     ETH/USD feed: ", ETH_USD_FEED);
  }

  // 授予 Oracle GOLD_ORACLE_ROLE
  const GOLD_ORACLE_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("GOLD_ORACLE_ROLE"));
  await treasury.grantRole(GOLD_ORACLE_ROLE, deployed.GoldOracle);
  console.log("  ✅ GOLD_ORACLE_ROLE → GoldOracle");

  // 5b. PriceDefense
  const PriceDefense = await hre.ethers.getContractFactory("PriceDefense");
  const defense = await PriceDefense.deploy(
    deployed.ConfigManager,
    deployed.Treasury,
    deployed.PGOLDSwap
  );
  await defense.waitForDeployment();
  deployed.PriceDefense = await defense.getAddress();
  console.log("  ✅ PriceDefense:", deployed.PriceDefense);

  // ══════════════════════════════════════════════════
  // 部署完成 — 输出清单
  // ══════════════════════════════════════════════════
  console.log("\n========================================");
  console.log("  🎉 pGOLD Protocol V4 部署完成!");
  console.log("========================================");
  console.log("  Network:", hre.network.name);
  console.log("  Chain ID:", hre.network.config.chainId);
  console.log("  Deployer:", deployer.address);
  console.log("========================================");
  console.log("\n  L1 Core Layer:");
  console.log("    PGOLDToken:     ", deployed.PGOLDToken);
  console.log("    Treasury:       ", deployed.Treasury);
  console.log("    ConfigManager:  ", deployed.ConfigManager);
  console.log("\n  L2 AMM Layer:");
  console.log("    PGOLDSwap:      ", deployed.PGOLDSwap);
  console.log("    FeeRouter:      ", deployed.FeeRouter);
  console.log("\n  L3 Five-Track Incentives:");
  console.log("    StakingRewards  ", deployed.StakingRewards);
  console.log("    RankingRewards  ", deployed.RankingRewards);
  console.log("    BurnMining      ", deployed.BurnMining);
  console.log("    TeamRewards     ", deployed.TeamRewards);
  console.log("    GenesisPool  ★  ", deployed.GenesisPool);
  console.log("    VestingManager  ", deployed.VestingManager);
  console.log("    vPGOLD          ", deployed.vPGOLD);
  console.log("\n  L4 Oracle/Defense:");
  console.log("    GoldOracle:     ", deployed.GoldOracle);
  console.log("    PriceDefense:   ", deployed.PriceDefense);
  console.log("\n========================================\n");

  // 保存部署地址到 JSON 文件
  const deployFile = path.join(__dirname, "..", `deployed_${hre.network.name}.json`);
  const deployData = {
    network: hre.network.name,
    chainId: hre.network.config.chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    addresses: deployed,
  };
  fs.writeFileSync(deployFile, JSON.stringify(deployData, null, 2));
  console.log(`  📄 部署清单已保存: ${deployFile}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ 部署失败:", error.message || error);
    process.exit(1);
  });
