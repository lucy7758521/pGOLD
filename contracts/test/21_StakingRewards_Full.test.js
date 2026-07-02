/**
 * StakingRewards 完整测试
 * 覆盖：部署 / stake / withdraw / updateRewardRate / claimReward /
 *        earned / getStakeInfo / rewardPerToken / 边界条件
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("StakingRewards — 完整覆盖", function () {
  let staking, pgold, config, treasury, mockPAXG, mockUSDC;
  let owner, alice, bob;

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

    staking = await (await ethers.getContractFactory("StakingRewards")).deploy(
      pgold.target, treasury.target, config.target
    );
    // treasury 授权 staking mint
    await treasury.setMintAuthorized(staking.target, true);

    // 给 alice / bob 铸造 pGOLD
    await treasury.setMintAuthorized(owner.address, true);
    await treasury["requestMint(address,uint256,bytes32)"](alice.address, ethers.parseEther("10000"), ethers.keccak256(ethers.toUtf8Bytes("A")));
    await treasury["requestMint(address,uint256,bytes32)"](bob.address,   ethers.parseEther("10000"), ethers.keccak256(ethers.toUtf8Bytes("B")));
    await pgold.connect(alice).approve(staking.target, ethers.MaxUint256);
    await pgold.connect(bob).approve(staking.target, ethers.MaxUint256);
  });

  describe("部署状态", function () {
    it("pGOLD 地址正确", async function () {
      expect(await staking.pGOLD()).to.equal(pgold.target);
    });
    it("treasury 地址正确", async function () {
      expect(await staking.treasury()).to.equal(treasury.target);
    });
    it("config 地址正确", async function () {
      expect(await staking.config()).to.equal(config.target);
    });
    it("初始 totalStaked = 0", async function () {
      expect(await staking.totalStaked()).to.equal(0n);
    });
    it("初始 rewardRate = 0", async function () {
      expect(await staking.rewardRate()).to.equal(0n);
    });
    it("初始 totalRewardsDistributed = 0", async function () {
      expect(await staking.totalRewardsDistributed()).to.equal(0n);
    });
  });

  describe("构造函数零地址检查", function () {
    it("pGOLD 零地址 revert", async function () {
      await expect(
        (await ethers.getContractFactory("StakingRewards")).deploy(
          ethers.ZeroAddress, treasury.target, config.target
        )
      ).to.be.revertedWith("Staking: zero pGOLD");
    });
  });

  describe("stake", function () {
    it("alice 可质押 pGOLD", async function () {
      await staking.connect(alice).stake(ethers.parseEther("1000"));
      const [staked,,] = await staking.getStakeInfo(alice.address);
      expect(staked).to.equal(ethers.parseEther("1000"));
    });
    it("totalStaked 正确累加", async function () {
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("1000"));
    });
    it("bob 也可以质押", async function () {
      await staking.connect(bob).stake(ethers.parseEther("2000"));
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("3000"));
    });
    it("零金额 stake revert", async function () {
      await expect(staking.connect(alice).stake(0n)).to.be.revertedWith("Staking: zero");
    });
    it("余额不足 stake revert", async function () {
      await expect(
        staking.connect(alice).stake(ethers.parseEther("999999"))
      ).to.be.reverted;
    });
  });

  describe("updateRewardRate", function () {
    it("totalStaked > 0 时 rewardRate > 0", async function () {
      await staking.updateRewardRate();
      expect(await staking.rewardRate()).to.be.gt(0n);
    });
    it("触发 RewardRateUpdated 事件", async function () {
      await expect(staking.updateRewardRate()).to.emit(staking, "RewardRateUpdated");
    });
    it("totalStaked = 0 时 rewardRate = 0", async function () {
      // 部署新实例测试
      const s2 = await (await ethers.getContractFactory("StakingRewards")).deploy(
        pgold.target, treasury.target, config.target
      );
      await s2.updateRewardRate();
      expect(await s2.rewardRate()).to.equal(0n);
    });
  });

  describe("rewardPerToken", function () {
    it("totalStaked = 0 时 rewardPerToken = rewardPerTokenStored", async function () {
      const s2 = await (await ethers.getContractFactory("StakingRewards")).deploy(
        pgold.target, treasury.target, config.target
      );
      expect(await s2.rewardPerToken()).to.equal(0n);
    });
    it("有质押时随时间增长", async function () {
      const before = await staking.rewardPerToken();
      await network.provider.send("evm_increaseTime", [3600]);
      await network.provider.send("evm_mine");
      const after = await staking.rewardPerToken();
      expect(after).to.be.gte(before);
    });
  });

  describe("earned", function () {
    it("质押后时间流逝 → earned > 0", async function () {
      await network.provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await network.provider.send("evm_mine");
      const aliceEarned = await staking.earned(alice.address);
      expect(aliceEarned).to.be.gt(0n);
    });
    it("bob earned >= alice earned（bob 质押更多）", async function () {
      const aliceEarned = await staking.earned(alice.address);
      const bobEarned   = await staking.earned(bob.address);
      expect(bobEarned).to.be.gte(aliceEarned);
    });
    it("未质押用户 earned = 0", async function () {
      expect(await staking.earned(owner.address)).to.equal(0n);
    });
  });

  describe("claimReward", function () {
    it("alice 领取奖励，pGOLD 余额增加", async function () {
      const before = await pgold.balanceOf(alice.address);
      await staking.connect(alice).claimReward();
      const after = await pgold.balanceOf(alice.address);
      expect(after).to.be.gt(before);
    });
    it("claimReward 触发 RewardClaimed 事件", async function () {
      // 再等一段时间让奖励积累
      await network.provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await network.provider.send("evm_mine");
      await expect(staking.connect(alice).claimReward()).to.emit(staking, "RewardClaimed");
    });
    it("totalRewardsDistributed 正确累加", async function () {
      expect(await staking.totalRewardsDistributed()).to.be.gt(0n);
    });
    it("无质押用户 claimReward revert", async function () {
      // owner 从未质押，rewardDebt = 0
      await expect(staking.connect(owner).claimReward()).to.be.revertedWith("Staking: no reward");
    });
  });

  describe("withdraw", function () {
    it("alice 可取回部分质押", async function () {
      const before = await pgold.balanceOf(alice.address);
      await staking.connect(alice).withdraw(ethers.parseEther("500"));
      expect(await pgold.balanceOf(alice.address)).to.equal(before + ethers.parseEther("500"));
    });
    it("totalStaked 正确减少", async function () {
      // alice 原来 1000，取走 500，bob 2000
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("2500"));
    });
    it("超额取回 revert", async function () {
      await expect(
        staking.connect(alice).withdraw(ethers.parseEther("99999"))
      ).to.be.revertedWith("Staking: insufficient");
    });
    it("零金额 withdraw revert", async function () {
      await expect(staking.connect(alice).withdraw(0n)).to.be.revertedWith("Staking: zero");
    });
    it("取回触发 Withdrawn 事件", async function () {
      await expect(
        staking.connect(alice).withdraw(ethers.parseEther("500"))
      ).to.emit(staking, "Withdrawn");
    });
  });

  describe("getStakeInfo", function () {
    it("返回 staked / earned / accumulated 三个字段", async function () {
      const [staked, earned_, accumulated] = await staking.getStakeInfo(bob.address);
      expect(staked).to.equal(ethers.parseEther("2000"));
      expect(earned_).to.be.gte(0n);
      expect(accumulated).to.be.gte(0n);
    });
    it("未质押用户三个字段均为 0", async function () {
      const [staked, earned_, accumulated] = await staking.getStakeInfo(owner.address);
      expect(staked).to.equal(0n);
      expect(earned_).to.equal(0n);
      expect(accumulated).to.equal(0n);
    });
  });
});
