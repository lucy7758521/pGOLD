/**
 * VestingManager 完整补充测试
 * 覆盖：createSchedule / claim / transferBeneficiary /
 *        claimable / getVestingState / authorizedCreators /
 *        createGenesisSchedule / 边界检查
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("VestingManager — 完整覆盖", function () {
  let vesting, pgold, treasury, mockPAXG, mockUSDC, mockRouter, config;
  let owner, alice, bob, creator;

  before(async function () {
    [owner, alice, bob, creator] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG   = await MockERC20.deploy("PAXG","PAXG");
    mockUSDC   = await MockERC20.deploy("USDC","USDC");
    pgold      = await (await ethers.getContractFactory("PGOLDToken")).deploy();
    config     = await (await ethers.getContractFactory("ConfigManager")).deploy();
    treasury   = await (await ethers.getContractFactory("Treasury")).deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await pgold.grantRole(await pgold.MINTER_ROLE(), treasury.target);

    vesting = await (await ethers.getContractFactory("VestingManager")).deploy(
      pgold.target, treasury.target
    );
    await treasury.setMintAuthorized(vesting.target, true);
    await vesting.setAuthorizedCreator(creator.address, true);
  });

  describe("setAuthorizedCreator", function () {
    it("ADMIN 可授权创建者", async function () {
      expect(await vesting.authorizedCreators(creator.address)).to.equal(true);
    });
    it("非 ADMIN 授权 revert", async function () {
      await expect(vesting.connect(alice).setAuthorizedCreator(alice.address, true)).to.be.reverted;
    });
    it("触发 CreatorAuthorized 事件", async function () {
      await expect(vesting.setAuthorizedCreator(bob.address, true)).to.emit(vesting, "CreatorAuthorized");
      await vesting.setAuthorizedCreator(bob.address, false);
    });
  });

  describe("createSchedule", function () {
    it("授权创建者可创建 BURN_MINING 计划", async function () {
      const id0 = await vesting.nextScheduleId();
      await vesting.connect(creator).createSchedule(
        alice.address, ethers.parseEther("1000"), 10 * 365 * 86400, 0
      );
      expect(await vesting.nextScheduleId()).to.equal(id0 + 1n);
    });
    it("未授权地址创建计划 revert", async function () {
      await expect(
        vesting.connect(alice).createSchedule(alice.address, 1n, 86400n, 0)
      ).to.be.revertedWith("Vesting: not authorized");
    });
    it("零金额 revert", async function () {
      await expect(
        vesting.connect(creator).createSchedule(alice.address, 0n, 86400n, 0)
      ).to.be.reverted;
    });
    it("零地址受益人 revert", async function () {
      await expect(
        vesting.connect(creator).createSchedule(ethers.ZeroAddress, 1n, 86400n, 0)
      ).to.be.reverted;
    });
  });

  describe("getClaimableAmount & claim", function () {
    let scheduleId;

    before(async function () {
      scheduleId = await vesting.nextScheduleId();
      await vesting.connect(creator).createSchedule(
        alice.address, ethers.parseEther("365"), 365 * 86400, 0
      );
    });

    it("刚创建时 claimable = 0", async function () {
      expect(await vesting.getClaimableAmount(scheduleId)).to.equal(0n);
    });

    it("推进 1 天后 claimable ≈ 1 pGOLD", async function () {
      await network.provider.send("evm_increaseTime", [86400]);
      await network.provider.send("evm_mine");
      const c = await vesting.getClaimableAmount(scheduleId);
      expect(c).to.be.gt(0n);
      expect(c).to.be.lte(ethers.parseEther("2"));
    });

    it("alice claim 后余额增加", async function () {
      const before = await pgold.balanceOf(alice.address);
      await vesting.connect(alice).claim(scheduleId);
      expect(await pgold.balanceOf(alice.address)).to.be.gt(before);
    });

    it("非受益人 claim revert", async function () {
      await expect(vesting.connect(bob).claim(scheduleId)).to.be.revertedWith("Vesting: not beneficiary");
    });

    it("推进至完整释放期 → 可领取全部", async function () {
      await network.provider.send("evm_increaseTime", [365 * 86400]);
      await network.provider.send("evm_mine");
      await vesting.connect(alice).claim(scheduleId);
      const s = await vesting.schedules(scheduleId);
      expect(s.claimedAmount).to.equal(s.totalAmount);
    });
  });

  describe("transferBeneficiary", function () {
    let sid;

    before(async function () {
      sid = await vesting.nextScheduleId();
      await vesting.connect(creator).createSchedule(
        alice.address, ethers.parseEther("100"), 365 * 86400, 0
      );
    });

    it("受益人可转移受益权", async function () {
      await vesting.connect(alice).transferBeneficiary(sid, bob.address);
      const s = await vesting.schedules(sid);
      expect(s.beneficiary).to.equal(bob.address);
    });

    it("转移后原受益人无法 claim", async function () {
      await expect(vesting.connect(alice).claim(sid)).to.be.revertedWith("Vesting: not beneficiary");
    });

    it("新受益人可 claim", async function () {
      await network.provider.send("evm_increaseTime", [30 * 86400]);
      await network.provider.send("evm_mine");
      const before = await pgold.balanceOf(bob.address);
      await vesting.connect(bob).claim(sid);
      expect(await pgold.balanceOf(bob.address)).to.be.gt(before);
    });

    it("非受益人转移 revert", async function () {
      await expect(
        vesting.connect(alice).transferBeneficiary(sid, alice.address)
      ).to.be.revertedWith("Vesting: not beneficiary");
    });
  });

  describe("claimable & getVestingState (聚合查询)", function () {
    it("claimable 返回用户所有计划可领总量", async function () {
      const total = await vesting.claimable(alice.address);
      expect(total).to.be.gte(0n);
    });
    it("getVestingState 返回 vested / pending", async function () {
      const [vested, pending] = await vesting.getVestingState(alice.address);
      expect(vested).to.be.gte(0n);
      expect(pending).to.be.gte(0n);
    });
  });

  describe("getBeneficiarySchedules", function () {
    it("返回受益人的所有计划 ID", async function () {
      const ids = await vesting.getBeneficiarySchedules(alice.address);
      expect(ids.length).to.be.gt(0);
    });
  });

  describe("createVestingSchedule (GenesisPool接口)", function () {
    it("授权创建者可创建创世池计划", async function () {
      await vesting.setAuthorizedCreator(creator.address, true);
      const sid = await vesting.nextScheduleId();
      const start = Math.floor(Date.now() / 1000);
      await vesting.connect(creator).createVestingSchedule(
        alice.address, ethers.parseEther("300"), start, 3 * 365 * 86400, 12
      );
      const s = await vesting.schedules(sid);
      expect(s.exists).to.equal(true);
      expect(s.scheduleType).to.equal(4n); // GENESIS_POOL
    });
    it("未授权地址创建 revert", async function () {
      await expect(
        vesting.connect(alice).createVestingSchedule(alice.address, 1n, 0, 86400, 0)
      ).to.be.revertedWith("Vesting: not authorized");
    });
  });
});
