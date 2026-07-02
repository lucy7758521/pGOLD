// pGOLD Protocol — 合约验证脚本
// 依赖: deployed_<network>.json（由 deploy.js 自动生成）
// 用法: npx hardhat run scripts/verify.js --network arbitrum-sepolia

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const networkName = hre.network.name;
  const deployFile = path.join(__dirname, "..", `deployed_${networkName}.json`);

  if (!fs.existsSync(deployFile)) {
    console.error(`❌ 找不到部署清单: ${deployFile}`);
    console.error("   请先运行: npx hardhat run scripts/deploy.js --network", networkName);
    process.exit(1);
  }

  const { addresses } = JSON.parse(fs.readFileSync(deployFile, "utf8"));

  console.log("========================================");
  console.log("  pGOLD Protocol — 合约验证");
  console.log("  Network:", networkName);
  console.log("========================================\n");

  // 外部依赖地址（无需构造参数）
  const USDC_ADDRESS = process.env.USDC_ADDRESS || "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const PAXG_ADDRESS = process.env.PAXG_ADDRESS || "0x_";
  const UNISWAP_ROUTER = process.env.UNISWAP_ROUTER || "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const GOLD_FEED = process.env.CHAINLINK_XAU_USD || "0x_";
  const PAXG_FEED = process.env.CHAINLINK_PAXG_USD || "0x_";

  const verifyQueue = [
    // Phase 1
    { name: "ConfigManager", address: addresses.ConfigManager, args: [] },
    { name: "PGOLDToken", address: addresses.PGOLDToken, args: [] },

    // Phase 2
    {
      name: "Treasury",
      address: addresses.Treasury,
      args: [addresses.PGOLDToken, addresses.ConfigManager, PAXG_ADDRESS, USDC_ADDRESS, UNISWAP_ROUTER],
    },
    {
      name: "FeeRouter",
      address: addresses.FeeRouter,
      args: [addresses.Treasury, USDC_ADDRESS],
    },

    // Phase 3
    {
      name: "VestingManager",
      address: addresses.VestingManager,
      args: [addresses.PGOLDToken, addresses.Treasury],
    },
    {
      name: "PGOLDSwap",
      address: addresses.PGOLDSwap,
      args: [addresses.PGOLDToken, USDC_ADDRESS, addresses.FeeRouter],
    },

    // Phase 4 — Five-track incentives
    {
      name: "StakingRewards",
      address: addresses.StakingRewards,
      args: [addresses.PGOLDToken, addresses.Treasury, addresses.ConfigManager],
    },
    {
      name: "BurnMining",
      address: addresses.BurnMining,
      args: [addresses.PGOLDToken, addresses.ConfigManager, addresses.VestingManager],
    },
    {
      name: "RankingRewards",
      address: addresses.RankingRewards,
      args: [addresses.ConfigManager, addresses.VestingManager],
    },
    { name: "vPGOLD", address: addresses.vPGOLD, args: [addresses.PGOLDToken, addresses.VestingManager] },
    {
      name: "TeamRewards",
      address: addresses.TeamRewards,
      args: [addresses.ConfigManager, addresses.Treasury],
    },
    {
      name: "GenesisPool",
      address: addresses.GenesisPool,
      args: [USDC_ADDRESS, PAXG_ADDRESS, addresses.deployer || "0x_"],
    },

    // Phase 5
    {
      name: "GoldOracle",
      address: addresses.GoldOracle,
      args: [addresses.Treasury, GOLD_FEED, PAXG_FEED],
    },
    {
      name: "PriceDefense",
      address: addresses.PriceDefense,
      args: [addresses.ConfigManager, addresses.Treasury, addresses.PGOLDSwap],
    },
  ];

  let success = 0;
  let failed = 0;

  for (const { name, address, args } of verifyQueue) {
    if (!address || address === "0x_" || address.startsWith("0x_")) {
      console.log(`  ⏭️  ${name}: 地址未配置，跳过`);
      continue;
    }

    try {
      console.log(`  🔍 正在验证 ${name}...`);
      await hre.run("verify:verify", {
        address,
        constructorArguments: args,
      });
      console.log(`  ✅ ${name} 验证成功`);
      success++;
    } catch (error) {
      // "Already Verified" 也视为成功
      if (error.message && error.message.includes("Already Verified")) {
        console.log(`  ✅ ${name} 已验证过`);
        success++;
      } else {
        console.error(`  ❌ ${name} 验证失败:`, error.message?.slice(0, 200));
        failed++;
      }
    }

    // 避免 API 频率限制
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log(`\n========================================`);
  console.log(`  验证完成: ${success} 成功, ${failed} 失败`);
  console.log(`========================================`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ 验证流程出错:", error.message || error);
    process.exit(1);
  });
