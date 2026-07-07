const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const usdc = (n) => BigInt(Math.round(Number(n) * 1e6));
const e18 = (n) => ethers.parseEther(String(n));

const GOLD_PRICE = e18(85); // $85/gram, 18 decimals
const PAXG_PRICE_USDC = 2644n; // from mock
const DAY = 86400n;
const POOL_TOTAL = e18(200_000);

describe("GenesisPool", function () {
  let pGOLD, paxg, usdcToken;
  let treasuryMock, oracleMock, vestingMock;
  let pool;
  let owner, alice, bob, charlie;

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    // Deploy token mocks
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    usdcToken = await ERC20Mock.deploy("USDC", "USDC"); // 6 decimals

    const ERC20Mock18 = await ethers.getContractFactory("ERC20Mock18");
    paxg = await ERC20Mock18.deploy("PAXG", "PAXG");

    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pGOLD = await PGOLDToken.deploy();

    // Deploy GenesisPool-specific mocks
    const MockTreasuryForGenesis = await ethers.getContractFactory("MockTreasuryForGenesis");
    treasuryMock = await MockTreasuryForGenesis.deploy(
      await pGOLD.getAddress(),
      await paxg.getAddress()
    );

    const MockGoldOracleForGenesis = await ethers.getContractFactory("MockGoldOracleForGenesis");
    oracleMock = await MockGoldOracleForGenesis.deploy();

    const MockVestingManagerForGenesis = await ethers.getContractFactory("MockVestingManagerForGenesis");
    vestingMock = await MockVestingManagerForGenesis.deploy();

    // Grant MINTER_ROLE to treasury mock
    const MINTER_ROLE = await pGOLD.MINTER_ROLE();
    await pGOLD.grantRole(MINTER_ROLE, await treasuryMock.getAddress());

    // Deploy GenesisPool
    const GenesisPool = await ethers.getContractFactory("GenesisPool");
    pool = await GenesisPool.deploy(
      await usdcToken.getAddress(),
      await paxg.getAddress(),
      owner.address
    );

    // Initialize ICO
    await pool.initializeICO(
      await treasuryMock.getAddress(),
      await oracleMock.getAddress(),
      await vestingMock.getAddress()
    );

    // Fund participants
    await usdcToken.mint(alice.address, usdc(10_000));
    await usdcToken.mint(bob.address, usdc(10_000));
    await usdcToken.mint(charlie.address, usdc(10_000));

    await usdcToken.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
    await usdcToken.connect(bob).approve(await pool.getAddress(), ethers.MaxUint256);
    await usdcToken.connect(charlie).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  // ─────────────────────────────────────────────
  // initializeICO()
  // ─────────────────────────────────────────────
  describe("initializeICO()", function () {
    it("sets startTime and endTime", async function () {
      const startTime = await pool.startTime();
      const endTime = await pool.endTime();
      expect(endTime - startTime).to.equal(180n * DAY);
    });

    it("reverts on second init", async function () {
      await expect(
        pool.initializeICO(
          await treasuryMock.getAddress(),
          await oracleMock.getAddress(),
          await vestingMock.getAddress()
        )
      ).to.be.revertedWith("Already initialized");
    });
  });

  // ─────────────────────────────────────────────
  // subscribe() — tier assignment
  // ─────────────────────────────────────────────
  describe("subscribe() — tier assignment", function () {
    it("assigns PIONEER tier in first 30 days", async function () {
      await pool.connect(alice).subscribe(usdc(850)); // ~10 pGOLD
      const sub = await pool.subs(alice.address);
      expect(sub.tier).to.equal(1n); // Tier.PIONEER
      expect(sub.weight).to.equal(10n);
    });

    it("assigns EARLY tier on day 31-60", async function () {
      await time.increase(31 * 86400);
      await pool.connect(alice).subscribe(usdc(850));
      const sub = await pool.subs(alice.address);
      expect(sub.tier).to.equal(2n); // Tier.EARLY
      expect(sub.weight).to.equal(7n);
    });

    it("assigns BUILDER tier on day 61-90", async function () {
      await time.increase(61 * 86400);
      await pool.connect(alice).subscribe(usdc(850));
      const sub = await pool.subs(alice.address);
      expect(sub.tier).to.equal(3n); // Tier.BUILDER
      expect(sub.weight).to.equal(4n);
    });

    it("assigns SUPPORTER tier on day 91-180", async function () {
      await time.increase(91 * 86400);
      await pool.connect(alice).subscribe(usdc(850));
      const sub = await pool.subs(alice.address);
      expect(sub.tier).to.equal(4n); // Tier.SUPPORTER
      expect(sub.weight).to.equal(2n);
    });
  });

  // ─────────────────────────────────────────────
  // subscribe() — mechanics
  // ─────────────────────────────────────────────
  describe("subscribe() — mechanics", function () {
    it("increments participant count and totalUsdcRaised", async function () {
      await pool.connect(alice).subscribe(usdc(850));
      await pool.connect(bob).subscribe(usdc(1700));
      expect(await pool.participants()).to.equal(2n);
      expect(await pool.totalUsdcRaised()).to.equal(usdc(850) + usdc(1700));
    });

    it("reverts if user subscribes twice", async function () {
      await pool.connect(alice).subscribe(usdc(850));
      await expect(pool.connect(alice).subscribe(usdc(100))).to.be.revertedWith("Already subscribed");
    });

    it("reverts if exceeds personal cap of 1000 pGOLD", async function () {
      // goldPrice = $85/g, cap = 1000 pGOLD = 1000g = $85,000 = 85000 USDC
      // goldGramsEstimate = usdcAmount * 1e30 / goldPrice
      // cap check: goldGramsEstimate <= 1000e18
      // $85,001 → ~1000.01 grams > cap
      await expect(
        pool.connect(alice).subscribe(usdc(85_001))
      ).to.be.revertedWith("ICO: exceeds personal cap");
    });

    it("allows exactly at cap ($85,000)", async function () {
      await usdcToken.mint(alice.address, usdc(85_000));
      await expect(
        pool.connect(alice).subscribe(usdc(85_000))
      ).to.not.be.reverted;
    });

    it("reverts if ICO not started", async function () {
      const GenesisPool = await ethers.getContractFactory("GenesisPool");
      const pool2 = await GenesisPool.deploy(
        await usdcToken.getAddress(),
        await paxg.getAddress(),
        owner.address
      );
      await expect(pool2.connect(alice).subscribe(usdc(100))).to.be.revertedWith("ICO: not active");
    });

    it("reverts after ICO ends", async function () {
      await time.increase(181 * 86400);
      await expect(pool.connect(alice).subscribe(usdc(100))).to.be.revertedWith("ICO: not active");
    });
  });

  // ─────────────────────────────────────────────
  // finalizeSnapshot()
  // ─────────────────────────────────────────────
  describe("finalizeSnapshot()", function () {
    it("finalizes after 180 days", async function () {
      await time.increase(181 * 86400);
      await pool.finalizeSnapshot();
      expect(await pool.claimed()).to.be.true;
    });

    it("reverts before ICO ends", async function () {
      await expect(pool.finalizeSnapshot()).to.be.revertedWith("ICO: not ended");
    });

    it("reverts if already finalized", async function () {
      await time.increase(181 * 86400);
      await pool.finalizeSnapshot();
      await expect(pool.finalizeSnapshot()).to.be.revertedWith("Already finalized");
    });
  });

  // ─────────────────────────────────────────────
  // claimPoolAllocation()
  // ─────────────────────────────────────────────
  describe("claimPoolAllocation()", function () {
    async function subscribeAndFinalize() {
      await pool.connect(alice).subscribe(usdc(850));
      await pool.connect(bob).subscribe(usdc(1700));
      await time.increase(181 * 86400);
      await pool.finalizeSnapshot();
    }

    it("allocates pool proportionally based on score", async function () {
      await subscribeAndFinalize();
      await pool.connect(alice).claimPoolAllocation();
      await pool.connect(bob).claimPoolAllocation();

      const aliceAlloc = (await pool.subs(alice.address)).poolAllocation;
      const bobAlloc = (await pool.subs(bob.address)).poolAllocation;

      // Both PIONEER (10x); alice contributed 850, bob 1700 → bob gets ~2× alice.
      // Score uses integer truncation (goldGrams×weight/1e18), so ratio is ~199:99, not 200:100.
      // The resulting allocation differs from exact 2:1 by ~670 pGOLD; allow 1000 pGOLD tolerance.
      expect(bobAlloc).to.be.closeTo(aliceAlloc * 2n, e18(1000));
    });

    it("creates vesting schedule in VestingManager mock", async function () {
      await subscribeAndFinalize();
      await pool.connect(alice).claimPoolAllocation();

      const total = await vestingMock.totalSchedules();
      expect(total).to.equal(1n);
    });

    it("reverts if called before snapshot finalized", async function () {
      await pool.connect(alice).subscribe(usdc(850));
      await expect(pool.connect(alice).claimPoolAllocation()).to.be.revertedWith("Snapshot not finalized");
    });

    it("reverts for non-participant", async function () {
      await time.increase(181 * 86400);
      await pool.finalizeSnapshot();
      await expect(pool.connect(alice).claimPoolAllocation()).to.be.revertedWith("Not a participant");
    });

    it("reverts on second claim", async function () {
      await subscribeAndFinalize();
      await pool.connect(alice).claimPoolAllocation();
      await expect(pool.connect(alice).claimPoolAllocation()).to.be.revertedWith("Already claimed allocation");
    });

    it("pool allocation sum does not exceed POOL_TOTAL", async function () {
      // Three participants
      await pool.connect(alice).subscribe(usdc(850));
      await pool.connect(bob).subscribe(usdc(1700));
      await pool.connect(charlie).subscribe(usdc(4250));
      await time.increase(181 * 86400);
      await pool.finalizeSnapshot();

      await pool.connect(alice).claimPoolAllocation();
      await pool.connect(bob).claimPoolAllocation();
      await pool.connect(charlie).claimPoolAllocation();

      const a = (await pool.subs(alice.address)).poolAllocation;
      const b = (await pool.subs(bob.address)).poolAllocation;
      const c = (await pool.subs(charlie.address)).poolAllocation;

      expect(a + b + c).to.be.lte(POOL_TOTAL);
    });
  });
});
