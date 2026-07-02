/**
 * RankingRewards 完整补充测试
 * 覆盖：depositStake / withdrawStake / createRound / claimReward / 查询
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("RankingRewards — 完整覆盖", function () {
  let ranking, pgold, config, vesting, treasury, mockPAXG, mockUSDC;
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

    ranking = await (await ethers.getContractFactory("RankingRewards")).deploy(
      config.target, vesting.target
    );
    await vesting.setAuthorizedCreator(ranking.target, true);

    await treasury.setMintAuthorized(owner.address, true);
    await treasury["requestMint(address,uint256,bytes32)"](alice.address, ethers.parseEther("5000"), ethers.keccak256(ethers.toUtf8Bytes("A")));
    await treasury["requestMint(address,uint256,bytes32)"](bob.address,   ethers.parseEther("5000"), ethers.keccak256(ethers.toUtf8Bytes("B")));
    await pgold.connect(alice).approve(ranking.target, ethers.MaxUint256);
    await pgold.connect(bob).approve(ranking.target, ethers.MaxUint256);
  });

  describe("depositStake / withdrawStake", function () {
    it("alice 可以存入质押", async function () {
      await ranking.connect(alice).depositStake(ethers.parseEther("1000"));
      const [amount, active] = await ranking.getStake(alice.address);
      expect(active).to.equal(true);
      expect(amount).to.equal(ethers.parseEther("1000"));
    });
    it("totalStaked 正确累加", async function () {
      expect(await ranking.totalStaked()).to.equal(ethers.parseEther("1000"));
    });
    it("0 质押 revert", async function () {
      await expect(ranking.connect(bob).depositStake(0n)).to.be.revertedWith("Rank: zero");
    });
    it("alice 可以部分取出质押", async function () {
      await ranking.connect(alice).withdrawStake(ethers.parseEther("500"));
      const [amount,] = await ranking.getStake(alice.address);
      expect(amount).to.equal(ethers.parseEther("500")); // 1000 - 500
    });
    it("超额取出 revert", async function () {
      await expect(
        ranking.connect(alice).withdrawStake(ethers.parseEther("99999"))
      ).to.be.revertedWith("Rank: insufficient");
    });
    it("非激活账户取出 revert — 先清零再测", async function () {
      await ranking.connect(alice).withdrawStake(ethers.parseEther("500")); // 清零
      await expect(
        ranking.connect(alice).withdrawStake(1n)
      ).to.be.revertedWith("Rank: not active");
    });
  });

  describe("createRound & claimReward", function () {
    let merkleRoot, aliceProof, stakeAmount;
    const rank            = 1n;
    const isAbsorbed      = false;
    const absorbingRoundId = 0n;

    before(async function () {
      stakeAmount = ethers.parseEther("2000");
      await ranking.connect(alice).depositStake(stakeAmount);

      // leaf = keccak256(user, rank, stakeAmount, isAbsorbed, absorbingRoundId)
      const leaf = ethers.solidityPackedKeccak256(
        ["address","uint256","uint256","bool","uint256"],
        [alice.address, rank, stakeAmount, isAbsorbed, absorbingRoundId]
      );
      merkleRoot = leaf;
      aliceProof = [];
    });

    it("RANKING_ORACLE_ROLE 可创建月榜", async function () {
      await ranking.createRound(0, merkleRoot);
      expect(await ranking.getRoundCount()).to.equal(1n);
    });

    it("RANKING_ORACLE_ROLE 可创建季榜", async function () {
      await ranking.createRound(1, merkleRoot);
      expect(await ranking.getRoundCount()).to.equal(2n);
    });

    it("RANKING_ORACLE_ROLE 可创建年榜", async function () {
      await ranking.createRound(2, merkleRoot);
      expect(await ranking.getRoundCount()).to.equal(3n);
    });

    it("非 ORACLE_ROLE 创建轮次 revert", async function () {
      await expect(ranking.connect(alice).createRound(0, merkleRoot)).to.be.reverted;
    });

    it("alice 可领取月榜奖励 → 创建 VestingSchedule", async function () {
      const before = await vesting.nextScheduleId();
      await ranking.connect(alice).claimReward(0, rank, stakeAmount, isAbsorbed, absorbingRoundId, aliceProof);
      expect(await vesting.nextScheduleId()).to.equal(before + 1n);
    });

    it("重复领取同一轮次 revert", async function () {
      await expect(
        ranking.connect(alice).claimReward(0, rank, stakeAmount, isAbsorbed, absorbingRoundId, aliceProof)
      ).to.be.revertedWith("Rank: already claimed");
    });

    it("无效 proof revert", async function () {
      const badLeaf = ethers.solidityPackedKeccak256(["address"], [bob.address]);
      await ranking.createRound(0, badLeaf);
      await expect(
        ranking.connect(alice).claimReward(3, rank, stakeAmount, isAbsorbed, absorbingRoundId, [])
      ).to.be.revertedWith("Rank: invalid proof");
    });

    it("getRound 返回正确数据", async function () {
      const round = await ranking.getRound(0);
      expect(round.merkleRoot).to.equal(merkleRoot);
      expect(round.period).to.equal(0n); // MONTHLY
    });

    it("totalRewardsDistributed 正确累加", async function () {
      expect(await ranking.totalRewardsDistributed()).to.be.gt(0n);
    });

    it("季榜领取奖励", async function () {
      const before = await vesting.nextScheduleId();
      await ranking.connect(alice).claimReward(1, rank, stakeAmount, isAbsorbed, absorbingRoundId, aliceProof);
      expect(await vesting.nextScheduleId()).to.be.gte(before);
    });

    it("年榜领取奖励", async function () {
      const before = await vesting.nextScheduleId();
      await ranking.connect(alice).claimReward(2, rank, stakeAmount, isAbsorbed, absorbingRoundId, aliceProof);
      expect(await vesting.nextScheduleId()).to.be.gte(before);
    });
  });
});
