const hre = require("hardhat");
async function main() {
  const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const usdc = await hre.ethers.getContractAt("ERC20Mock", USDC);
  await usdc.mint(ACCOUNT0, hre.ethers.parseUnits("10000", 6));
  const bal = await usdc.balanceOf(ACCOUNT0);
  console.log("USDC balance:", hre.ethers.formatUnits(bal, 6));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
