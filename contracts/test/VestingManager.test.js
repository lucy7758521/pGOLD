const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const e18 = (n) => ethers.parseEther(String(n));
const YEAR = 365 * 24 * 3600;
const TEN_YEARS = 10 * YEAR;

describe("VestingManager", function () {
  let pGOLD, treasury, vesting;
  let owner, alice, bob, creator;

  beforeEach(async function () {
    [owner, alice, bob, creator] = await ethers.getSigners();

    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pGOLD = await PGOLDToken.deploy();

    const MockTreasuryStaking = await ethers.getContractFactory("MockTreasuryStaking");
    treasury = await MockTreasuryStaking.deploy(await pGOLD.getAddress());

    const MINTER_ROLE = await pGOLD.MINTER_ROLE();
    await pGOLD.grantRole(MINTER_ROLE, await treasury.getAddress());

    const VestingManager = await ethers.getContractFactory("VestingManager");
    vesting = await VestingManager.deploy(
      await pGOLD.getAddress(),
      await treasury.getAddress()
    );

    // Authorize vesting to call requestMint on treasury mock
    await treasury.authorize(await vesting.getAddress());

    // Creator authorized to call createSchedule
    await vesting.setAuthorizedCreator(creator.address, true);
  });

  async function createSchedule(beneficiary, amount, duration) {
    const BURN_MINING = 0; // ScheduleType.BURN_MINING
    return vesting.connect(creator).createSchedule(beneficiary, e18(amount), duration, BURN_MINING);
  }

  // ─────────────────────────────────────────────
  // createSchedule()
  // ─────────────────────────────────────────────
  describe("createSchedule()", function () {
    it("stores schedule with correct fields", async function () {
      const tx = await createSchedule(alice.address, 1000, TEN_YEARS);
      const receipt = await tx.wait();
      const id = 0n;

      const s = await vesting.getSchedule(id);
      expect(s.totalAmount).to.equal(e18(1000));
      expect(s.claimedAmount).to.equal(0n);
      expect(s.duration).to.equal(BigInt(TEN_YEARS));
      expect(s.beneficiary).to.equal(alice.address);
      expect(s.originalBeneficiary).to.equal(alice.address);
      expect(s.exists).to.be.true;
    });

    it("assigns sequential IDs", async function () {
      await createSchedule(alice.address, 100, TEN_YEARS);
      await createSchedule(bob.address, 200, TEN_YEARS);
      expect(await vesting.nextScheduleId()).to.equal(2n);
    });

    it("reverts if caller is not an authorized creator", async function () {
      const BURN_MINING = 0;
      await expect(
        vesting.connect(alice).createSchedule(alice.address, e18(100), TEN_YEARS, BURN_MINING)
      ).to.be.revertedWith("Vesting: not authorized");
    });

    it("reverts on zero amount", async function () {
      const BURN_MINING = 0;
      await expect(
        vesting.connect(creator).createSchedule(alice.address, 0, TEN_YEARS, BURN_MINING)
      ).to.be.revertedWith("Vesting: zero amount");
    });
  });

  // ─────────────────────────────────────────────
  // getVestedAmount() / getClaimableAmount()
  // ─────────────────────────────────────────────
  describe("linear vesting math", function () {
    it("nothing vested at t=0", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      expect(await vesting.getVestedAmount(0)).to.equal(0n);
    });

    it("linearly vests at halfway point", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      await time.increase(TEN_YEARS / 2);
      const vested = await vesting.getVestedAmount(0);
      expect(vested).to.be.closeTo(e18(600), e18(1));
    });

    it("returns totalAmount after duration elapses", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await time.increase(TEN_YEARS + 1);
      expect(await vesting.getVestedAmount(0)).to.equal(e18(1000));
    });

    it("claimable decreases by claimed amount", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      await time.increase(TEN_YEARS / 2);

      const claimable = await vesting.getClaimableAmount(0);
      await vesting.connect(alice).claim(0);

      // After claiming, claimable should be near 0 (more time hasn't passed)
      expect(await vesting.getClaimableAmount(0)).to.be.closeTo(0n, e18(1));
    });
  });

  // ─────────────────────────────────────────────
  // claim()
  // ─────────────────────────────────────────────
  describe("claim()", function () {
    it("mints claimable pGOLD to beneficiary", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      await time.increase(TEN_YEARS / 2);

      const before = await pGOLD.balanceOf(alice.address);
      await vesting.connect(alice).claim(0);
      const after = await pGOLD.balanceOf(alice.address);
      const claimed = after - before;

      expect(claimed).to.be.closeTo(e18(600), e18(1));
    });

    it("increments claimedAmount in schedule", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      await time.increase(TEN_YEARS / 2);
      await vesting.connect(alice).claim(0);

      const s = await vesting.getSchedule(0);
      expect(s.claimedAmount).to.be.closeTo(e18(600), e18(1));
    });

    it("can claim in multiple installments", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      await time.increase(TEN_YEARS / 4);
      await vesting.connect(alice).claim(0); // ~300

      await time.increase(TEN_YEARS / 4);
      await vesting.connect(alice).claim(0); // ~300 more

      const s = await vesting.getSchedule(0);
      expect(s.claimedAmount).to.be.closeTo(e18(600), e18(2));
    });

    it("reverts if nothing to claim", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      await time.increase(TEN_YEARS + 1);
      await vesting.connect(alice).claim(0); // drain everything
      // Nothing left to claim
      await expect(vesting.connect(alice).claim(0)).to.be.revertedWith("Vesting: nothing to claim");
    });

    it("reverts if caller is not beneficiary", async function () {
      await createSchedule(alice.address, 1200, TEN_YEARS);
      await time.increase(TEN_YEARS / 2);
      await expect(vesting.connect(bob).claim(0)).to.be.revertedWith("Vesting: not beneficiary");
    });

    it("can claim full amount after duration", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await time.increase(TEN_YEARS + 1);
      const before = await pGOLD.balanceOf(alice.address);
      await vesting.connect(alice).claim(0);
      expect(await pGOLD.balanceOf(alice.address) - before).to.equal(e18(1000));
    });
  });

  // ─────────────────────────────────────────────
  // claimMultiple()
  // ─────────────────────────────────────────────
  describe("claimMultiple()", function () {
    it("claims from multiple schedules in one tx", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await createSchedule(alice.address, 2000, TEN_YEARS);
      await time.increase(TEN_YEARS);

      const before = await pGOLD.balanceOf(alice.address);
      await vesting.connect(alice).claimMultiple([0, 1]);
      const claimed = (await pGOLD.balanceOf(alice.address)) - before;

      expect(claimed).to.equal(e18(3000));
    });

    it("silently skips schedules where caller is not beneficiary", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await createSchedule(bob.address, 2000, TEN_YEARS);
      await time.increase(TEN_YEARS);

      const before = await pGOLD.balanceOf(alice.address);
      await vesting.connect(alice).claimMultiple([0, 1]); // id=1 belongs to bob
      const claimed = (await pGOLD.balanceOf(alice.address)) - before;

      expect(claimed).to.equal(e18(1000));
    });

    it("reverts if nothing to claim across all ids", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await time.increase(TEN_YEARS + 1);
      await vesting.connect(alice).claimMultiple([0]); // drain everything
      // Nothing left to claim
      await expect(vesting.connect(alice).claimMultiple([0])).to.be.revertedWith("Vesting: nothing to claim");
    });
  });

  // ─────────────────────────────────────────────
  // transferBeneficiary()
  // ─────────────────────────────────────────────
  describe("transferBeneficiary()", function () {
    it("transfers beneficiary to new address", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await vesting.connect(alice).transferBeneficiary(0, bob.address);

      const s = await vesting.getSchedule(0);
      expect(s.beneficiary).to.equal(bob.address);
      expect(s.originalBeneficiary).to.equal(alice.address); // unchanged
    });

    it("new beneficiary can claim, old cannot", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await vesting.connect(alice).transferBeneficiary(0, bob.address);
      await time.increase(TEN_YEARS / 2);

      await expect(vesting.connect(alice).claim(0)).to.be.revertedWith("Vesting: not beneficiary");
      await expect(vesting.connect(bob).claim(0)).to.not.be.reverted;
    });

    it("reverts if caller is not current beneficiary", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await expect(
        vesting.connect(bob).transferBeneficiary(0, bob.address)
      ).to.be.revertedWith("Vesting: not beneficiary");
    });

    it("getBeneficiarySchedules filters out transferred schedules", async function () {
      await createSchedule(alice.address, 1000, TEN_YEARS);
      await vesting.connect(alice).transferBeneficiary(0, bob.address);

      const aliceIds = await vesting.getBeneficiarySchedules(alice.address);
      expect(aliceIds.length).to.equal(0);

      const bobIds = await vesting.getBeneficiarySchedules(bob.address);
      expect(bobIds.length).to.equal(1);
    });
  });

  // ─────────────────────────────────────────────
  // createVestingSchedule() — GenesisPool compat
  // ─────────────────────────────────────────────
  describe("createVestingSchedule()", function () {
    it("creates a GENESIS_POOL schedule with custom start time", async function () {
      const now = await time.latest();
      const THREE_YEARS = 3 * YEAR;
      await vesting.connect(creator).createVestingSchedule(
        alice.address, e18(500), now, THREE_YEARS, 36
      );

      const s = await vesting.getSchedule(0);
      expect(s.totalAmount).to.equal(e18(500));
      expect(s.startTime).to.equal(BigInt(now));
      expect(s.scheduleType).to.equal(4n); // GENESIS_POOL
    });
  });
});
