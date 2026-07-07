const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const e18 = (n) => ethers.parseEther(String(n));
const YEAR = 365 * 24 * 3600;
const TEN_YEARS = 10 * YEAR;
const MIN_STAKE = e18(100);

function buildBurnLeaf(user, loss) {
  return Buffer.from(
    ethers.solidityPackedKeccak256(["address", "uint256"], [user, loss]).slice(2),
    "hex"
  );
}

describe("BurnMining", function () {
  let pGOLD, config, vesting, burnMining, treasury;
  let owner, alice, bob, oracle;

  beforeEach(async function () {
    [owner, alice, bob, oracle] = await ethers.getSigners();

    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pGOLD = await PGOLDToken.deploy();

    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();

    const MockTreasuryStaking = await ethers.getContractFactory("MockTreasuryStaking");
    treasury = await MockTreasuryStaking.deploy(await pGOLD.getAddress());

    const MINTER_ROLE = await pGOLD.MINTER_ROLE();
    await pGOLD.grantRole(MINTER_ROLE, await treasury.getAddress());

    const VestingManager = await ethers.getContractFactory("VestingManager");
    vesting = await VestingManager.deploy(
      await pGOLD.getAddress(),
      await treasury.getAddress()
    );
    await treasury.authorize(await vesting.getAddress());

    const BurnMining = await ethers.getContractFactory("BurnMining");
    burnMining = await BurnMining.deploy(
      await pGOLD.getAddress(),
      await config.getAddress(),
      await vesting.getAddress()
    );

    // Authorize BurnMining to create vesting schedules
    await vesting.setAuthorizedCreator(await burnMining.getAddress(), true);

    // Grant oracle role
    const RANKING_ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RANKING_ORACLE_ROLE"));
    await burnMining.grantRole(RANKING_ORACLE_ROLE, oracle.address);

    // Fund alice and bob with pGOLD for staking
    await treasury.directMint(alice.address, e18(10000));
    await treasury.directMint(bob.address, e18(10000));
    await pGOLD.connect(alice).approve(await burnMining.getAddress(), ethers.MaxUint256);
    await pGOLD.connect(bob).approve(await burnMining.getAddress(), ethers.MaxUint256);
  });

  // ─────────────────────────────────────────────
  // lockStake()
  // ─────────────────────────────────────────────
  describe("lockStake()", function () {
    it("locks pGOLD and records burn stake", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      const [amount, , active] = await burnMining.getBurnStake(alice.address);
      expect(amount).to.equal(MIN_STAKE);
      expect(active).to.be.true;
    });

    it("sets lockUntil = now + burnMinHoldingDays", async function () {
      const before = await time.latest();
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      const [, lockUntil] = await burnMining.getBurnStake(alice.address);
      // burnMinHoldingDays = 30
      expect(lockUntil).to.be.closeTo(BigInt(before) + 30n * 86400n, 5n);
    });

    it("reverts below minimum 100 pGOLD", async function () {
      await expect(
        burnMining.connect(alice).lockStake(e18(99))
      ).to.be.revertedWith("Burn: below minimum");
    });

    it("reverts if already active", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      await expect(
        burnMining.connect(alice).lockStake(MIN_STAKE)
      ).to.be.revertedWith("Burn: already active");
    });
  });

  // ─────────────────────────────────────────────
  // addStake()
  // ─────────────────────────────────────────────
  describe("addStake()", function () {
    it("increases staked amount", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      await burnMining.connect(alice).addStake(e18(200));
      const [amount] = await burnMining.getBurnStake(alice.address);
      expect(amount).to.equal(MIN_STAKE + e18(200));
    });

    it("reverts if stake not active", async function () {
      await expect(
        burnMining.connect(alice).addStake(e18(100))
      ).to.be.revertedWith("Burn: not active");
    });
  });

  // ─────────────────────────────────────────────
  // withdrawStake()
  // ─────────────────────────────────────────────
  describe("withdrawStake()", function () {
    it("returns pGOLD after lock expires", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      await time.increase(30 * 86400 + 1);

      const before = await pGOLD.balanceOf(alice.address);
      await burnMining.connect(alice).withdrawStake();
      const after = await pGOLD.balanceOf(alice.address);
      expect(after - before).to.equal(MIN_STAKE);
    });

    it("reverts before lock expires", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      await expect(burnMining.connect(alice).withdrawStake()).to.be.revertedWith("Burn: still locked");
    });
  });

  // ─────────────────────────────────────────────
  // createRound() / claimCompensation()
  // ─────────────────────────────────────────────
  describe("claimCompensation()", function () {
    it("creates vesting schedule for valid proof", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);

      const loss = e18(100); // 100 pGOLD fee loss
      const leaf = buildBurnLeaf(alice.address, loss);
      const tree = new MerkleTree([leaf], keccak256, { sortPairs: true });
      const root = tree.getHexRoot();

      await burnMining.connect(oracle).createRound(root);
      const proof = tree.getHexProof(leaf);

      const tx = await burnMining.connect(alice).claimCompensation(0, loss, proof);
      const receipt = await tx.wait();

      const evt = receipt.logs
        .map((log) => { try { return burnMining.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === "CompensationClaimed");

      // compensation = loss * 1000 / 100 = 10× loss
      expect(evt.args.compensation).to.equal(loss * 10n);
    });

    it("reverts if user has no active stake", async function () {
      const loss = e18(100);
      const leaf = buildBurnLeaf(alice.address, loss);
      const tree = new MerkleTree([leaf], keccak256, { sortPairs: true });
      const root = tree.getHexRoot();
      await burnMining.connect(oracle).createRound(root);
      const proof = tree.getHexProof(leaf);

      await expect(
        burnMining.connect(alice).claimCompensation(0, loss, proof)
      ).to.be.revertedWith("Burn: no active stake");
    });

    it("reverts on double-claim", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      const loss = e18(50);
      const leaf = buildBurnLeaf(alice.address, loss);
      const tree = new MerkleTree([leaf], keccak256, { sortPairs: true });
      await burnMining.connect(oracle).createRound(tree.getHexRoot());
      const proof = tree.getHexProof(leaf);

      await burnMining.connect(alice).claimCompensation(0, loss, proof);
      await expect(
        burnMining.connect(alice).claimCompensation(0, loss, proof)
      ).to.be.revertedWith("Burn: already claimed");
    });

    it("reverts on invalid Merkle proof", async function () {
      await burnMining.connect(alice).lockStake(MIN_STAKE);
      const loss = e18(100);
      const leaf = buildBurnLeaf(alice.address, loss);
      const tree = new MerkleTree([leaf], keccak256, { sortPairs: true });
      await burnMining.connect(oracle).createRound(tree.getHexRoot());

      const badProof = [ethers.hexlify(ethers.randomBytes(32))];
      await expect(
        burnMining.connect(alice).claimCompensation(0, loss, badProof)
      ).to.be.revertedWith("Burn: invalid proof");
    });

    it("enforces per-round cap", async function () {
      // Set very small cap
      await burnMining.setCompensationCaps(e18(1), ethers.MaxUint256);
      await burnMining.connect(alice).lockStake(MIN_STAKE);

      // loss of 1 pGOLD → compensation = 10 pGOLD > cap of 1 pGOLD
      const loss = e18(1);
      const leaf = buildBurnLeaf(alice.address, loss);
      const tree = new MerkleTree([leaf], keccak256, { sortPairs: true });
      await burnMining.connect(oracle).createRound(tree.getHexRoot());
      const proof = tree.getHexProof(leaf);

      await expect(
        burnMining.connect(alice).claimCompensation(0, loss, proof)
      ).to.be.revertedWith("Burn: round cap exceeded");
    });
  });
});
