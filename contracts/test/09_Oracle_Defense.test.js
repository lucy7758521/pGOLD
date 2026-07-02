/**
 * GoldOracle + PriceDefense 单元测试
 * 金价预言机 + 三层价格防线
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

// =====================================================================
// GoldOracle
// =====================================================================
describe("GoldOracle", function () {
  let oracle, owner, alice;

  before(async function () {
    [owner, alice] = await hre.ethers.getSigners();
    const GoldOracle = await ethers.getContractFactory("GoldOracle");
    oracle = await GoldOracle.deploy(owner.address, owner.address, owner.address);
    await oracle.waitForDeployment();
  });

  describe("部署", function () {
    it("treasury 地址正确", async function () {
      expect(await oracle.treasury()).to.equal(owner.address);
    });

    it("初始金价 = 0 (未喂价)", async function () {
      expect(await oracle.goldPriceUSD()).to.equal(0n);
    });

    it("初始 PAXG 价格 = 0", async function () {
      expect(await oracle.paxgPriceUSD()).to.equal(0n);
    });

    it("GOLD_ORACLE_ROLE 已授予部署者", async function () {
      const oracleRole = ethers.keccak256(ethers.toUtf8Bytes("GOLD_ORACLE_ROLE"));
      expect(await oracle.hasRole(oracleRole, owner.address)).to.equal(true);
    });
  });

  describe("Feed 管理", function () {
    it("DEFAULT_ADMIN 可设置 goldFeed", async function () {
      await oracle.setGoldFeed(alice.address);
      expect(await oracle.goldFeed()).to.equal(alice.address);
    });

    it("DEFAULT_ADMIN 可设置 paxgFeed", async function () {
      await oracle.setPAXGFeed(alice.address);
      expect(await oracle.paxgFeed()).to.equal(alice.address);
    });

    it("非 ADMIN 设置失败", async function () {
      await expect(
        oracle.connect(alice).setGoldFeed(owner.address)
      ).to.be.reverted;
    });
  });

  describe("价格查询", function () {
    it("getGoldPricePerGram 返回 0 (无真实 feed)", async function () {
      expect(await oracle.getGoldPricePerGram()).to.equal(0n);
    });

    it("getPAXGPremium 返回 0 (无价格数据)", async function () {
      expect(await oracle.getPAXGPremium()).to.equal(0n);
    });
  });
});

// =====================================================================
// PriceDefense
// =====================================================================
describe("PriceDefense", function () {
  let defense, config, treasury, swap, feeRouter, pgold, mockPAXG, mockUSDC;
  let owner, alice;

  before(async function () {
    [owner, alice] = await hre.ethers.getSigners();

    // Deploy pGOLD
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC = await MockERC20.deploy("USDC", "USDC");
    await mockPAXG.waitForDeployment();
    await mockUSDC.waitForDeployment();

    // ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // Deploy real Treasury
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await treasury.waitForDeployment();

    // Deploy FeeRouter
    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    feeRouter = await FeeRouter.deploy(treasury.target, mockUSDC.target);
    await feeRouter.waitForDeployment();

    // Deploy PGOLDSwap
    const PGOLDSwap = await ethers.getContractFactory("PGOLDSwap");
    swap = await PGOLDSwap.deploy(pgold.target, mockUSDC.target, feeRouter.target);
    await swap.waitForDeployment();

    // Wire FeeRouter
    await feeRouter.setSwapContract(swap.target);

    // PriceDefense (config, treasury, swap) — all real contracts now
    const PriceDefense = await ethers.getContractFactory("PriceDefense");
    defense = await PriceDefense.deploy(config.target, treasury.target, swap.target);
    await defense.waitForDeployment();
  });

  describe("部署", function () {
    it("config 地址正确", async function () {
      expect(await defense.config()).to.equal(config.target);
    });

    it("treasury 地址正确", async function () {
      expect(await defense.treasury()).to.equal(treasury.target);
    });

    it("swap 地址正确", async function () {
      expect(await defense.swap()).to.equal(swap.target);
    });

    it("初始级别为 NONE", async function () {
      expect(await defense.currentLevel()).to.equal(0n); // DefenseLevel.NONE
    });
  });

  describe("防线参数", function () {
    it("L2 折价阈值 = 300 (3%)", async function () {
      expect(await config.l2DiscountThreshold()).to.equal(300n);
    });

    it("L2 持续时间阈值 = 7 days", async function () {
      expect(await config.l2DurationThreshold()).to.equal(7n * 86400n);
    });

    it("L3 折价阈值 = 1000 (10%)", async function () {
      expect(await config.l3DiscountThreshold()).to.equal(1000n);
    });

    it("L3 持续时间阈值 = 48 hours", async function () {
      expect(await config.l3DurationThreshold()).to.equal(48n * 3600n);
    });
  });

  describe("大额卖单限制", function () {
    it("大额阈值默认 10000 pGOLD", async function () {
      expect(await defense.largeSellThreshold()).to.equal(ethers.parseEther("10000"));
    });

    it("GOVERNOR 可修改阈值", async function () {
      await defense.setLargeSellThreshold(ethers.parseEther("5000"));
      expect(await defense.largeSellThreshold()).to.equal(ethers.parseEther("5000"));
    });
  });

  describe("赎回上限", function () {
    it("L2 每人赎回上限 5000 PAXG", async function () {
      expect(await defense.l2RedeemCapPerUser()).to.equal(ethers.parseEther("5000"));
    });

    it("L3 单次回购上限 $50K USDC", async function () {
      expect(await defense.l3MaxBuyPerTrigger()).to.equal(ethers.parseUnits("50000", 6));
    });
  });

  describe("防御状态查询", function () {
    it("getDefenseStatus 返回完整状态", async function () {
      const status = await defense.getDefenseStatus();
      // 返回结构: (level, discountBPS, discountDuration, l2Active_, l3Active_, l2Redeemed, l3Bought)
      expect(status.level).to.equal(0n); // DefenseLevel.NONE
      expect(status.l2Active_).to.equal(false);
      expect(status.l3Active_).to.equal(false);
    });
  });
});
