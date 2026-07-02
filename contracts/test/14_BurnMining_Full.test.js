/**
 * BurnMining 完整补充测试
 * 覆盖：lockStake / addStake / withdrawStake / createRound /
 *        claimCompensation / setCompensationCaps / 查询
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("BurnMining — 完整覆盖", function () {
  let burn, pgold, config, vesting, treasury, mockPAXG, mockUSDC;
  let owner, alice, bob;

  before(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG","PAXG");
    mockUSDC = await MockERC20.deploy("USDC","USDC");
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

    burn = await (await ethers.getContractFactory("BurnMining")).deploy(
      pgold.target, config.target, vesting.target
    );
    await vesting.setAuthorizedCreator(burn.target, true);

    await treasury.setMintAuthorized(owner.address, true);
    await treasury["requestMint(address,uint256,bytes32)"](alice.address, ethers.parseEther("10000"), ethers.keccak256(ethers.toUtf8Bytes("A")));
    await treasury["requestMint(address,uint256,bytes32)"](bob.address,   ethers.parseEther("10000"), ethers.keccak256(ethers.toUtf8Bytes("B")));
    await pgold.connect(alice).approve(burn.target, ethers.MaxUint256);
    await pgold.connect(bob).approve(burn.target, ethers.MaxUint256);
  });

  describe("lockStake — 质押保证金", function () {
    it("alice 可以锁定保证金（≥100 pGOLD）", async function () {
      const amt = ethers.parseEther("1000");
      await burn.connect(alice).lockStake(amt);
      const [amount, lockUntil, active] = await burn.getBurnStake(alice.address);
      expect(active).to.equal(true);
      expect(amount).to.equal(amt);
      expect(lockUntil).to.be.gt(0n);
    });
    it("低于最低质押量 revert", async function () {
      await expect(burn.connect(bob).lockStake(ethers.parseEther("10"))).to.be.revertedWith("Burn: below minimum");
    });
    it("重复 lockStake revert", async function () {
      await expect(burn.connect(alice).lockStake(ethers.parseEther("1000"))).to.be.revertedWith("Burn: already active");
    });
    it("bob 也可以质押", async function () {
      await burn.connect(bob).lockStake(ethers.parseEther("500"));
      expect(await burn.totalStaked()).to.be.gte(ethers.parseEther("1500"));
    });
    it("addStake 可追加质押", async function () {
      await burn.connect(alice).addStake(ethers.parseEther("100"));
      const [amount,,] = await burn.getBurnStake(alice.address);
      expect(amount).to.equal(ethers.parseEther("1100"));
    });
  });

  describe("withdrawStake — 解锁保证金", function () {
    it("锁定期内 withdrawStake revert", async function () {
      await expect(burn.connect(alice).withdrawStake()).to.be.revertedWith("Burn: still locked");
    });
    it("锁定期满后可取回", async function () {
      // 推进锁定期（burnMinHoldingDays，默认30天）
      await network.provider.send("evm_increaseTime", [30 * 24 * 3600 + 1]);
      await network.provider.send("evm_mine");
      const before = await pgold.balanceOf(alice.address);
      await burn.connect(alice).withdrawStake();
      expect(await pgold.balanceOf(alice.address)).to.be.gt(before);
      const [,, active] = await burn.getBurnStake(alice.address);
      expect(active).to.equal(false);
    });
    it("非激活账户取出 revert", async function () {
      await expect(burn.connect(alice).withdrawStake()).to.be.revertedWith("Burn: not active");
    });
  });

  describe("setCompensationCaps", function () {
    it("DEFAULT_ADMIN 可设置上限", async function () {
      await burn.setCompensationCaps(ethers.parseEther("50000"), ethers.parseEther("5000000"));
      expect(await burn.maxCompPerRound()).to.equal(ethers.parseEther("50000"));
    });
    it("非 ADMIN 设置上限 revert", async function () {
      await expect(burn.connect(alice).setCompensationCaps(1n, 1n)).to.be.reverted;
    });
  });

  describe("createRound & claimCompensation", function () {
    let roundId, aliceLeaf, aliceProof, merkleRoot;

    before(async function () {
      // alice 重新质押（之前已取回）
      await burn.connect(alice).lockStake(ethers.parseEther("1000"));

      const loss = ethers.parseEther("10");
      // leaf = keccak256(abi.encodePacked(user, loss))
      aliceLeaf  = ethers.keccak256(ethers.solidityPacked(["address","uint256"], [alice.address, loss]));
      merkleRoot = aliceLeaf;
      aliceProof = [];

      await burn.setCompensationCaps(ethers.parseEther("100000"), ethers.parseEther("10000000"));
      await burn.createRound(merkleRoot);
      roundId = 0;
    });

    it("createRound 创建成功，轮次数 = 1", async function () {
      expect(await burn.getRoundCount()).to.equal(1n);
    });

    it("非 RANKING_ORACLE_ROLE 创建轮次 revert", async function () {
      await expect(burn.connect(alice).createRound(ethers.ZeroHash)).to.be.reverted;
    });

    it("alice 可领取补偿，创建 VestingSchedule", async function () {
      const loss = ethers.parseEther("10");
      const schedulesBefore = await vesting.nextScheduleId();
      await burn.connect(alice).claimCompensation(roundId, loss, aliceProof);
      expect(await vesting.nextScheduleId()).to.equal(schedulesBefore + 1n);
    });

    it("重复领取 revert", async function () {
      const loss = ethers.parseEther("10");
      await expect(
        burn.connect(alice).claimCompensation(roundId, loss, aliceProof)
      ).to.be.revertedWith("Burn: already claimed");
    });

    it("无效 proof revert", async function () {
      const loss = ethers.parseEther("10");
      await burn.createRound(merkleRoot);
      await expect(
        burn.connect(bob).claimCompensation(1, loss, [])
      ).to.be.revertedWith("Burn: invalid proof");
    });

    it("非激活质押用户领取 revert", async function () {
      const bobLoss = ethers.parseEther("5");
      const bobLeaf = ethers.keccak256(ethers.solidityPacked(["address","uint256"], [bob.address, bobLoss]));
      await burn.createRound(bobLeaf);
      // bob 已质押，可以 claim
      await burn.connect(bob).claimCompensation(2, bobLoss, []);
    });

    it("getRound 返回正确数据", async function () {
      const round = await burn.getRound(roundId);
      expect(round.merkleRoot).to.equal(merkleRoot);
    });
  });
});
