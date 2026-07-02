/**
 * vPGOLD 单元测试 — 锁仓凭证代币化
 * 覆盖：wrap/unwrap/claimUnderlying/收益映射/防双花
 *
 * V2 修订：wrap 须先 transferBeneficiary 转给 vPGOLD 合约托管（防双花+防抢跑）
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("vPGOLD", function () {
  let vpgold, vesting, pgold, treasury, config, mockPAXG, mockUSDC;
  let owner, alice, bob;

  before(async function () {
    [owner, alice, bob] = await hre.ethers.getSigners();

    // Deploy pGOLD
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // Config
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // Mock tokens
    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC = await MockERC20.deploy("USDC", "USDC");
    await mockPAXG.waitForDeployment();
    await mockUSDC.waitForDeployment();

    // Treasury
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await treasury.waitForDeployment();

    // Grant MINTER_ROLE to Treasury
    const minterRole = await pgold.MINTER_ROLE();
    await pgold.grantRole(minterRole, treasury.target);

    // VestingManager
    const VestingManager = await ethers.getContractFactory("VestingManager");
    vesting = await VestingManager.deploy(pgold.target, treasury.target);
    await vesting.waitForDeployment();

    // Authorizations
    await vesting.setAuthorizedCreator(owner.address, true);
    await treasury.setMintAuthorized(vesting.target, true);

    // vPGOLD
    const VPGOLD = await ethers.getContractFactory("vPGOLD");
    vpgold = await VPGOLD.deploy(pgold.target, vesting.target);
    await vpgold.waitForDeployment();

    // Create vesting schedules for testing (id 0 = alice 10000, id 1 = bob 5000)
    await vesting.createSchedule(alice.address, ethers.parseEther("10000"), 10n * 365n * 86400n, 0);
    await vesting.createSchedule(bob.address, ethers.parseEther("5000"), 10n * 365n * 86400n, 0);
  });

  describe("部署", function () {
    it("名称正确", async function () {
      expect(await vpgold.name()).to.equal("Vested pGOLD");
    });

    it("符号正确", async function () {
      expect(await vpgold.symbol()).to.equal("vPGOLD");
    });

    it("vestingManager 正确", async function () {
      expect(await vpgold.vestingManager()).to.equal(vesting.target);
    });
  });

  describe("Wrap (锁仓→vPGOLD)", function () {
    it("未转移受益人时 wrap 失败", async function () {
      // schedule 0 受益人仍是 alice，未转给 vPGOLD 合约托管
      await expect(vpgold.connect(alice).wrap(0))
        .to.be.revertedWith("vPGOLD: transfer beneficiary first");
    });

    it("转移受益人后可 wrap", async function () {
      // alice 先把 schedule 0 的受益人转给 vPGOLD 合约托管
      await vesting.connect(alice).transferBeneficiary(0, vpgold.target);
      await vpgold.connect(alice).wrap(0);
      const pos = await vpgold.getWrappedSchedule(0);
      expect(pos.active).to.equal(true);
    });

    it("wrap 后 vPGOLD 铸造 1:1", async function () {
      expect(await vpgold.balanceOf(alice.address)).to.equal(ethers.parseEther("10000"));
    });

    it("已 wrap 不可重复", async function () {
      await expect(vpgold.connect(alice).wrap(0)).to.be.reverted;
    });

    it("非原始受益人不可 wrap（防抢跑）", async function () {
      // bob 把自己的 schedule 1 转给 vPGOLD 托管
      await vesting.connect(bob).transferBeneficiary(1, vpgold.target);
      // alice 冒名 wrap bob 的 schedule 应失败
      await expect(vpgold.connect(alice).wrap(1))
        .to.be.revertedWith("vPGOLD: not original beneficiary");
    });
  });

  describe("防双花", function () {
    it("wrap 后原受益人无法直接 claim 底层 pGOLD", async function () {
      // schedule 0 受益人已是 vPGOLD 合约，alice 无权直接 claim
      await expect(vesting.connect(alice).claim(0)).to.be.reverted;
    });
  });

  describe("Unwrap (vPGOLD→锁仓)", function () {
    it("持有 vPGOLD 可部分 unwrap", async function () {
      // 烧 5000，totalSupply 仍为 5000，不归还受益权
      await vpgold.connect(alice).unwrap(0, ethers.parseEther("5000"));
      expect(await vpgold.balanceOf(alice.address)).to.equal(ethers.parseEther("5000"));
      const pos = await vpgold.getWrappedSchedule(0);
      expect(pos.active).to.equal(true); // 仍有流通，未归还
    });
  });

  describe("Transfer vPGOLD (二级市场)", function () {
    it("vPGOLD 可转让", async function () {
      await vpgold.connect(alice).transfer(bob.address, ethers.parseEther("2000"));
      expect(await vpgold.balanceOf(bob.address)).to.equal(ethers.parseEther("2000"));
    });
  });

  describe("ClaimUnderlying (赎回底层 pGOLD)", function () {
    it("vPGOLD 持有人可领取已释放的 pGOLD", async function () {
      // 推进 1 年，schedule 0 (10年周期) 释放 10% = 1000 pGOLD
      await network.provider.send("evm_increaseTime", [365 * 86400]);
      await network.provider.send("evm_mine");

      // alice 持有 3000 vPGOLD，totalSupply = 5000，占 60% → 应分得约 600 pGOLD
      const before = await pgold.balanceOf(alice.address);
      await vpgold.connect(alice).claimUnderlying(0);
      const after = await pgold.balanceOf(alice.address);
      expect(after).to.be.gt(before);
    });
  });
});
