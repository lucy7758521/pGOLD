const hre = require("hardhat");
const { ethers } = require("hardhat");

async function main() {
  console.log("Initializing PGOLDSwap pool...");

  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);

  // Contract addresses (update these from your deployment)
  const PGOLD_ADDR = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";
  const USDC_ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const SWAP_ADDR = "0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82";

  // Get contracts
  const pgold = await ethers.getContractAt("PGOLDToken", PGOLD_ADDR);
  const usdc = await ethers.getContractAt("ERC20Mock", USDC_ADDR);
  const swap = await ethers.getContractAt("PGOLDSwap", SWAP_ADDR);

  // Check current reserves
  const reserveUSDC = await swap.reserveUSDC();
  const reservePGOLD = await swap.reservePGOLD();

  if (reserveUSDC > 0n || reservePGOLD > 0n) {
    console.log("Pool already initialized!");
    console.log("USDC Reserve:", ethers.formatUnits(reserveUSDC, 6));
    console.log("pGOLD Reserve:", ethers.formatEther(reservePGOLD));
    return;
  }

  // Initial liquidity: 100 USDC + 1 pGOLD (price = $100/pGOLD)
  const usdcAmount = ethers.parseUnits("100", 6);  // 100 USDC
  const pgoldAmount = ethers.parseEther("1");       // 1 pGOLD

  console.log("\nAdding initial liquidity:");
  console.log("- USDC:", ethers.formatUnits(usdcAmount, 6));
  console.log("- pGOLD:", ethers.formatEther(pgoldAmount));

  // Check balances
  const usdcBal = await usdc.balanceOf(deployer.address);
  const pgoldBal = await pgold.balanceOf(deployer.address);

  console.log("\nCurrent balances:");
  console.log("- USDC:", ethers.formatUnits(usdcBal, 6));
  console.log("- pGOLD:", ethers.formatEther(pgoldBal));

  if (usdcBal < usdcAmount) {
    console.error("Insufficient USDC balance!");
    return;
  }
  if (pgoldBal < pgoldAmount) {
    console.error("Insufficient pGOLD balance!");
    return;
  }

  // Approve tokens
  console.log("\nApproving tokens...");
  let tx = await usdc.approve(SWAP_ADDR, usdcAmount);
  await tx.wait();
  console.log("✓ USDC approved");

  tx = await pgold.approve(SWAP_ADDR, pgoldAmount);
  await tx.wait();
  console.log("✓ pGOLD approved");

  // Initialize pool
  console.log("\nInitializing pool...");
  tx = await swap.initializePool(usdcAmount, pgoldAmount);
  await tx.wait();
  console.log("✓ Pool initialized!");

  // Verify
  const newReserveUSDC = await swap.reserveUSDC();
  const newReservePGOLD = await swap.reservePGOLD();
  const price = await swap.getPrice();

  console.log("\nPool state:");
  console.log("- USDC Reserve:", ethers.formatUnits(newReserveUSDC, 6));
  console.log("- pGOLD Reserve:", ethers.formatEther(newReservePGOLD));
  console.log("- Price:", ethers.formatUnits(price, 8), "USDC/pGOLD");

  console.log("\n✅ Swap pool ready for trading!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
