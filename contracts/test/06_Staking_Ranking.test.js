/**
 * StakingRewards + RankingRewards 联合单元测试
 * A轨：持有分红 3.5%  |  B轨：Top100 排名 300%/500%/1000%
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

// =====================================================================
// A轨 — 持有分红
// =====================================================================
describe("StakingRewards (A轨)", function () {
  let staking, pgold, config, treasury, mockPAXG, mockUSDC;
  let owner, alice, bob;

  before(async function () {
    [owner, alice, bob] = await hre.ethers.getSigners();

    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // Deploy mock tokens for Treasury
    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC = await MockERC20.deploy("USDC", "USDC");
    await mockPAXG.waitForDeployment();
    await mockUSDC.waitForDeployment();

    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // Deploy real Treasury (needed for requestMint in claimReward)
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await treasury.waitForDeployment();

    // Grant MINTER_ROLE to Treasury
    const minterRole = await pgold.MINTER_ROLE();
    await pgold.grantRole(minterRole, treasury.target);

    // Authorize StakingRewards to mint via Treasury
    const StakingRewards = await ethers.getContractFactory("StakingRewards");
    staking = await StakingRewards.deploy(pgold.target, treasury.target, config.target);
    await staking.waitForDeployment();

    await treasury.setMintAuthorized(staking.target, true);

    // Mint some pGOLD to alice for staking
    await pgold.grantRole(minterRole, owner.address);
    await pgold.mint(alice.address, ethers.parseEther("1000"), ethers.encodeBytes32String("TEST"));
    await pgold.revokeRole(minterRole, owner.address);
  });

  describe("部署", function () {
    it("pGOLD 地址正确", async function () {
      expect(await staking.pGOLD()).to.equal(pgold.target);
    });

    it("初始 totalStaked = 0", async function () {
      expect(await staking.totalStaked()).to.equal(0n);
    });
  });

  describe("质押", function () {
    it("质押后 totalStaked 增加", async function () {
      // mint more pGOLD to alice via owner (has minter role from before)
      await pgold.grantRole(await pgold.MINTER_ROLE(), owner.address);
      await pgold.mint(alice.address, ethers.parseEther("1000"), ethers.encodeBytes32String("TEST"));
      await pgold.revokeRole(await pgold.MINTER_ROLE(), owner.address);
      await pgold.connect(alice).approve(staking.target, ethers.parseEther("1500"));
      await staking.connect(alice).stake(ethers.parseEther("500"));

      const s = await staking.stakes(alice.address);
      expect(s.amount).to.equal(ethers.parseEther("500"));
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("500"));
    });

    it("0 质押 revert", async function () {
      await expect(staking.connect(alice).stake(0)).to.be.revertedWith("Staking: zero");
    });
  });

  describe("解质押", function () {
    it("解质押后余额恢复", async function () {
      const before = await pgold.balanceOf(alice.address);
      await staking.connect(alice).withdraw(ethers.parseEther("300"));
      const after = await pgold.balanceOf(alice.address);
      expect(after).to.be.gt(before);
      const s = await staking.stakes(alice.address);
      expect(s.amount).to.equal(ethers.parseEther("200"));
    });

    it("超额解质押失败", async function () {
      await expect(
        staking.connect(alice).withdraw(ethers.parseEther("9999"))
      ).to.be.reverted;
    });
  });

  describe("分红", function () {
    it("updateRewardRate 后产生收益", async function () {
      await staking.updateRewardRate();
      await ethers.provider.send("evm_increaseTime", [86400 * 30]); // 30 days
      await ethers.provider.send("evm_mine");

      const earned = await staking.earned(alice.address);
      expect(earned).to.be.gt(0n);
    });

    it("claimReward 领取收益", async function () {
      const before = await pgold.balanceOf(alice.address);
      await staking.connect(alice).claimReward();
      const after = await pgold.balanceOf(alice.address);
      expect(after).to.be.gt(before);
    });
  });
});

// =====================================================================
// B轨 — 排名激励
// =====================================================================
describe("RankingRewards (B轨)", function () {
  let ranking, vesting, pgold, config;
  let owner, treasury, oracle, alice;

  before(async function () {
    [owner, treasury, oracle, alice] = await hre.ethers.getSigners();

    // Config
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // pGOLD
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // VestingManager
    const VestingManager = await ethers.getContractFactory("VestingManager");
    vesting = await VestingManager.deploy(pgold.target, treasury.address);
    await vesting.waitForDeployment();

    // RankingRewards
    const RankingRewards = await ethers.getContractFactory("RankingRewards");
    ranking = await RankingRewards.deploy(config.target, vesting.target);
    await ranking.waitForDeployment();
  });

  describe("部署", function () {
    it("vestingManager 正确", async function () {
      expect(await ranking.vestingManager()).to.equal(vesting.target);
    });

    it("RANKING_ORACLE_ROLE 已授予部署者", async function () {
      const oracleRole = ethers.keccak256(ethers.toUtf8Bytes("RANKING_ORACLE_ROLE"));
      expect(await ranking.hasRole(oracleRole, owner.address)).to.equal(true);
    });
  });

  describe("创建排名周期", function () {
    const merkleRoot = ethers.ZeroHash;

    it("RANKING_ORACLE_ROLE 可创建月榜", async function () {
      await ranking.createRound(0, merkleRoot); // MONTHLY
      expect(await ranking.getRoundCount()).to.equal(1n);
    });

    it("可创建季榜", async function () {
      await ranking.createRound(1, merkleRoot); // QUARTERLY
      expect(await ranking.getRoundCount()).to.equal(2n);
    });

    it("非 RANKING_ORACLE_ROLE 创建失败", async function () {
      await expect(
        ranking.connect(alice).createRound(0, merkleRoot)
      ).to.be.reverted;
    });
  });

  describe("领取排名奖励 (Merkle Proof)", function () {
    it("无效 proof 时 revert", async function () {
      await expect(
        ranking.claimReward(
          1,           // roundId
          10,          // rank
          ethers.parseEther("1000"), // stakeAmount
          false,       // isAbsorbed
          0,           // absorbingRoundId
          []           // empty proof
        )
      ).to.be.reverted;
    });
  });

  describe("递进覆盖", function () {
    it("年榜吸收季榜吸收月榜 (1000% 硬顶)", async function () {
      expect(await config.annualMultiplier()).to.equal(1000n);
      expect(await config.quarterlyMultiplier()).to.equal(500n);
      expect(await config.monthlyMultiplier()).to.equal(300n);
    });
  });
});
