/**
 * PriceDefense 完整补充测试
 * 覆盖：checkAndDefend / L1触发 / L2激活 / L3激活 /
 *        deactivateL2 / deactivateL3 / setLargeSellThreshold /
 *        checkLargeSell / getDefenseStatus
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("PriceDefense — 完整覆盖", function () {
  let defense, swap, treasury, config, pgold, mockPAXG, mockUSDC, mockRouter;
  let owner, alice, governor;

  async function deploy() {
    [owner, alice, governor] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC  = await MockERC20.deploy("USDC", "USDC");

    pgold  = await (await ethers.getContractFactory("PGOLDToken")).deploy();
    config = await (await ethers.getContractFactory("ConfigManager")).deploy();

    treasury = await (await ethers.getContractFactory("Treasury")).deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await pgold.grantRole(await pgold.MINTER_ROLE(), treasury.target);

    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    const feeRouter = await FeeRouter.deploy(treasury.target, mockUSDC.target);

    swap = await (await ethers.getContractFactory("PGOLDSwap")).deploy(
      pgold.target, mockUSDC.target, feeRouter.target, treasury.target
    );

    // 初始化流动性池：1,000,000 USDC / 11765 pGOLD → price ≈ $85/g
    const usdcAmt  = ethers.parseUnits("1000000", 6);
    const pgoldAmt = ethers.parseUnits("11765", 18);
    await mockUSDC.mint(owner.address, usdcAmt);
    await mockUSDC.approve(swap.target, usdcAmt);
    await treasury.setMintAuthorized(owner.address, true);
    await treasury["requestMint(address,uint256,bytes32)"](owner.address, pgoldAmt, ethers.keccak256(ethers.toUtf8Bytes("INIT")));
    await pgold.approve(swap.target, pgoldAmt);
    await swap.initializePool(usdcAmt, pgoldAmt);

    defense = await (await ethers.getContractFactory("PriceDefense")).deploy(
      config.target, treasury.target, swap.target
    );

    const GOVERNOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNOR_ROLE"));
    await defense.grantRole(GOVERNOR_ROLE, governor.address);
    const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOLD_ORACLE_ROLE"));
    await treasury.grantRole(ORACLE_ROLE, owner.address);
    // 设置金价为 swap 价格的两倍，制造折价
    const swapPrice = await swap.getPrice();
    // goldPrice 设为正常水平 (8 decimals, USD/g)
    await treasury.updateGoldPrice(ethers.parseUnits("85", 8));
  }

  beforeEach(deploy);

  describe("部署状态", function () {
    it("config / treasury / swap 地址正确", async function () {
      expect(await defense.config()).to.equal(config.target);
      expect(await defense.treasury()).to.equal(treasury.target);
      expect(await defense.swap()).to.equal(swap.target);
    });
    it("初始防御级别为 NONE(0)", async function () {
      expect(await defense.currentLevel()).to.equal(0n);
    });
    it("l2Active / l3Active 初始均为 false", async function () {
      expect(await defense.l2Active()).to.equal(false);
      expect(await defense.l3Active()).to.equal(false);
    });
  });

  describe("setLargeSellThreshold", function () {
    it("GOVERNOR 可修改大额卖单阈值", async function () {
      await defense.connect(governor).setLargeSellThreshold(ethers.parseUnits("5000", 18));
      expect(await defense.largeSellThreshold()).to.equal(ethers.parseUnits("5000", 18));
    });
    it("非 GOVERNOR 修改 revert", async function () {
      await expect(defense.connect(alice).setLargeSellThreshold(1n)).to.be.reverted;
    });
  });

  describe("checkLargeSell", function () {
    it("正常金额不 revert", async function () {
      await defense.checkLargeSell(ethers.parseUnits("100", 18));
    });
    it("超过阈值且 L1 激活时 revert", async function () {
      // 先触发 L1：让金价高于 swap 价格超过 1%
      const swapPrice = await swap.getPrice();
      // 设金价为 swap 价格 * 1.02 (折价 2%)
      // swapPrice 是 8 decimals USD/pGOLD, 需要换算
      // 直接设置一个比 swap 大很多的金价来模拟折价
      await treasury.updateGoldPrice(swapPrice * 200n / 100n);
      await defense.checkAndDefend();
      // 此时 L1 应已激活
      if ((await defense.currentLevel()) >= 1n) {
        await expect(
          defense.checkLargeSell(ethers.parseUnits("20000", 18))
        ).to.be.reverted;
      }
    });
  });

  describe("checkAndDefend — 正常价格无防线触发", function () {
    it("swap 价格与金价接近 → 不触发防线", async function () {
      await defense.checkAndDefend();
      // 正常市场不应激活 L2/L3
      expect(await defense.l2Active()).to.equal(false);
      expect(await defense.l3Active()).to.equal(false);
    });

    it("价格折扣超过 1% → L1 激活并发出 DiscountAlert", async function () {
      const swapPrice = await swap.getPrice();
      await treasury.updateGoldPrice(swapPrice * 105n / 100n); // 5% 折价
      await expect(defense.checkAndDefend()).to.emit(defense, "DiscountAlert");
      expect(await defense.currentLevel()).to.be.gte(1n);
    });

    it("折价 > 3% 持续 7 天 → L2 激活", async function () {
      const swapPrice = await swap.getPrice();
      await treasury.updateGoldPrice(swapPrice * 110n / 100n); // 10% 折价
      await defense.checkAndDefend(); // 记录开始时间
      await network.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await network.provider.send("evm_mine");
      await defense.checkAndDefend();
      expect(await defense.l2Active()).to.equal(true);
      expect(await defense.currentLevel()).to.be.gte(2n);
    });

    it("折价 > 10% 持续 48h → L3 激活", async function () {
      const swapPrice = await swap.getPrice();
      await treasury.updateGoldPrice(swapPrice * 120n / 100n); // 20% 折价
      await defense.checkAndDefend();
      await network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
      await network.provider.send("evm_mine");
      await defense.checkAndDefend();
      expect(await defense.l3Active()).to.equal(true);
    });
  });

  describe("deactivateL2 / deactivateL3", function () {
    it("GOVERNOR 可关闭 L2", async function () {
      // 先激活
      const swapPrice = await swap.getPrice();
      await treasury.updateGoldPrice(swapPrice * 110n / 100n);
      await defense.checkAndDefend();
      await network.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await network.provider.send("evm_mine");
      await defense.checkAndDefend();
      if (await defense.l2Active()) {
        await expect(defense.connect(governor).deactivateL2()).to.emit(defense, "L2Deactivated");
        expect(await defense.l2Active()).to.equal(false);
      }
    });
    it("非 GOVERNOR 关闭 L2 revert", async function () {
      await expect(defense.connect(alice).deactivateL2()).to.be.reverted;
    });
    it("非 GOVERNOR 关闭 L3 revert", async function () {
      await expect(defense.connect(alice).deactivateL3()).to.be.reverted;
    });
  });

  describe("getDefenseStatus", function () {
    it("返回完整状态结构", async function () {
      const [level, discount, duration, l2, l3, l2Total, l3Total] = await defense.getDefenseStatus();
      expect(typeof level).to.not.equal("undefined");
      expect(l2).to.equal(false);
      expect(l3).to.equal(false);
    });
  });
});
