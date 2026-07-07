// ╔══════════════════════════════════════════════════════════════╗
// ║  verify_testnet.js — Arbiscan 合约源码验证                   ║
// ║  用法: npx hardhat run scripts/verify_testnet.js             ║
// ║        --network arbitrum-sepolia                            ║
// ╚══════════════════════════════════════════════════════════════╝

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function verify(address, constructorArgs, contractName) {
  console.log(`\n  🔍 Verifying ${contractName} @ ${address}`);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`  ✅ ${contractName} verified`);
    return true;
  } catch(e) {
    if (e.message && e.message.includes("Already Verified")) {
      console.log(`  ✓  ${contractName} already verified`);
      return true;
    }
    console.warn(`  ⚠️  ${contractName} failed: ${e.message?.split("\n")[0]}`);
    return false;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  pGOLD Protocol V4 — Arbiscan 验证                          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const deployedPath = path.join(__dirname, "..", "deployed_testnet.json");
  if (!fs.existsSync(deployedPath)) {
    console.error("❌  deployed_testnet.json not found. Deploy first:");
    console.error("    npx hardhat run scripts/deploy_testnet.js --network arbitrum-sepolia");
    process.exit(1);
  }

  const { addresses: a } = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  const results = [];
  let passed = 0, failed = 0;

  async function run(name, addr, args) {
    const ok = await verify(addr, args, name);
    results.push({ name, addr, ok });
    ok ? passed++ : failed++;
  }

  // ── Mock contracts (skip — no source available on Arbiscan for mocks) ──
  console.log("  ℹ️  Skipping mock contracts (ERC20Mock, Aggregator, Router)\n");

  // ── Core ──
  await run("ConfigManager", a.ConfigManager, []);
  await run("PGOLDToken",    a.PGOLDToken,    []);
  await run("Treasury",      a.Treasury,      [a.PGOLDToken, a.ConfigManager, a.PAXG, a.USDC, a.UNISWAP_ROUTER]);
  await run("FeeRouter",     a.FeeRouter,     [a.Treasury, a.USDC]);

  // ── Phase 3 ──
  await run("VestingManager", a.VestingManager, [a.PGOLDToken, a.Treasury]);
  await run("PGOLDSwap",      a.PGOLDSwap,      [a.PGOLDToken, a.USDC, a.FeeRouter, a.Treasury]);

  // ── Incentives ──
  await run("StakingRewards", a.StakingRewards, [a.PGOLDToken, a.Treasury, a.ConfigManager]);
  await run("BurnMining",     a.BurnMining,     [a.PGOLDToken, a.ConfigManager, a.VestingManager]);
  await run("RankingRewards", a.RankingRewards, [a.ConfigManager, a.VestingManager]);
  await run("TeamRewards",    a.TeamRewards,    [a.ConfigManager, a.Treasury]);
  await run("vPGOLD",         a.vPGOLD,         [a.PGOLDToken, a.VestingManager]);
  await run("GenesisPool",    a.GenesisPool,    [a.USDC, a.PAXG, (await hre.ethers.getSigners())[0].address]);

  // ── Oracle / Defense ──
  await run("GoldOracle",   a.GoldOracle,   [a.Treasury, a.CHAINLINK_XAU, a.CHAINLINK_PAXG]);
  await run("PriceDefense", a.PriceDefense, [a.ConfigManager, a.Treasury, a.PGOLDSwap]);

  // ── Summary ──
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  验证结果: ${passed} 通过 / ${failed} 失败`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (failed > 0) {
    console.log("  失败的合约（可单独重试）:");
    results.filter(r => !r.ok).forEach(r => {
      console.log(`    npx hardhat verify --network arbitrum-sepolia ${r.addr}`);
    });
    console.log("");
  }

  console.log("  Arbiscan: https://sepolia.arbiscan.io\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌", err.message || err);
    process.exit(1);
  });
