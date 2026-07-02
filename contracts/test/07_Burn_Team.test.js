/**
 * BurnMining + TeamRewards 单元测试
 * C轨：燃烧挖矿 1000% / 10年  |  D轨：推荐返佣 20%/5% + 战队竞赛
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

// =====================================================================
// C轨 — 燃烧挖矿
// =====================================================================
describe("BurnMining (C轨)", function () {
  let burnMining, vesting, pgold, config;
  let owner, treasury, oracle, alice;

  before(async function () {
    [owner, treasury, oracle, alice] = await hre.ethers.getSigners();

    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    const VestingManager = await ethers.getContractFactory("VestingManager");
    vesting = await VestingManager.deploy(pgold.target, treasury.address);
    await vesting.waitForDeployment();

    const BurnMining = await ethers.getContractFactory("BurnMining");
    burnMining = await BurnMining.deploy(
      pgold.target,
      config.target,
      vesting.target
    );
    await burnMining.waitForDeployment();
  });

  describe("部署", function () {
    it("补偿率 = 1000 (1000%)", async function () {
      expect(await config.burnCompensationRate()).to.equal(1000n);
    });

    it("释放年限 = 10", async function () {
      expect(await config.burnVestingYears()).to.equal(10n);
    });

    it("RANKING_ORACLE_ROLE 已授予部署者", async function () {
      const oracleRole = ethers.keccak256(ethers.toUtf8Bytes("RANKING_ORACLE_ROLE"));
      expect(await burnMining.hasRole(oracleRole, owner.address)).to.equal(true);
    });
  });

  describe("创建补偿批次", function () {
    const merkleRoot = ethers.ZeroHash;

    it("RANKING_ORACLE_ROLE 可创建批次", async function () {
      await burnMining.createRound(merkleRoot);
      expect(await burnMining.getRoundCount()).to.equal(1n);
    });
  });

  describe("领取燃烧补偿 (Merkle Proof)", function () {
    it("无效 proof 时 revert", async function () {
      await expect(
        burnMining.connect(alice).claimCompensation(
          1, // roundId
          ethers.parseEther("10000"), // loss
          [] // empty proof
        )
      ).to.be.reverted;
    });
  });

  describe("补偿计算逻辑", function () {
    it("手续费 × 10 = 补偿 (离线校验)", async function () {
      // 1000 USDC 手续费 → 10000 USDC 等值 pGOLD 补偿
      const loss = 1000n;
      const expected = loss * 1000n / 100n; // 1000% = 1000/100
      expect(expected).to.equal(10000n);
    });

    it("10年释放校验", async function () {
      expect(await config.burnVestingYears()).to.equal(10n);
    });
  });
});

// =====================================================================
// D轨 — 战队奖励
// =====================================================================
describe("TeamRewards (D轨)", function () {
  let teamRewards, pgold, config, treasury;
  let owner, oracle, user1, user2, user3, user4;

  before(async function () {
    [owner, treasury, oracle, user1, user2, user3, user4] = await hre.ethers.getSigners();

    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    const TeamRewards = await ethers.getContractFactory("TeamRewards");
    teamRewards = await TeamRewards.deploy(config.target, treasury.address);
    await teamRewards.waitForDeployment();
  });

  // ==================== D1 推荐关系 ====================
  describe("D1 推荐关系", function () {
    it("user2 绑定 user1 为邀请人", async function () {
      await teamRewards.connect(user2).bindInviter(user1.address);
      const inviterInfo = await teamRewards.getInviter(user2.address);
      expect(inviterInfo.inviter).to.equal(user1.address);
    });

    it("不可重复绑定邀请人", async function () {
      await expect(
        teamRewards.connect(user2).bindInviter(user3.address)
      ).to.be.revertedWith("Team: already bound");
    });

    it("不可绑定自己", async function () {
      await expect(
        teamRewards.connect(user1).bindInviter(user1.address)
      ).to.be.reverted;
    });
  });

  // ==================== D1 返佣 ====================
  describe("D1 返佣逻辑", function () {
    it("直邀返佣率 = 20%", async function () {
      expect(await config.directInviteRate()).to.equal(20n);
    });

    it("间邀返佣率 = 5%", async function () {
      expect(await config.indirectInviteRate()).to.equal(5n);
    });

    it("返佣计算正确 (离线)", async function () {
      const fee = 100n;
      const l1Rate = await config.directInviteRate();
      const l1Expected = fee * l1Rate / 100n;
      expect(l1Expected).to.equal(20n);
    });
  });

  // ==================== D2 战队 ====================
  describe("D2 战队", function () {
    it("user1 创建战队", async function () {
      await teamRewards.connect(user1).createTeam("TIGER_TEAM");
      const team = await teamRewards.getTeam(1);
      expect(team.name).to.equal("TIGER_TEAM");
    });

    it("user2 加入战队", async function () {
      await teamRewards.connect(user2).joinTeam(1);
      expect(await teamRewards.getUserTeam(user2.address)).to.equal(1n);
    });

    it("队伍人数正确", async function () {
      const team = await teamRewards.getTeam(1);
      expect(team.memberCount).to.equal(2n);
    });

    it("已加入战队不可重复加入", async function () {
      await expect(
        teamRewards.connect(user2).joinTeam(1)
      ).to.be.revertedWith("Team: already in team");
    });

    it("队长分润比 = 30%", async function () {
      expect(await config.teamCaptainShare()).to.equal(30n);
    });
  });
});
