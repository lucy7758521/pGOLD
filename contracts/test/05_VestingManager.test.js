/**
 * VestingManager 单元测试
 * 覆盖：释放计划创建/claim/线性精度/批量获取
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("VestingManager", function () {
  let vesting, pgold, treasury, config, mockPAXG, mockUSDC;
  let owner, alice, bob;

  before(async function () {
    [owner, alice, bob] = await hre.ethers.getSigners();

    // Deploy pGOLD
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // Deploy ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC = await MockERC20.deploy("USDC", "USDC");
    await mockPAXG.waitForDeployment();
    await mockUSDC.waitForDeployment();

    // Deploy Treasury
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target,
      mockPAXG.target, mockUSDC.target, owner.address
    );
    await treasury.waitForDeployment();

    // Grant MINTER_ROLE to Treasury
    const minterRole = await pgold.MINTER_ROLE();
    await pgold.grantRole(minterRole, treasury.target);

    // Deploy VestingManager
    const VestingManager = await ethers.getContractFactory("VestingManager");
    vesting = await VestingManager.deploy(pgold.target, treasury.target);
    await vesting.waitForDeployment();

    // Authorize owner as creator, Treasury authorizes VestingManager for mint
    await vesting.setAuthorizedCreator(owner.address, true);
    await treasury.setMintAuthorized(vesting.target, true);
  });

  describe("部署", function () {
    it("pGOLD 地址正确", async function () {
      expect(await vesting.pGOLD()).to.equal(pgold.target);
    });

    it("初始 nextScheduleId = 0", async function () {
      expect(await vesting.nextScheduleId()).to.equal(0n);
    });
  });

  describe("创建释放计划", function () {
    it("10年释放计划创建成功", async function () {
      const total = ethers.parseEther("10000");
      const duration = 10n * 365n * 86400n;
      const tx = await vesting.createSchedule(
        alice.address, total, duration, 0 // BURN_MINING
      );
      await tx.wait();

      // 第一个 schedule ID 为 0
      const sched = await vesting.getSchedule(0);
      expect(sched.beneficiary).to.equal(alice.address);
      expect(sched.totalAmount).to.equal(total);
      expect(sched.duration).to.equal(duration);
      expect(await vesting.nextScheduleId()).to.equal(1n);
    });

    it("不同受益人独立计划", async function () {
      await vesting.createSchedule(
        bob.address,
        ethers.parseEther("5000"),
        10n * 365n * 86400n,
        1 // RANKING_MONTHLY
      );

      // alice → ID 0, bob → ID 1
      const sched0 = await vesting.getSchedule(0);
      const sched1 = await vesting.getSchedule(1);
      expect(sched0.beneficiary).to.equal(alice.address);
      expect(sched1.beneficiary).to.equal(bob.address);
    });
  });

  describe("Claim 线性释放", function () {
    let scheduleId;
    const total = ethers.parseEther("3650"); // 3650 pGOLD over 1 year
    const duration = 365n * 86400n;

    before(async function () {
      const tx = await vesting.createSchedule(
        alice.address, total, duration, 0
      );
      await tx.wait();
      // nextScheduleId 在 createSchedule 中自增，刚创建的 schedule id = nextScheduleId - 1
      scheduleId = (await vesting.nextScheduleId()) - 1n;
    });

    it("刚创建时 claimable = 0", async function () {
      expect(await vesting.getClaimableAmount(scheduleId)).to.equal(0n);
    });

    it("1 天后 claimable ≈ total/365", async function () {
      await ethers.provider.send("evm_increaseTime", [86400]);
      await ethers.provider.send("evm_mine");

      const claimableAmount = await vesting.getClaimableAmount(scheduleId);
      expect(claimableAmount).to.be.closeTo(
        ethers.parseEther("10"), ethers.parseEther("0.1")
      );
    });

    it("claim 后已释放量累计", async function () {
      await vesting.connect(alice).claim(scheduleId);
      const sched = await vesting.getSchedule(scheduleId);
      expect(sched.claimedAmount).to.be.gt(0n);
    });

    it("相同时间点重复 claim 不增", async function () {
      const before = (await vesting.getSchedule(scheduleId)).claimedAmount;
      // 同一区块内 claimable 接近 0（block 间隔可能积累微量）
      const claimable = await vesting.getClaimableAmount(scheduleId);
      expect(claimable).to.be.lte(ethers.parseEther("0.01"));
      // 即使有微量，claimedAmount 也不应有显著变化
      if (claimable > 0n) {
        await vesting.connect(alice).claim(scheduleId);
      }
      const after = (await vesting.getSchedule(scheduleId)).claimedAmount;
      expect(after).to.be.closeTo(before, ethers.parseEther("0.01"));
    });

    it("180 天后剩余可领取", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(179n * 86400n)]);
      await ethers.provider.send("evm_mine");

      const claimableAmount = await vesting.getClaimableAmount(scheduleId);
      expect(claimableAmount).to.be.gt(ethers.parseEther("1700"));
    });

    it("完成后 claimable = total - claimed", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(365n * 86400n)]);
      await ethers.provider.send("evm_mine");

      const schedBefore = await vesting.getSchedule(scheduleId);
      const claimableAmount = await vesting.getClaimableAmount(scheduleId);
      expect(claimableAmount).to.be.closeTo(
        schedBefore.totalAmount - schedBefore.claimedAmount,
        ethers.parseEther("1")
      );
    });
  });

  describe("getBeneficiarySchedules", function () {
    it("返回受益人的所有计划 ID", async function () {
      const ids = await vesting.getBeneficiarySchedules(alice.address);
      expect(ids.length).to.be.gt(0n);
    });
  });
});
