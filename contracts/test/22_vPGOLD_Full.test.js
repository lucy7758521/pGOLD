/**
 * vPGOLD 完整测试
 * 覆盖：部署 / wrap / unwrap / claimUnderlying / getUnderlyingValue /
 *        getWrappedSchedule / 权限 / 边界条件
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("vPGOLD — 完整覆盖", function () {
  let vpgold, vesting, pgold, treasury, config, mockPAXG, mockUSDC;
  let owner, alice, bob;
  let scheduleId;

  before(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC  = await MockERC20.deploy("USDC", "USDC");
    pgold    = await (await ethers.getContractFactory("PGOLDToken")).deploy();
    config   = await (await ethers.getContractFactory("ConfigManager")).deploy();
    treasury = await (await ethers.getContractFactory("Treasury")).deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await pgold.grantRole(await pgold.MINTER_ROLE(), treasury.target);

    vesting = await (await ethers.getContractFactory("VestingManager")).deploy(
      pgold.target, treasury.target
    );
    await treasury.setMintAuthorized(vesting.target, true);
    await treasury.setMintAuthorized(owner.address, true);

    vpgold = await (await ethers.getContractFactory("vPGOLD")).deploy(
      pgold.target, vesting.target
    );

    // 授权 owner 创建释放计划
    await vesting.setAuthorizedCreator(owner.address, true);

    // 给 alice 创建一个释放计划（1 年线性）
    scheduleId = await vesting.nextScheduleId();
    await vesting.createSchedule(
      alice.address,
      ethers.parseEther("1200"),
      365 * 24 * 3600,
      0 // ScheduleType.VESTING = 0
    );

    // alice 将释放计划受益权转给 vPGOLD 合约（wrap 前置步骤）
    await vesting.connect(alice).transferBeneficiary(scheduleId, vpgold.target);
  });

  describe("部署状态", function () {
    it("名称 = 'Vested pGOLD'", async function () {
      expect(await vpgold.name()).to.equal("Vested pGOLD");
    });
    it("符号 = 'vPGOLD'", async function () {
      expect(await vpgold.symbol()).to.equal("vPGOLD");
    });
    it("pGOLD 地址正确", async function () {
      expect(await vpgold.pGOLD()).to.equal(pgold.target);
    });
    it("vestingManager 地址正确", async function () {
      expect(await vpgold.vestingManager()).to.equal(vesting.target);
    });
    it("初始 totalWrapped = 0", async function () {
      expect(await vpgold.totalWrapped()).to.equal(0n);
    });
  });

  describe("构造函数零地址检查", function () {
    it("pGOLD 零地址 revert", async function () {
      await expect(
        (await ethers.getContractFactory("vPGOLD")).deploy(ethers.ZeroAddress, vesting.target)
      ).to.be.revertedWith("vPGOLD: zero pGOLD");
    });
    it("vesting 零地址 revert", async function () {
      await expect(
        (await ethers.getContractFactory("vPGOLD")).deploy(pgold.target, ethers.ZeroAddress)
      ).to.be.revertedWith("vPGOLD: zero vesting");
    });
  });

  describe("wrap", function () {
    it("wrap 前未转益权 revert", async function () {
      // bob 没有 schedule，直接测 beneficiary 错误
      const sid2 = await vesting.nextScheduleId();
      await vesting.createSchedule(bob.address, ethers.parseEther("100"), 365 * 24 * 3600, 0);
      await expect(vpgold.connect(bob).wrap(sid2)).to.be.revertedWith("vPGOLD: transfer beneficiary first");
    });

    it("alice wrap 成功，获得等量 vPGOLD", async function () {
      const schedule = await vesting.getSchedule(scheduleId);
      const expectedVAmount = schedule.totalAmount - schedule.claimedAmount;
      await vpgold.connect(alice).wrap(scheduleId);
      expect(await vpgold.balanceOf(alice.address)).to.equal(expectedVAmount);
    });

    it("totalWrapped 正确更新", async function () {
      expect(await vpgold.totalWrapped()).to.equal(ethers.parseEther("1200"));
    });

    it("重复 wrap 同一计划 revert", async function () {
      await expect(vpgold.connect(alice).wrap(scheduleId)).to.be.revertedWith("vPGOLD: already wrapped");
    });

    it("不存在的 scheduleId wrap revert", async function () {
      await expect(vpgold.connect(alice).wrap(9999n)).to.be.revertedWith("vPGOLD: schedule not found");
    });

    it("触发 Wrapped 事件", async function () {
      // 再创建一个新的 schedule 并 wrap
      const sid3 = await vesting.nextScheduleId();
      await vesting.createSchedule(owner.address, ethers.parseEther("600"), 365 * 24 * 3600, 0);
      await vesting.transferBeneficiary(sid3, vpgold.target);
      await expect(vpgold.connect(owner).wrap(sid3)).to.emit(vpgold, "Wrapped");
    });
  });

  describe("getWrappedSchedule", function () {
    it("返回正确的包装信息", async function () {
      const ws = await vpgold.getWrappedSchedule(scheduleId);
      expect(ws.active).to.equal(true);
      expect(ws.originalOwner).to.equal(alice.address);
      expect(ws.scheduleId).to.equal(scheduleId);
    });
    it("未包装的 scheduleId 返回 active=false", async function () {
      const ws = await vpgold.getWrappedSchedule(9999n);
      expect(ws.active).to.equal(false);
    });
  });

  describe("getUnderlyingValue", function () {
    it("包装后 getUnderlyingValue 返回正确数据", async function () {
      const [totalVested, claimed, claimable] = await vpgold.getUnderlyingValue(scheduleId);
      expect(totalVested).to.be.gte(0n);
      expect(claimed).to.equal(0n);
    });
    it("时间推进后 claimable > 0", async function () {
      await network.provider.send("evm_increaseTime", [30 * 24 * 3600]); // 30天
      await network.provider.send("evm_mine");
      const [, , claimable] = await vpgold.getUnderlyingValue(scheduleId);
      expect(claimable).to.be.gt(0n);
    });
    it("未包装的 scheduleId 返回全零", async function () {
      const [a, b, c] = await vpgold.getUnderlyingValue(9999n);
      expect(a).to.equal(0n);
      expect(b).to.equal(0n);
      expect(c).to.equal(0n);
    });
  });

  describe("claimUnderlying", function () {
    it("alice 领取已释放的 pGOLD", async function () {
      const before = await pgold.balanceOf(alice.address);
      await vpgold.connect(alice).claimUnderlying(scheduleId);
      expect(await pgold.balanceOf(alice.address)).to.be.gt(before);
    });
    it("触发 Redeemed 事件", async function () {
      await network.provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await network.provider.send("evm_mine");
      await expect(vpgold.connect(alice).claimUnderlying(scheduleId)).to.emit(vpgold, "Redeemed");
    });
    it("未包装的 scheduleId claimUnderlying revert", async function () {
      await expect(vpgold.connect(alice).claimUnderlying(9999n)).to.be.revertedWith("vPGOLD: not wrapped");
    });
  });

  describe("unwrap", function () {
    it("非原始持有人 unwrap revert", async function () {
      await expect(
        vpgold.connect(bob).unwrap(scheduleId, ethers.parseEther("1"))
      ).to.be.revertedWith("vPGOLD: not owner");
    });
    it("未包装的 scheduleId unwrap revert", async function () {
      await expect(
        vpgold.connect(alice).unwrap(9999n, 1n)
      ).to.be.revertedWith("vPGOLD: not wrapped");
    });
    it("零金额 unwrap revert", async function () {
      await expect(
        vpgold.connect(alice).unwrap(scheduleId, 0n)
      ).to.be.revertedWith("vPGOLD: zero");
    });
    it("alice 部分 unwrap 成功，vPGOLD 减少", async function () {
      const balanceBefore = await vpgold.balanceOf(alice.address);
      const burnAmt = ethers.parseEther("100");
      await vpgold.connect(alice).unwrap(scheduleId, burnAmt);
      expect(await vpgold.balanceOf(alice.address)).to.equal(balanceBefore - burnAmt);
    });
    it("触发 Unwrapped 事件", async function () {
      await expect(
        vpgold.connect(alice).unwrap(scheduleId, ethers.parseEther("100"))
      ).to.emit(vpgold, "Unwrapped");
    });
  });
});
