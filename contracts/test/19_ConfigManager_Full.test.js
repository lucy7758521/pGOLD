/**
 * ConfigManager 完整测试
 * 覆盖：默认值 / getAllParams / TIMELOCK_DELAY / 角色控制
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("ConfigManager — 完整覆盖", function () {
  let config, owner, alice;

  before(async function () {
    [owner, alice] = await ethers.getSigners();
    config = await (await ethers.getContractFactory("ConfigManager")).deploy();
  });

  describe("默认参数值", function () {
    it("dividendAPR = 350", async function () {
      expect(await config.dividendAPR()).to.equal(350n);
    });
    it("monthlyMultiplier = 300", async function () {
      expect(await config.monthlyMultiplier()).to.equal(300n);
    });
    it("quarterlyMultiplier = 500", async function () {
      expect(await config.quarterlyMultiplier()).to.equal(500n);
    });
    it("annualMultiplier = 1000", async function () {
      expect(await config.annualMultiplier()).to.equal(1000n);
    });
    it("rankingVestingYears = 10", async function () {
      expect(await config.rankingVestingYears()).to.equal(10n);
    });
    it("burnCompensationRate = 1000", async function () {
      expect(await config.burnCompensationRate()).to.equal(1000n);
    });
    it("burnVestingYears = 10", async function () {
      expect(await config.burnVestingYears()).to.equal(10n);
    });
    it("burnMinHoldingDays = 30", async function () {
      expect(await config.burnMinHoldingDays()).to.equal(30n);
    });
    it("directInviteRate = 20", async function () {
      expect(await config.directInviteRate()).to.equal(20n);
    });
    it("indirectInviteRate = 5", async function () {
      expect(await config.indirectInviteRate()).to.equal(5n);
    });
    it("teamBonusRate = 20", async function () {
      expect(await config.teamBonusRate()).to.equal(20n);
    });
    it("teamCaptainShare = 30", async function () {
      expect(await config.teamCaptainShare()).to.equal(30n);
    });
    it("topTeamCount = 10", async function () {
      expect(await config.topTeamCount()).to.equal(10n);
    });
    it("tradeFeeRate = 25", async function () {
      expect(await config.tradeFeeRate()).to.equal(25n);
    });
    it("l2DiscountThreshold = 300", async function () {
      expect(await config.l2DiscountThreshold()).to.equal(300n);
    });
    it("l2DurationThreshold = 7 days", async function () {
      expect(await config.l2DurationThreshold()).to.equal(7n * 24n * 3600n);
    });
    it("l3DiscountThreshold = 1000", async function () {
      expect(await config.l3DiscountThreshold()).to.equal(1000n);
    });
    it("l3DurationThreshold = 48 hours", async function () {
      expect(await config.l3DurationThreshold()).to.equal(48n * 3600n);
    });
  });

  describe("getAllParams", function () {
    it("返回 18 个参数", async function () {
      const params = await config.getAllParams();
      expect(params.length).to.equal(18);
    });
    it("params[0] = dividendAPR = 350", async function () {
      const params = await config.getAllParams();
      expect(params[0]).to.equal(350n);
    });
    it("params[13] = tradeFeeRate = 25", async function () {
      const params = await config.getAllParams();
      expect(params[13]).to.equal(25n);
    });
    it("params[14] = l2DiscountThreshold = 300", async function () {
      const params = await config.getAllParams();
      expect(params[14]).to.equal(300n);
    });
    it("params[16] = l3DiscountThreshold = 1000", async function () {
      const params = await config.getAllParams();
      expect(params[16]).to.equal(1000n);
    });
  });

  describe("TIMELOCK_DELAY", function () {
    it("TIMELOCK_DELAY = 2 天 (172800 秒)", async function () {
      expect(await config.TIMELOCK_DELAY()).to.equal(2n * 24n * 3600n);
    });
  });

  describe("角色控制", function () {
    it("部署者拥有 DEFAULT_ADMIN_ROLE", async function () {
      expect(await config.hasRole(await config.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(true);
    });
    it("部署者拥有 GOVERNOR_ROLE", async function () {
      const GOVERNOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNOR_ROLE"));
      expect(await config.hasRole(GOVERNOR_ROLE, owner.address)).to.equal(true);
    });
    it("alice 默认无 GOVERNOR_ROLE", async function () {
      const GOVERNOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNOR_ROLE"));
      expect(await config.hasRole(GOVERNOR_ROLE, alice.address)).to.equal(false);
    });
    it("ADMIN 可授予 alice GOVERNOR_ROLE", async function () {
      const GOVERNOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNOR_ROLE"));
      await config.grantRole(GOVERNOR_ROLE, alice.address);
      expect(await config.hasRole(GOVERNOR_ROLE, alice.address)).to.equal(true);
      await config.revokeRole(GOVERNOR_ROLE, alice.address);
    });
  });
});
