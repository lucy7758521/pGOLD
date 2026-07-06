// ╔══════════════════════════════════════════════════════════════╗
// ║  sync_addresses.js — 部署后自动同步合约地址到前端文件       ║
// ║  用法: node scripts/sync_addresses.js                       ║
// ╚══════════════════════════════════════════════════════════════╝

const fs = require("fs");
const path = require("path");

const DEPLOYED_JSON = path.join(__dirname, "..", "deployed_hardhat.json");
const FRONTEND_DIR  = path.join(__dirname, "..", "..", "frontend");

const FRONTEND_FILES = [
  "dapp_v3.html",
  "swap_v3.html",
];

// ── 从 deployed_hardhat.json 读取地址 ──
if (!fs.existsSync(DEPLOYED_JSON)) {
  console.error("❌  deployed_hardhat.json not found. Run deploy_local.js first.");
  process.exit(1);
}

const deployed = JSON.parse(fs.readFileSync(DEPLOYED_JSON, "utf8")).addresses;

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
  // remove trailing comma from last entry
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
  return lines.join("\n");
}

function syncFile(filename, addrMap, startMarker, endMarker) {
  const filepath = path.join(FRONTEND_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`  ⚠️  File not found: ${filename}`);
    return;
  }

  let content = fs.readFileSync(filepath, "utf8");
  const start = content.indexOf(startMarker);
  const end   = content.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    console.warn(`  ⚠️  Could not find CONTRACT_ADDRS block in ${filename}`);
    return;
  }

  const indent = "  ";
  const newBlock =
    startMarker + "\n" +
    buildAddrBlock(addrMap, indent) + "\n" +
    endMarker;

  const before = content.slice(0, start);
  const after  = content.slice(end + endMarker.length);
  content = before + newBlock + after;

  fs.writeFileSync(filepath, content, "utf8");
  console.log(`  ✅  ${filename} updated`);
}

console.log("\n╔══ sync_addresses.js ══════════════════════════════════════╗\n");
console.log(`  📄 Source: ${DEPLOYED_JSON}`);
console.log(`  🕐 Deployed at: ${JSON.parse(fs.readFileSync(DEPLOYED_JSON, "utf8")).timestamp}\n`);

syncFile("dapp_v3.html", DAPP_ADDR_MAP, "const CONTRACT_ADDRS = {", "};");
syncFile("swap_v3.html", SWAP_ADDR_MAP, "const CONTRACT_ADDRS = {", "};");

console.log("\n✅  Address sync complete.\n");
