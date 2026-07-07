// Mint test USDC (and optionally pGOLD) to a target address on Arbitrum Sepolia
//
// Usage:
//   npx hardhat run scripts/mint_test_tokens.js --network arbitrum-sepolia
//
// Config: edit the variables below before running

const hre = require("hardhat");

// ── Config ──────────────────────────────────────────────────────────────────
const USDC_ADDRESS  = "0x8E927ACEF4e77CCCc56bcfd94bE43B964D741E66";
const PGOLD_ADDRESS = "0x8bAeC48a7F13100D57cf08448081Cf6a8620cF7F";

// Address to receive tokens — defaults to deployer if left empty
const TARGET = "";

const USDC_AMOUNT  = "10000";   // 10,000 USDC  (6 decimals)
const PGOLD_AMOUNT = "100";     // 100 pGOLD    (18 decimals)
// ────────────────────────────────────────────────────────────────────────────

const ERC20_MINT_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function mintToken(signer, address, amount, label) {
  const contract = new hre.ethers.Contract(address, ERC20_MINT_ABI, signer);
  const decimals  = await contract.decimals();
  const symbol    = await contract.symbol();
  const parsed    = hre.ethers.parseUnits(amount, decimals);
  const target    = TARGET || signer.address;

  console.log(`  Minting ${amount} ${symbol} to ${target} ...`);
  const tx = await contract.mint(target, parsed);
  await tx.wait();

  const bal = await contract.balanceOf(target);
  console.log(`  ✅ ${label} balance: ${hre.ethers.formatUnits(bal, decimals)} ${symbol}`);
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const target   = TARGET || signer.address;

  console.log("========================================");
  console.log("  pGOLD — Mint Test Tokens");
  console.log("========================================");
  console.log("  Network:", hre.network.name);
  console.log("  Signer: ", signer.address);
  console.log("  Target: ", target);
  console.log("========================================\n");

  await mintToken(signer, USDC_ADDRESS,  USDC_AMOUNT,  "USDC");
  await mintToken(signer, PGOLD_ADDRESS, PGOLD_AMOUNT, "pGOLD");

  console.log("\n  Done. You can now use these tokens in the DApp.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Failed:", err.message || err);
    process.exit(1);
  });
