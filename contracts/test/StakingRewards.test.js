const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// helpers
const e18 = (n) => ethers.parseEther(String(n));
const YEAR = 365 * 24 * 3600;
const APR_BPS = 350n; // 3.50%

describe("StakingRewards", function () {
  let pGOLD, treasury, config, staking;
  let owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    // ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();

    // PGOLDToken
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pGOLD = await PGOLDToken.deploy();

    // Minimal Treasury stub — we only need requestMint to work
    // Use a mock that just calls pGOLD.mint
    const MockTreasury = await ethers.getContractFactory("MockTreasuryStaking");
    treasury = await MockTreasury.deploy(await pGOLD.getAddress());

    // Grant MINTER_ROLE to MockTreasury
    const MINTER_ROLE = await pGOLD.MINTER_ROLE();
    await pGOLD.grantRole(MINTER_ROLE, await treasury.getAddress());

    // StakingRewards
    const StakingRewards = await ethers.getContractFactory("StakingRewards");
    staking = await StakingRewards.deploy(
      await pGOLD.getAddress(),
      await treasury.getAddress(),
      await config.getAddress()
    );

    // Authorize staking to call requestMint on treasury mock
    await treasury.authorize(await staking.getAddress());

    // Mint initial pGOLD to alice and bob for staking
    await treasury.directMint(alice.address, e18(10000));
    await treasury.directMint(bob.address, e18(10000));

    // Approve staking contract
    await pGOLD.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);
    await pGOLD.connect(bob).approve(await staking.getAddress(), ethers.MaxUint256);
  });

  // ─────────────────────────────────────────────
  // stake()
  // ─────────────────────────────────────────────
  describe("stake()", function () {
    it("records stake amount and increases totalStaked", async function () {
      await staking.connect(alice).stake(e18(1000));
      const [staked] = await staking.getStakeInfo(alice.address);
      expect(staked).to.equal(e18(1000));
      expect(await staking.totalStaked()).to.equal(e18(1000));
    });

    it("transfers pGOLD from staker to contract", async function () {
      const before = await pGOLD.balanceOf(alice.address);
      await staking.connect(alice).stake(e18(500));
      expect(await pGOLD.balanceOf(alice.address)).to.equal(before - e18(500));
      expect(await pGOLD.balanceOf(await staking.getAddress())).to.equal(e18(500));
    });

    it("reverts on zero amount", async function () {
      await expect(staking.connect(alice).stake(0)).to.be.revertedWith("Staking: zero");
    });

    it("checkpoints pending reward on second stake", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR / 2);

      // second stake should checkpoint without losing pending rewards
      await staking.connect(alice).stake(e18(1000));
      const [, earned] = await staking.getStakeInfo(alice.address);
      expect(earned).to.be.gt(0n);
    });
  });

  // ─────────────────────────────────────────────
  // withdraw()
  // ─────────────────────────────────────────────
  describe("withdraw()", function () {
    it("returns pGOLD and decrements totalStaked", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.connect(alice).withdraw(e18(400));
      const [staked] = await staking.getStakeInfo(alice.address);
      expect(staked).to.equal(e18(600));
      expect(await staking.totalStaked()).to.equal(e18(600));
    });

    it("reverts if withdrawing more than staked", async function () {
      await staking.connect(alice).stake(e18(500));
      await expect(staking.connect(alice).withdraw(e18(501))).to.be.revertedWith("Staking: insufficient");
    });

    it("preserves accrued rewards on partial withdraw", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR);

      await staking.connect(alice).withdraw(e18(500));
      const [, earned] = await staking.getStakeInfo(alice.address);
      expect(earned).to.be.gt(0n);
    });
  });

  // ─────────────────────────────────────────────
  // earned() / rewardPerToken()
  // ─────────────────────────────────────────────
  describe("earned()", function () {
    it("returns 0 before any time passes or rate set", async function () {
      await staking.connect(alice).stake(e18(1000));
      expect(await staking.earned(alice.address)).to.equal(0n);
    });

    it("accumulates ~3.5% APR over one year", async function () {
      await staking.connect(alice).stake(e18(10000));
      await staking.updateRewardRate();
      await time.increase(YEAR);

      const earned = await staking.earned(alice.address);
      // Expected: 10000 * 3.5% = 350 pGOLD ± 1% rounding tolerance
      const expected = e18(350);
      const tolerance = e18(4); // rounding from integer division
      expect(earned).to.be.closeTo(expected, tolerance);
    });

    it("splits rewards proportionally between two stakers", async function () {
      // alice stakes 3000, bob stakes 1000 → alice gets 75%, bob 25%
      await staking.connect(alice).stake(e18(3000));
      await staking.connect(bob).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR);

      const aliceEarned = await staking.earned(alice.address);
      const bobEarned = await staking.earned(bob.address);
      const total = aliceEarned + bobEarned;

      // alice share ≈ 75%
      expect(aliceEarned * 100n / total).to.be.closeTo(75n, 1n);
      expect(bobEarned * 100n / total).to.be.closeTo(25n, 1n);
    });

    it("does NOT double-count after multiple checkpoints", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR / 4);

      // checkpoint midway
      await staking.connect(alice).stake(e18(1)); // triggers _updateReward
      const earnedMid = await staking.earned(alice.address);

      await time.increase(YEAR / 4);
      const earnedFinal = await staking.earned(alice.address);

      // earnedFinal must be strictly greater than earnedMid (new rewards accrued)
      // and must not include earnedMid twice
      expect(earnedFinal).to.be.gt(earnedMid);
      // rough upper bound: can't be more than 2× the midpoint value
      expect(earnedFinal).to.be.lt(earnedMid * 3n);
    });
  });

  // ─────────────────────────────────────────────
  // claimReward()
  // ─────────────────────────────────────────────
  describe("claimReward()", function () {
    it("mints correct reward to user and resets pending", async function () {
      await staking.connect(alice).stake(e18(10000));
      await staking.updateRewardRate();
      await time.increase(YEAR);

      const before = await pGOLD.balanceOf(alice.address);
      await staking.connect(alice).claimReward();
      const after = await pGOLD.balanceOf(alice.address);
      const claimed = after - before;

      const expected = e18(350);
      expect(claimed).to.be.closeTo(expected, e18(4));
    });

    it("increments accumulatedRewards", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR);

      await staking.connect(alice).claimReward();
      const [, , accumulated] = await staking.getStakeInfo(alice.address);
      expect(accumulated).to.be.gt(0n);
    });

    it("reverts if no reward pending", async function () {
      await staking.connect(alice).stake(e18(1000));
      await expect(staking.connect(alice).claimReward()).to.be.revertedWith("Staking: no reward");
    });

    it("can claim multiple times; second claim only gets new rewards", async function () {
      await staking.connect(alice).stake(e18(10000));
      await staking.updateRewardRate();
      await time.increase(YEAR / 2);

      const before1 = await pGOLD.balanceOf(alice.address);
      await staking.connect(alice).claimReward();
      const after1 = await pGOLD.balanceOf(alice.address);
      const claim1 = after1 - before1;

      await time.increase(YEAR / 2);
      const before2 = await pGOLD.balanceOf(alice.address);
      await staking.connect(alice).claimReward();
      const after2 = await pGOLD.balanceOf(alice.address);
      const claim2 = after2 - before2;

      // Both half-year claims should be roughly equal
      expect(claim1).to.be.closeTo(claim2, e18(5));
      // Total ≈ 350 pGOLD for 10000 staked × APR 3.5%
      expect(claim1 + claim2).to.be.closeTo(e18(350), e18(10));
    });

    it("totalRewardsDistributed tracks cumulative claims", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR);
      await staking.connect(alice).claimReward();
      expect(await staking.totalRewardsDistributed()).to.be.gt(0n);
    });
  });

  // ─────────────────────────────────────────────
  // updateRewardRate()
  // ─────────────────────────────────────────────
  describe("updateRewardRate()", function () {
    it("sets rewardRate based on current totalStaked and APR", async function () {
      await staking.connect(alice).stake(e18(10000));
      await staking.updateRewardRate();
      const rate = await staking.rewardRate();
      // Expected: 10000e18 * 350 / 10000 / 365 / 86400
      const expected = (e18(10000) * 350n) / 10000n / 365n / 86400n;
      expect(rate).to.equal(expected);
    });

    it("sets rate to 0 when nothing is staked", async function () {
      await staking.updateRewardRate();
      expect(await staking.rewardRate()).to.equal(0n);
    });

    it("checkpoints rewardPerTokenStored before changing rate", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR / 4);

      const rptBefore = await staking.rewardPerTokenStored();
      await staking.updateRewardRate();
      const rptAfter = await staking.rewardPerTokenStored();

      // rewardPerTokenStored must increase after time passes
      expect(rptAfter).to.be.gt(rptBefore);
    });

    it("rewards already earned are not lost when rate changes", async function () {
      await staking.connect(alice).stake(e18(1000));
      await staking.updateRewardRate();
      await time.increase(YEAR / 2);

      const earnedBefore = await staking.earned(alice.address);
      await staking.updateRewardRate(); // checkpoint
      const earnedAfter = await staking.earned(alice.address);

      expect(earnedAfter).to.be.closeTo(earnedBefore, e18(1));
    });
  });
});
