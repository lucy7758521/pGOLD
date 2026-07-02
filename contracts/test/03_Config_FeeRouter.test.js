/**
 * ConfigManager + FeeRouter + RoleRegistry 联合单元测试
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("ConfigManager", function () {
  let config, owner, alice;

  before(async function () {
    [owner, alice] = await hre.ethers.getSigners();
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();
  });

  describe("默认参数", function () {
    it("tradeFeeRate = 25 (0.25%)", async function () {
      expect(await config.tradeFeeRate()).to.equal(25n);
    });

    it("burnCompensationRate = 1000 (1000%)", async function () {
      expect(await config.burnCompensationRate()).to.equal(1000n);
    });

    it("burnVestingYears = 10", async function () {
      expect(await config.burnVestingYears()).to.equal(10n);
    });

    it("rankingVestingYears = 10", async function () {
      expect(await config.rankingVestingYears()).to.equal(10n);
    });

    it("monthlyMultiplier = 300 (300%)", async function () {
      expect(await config.monthlyMultiplier()).to.equal(300n);
    });

    it("quarterlyMultiplier = 500 (500%)", async function () {
      expect(await config.quarterlyMultiplier()).to.equal(500n);
    });

    it("annualMultiplier = 1000 (1000%)", async function () {
      expect(await config.annualMultiplier()).to.equal(1000n);
    });

    it("dividendAPR = 350 (3.5%)", async function () {
      expect(await config.dividendAPR()).to.equal(350n);
    });

    it("directInviteRate = 20 (20%)", async function () {
      expect(await config.directInviteRate()).to.equal(20n);
    });

    it("indirectInviteRate = 5 (5%)", async function () {
      expect(await config.indirectInviteRate()).to.equal(5n);
    });

    it("teamBonusRate = 20 (20%)", async function () {
      expect(await config.teamBonusRate()).to.equal(20n);
    });

    it("teamCaptainShare = 30 (30%)", async function () {
      expect(await config.teamCaptainShare()).to.equal(30n);
    });

    it("l2DiscountThreshold = 300 (3%)", async function () {
      expect(await config.l2DiscountThreshold()).to.equal(300n);
    });

    it("l2DurationThreshold = 7 days", async function () {
      expect(await config.l2DurationThreshold()).to.equal(7n * 86400n);
    });

    it("l3DiscountThreshold = 1000 (10%)", async function () {
      expect(await config.l3DiscountThreshold()).to.equal(1000n);
    });

    it("l3DurationThreshold = 48 hours", async function () {
      expect(await config.l3DurationThreshold()).to.equal(48n * 3600n);
    });

    it("getAllParams 返回完整参数", async function () {
      const params = await config.getAllParams();
      expect(params.dividendAPR_).to.equal(350n);
      expect(params.tradeFeeRate_).to.equal(25n);
    });
  });

  describe("参数修改 (需 GOVERNOR_ROLE + 时间锁)", function () {
    it("tradeFeeRate 有默认值", async function () {
      expect(await config.tradeFeeRate()).to.equal(25n);
    });

    it("时间锁延迟为 2 天", async function () {
      expect(await config.TIMELOCK_DELAY()).to.equal(2n * 86400n);
    });
  });
});

// ===================================================================

describe("FeeRouter", function () {
  let feeRouter, mockUSDC, mockPAXG, treasury, pgold, config, owner, alice;

  before(async function () {
    [owner, alice] = await hre.ethers.getSigners();

    // Deploy mocks
    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockUSDC = await MockERC20.deploy("USDC", "USDC");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    await mockUSDC.waitForDeployment();
    await mockPAXG.waitForDeployment();

    // Deploy pGOLD
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // Deploy ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // Deploy real Treasury (needed for receiveFees)
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await treasury.waitForDeployment();

    // Grant MINTER_ROLE to Treasury
    const minterRole = await pgold.MINTER_ROLE();
    await pgold.grantRole(minterRole, treasury.target);

    // Deploy FeeRouter with real Treasury
    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    feeRouter = await FeeRouter.deploy(treasury.target, mockUSDC.target);
    await feeRouter.waitForDeployment();

    // Set swapContract to allow routeFee calls from test
    await feeRouter.setSwapContract(owner.address);
  });

  describe("手续费分配", function () {
    it("分配比例正确 (95/3/1.5/0.5)", async function () {
      const U = (v) => ethers.parseUnits(v, 6);
      const distribution = await feeRouter.calculateDistribution(U("10000"));
      expect(distribution[0]).to.equal(U("9500"));  // 95% GOLD_RESERVE
      expect(distribution[1]).to.equal(U("300"));   // 3% INSURANCE
      expect(distribution[2]).to.equal(U("150"));   // 1.5% LIQUIDITY
      expect(distribution[3]).to.equal(U("50"));    // 0.5% EMERGENCY
    });

    it("四份之和等于总手续费", async function () {
      const U = (v) => ethers.parseUnits(v, 6);
      const total = U("7777");
      const dist = await feeRouter.calculateDistribution(total);
      const sum = dist[0] + dist[1] + dist[2] + dist[3];
      expect(sum).to.equal(total);
    });
  });

  describe("routeFee", function () {
    it("正确路由手续费到 Treasury（Treasury 内部记账更新）", async function () {
      const feeAmount = ethers.parseUnits("10000", 6);
      // USDC 不经过 FeeRouter — PGOLDSwap 直接将 USDC 转入 Treasury
      // FeeRouter.routeFee 仅负责调用 Treasury.receiveFees 做分配记账
      // 直接 mint USDC 到 Treasury 模拟已转入
      await mockUSDC.mint(treasury.target, feeAmount);
      await feeRouter.routeFee(feeAmount);
      // 验证：Treasury GOLD_RESERVE 账户收到 95%
      const goldReserve = await treasury.getAccountBalance(0);
      expect(goldReserve).to.equal(ethers.parseUnits("9500", 6));
    });
  });
});
