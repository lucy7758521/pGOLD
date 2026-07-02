/**
 * FeeRouter 完整测试
 * 覆盖：常量值 / 部署 / setSwapContract / calculateDistribution / routeFee / 权限
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("FeeRouter — 完整覆盖", function () {
  let feeRouter, treasury, pgold, config, mockPAXG, mockUSDC;
  let owner, alice, swapSigner;

  before(async function () {
    [owner, alice, swapSigner] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC  = await MockERC20.deploy("USDC", "USDC");
    pgold    = await (await ethers.getContractFactory("PGOLDToken")).deploy();
    config   = await (await ethers.getContractFactory("ConfigManager")).deploy();
    treasury = await (await ethers.getContractFactory("Treasury")).deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await pgold.grantRole(await pgold.MINTER_ROLE(), treasury.target);

    feeRouter = await (await ethers.getContractFactory("FeeRouter")).deploy(
      treasury.target, mockUSDC.target
    );
  });

  describe("部署状态", function () {
    it("treasury 地址正确", async function () {
      expect(await feeRouter.treasury()).to.equal(treasury.target);
    });
    it("USDC 地址正确", async function () {
      expect(await feeRouter.USDC()).to.equal(mockUSDC.target);
    });
    it("swapContract 初始为零地址", async function () {
      expect(await feeRouter.swapContract()).to.equal(ethers.ZeroAddress);
    });
    it("totalFeesCollected 初始为 0", async function () {
      expect(await feeRouter.totalFeesCollected()).to.equal(0n);
    });
  });

  describe("硬编码常量", function () {
    it("GOLD_RESERVE_SHARE = 9500", async function () {
      expect(await feeRouter.GOLD_RESERVE_SHARE()).to.equal(9500n);
    });
    it("INSURANCE_SHARE = 300", async function () {
      expect(await feeRouter.INSURANCE_SHARE()).to.equal(300n);
    });
    it("LIQUIDITY_SHARE = 150", async function () {
      expect(await feeRouter.LIQUIDITY_SHARE()).to.equal(150n);
    });
    it("EMERGENCY_SHARE = 50", async function () {
      expect(await feeRouter.EMERGENCY_SHARE()).to.equal(50n);
    });
    it("TOTAL_SHARES = 10000", async function () {
      expect(await feeRouter.TOTAL_SHARES()).to.equal(10000n);
    });
    it("四份额之和 = 10000", async function () {
      const total = 9500n + 300n + 150n + 50n;
      expect(total).to.equal(10000n);
    });
  });

  describe("calculateDistribution", function () {
    it("10000 USDC 分配比例正确", async function () {
      const total = ethers.parseUnits("10000", 6);
      const dist = await feeRouter.calculateDistribution(total);
      expect(dist[0]).to.equal(total * 9500n / 10000n); // 95%
      expect(dist[1]).to.equal(total * 300n  / 10000n); //  3%
      expect(dist[2]).to.equal(total * 150n  / 10000n); // 1.5%
      expect(dist[3]).to.equal(total * 50n   / 10000n); // 0.5%
    });
    it("四份额之和 = 总额", async function () {
      const total = ethers.parseUnits("10000", 6);
      const dist = await feeRouter.calculateDistribution(total);
      const sum = dist[0] + dist[1] + dist[2] + dist[3];
      expect(sum).to.equal(total);
    });
    it("total=0 时各份额为 0", async function () {
      const dist = await feeRouter.calculateDistribution(0n);
      for (const d of dist) expect(d).to.equal(0n);
    });
    it("奇数金额也能整除", async function () {
      const total = 10001n;
      const dist = await feeRouter.calculateDistribution(total);
      const sum = dist[0] + dist[1] + dist[2] + dist[3];
      // 整除截断，sum <= total
      expect(sum).to.be.lte(total);
    });
  });

  describe("setSwapContract", function () {
    it("ADMIN 可设置 swapContract", async function () {
      await feeRouter.setSwapContract(swapSigner.address);
      expect(await feeRouter.swapContract()).to.equal(swapSigner.address);
    });
    it("重复设置 revert", async function () {
      await expect(
        feeRouter.setSwapContract(alice.address)
      ).to.be.revertedWith("FeeRouter: already set");
    });
    it("非 ADMIN 设置 revert", async function () {
      const feeRouter2 = await (await ethers.getContractFactory("FeeRouter")).deploy(
        treasury.target, mockUSDC.target
      );
      await expect(
        feeRouter2.connect(alice).setSwapContract(alice.address)
      ).to.be.reverted;
    });
    it("零地址 setSwapContract revert", async function () {
      const feeRouter3 = await (await ethers.getContractFactory("FeeRouter")).deploy(
        treasury.target, mockUSDC.target
      );
      await expect(
        feeRouter3.setSwapContract(ethers.ZeroAddress)
      ).to.be.revertedWith("FeeRouter: zero swap");
    });
  });

  describe("routeFee", function () {
    before(async function () {
      // grant treasury GOVERNOR_ROLE to allow receiveFees
      const GOVERNOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNOR_ROLE"));
      await treasury.grantRole(GOVERNOR_ROLE, feeRouter.target);
      // fund treasury with USDC for receiveFees accounting
      await mockUSDC.mint(treasury.target, ethers.parseUnits("100000", 6));
    });

    it("只有 swapContract 可调用 routeFee", async function () {
      await expect(
        feeRouter.connect(alice).routeFee(ethers.parseUnits("100", 6))
      ).to.be.revertedWith("FeeRouter: only swap");
    });
    it("零手续费 revert", async function () {
      await expect(
        feeRouter.connect(swapSigner).routeFee(0n)
      ).to.be.revertedWith("FeeRouter: zero fee");
    });
    it("正常路由手续费，totalFeesCollected 累加", async function () {
      const fee = ethers.parseUnits("1000", 6);
      await feeRouter.connect(swapSigner).routeFee(fee);
      expect(await feeRouter.totalFeesCollected()).to.equal(fee);
    });
    it("多次路由后 totalFeesCollected 正确累积", async function () {
      const fee = ethers.parseUnits("500", 6);
      const before = await feeRouter.totalFeesCollected();
      await feeRouter.connect(swapSigner).routeFee(fee);
      expect(await feeRouter.totalFeesCollected()).to.equal(before + fee);
    });
    it("routeFee 触发 FeesRouted 事件", async function () {
      const fee = ethers.parseUnits("200", 6);
      await expect(
        feeRouter.connect(swapSigner).routeFee(fee)
      ).to.emit(feeRouter, "FeesRouted");
    });
  });

  describe("构造函数边界检查", function () {
    it("treasury 零地址 revert", async function () {
      await expect(
        (await ethers.getContractFactory("FeeRouter")).deploy(ethers.ZeroAddress, mockUSDC.target)
      ).to.be.revertedWith("FeeRouter: zero treasury");
    });
    it("USDC 零地址 revert", async function () {
      await expect(
        (await ethers.getContractFactory("FeeRouter")).deploy(treasury.target, ethers.ZeroAddress)
      ).to.be.revertedWith("FeeRouter: zero USDC");
    });
  });
});
