const { expect } = require("chai");
const { ethers } = require("hardhat");

// USDC is 6 decimals
const usdc = (n) => BigInt(Math.round(Number(n) * 1e6));
const e18 = (n) => ethers.parseEther(String(n));

describe("PGOLDSwap + FeeRouter", function () {
  let pGOLD, usdcToken, paxgToken, swapRouter, feeRouter, treasury, swap;
  let owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    // Mock tokens
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    usdcToken = await ERC20Mock.deploy("USDC", "USDC"); // 6 decimals
    const ERC20Mock18 = await ethers.getContractFactory("ERC20Mock18");
    paxgToken = await ERC20Mock18.deploy("PAXG", "PAXG");

    // PGOLDToken
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pGOLD = await PGOLDToken.deploy();

    // ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    const config = await ConfigManager.deploy();

    // MockUniswapRouter
    const MockUniswapRouter = await ethers.getContractFactory("MockUniswapRouter");
    swapRouter = await MockUniswapRouter.deploy(
      await usdcToken.getAddress(),
      await paxgToken.getAddress()
    );

    // Treasury (real)
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      await pGOLD.getAddress(),
      await config.getAddress(),
      await paxgToken.getAddress(),
      await usdcToken.getAddress(),
      await swapRouter.getAddress()
    );

    // FeeRouter
    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    feeRouter = await FeeRouter.deploy(
      await treasury.getAddress(),
      await usdcToken.getAddress()
    );

    // PGOLDSwap
    const PGOLDSwap = await ethers.getContractFactory("PGOLDSwap");
    swap = await PGOLDSwap.deploy(
      await pGOLD.getAddress(),
      await usdcToken.getAddress(),
      await feeRouter.getAddress(),
      await treasury.getAddress()
    );

    // Wire FeeRouter → PGOLDSwap
    await feeRouter.setSwapContract(await swap.getAddress());

    // Mint pGOLD to owner to seed pool
    const MINTER_ROLE = await pGOLD.MINTER_ROLE();
    await pGOLD.grantRole(MINTER_ROLE, owner.address);
    await pGOLD.mint(owner.address, e18(100000), bytes32("SEED"));

    // Mint USDC to owner, alice, bob
    await usdcToken.mint(owner.address, usdc(1_000_000));
    await usdcToken.mint(alice.address, usdc(100_000));
    await usdcToken.mint(bob.address, usdc(100_000));

    // Approve swap to spend owner's tokens for pool init
    await usdcToken.approve(await swap.getAddress(), ethers.MaxUint256);
    await pGOLD.approve(await swap.getAddress(), ethers.MaxUint256);

    // Initialize pool: 85 USDC per pGOLD, 1000 USDC + ~11.76 pGOLD
    // Use round numbers: 85000 USDC, 1000 pGOLD → price ≈ $85
    await swap.initializePool(usdc(85_000), e18(1000));
  });

  function bytes32(s) {
    return ethers.encodeBytes32String(s);
  }

  // ─────────────────────────────────────────────
  // initializePool()
  // ─────────────────────────────────────────────
  describe("initializePool()", function () {
    it("sets correct reserves and k", async function () {
      const [r_usdc, r_pgold, k] = await swap.getReserves();
      expect(r_usdc).to.equal(usdc(85_000));
      expect(r_pgold).to.equal(e18(1000));
      expect(k).to.equal(usdc(85_000) * e18(1000));
    });

    it("reverts on second initialization attempt", async function () {
      await expect(
        swap.initializePool(usdc(1000), e18(10))
      ).to.be.revertedWith("Swap: already initialized");
    });
  });

  // ─────────────────────────────────────────────
  // buy()
  // ─────────────────────────────────────────────
  describe("buy()", function () {
    beforeEach(async function () {
      await usdcToken.connect(alice).approve(await swap.getAddress(), ethers.MaxUint256);
    });

    it("transfers pGOLD to buyer and USDC to pool", async function () {
      const pgoldBefore = await pGOLD.balanceOf(alice.address);
      await swap.connect(alice).buy(usdc(850), 0n, 9999999999n);
      const pgoldAfter = await pGOLD.balanceOf(alice.address);
      expect(pgoldAfter).to.be.gt(pgoldBefore);
    });

    it("collects 0.25% fee and routes to Treasury", async function () {
      const usdcIn = usdc(1000);
      const expectedFee = (usdcIn * 25n) / 10000n;

      // GOLD_RESERVE balance in treasury before
      const Account = { GOLD_RESERVE: 0 };
      const before = await treasury.getAccountBalance(Account.GOLD_RESERVE);

      await swap.connect(alice).buy(usdcIn, 0n, 9999999999n);

      const after = await treasury.getAccountBalance(Account.GOLD_RESERVE);
      // GOLD_RESERVE gets 95% of fee
      const expectedGoldReserve = (expectedFee * 9500n) / 10000n;
      expect(after - before).to.be.closeTo(expectedGoldReserve, 2n);
    });

    it("reverts if slippage too tight", async function () {
      const [pgoldOut] = await swap.getBuyQuote(usdc(100));
      await expect(
        swap.connect(alice).buy(usdc(100), pgoldOut + e18(1), 9999999999n)
      ).to.be.revertedWith("Swap: slippage");
    });

    it("increments totalSwapCount and totalFeesCollected", async function () {
      await swap.connect(alice).buy(usdc(850), 0n, 9999999999n);
      expect(await swap.totalSwapCount()).to.equal(1n);
      expect(await swap.totalFeesCollected()).to.be.gt(0n);
    });
  });

  // ─────────────────────────────────────────────
  // sell()
  // ─────────────────────────────────────────────
  describe("sell()", function () {
    beforeEach(async function () {
      // Give alice some pGOLD to sell
      await pGOLD.mint(alice.address, e18(10), bytes32("TEST"));
      await pGOLD.connect(alice).approve(await swap.getAddress(), ethers.MaxUint256);
    });

    it("transfers USDC to seller and pGOLD to pool", async function () {
      const usdcBefore = await usdcToken.balanceOf(alice.address);
      await swap.connect(alice).sell(e18(1), 0n, 9999999999n);
      const usdcAfter = await usdcToken.balanceOf(alice.address);
      expect(usdcAfter).to.be.gt(usdcBefore);
    });

    it("reverts if slippage too tight", async function () {
      const [usdcOut] = await swap.getSellQuote(e18(1));
      await expect(
        swap.connect(alice).sell(e18(1), usdcOut + usdc(1), 9999999999n)
      ).to.be.revertedWith("Swap: slippage");
    });

    it("fee goes to Treasury GOLD_RESERVE (95%)", async function () {
      const before = await treasury.getAccountBalance(0);
      await swap.connect(alice).sell(e18(5), 0n, 9999999999n);
      const after = await treasury.getAccountBalance(0);
      expect(after).to.be.gt(before);
    });
  });

  // ─────────────────────────────────────────────
  // getPrice() / quote functions
  // ─────────────────────────────────────────────
  describe("price queries", function () {
    it("getPrice returns ~$85 (8 decimals)", async function () {
      const price = await swap.getPrice();
      // 85000 USDC (6 dec) / 1000 pGOLD (18 dec) × 1e20 = 85 * 1e8
      expect(price).to.equal(85n * 10n ** 8n);
    });

    it("getBuyQuote returns positive pgoldOut and fee", async function () {
      const [pgoldOut, fee] = await swap.getBuyQuote(usdc(850));
      expect(pgoldOut).to.be.gt(0n);
      expect(fee).to.equal((usdc(850) * 25n) / 10000n);
    });

    it("getSellQuote returns positive usdcOut and fee", async function () {
      const [usdcOut, fee] = await swap.getSellQuote(e18(10));
      expect(usdcOut).to.be.gt(0n);
      expect(fee).to.be.gt(0n);
    });
  });

  // ─────────────────────────────────────────────
  // FeeRouter.calculateDistribution()
  // ─────────────────────────────────────────────
  describe("FeeRouter distribution", function () {
    it("splits 100 USDC correctly (hardcoded BPS)", async function () {
      const dist = await feeRouter.calculateDistribution(usdc(100));
      // 95 + 3 + 1.5 + 0.5 = 100
      expect(dist[0]).to.equal(usdc(95));       // GOLD_RESERVE
      expect(dist[1]).to.equal(usdc(3));         // INSURANCE
      expect(dist[2]).to.equal(usdc(1.5));       // LIQUIDITY
      expect(dist[3]).to.equal(usdc(0.5));       // EMERGENCY
    });

    it("sum of distribution equals total fee", async function () {
      const total = usdc(1234);
      const dist = await feeRouter.calculateDistribution(total);
      const sum = dist[0] + dist[1] + dist[2] + dist[3];
      // Due to integer division, sum may be <= total (dust rounding)
      expect(sum).to.be.lte(total);
      expect(total - sum).to.be.lte(3n); // max 3 wei dust
    });
  });
});
