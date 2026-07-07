const hre = require("hardhat");
const { ethers } = require("hardhat");

async function main() {
  console.log("Feeding price to Oracle/Treasury...");

  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);

  // Contract addresses
  const ORACLE_ADDR = "0x9A676e781A523b5d0C0e43731313A708CB607508";
  const TREASURY_ADDR = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6";

  // Get contracts
  const oracle = await ethers.getContractAt("GoldOracle", ORACLE_ADDR);
  const treasury = await ethers.getContractAt("Treasury", TREASURY_ADDR);

  // Check current prices
  console.log("\nBefore update:");
  const goldPriceBefore = await treasury.goldPriceUSD();
  const paxgPriceBefore = await treasury.paxgPriceUSD();
  console.log("Gold price (USD/gram):", ethers.formatUnits(goldPriceBefore, 8));
  console.log("PAXG price (USD/oz):", ethers.formatUnits(paxgPriceBefore, 8));

  // Update prices via Oracle
  console.log("\nUpdating prices...");
  const tx = await oracle.updatePrices();
  await tx.wait();
  console.log("✓ Prices updated");

  // Check new prices
  console.log("\nAfter update:");
  const goldPriceAfter = await treasury.goldPriceUSD();
  const paxgPriceAfter = await treasury.paxgPriceUSD();
  console.log("Gold price (USD/gram):", ethers.formatUnits(goldPriceAfter, 8));
  console.log("PAXG price (USD/oz):", ethers.formatUnits(paxgPriceAfter, 8));

  // Calculate pGOLD price
  const goldPrice = parseFloat(ethers.formatUnits(goldPriceAfter, 8));
  const paxgPrice = parseFloat(ethers.formatUnits(paxgPriceAfter, 8));
  const pGoldPrice = paxgPrice / 31.1035;

  console.log("\nCalculated pGOLD price (1 gram):", pGoldPrice.toFixed(2), "USD");
  console.log("✅ Price feed complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
