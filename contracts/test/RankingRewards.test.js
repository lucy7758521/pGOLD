const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const e18 = (n) => ethers.parseEther(String(n));

// Build a Merkle leaf matching the Solidity leaf encoding
function buildLeaf(user, rank, stakeAmount, isAbsorbed, absorbingRoundId) {
  return Buffer.from(
    ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "bool", "uint256"],
      [user, rank, stakeAmount, isAbsorbed, absorbingRoundId]
    ).slice(2),
    "hex"
  );
}

describe("RankingRewards", function () {
  let pGOLD, treasury, config, vesting, ranking;
  let owner, alice, bob, oracle;

  beforeEach(async function () {
    [owner, alice, bob, oracle] = await ethers.getSigners();

    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();

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
    await treasury.authorize(await vesting.getAddress());

    const RankingRewards = await ethers.getContractFactory("RankingRewards");
    ranking = await RankingRewards.deploy(
      await config.getAddress(),
      await vesting.getAddress()
    );

    // Authorize RankingRewards to create vesting schedules
    await vesting.setAuthorizedCreator(await ranking.getAddress(), true);

    // Grant oracle role to `oracle` signer
    const RANKING_ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RANKING_ORACLE_ROLE"));
    await ranking.grantRole(RANKING_ORACLE_ROLE, oracle.address);
  });

  // helper: build a tree with a single leaf for `user`
  function singleLeafTree(user, rank, stakeAmount, isAbsorbed, absorbingRoundId) {
    const leaf = buildLeaf(user, rank, stakeAmount, isAbsorbed, absorbingRoundId);
    const tree = new MerkleTree([leaf], keccak256, { sortPairs: true });
    return { tree, leaf };
  }

  // ─────────────────────────────────────────────
  // depositStake() / withdrawStake()
  // ─────────────────────────────────────────────
  describe("depositStake() / withdrawStake()", function () {
    it("records stake and increments totalStaked", async function () {
      await ranking.connect(alice).depositStake(e18(500));
      const [amt, active] = await ranking.getStake(alice.address);
      expect(amt).to.equal(e18(500));
      expect(active).to.be.true;
      expect(await ranking.totalStaked()).to.equal(e18(500));
    });

    it("withdrawStake reduces amount", async function () {
      await ranking.connect(alice).depositStake(e18(500));
      await ranking.connect(alice).withdrawStake(e18(200));
      const [amt] = await ranking.getStake(alice.address);
      expect(amt).to.equal(e18(300));
    });

    it("sets active=false when fully withdrawn", async function () {
      await ranking.connect(alice).depositStake(e18(100));
      await ranking.connect(alice).withdrawStake(e18(100));
      const [, active] = await ranking.getStake(alice.address);
      expect(active).to.be.false;
    });

    it("reverts on zero deposit", async function () {
      await expect(ranking.connect(alice).depositStake(0)).to.be.revertedWith("Rank: zero");
    });

    it("reverts withdrawing more than staked", async function () {
      await ranking.connect(alice).depositStake(e18(100));
      await expect(ranking.connect(alice).withdrawStake(e18(200))).to.be.revertedWith("Rank: insufficient");
    });
  });

  // ─────────────────────────────────────────────
  // createRound()
  // ─────────────────────────────────────────────
  describe("createRound()", function () {
    it("creates round with correct multiplier for MONTHLY (300)", async function () {
      const root = ethers.hexlify(ethers.randomBytes(32));
      await ranking.connect(oracle).createRound(0 /* MONTHLY */, root);
      const round = await ranking.getRound(0);
      expect(round.multiplier).to.equal(300n);
      expect(round.merkleRoot).to.equal(root);
    });

    it("multiplier 500 for QUARTERLY, 1000 for ANNUAL", async function () {
      const root = ethers.hexlify(ethers.randomBytes(32));
      await ranking.connect(oracle).createRound(1 /* QUARTERLY */, root);
      await ranking.connect(oracle).createRound(2 /* ANNUAL */, root);
      expect((await ranking.getRound(0)).multiplier).to.equal(500n);
      expect((await ranking.getRound(1)).multiplier).to.equal(1000n);
    });

    it("reverts if called by non-oracle", async function () {
      const root = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        ranking.connect(alice).createRound(0, root)
      ).to.be.reverted;
    });
  });

  // ─────────────────────────────────────────────
  // claimReward() — happy path
  // ─────────────────────────────────────────────
  describe("claimReward()", function () {
    it("creates vesting schedule for valid proof (MONTHLY)", async function () {
      const stakeAmount = e18(1000);
      const rank = 1n;
      const { tree, leaf } = singleLeafTree(alice.address, rank, stakeAmount, false, 0n);
      const root = tree.getHexRoot();

      await ranking.connect(oracle).createRound(0 /* MONTHLY */, root);

      const proof = tree.getHexProof(leaf);

      const tx = await ranking.connect(alice).claimReward(
        0, rank, stakeAmount, false, 0n, proof
      );
      const receipt = await tx.wait();

      // vestingId returned via event
      const evt = receipt.logs
        .map((log) => { try { return ranking.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === "RewardClaimed");
      expect(evt).to.not.be.undefined;

      // reward = stakeAmount * 300 / 100 = 3000 pGOLD
      expect(evt.args.totalReward).to.equal(e18(3000));
    });

    it("reward is 0 and no vesting schedule for isAbsorbed=true", async function () {
      const stakeAmount = e18(1000);
      const rank = 1n;
      const { tree, leaf } = singleLeafTree(alice.address, rank, stakeAmount, true, 1n);
      const root = tree.getHexRoot();

      await ranking.connect(oracle).createRound(0 /* MONTHLY */, root);
      const proof = tree.getHexProof(leaf);

      const tx = await ranking.connect(alice).claimReward(0, rank, stakeAmount, true, 1n, proof);
      const receipt = await tx.wait();
      const evt = receipt.logs
        .map((log) => { try { return ranking.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === "RewardClaimed");
      expect(evt.args.totalReward).to.equal(0n);
    });

    it("reverts on invalid Merkle proof", async function () {
      const stakeAmount = e18(1000);
      const { tree, leaf } = singleLeafTree(alice.address, 1n, stakeAmount, false, 0n);
      const root = tree.getHexRoot();
      await ranking.connect(oracle).createRound(0, root);

      // Tampered proof
      const badProof = [ethers.hexlify(ethers.randomBytes(32))];
      await expect(
        ranking.connect(alice).claimReward(0, 1n, stakeAmount, false, 0n, badProof)
      ).to.be.revertedWith("Rank: invalid proof");
    });

    it("reverts on double-claim", async function () {
      const stakeAmount = e18(1000);
      const { tree, leaf } = singleLeafTree(alice.address, 1n, stakeAmount, false, 0n);
      const root = tree.getHexRoot();
      await ranking.connect(oracle).createRound(0, root);
      const proof = tree.getHexProof(leaf);

      await ranking.connect(alice).claimReward(0, 1n, stakeAmount, false, 0n, proof);
      await expect(
        ranking.connect(alice).claimReward(0, 1n, stakeAmount, false, 0n, proof)
      ).to.be.revertedWith("Rank: already claimed");
    });

    it("two users can independently claim from the same round", async function () {
      const aliceStake = e18(1000);
      const bobStake = e18(2000);

      const aliceLeaf = buildLeaf(alice.address, 1n, aliceStake, false, 0n);
      const bobLeaf = buildLeaf(bob.address, 2n, bobStake, false, 0n);
      const tree = new MerkleTree([aliceLeaf, bobLeaf], keccak256, { sortPairs: true });
      const root = tree.getHexRoot();

      await ranking.connect(oracle).createRound(0 /* MONTHLY */, root);

      const aliceProof = tree.getHexProof(aliceLeaf);
      const bobProof = tree.getHexProof(bobLeaf);

      await ranking.connect(alice).claimReward(0, 1n, aliceStake, false, 0n, aliceProof);
      await ranking.connect(bob).claimReward(0, 2n, bobStake, false, 0n, bobProof);

      expect(await ranking.claimed(alice.address, 0)).to.be.true;
      expect(await ranking.claimed(bob.address, 0)).to.be.true;
    });
  });
});
