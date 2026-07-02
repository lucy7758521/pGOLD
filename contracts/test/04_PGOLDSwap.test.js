/**
 * PGOLDSwap 单元测试 — x*y=k 内部 AMM
 * 覆盖：部署/初始化/买/卖/手续费/价格冲击/流动性
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("PGOLDSwap", function () {
  let swap, pgold, usdcMock, feeRouter, treasury, config, mockPAXG;
  let owner, treasurySigner, alice, bob, lp;

  const INITIAL_PGOLD = ethers.parseEther("200000");
  const INITIAL_USDC = ethers.parseUnits("17000000", 6); // $17M → ~$85/g

  before(async function () {
    [owner, treasurySigner, alice, bob, lp] = await hre.ethers.getSigners();

    // Deploy pGOLD
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // Deploy mock tokens
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    usdcMock = await ERC20Mock.deploy("USDC", "USDC");
    mockPAXG = await ERC20Mock.deploy("PAXG", "PAXG");
    await usdcMock.waitForDeployment();
    await mockPAXG.waitForDeployment();

    // Deploy ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // Deploy real Treasury (needed for routeFee → receiveFees)
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target, mockPAXG.target, usdcMock.target, owner.address
    );
    await treasury.waitForDeployment();

    // Grant MINTER_ROLE to Treasury
    const minterRole = await pgold.MINTER_ROLE();
    await pgold.grantRole(minterRole, treasury.target);

    // Deploy FeeRouter with real Treasury
    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    feeRouter = await FeeRouter.deploy(treasury.target, usdcMock.target);
    await feeRouter.waitForDeployment();

    // Deploy PGOLDSwap
    const PGOLDSwap = await ethers.getContractFactory("PGOLDSwap");
    swap = await PGOLDSwap.deploy(pgold.target, usdcMock.target, feeRouter.target);
    await swap.waitForDeployment();

    // Wire FeeRouter → set swapContract so routeFee doesn't revert
    await feeRouter.setSwapContract(swap.target);

    // Mint USDC to owner and approve swap
    await usdcMock.mint(owner.address, INITIAL_USDC);
    await usdcMock.connect(owner).approve(swap.target, INITIAL_USDC);

    // Mint pGOLD to owner and approve swap
    await pgold.grantRole(minterRole, owner.address);
    await pgold.mint(owner.address, INITIAL_PGOLD, ethers.encodeBytes32String("LIQUIDITY"));
    await pgold.connect(owner).approve(swap.target, INITIAL_PGOLD);

    // Initialize pool (pulls USDC & pGOLD from owner via transferFrom)
    await swap.initializePool(INITIAL_USDC, INITIAL_PGOLD);

    // Grant minter to swap for buy/sell operations
    await pgold.grantRole(minterRole, swap.target);

    // Mint USDC to lp for testing
    await usdcMock.mint(lp.address, ethers.parseUnits("100000", 6));
  });

  // ==================== 部署 ====================
  describe("部署 & 初始化", function () {
    it("pGOLD 地址正确", async function () {
      expect(await swap.pGOLD()).to.equal(pgold.target);
    });

    it("USDC 地址正确", async function () {
      expect(await swap.USDC()).to.equal(usdcMock.target);
    });

    it("初始 k 值 > 0", async function () {
      const reserves = await swap.getReserves();
      expect(reserves.k).to.be.gt(0n);
    });

    it("不可重复初始化", async function () {
      await expect(
        swap.initializePool(ethers.parseUnits("1", 6), ethers.parseEther("1"))
      ).to.be.reverted;
    });
  });

  // ==================== 买入 pGOLD ====================
  describe("buy — 用 USDC 买 pGOLD", function () {
    it("买入后用户收到 pGOLD", async function () {
      const usdcIn = ethers.parseUnits("8500", 6); // ~100g worth
      await usdcMock.mint(alice.address, usdcIn);
      await usdcMock.connect(alice).approve(swap.target, usdcIn);

      const balBefore = await pgold.balanceOf(alice.address);
      await swap.connect(alice).buy(usdcIn, 0);
      const balAfter = await pgold.balanceOf(alice.address);

      expect(balAfter).to.be.gt(balBefore);
    });

    it("触发 Swap 事件", async function () {
      const usdcIn = ethers.parseUnits("850", 6);
      await usdcMock.mint(bob.address, usdcIn);
      await usdcMock.connect(bob).approve(swap.target, usdcIn);

      await expect(swap.connect(bob).buy(usdcIn, 0))
        .to.emit(swap, "Swapped");
    });
  });

  // ==================== 卖出 pGOLD ====================
  describe("sell — 用 pGOLD 卖 USDC", function () {
    it("卖出后用户收到 USDC", async function () {
      const pgoldIn = ethers.parseEther("10");
      // Give bob some pGOLD
      await usdcMock.mint(alice.address, ethers.parseUnits("850", 6));
      await usdcMock.connect(alice).approve(swap.target, ethers.parseUnits("850", 6));
      await swap.connect(alice).buy(ethers.parseUnits("850", 6), 0);
      const alicePGOLD = await pgold.balanceOf(alice.address);
      await pgold.connect(alice).transfer(bob.address, pgoldIn);

      await pgold.connect(bob).approve(swap.target, pgoldIn);
      const balBefore = await usdcMock.balanceOf(bob.address);
      await swap.connect(bob).sell(pgoldIn, 0);
      const balAfter = await usdcMock.balanceOf(bob.address);
      expect(balAfter).to.be.gt(balBefore);
    });
  });

  // ==================== 手续费 ====================
  describe("手续费", function () {
    it("FEE_RATE = 25 (0.25%)", async function () {
      expect(await swap.FEE_RATE()).to.equal(25n);
    });

    it("buy 后 Treasury 收到 USDC 手续费", async function () {
      const usdcIn = ethers.parseUnits("8500", 6);
      await usdcMock.mint(alice.address, usdcIn);
      await usdcMock.connect(alice).approve(swap.target, usdcIn);

      const treasuryBalBefore = await usdcMock.balanceOf(treasury.target);
      await swap.connect(alice).buy(usdcIn, 0);
      const treasuryBalAfter = await usdcMock.balanceOf(treasury.target);
      // 手续费直接转到 Treasury（FeeRouter 只做记账）
      expect(treasuryBalAfter).to.be.gt(treasuryBalBefore);
    });
  });

  // ==================== 滑点保护 ====================
  describe("滑点保护", function () {
    it("minOut 为 0 时任意通过", async function () {
      const usdcIn = ethers.parseUnits("85", 6);
      await usdcMock.mint(bob.address, usdcIn);
      await usdcMock.connect(bob).approve(swap.target, usdcIn);
      await expect(swap.connect(bob).buy(usdcIn, 0)).to.not.be.reverted;
    });

    it("minOut 过高时 revert", async function () {
      const usdcIn = ethers.parseUnits("85", 6);
      await usdcMock.mint(alice.address, usdcIn);
      await usdcMock.connect(alice).approve(swap.target, usdcIn);
      await expect(
        swap.connect(alice).buy(usdcIn, ethers.parseEther("100000"))
      ).to.be.reverted;
    });
  });

  // ==================== 查询 ====================
  describe("查询", function () {
    it("getPrice 返回 pGOLD 价格 (USDC/g)", async function () {
      const price = await swap.getPrice();
      expect(price).to.be.gt(0n);
    });

    it("getBuyQuote 返回买入估算", async function () {
      const [pgoldOut, fee] = await swap.getBuyQuote(ethers.parseUnits("85", 6));
      expect(pgoldOut).to.be.gt(0n);
      expect(fee).to.be.gte(0n);
    });

    it("getSellQuote 返回卖出估算", async function () {
      const [usdcOut, fee] = await swap.getSellQuote(ethers.parseEther("1"));
      expect(usdcOut).to.be.gt(0n);
      expect(fee).to.be.gte(0n);
    });
  });
});
