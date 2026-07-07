// ╔══════════════════════════════════════════════════════════════╗
// ║  sync_addresses.js — 部署后自动同步合约地址到前端文件       ║
// ║  用法:                                                       ║
// ║    node scripts/sync_addresses.js              (本地)        ║
// ║    node scripts/sync_addresses.js --testnet    (测试网)      ║
// ╚══════════════════════════════════════════════════════════════╝

const fs   = require("fs");
const path = require("path");

const isTestnet = process.argv.includes("--testnet");
const JSON_FILE = isTestnet ? "deployed_testnet.json" : "deployed_hardhat.json";
const CHAIN_ID  = isTestnet ? 421614 : 31337;

const DEPLOYED_JSON = path.join(__dirname, "..", JSON_FILE);
const FRONTEND_DIR  = path.join(__dirname, "..", "..", "frontend");

if (!fs.existsSync(DEPLOYED_JSON)) {
  const cmd = isTestnet
    ? "npx hardhat run scripts/deploy_testnet.js --network arbitrum-sepolia"
    : "npx hardhat run scripts/deploy_local.js";
  console.error(`❌  ${JSON_FILE} not found. Run:\n    ${cmd}`);
  process.exit(1);
}

const deployData = JSON.parse(fs.readFileSync(DEPLOYED_JSON, "utf8"));
const deployed   = deployData.addresses;

// ── 地址映射：前端 key → JSON key ──
const DAPP_ADDR_MAP = {
  pgold:      "PGOLDToken",
  treasury:   "Treasury",
  feeRouter:  "FeeRouter",
  vesting:    "VestingManager",
  swap:       "PGOLDSwap",
  staking:    "StakingRewards",
  ranking:    "RankingRewards",
  burnMining: "BurnMining",
  team:       "TeamRewards",
  genesis:    "GenesisPool",
  vpgold:     "vPGOLD",
  oracle:     "GoldOracle",
  usdc:       "USDC",
  paxg:       "PAXG",
};

const SWAP_ADDR_MAP = {
  pgold:    "PGOLDToken",
  usdc:     "USDC",
  swap:     "PGOLDSwap",
  treasury: "Treasury",
};

function buildAddrBlock(addrMap, indent) {
  const lines = Object.entries(addrMap).map(([key, jsonKey]) => {
    const addr = deployed[jsonKey];
    if (!addr) { console.warn(`  ⚠️  Missing address for key: ${jsonKey}`); return null; }
    const pad = " ".repeat(Math.max(1, 12 - key.length));
    return `${indent}${key}:${pad}'${addr}',`;
  }).filter(Boolean);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
  return lines.join("\n");
}

function syncFile(filename, addrMap) {
  const filepath = path.join(FRONTEND_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`  ⚠️  File not found: ${filename}`);
    return;
  }

  let content = fs.readFileSync(filepath, "utf8");

  // 更新 CHAIN_ID
  content = content.replace(
    /const CHAIN_ID\s*=\s*\d+;/,
    `const CHAIN_ID = ${CHAIN_ID};`
  );

  // 更新 CONTRACT_ADDRS 块
  const startMarker = "const CONTRACT_ADDRS = {";
  const endMarker   = "};";
  const start = content.indexOf(startMarker);
  const end   = content.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    console.warn(`  ⚠️  Could not find CONTRACT_ADDRS block in ${filename}`);
    return;
  }

  const indent   = "  ";
  const newBlock = startMarker + "\n" + buildAddrBlock(addrMap, indent) + "\n" + endMarker;
  content = content.slice(0, start) + newBlock + content.slice(end + endMarker.length);

  fs.writeFileSync(filepath, content, "utf8");
  console.log(`  ✅  ${filename} updated (chainId=${CHAIN_ID})`);
}

const network = isTestnet ? "Arbitrum Sepolia (testnet)" : "Hardhat local";
console.log(`\n╔══ sync_addresses.js — ${network} ══════════════════╗\n`);
console.log(`  📄 Source:  ${DEPLOYED_JSON}`);
console.log(`  🕐 Deployed: ${deployData.timestamp}\n`);

syncFile("dapp_v3.html", DAPP_ADDR_MAP);
syncFile("swap_v3.html", SWAP_ADDR_MAP);

console.log(`\n✅  Address sync complete. Network: ${network}\n`);

