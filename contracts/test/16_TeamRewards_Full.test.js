/**
 * TeamRewards 完整补充测试
 * 覆盖：bindInviter / createTeam / joinTeam / createRewardRound /
 *        claimReferralReward / claimTeamReward / 边界检查 / 查询
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("TeamRewards — 完整覆盖", function () {
  let team, pgold, config, treasury, mockPAXG, mockUSDC, mockRouter;
  let owner, alice, bob, carol, dave;

  before(async function () {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG   = await MockERC20.deploy("PAXG","PAXG");
    mockUSDC   = await MockERC20.deploy("USDC","USDC");
    pgold      = await (await ethers.getContractFactory("PGOLDToken")).deploy();
    config     = await (await ethers.getContractFactory("ConfigManager")).deploy();
    treasury   = await (await ethers.getContractFactory("Treasury")).deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await pgold.grantRole(await pgold.MINTER_ROLE(), treasury.target);

    team = await (await ethers.getContractFactory("TeamRewards")).deploy(
      config.target, treasury.target
    );
    await treasury.setMintAuthorized(team.target, true);
  });

  describe("bindInviter — 推荐关系", function () {
    it("alice 绑定 owner 为邀请人", async function () {
      await team.connect(alice).bindInviter(owner.address);
      const [inviter,,bound] = await team.getInviter(alice.address);
      expect(bound).to.equal(true);
      expect(inviter).to.equal(owner.address);
    });
    it("重复绑定 revert", async function () {
      await expect(team.connect(alice).bindInviter(bob.address)).to.be.revertedWith("Team: already bound");
    });
    it("绑定自己 revert", async function () {
      await expect(team.connect(bob).bindInviter(bob.address)).to.be.revertedWith("Team: self invite");
    });
    it("bob 绑定 alice 为邀请人（间接关系）", async function () {
      await team.connect(bob).bindInviter(alice.address);
      const [inviter,,bound] = await team.getInviter(bob.address);
      expect(bound).to.equal(true);
      expect(inviter).to.equal(alice.address);
    });
  });

  describe("createTeam & joinTeam", function () {
    it("alice 创建战队", async function () {
      await team.connect(alice).createTeam("Alpha");
      const t = await team.getTeam(1);
      expect(t.captain).to.equal(alice.address);
      expect(t.name).to.equal("Alpha");
      expect(t.active).to.equal(true);
    });
    it("bob 加入战队", async function () {
      await team.connect(bob).joinTeam(1);
      const t = await team.getTeam(1);
      expect(t.memberCount).to.equal(2n);
    });
    it("已加入战队不可重复加入", async function () {
      await expect(team.connect(bob).joinTeam(1)).to.be.revertedWith("Team: already in team");
    });
    it("carol 加入另一个新战队", async function () {
      await team.connect(carol).createTeam("Beta");
      expect(await team.getUserTeam(carol.address)).to.equal(2n);
    });
    it("getRoundCount 初始为 0", async function () {
      expect(await team.getRoundCount()).to.equal(0n);
    });
  });

  describe("createRewardRound & claimReferralReward", function () {
    let roundId, aliceLeaf, aliceProof, refRoot;
    // claimReferral params
    const totalFeePaid       = ethers.parseEther("100");
    const directCount        = 1n;
    const directCommission   = ethers.parseEther("20");
    const indirectCommission = ethers.parseEther("5");

    before(async function () {
      // leaf = keccak256(user, totalFeePaid, directCount, directCommission, indirectCommission)
      aliceLeaf = ethers.solidityPackedKeccak256(
        ["address","uint256","uint256","uint256","uint256"],
        [alice.address, totalFeePaid, directCount, directCommission, indirectCommission]
      );
      refRoot    = aliceLeaf; // 单叶时 root == leaf
      aliceProof = [];

      const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TEAM_ORACLE_ROLE"));
      await team.grantRole(ORACLE_ROLE, owner.address);
      await team.createRewardRound(refRoot, ethers.ZeroHash);
      roundId = 0;
    });

    it("createRewardRound 成功，轮次数 = 1", async function () {
      expect(await team.getRoundCount()).to.equal(1n);
    });

    it("非 ORACLE_ROLE 创建轮次 revert", async function () {
      await expect(
        team.connect(alice).createRewardRound(ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.reverted;
    });

    it("alice 领取推荐返佣 → pGOLD 余额增加", async function () {
      const before = await pgold.balanceOf(alice.address);
      await team.connect(alice).claimReferral(
        roundId, totalFeePaid, directCount, directCommission, indirectCommission, aliceProof
      );
      expect(await pgold.balanceOf(alice.address)).to.be.gt(before);
    });

    it("重复领取推荐返佣 revert", async function () {
      await expect(
        team.connect(alice).claimReferral(
          roundId, totalFeePaid, directCount, directCommission, indirectCommission, aliceProof
        )
      ).to.be.revertedWith("Team: already claimed");
    });

    it("无效 proof 领取 revert", async function () {
      await team.createRewardRound(refRoot, ethers.ZeroHash);
      await expect(
        team.connect(bob).claimReferral(1, totalFeePaid, directCount, directCommission, indirectCommission, [])
      ).to.be.revertedWith("Team: invalid proof");
    });
  });

  describe("claimTeamReward", function () {
    let teamRoundId, teamLeaf, teamProof, teamRoot;
    // claimTeamReward params: roundId, teamId, rank, totalTeamFee, bonusBase, captainShare, memberShare, proof
    const rank         = 1n;
    const totalTeamFee = ethers.parseEther("500");
    const bonusBase    = ethers.parseEther("100"); // 20% of totalTeamFee
    const captainShare = ethers.parseEther("30");
    const memberShare  = ethers.parseEther("70");

    before(async function () {
      // leaf = keccak256(teamId, rank, totalTeamFee, bonusBase, captainShare, memberShare)
      teamLeaf = ethers.solidityPackedKeccak256(
        ["uint256","uint256","uint256","uint256","uint256","uint256"],
        [1n, rank, totalTeamFee, bonusBase, captainShare, memberShare]
      );
      teamRoot  = teamLeaf;
      teamProof = [];

      await team.createRewardRound(ethers.ZeroHash, teamRoot);
      teamRoundId = await team.getRoundCount() - 1n;
    });

    it("alice(队长) 领取战队奖励 → pGOLD 增加", async function () {
      const before = await pgold.balanceOf(alice.address);
      await team.connect(alice).claimTeamReward(
        teamRoundId, 1, rank, totalTeamFee, bonusBase, captainShare, memberShare, teamProof
      );
      expect(await pgold.balanceOf(alice.address)).to.be.gt(before);
    });

    it("重复领取战队奖励 revert", async function () {
      await expect(
        team.connect(alice).claimTeamReward(
          teamRoundId, 1, rank, totalTeamFee, bonusBase, captainShare, memberShare, teamProof
        )
      ).to.be.revertedWith("Team: already claimed");
    });

    it("无效 proof 战队奖励 revert", async function () {
      await team.createRewardRound(ethers.ZeroHash, teamRoot);
      const nextRound = await team.getRoundCount() - 1n;
      await expect(
        team.connect(alice).claimTeamReward(
          nextRound, 1, rank, totalTeamFee, bonusBase, captainShare, memberShare, [ethers.ZeroHash]
        )
      ).to.be.revertedWith("Team: invalid proof");
    });
  });

  describe("查询接口", function () {
    it("getRound 返回正确数据", async function () {
      const r = await team.getRound(0);
      expect(r.timestamp).to.be.gt(0n);
    });
    it("getUserTeam 返回正确战队 ID", async function () {
      expect(await team.getUserTeam(alice.address)).to.equal(1n);
    });
    it("nextTeamId 正确递增", async function () {
      expect(await team.nextTeamId()).to.be.gte(3n);
    });
  });
});
