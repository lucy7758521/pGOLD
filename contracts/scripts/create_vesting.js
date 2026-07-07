const hre = require("hardhat");

const ADDRESSES = {
  vesting: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
  vpgold:  "0x322813Fd9A801c5507c9de605d63CEA4f2CE6c44",
  account0:"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
};

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const vesting = await hre.ethers.getContractAt("VestingManager", ADDRESSES.vesting);

  // 1. Authorize deployer as creator
  await vesting.setAuthorizedCreator(signer.address, true);
  console.log("Authorized creator:", signer.address);

  // 2. Create a 3-year vesting schedule for Account #0: 1200 pGOLD
  const THREE_YEARS = 3 * 365 * 24 * 3600;
  const tx = await vesting.createSchedule(
    ADDRESSES.account0,
    hre.ethers.parseEther("1200"),
    THREE_YEARS,
    4 // ScheduleType.GENESIS_POOL
  );
  const receipt = await tx.wait();
  const event = receipt.logs.find(l => {
    try { return vesting.interface.parseLog(l).name === "ScheduleCreated"; } catch { return false; }
  });
  const parsed = vesting.interface.parseLog(event);
  const scheduleId = parsed.args[0];
  console.log("Schedule ID:", scheduleId.toString());

  // 3. Show schedule
  const schedule = await vesting.getSchedule(scheduleId);
  console.log("Total:", hre.ethers.formatEther(schedule.totalAmount), "pGOLD");
  console.log("Beneficiary:", schedule.beneficiary);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
