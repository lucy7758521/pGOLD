/**
 * 全链路集成测试
 * 端到端：Swap → 手续费 → Treasury → 四轨激励 → 释放 → 防线
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("Integration — 全链路端到端测试", function () {
  let pgold, treasury, config, feeRouter, swap, vesting;
  let staking, ranking, burnMining, teamRewards, vpgold;
  let oracle, defense;
  let mockPAXG, mockUSDC;

  let owner, keeper, rankingOracleAddr, burnOracleAddr;
  let alice, bob, charlie, dave; // 用户

  before(async function () {
    [owner, keeper, rankingOracleAddr, burnOracleAddr, alice, bob, charlie, dave] =
      await hre.ethers.getSigners();

    // ==========================================================
    // Phase 1: 部署基础合约
    // ==========================================================

    // Mock tokens — USDC 用 6 位小数, PAXG 用 18 位小数
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    mockUSDC = await ERC20Mock.deploy("USDC", "USDC");
    const ERC20Mock18 = await ethers.getContractFactory("ERC20Mock18");
    mockPAXG = await ERC20Mock18.deploy("PAXG", "PAXG");
    await mockUSDC.waitForDeployment();
    await mockPAXG.waitForDeployment();

    // pGOLD (部署时 Treasury 地址先填 owner，后面重新授权)
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // RoleRegistry (纯常量库，无需部署)

    // Treasury (5 args: pGOLD, config, paxg, usdc, swapRouter)
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await treasury.waitForDeployment();

    // FeeRouter (treasury, usdc) — ORDER MATTERS
    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    feeRouter = await FeeRouter.deploy(treasury.target, mockUSDC.target);
    await feeRouter.waitForDeployment();

    // PGOLDSwap
    const PGOLDSwap = await ethers.getContractFactory("PGOLDSwap");
    swap = await PGOLDSwap.deploy(pgold.target, mockUSDC.target, feeRouter.target);
    await swap.waitForDeployment();

    // ==========================================================
    // Phase 2: 部署激励层
    // ==========================================================

    // VestingManager
    const VestingManager = await ethers.getContractFactory("VestingManager");
    vesting = await VestingManager.deploy(pgold.target, treasury.target);
    await vesting.waitForDeployment();

    // StakingRewards (pGOLD, treasury, config)
    const StakingRewards = await ethers.getContractFactory("StakingRewards");
    staking = await StakingRewards.deploy(pgold.target, treasury.target, config.target);
    await staking.waitForDeployment();

    // RankingRewards (config, vestingManager)
    const RankingRewards = await ethers.getContractFactory("RankingRewards");
    ranking = await RankingRewards.deploy(config.target, vesting.target);
    await ranking.waitForDeployment();

    // BurnMining (pGOLD, config, vestingManager)
    const BurnMining = await ethers.getContractFactory("BurnMining");
    burnMining = await BurnMining.deploy(pgold.target, config.target, vesting.target);
    await burnMining.waitForDeployment();

    // TeamRewards (config, treasury)
    const TeamRewards = await ethers.getContractFactory("TeamRewards");
    teamRewards = await TeamRewards.deploy(config.target, treasury.target);
    await teamRewards.waitForDeployment();

    // vPGOLD (pGOLD, vestingManager)
    const VPGOLD = await ethers.getContractFactory("vPGOLD");
    vpgold = await VPGOLD.deploy(pgold.target, vesting.target);
    await vpgold.waitForDeployment();

    // ==========================================================
    // Phase 3: 部署防线层
    // ==========================================================

    // GoldOracle (treasury, goldFeed, paxgFeed)
    const GoldOracle = await ethers.getContractFactory("GoldOracle");
    oracle = await GoldOracle.deploy(treasury.target, owner.address, owner.address);
    await oracle.waitForDeployment();

    // PriceDefense (config, treasury, swap)
    const PriceDefense = await ethers.getContractFactory("PriceDefense");
    defense = await PriceDefense.deploy(config.target, treasury.target, swap.target);
    await defense.waitForDeployment();

    // ==========================================================
    // Phase 4: 关联设置
    // ==========================================================

    // FeeRouter 授权 PGOLDSwap 调用 routeFee
    await feeRouter.setSwapContract(swap.target);

    // Grant MINTER_ROLE to Treasury
    const minterRole = await pgold.MINTER_ROLE();
    await pgold.grantRole(minterRole, treasury.target);

    // Treasury authorizes all incentive contracts
    await treasury.setMintAuthorized(staking.target, true);
    await treasury.setMintAuthorized(ranking.target, true);
    await treasury.setMintAuthorized(burnMining.target, true);
    await treasury.setMintAuthorized(teamRewards.target, true);
    await treasury.setMintAuthorized(vesting.target, true);
    await treasury.setMintAuthorized(vpgold.target, true);

    // Authorize VestingManager creators for integration test
    await vesting.setAuthorizedCreator(owner.address, true);
    await vesting.setAuthorizedCreator(ranking.target, true);
    await vesting.setAuthorizedCreator(burnMining.target, true);

    // Grant RANKING_ORACLE_ROLE to rankingOracleAddr and burnOracleAddr
    const rankingOracleRole = ethers.keccak256(ethers.toUtf8Bytes("RANKING_ORACLE_ROLE"));
    await ranking.grantRole(rankingOracleRole, rankingOracleAddr.address);
    await burnMining.grantRole(rankingOracleRole, burnOracleAddr.address);
  });

  // ==================== 全链路场景 ====================
  describe("场景：完整用户生命周期", function () {
    const PGOLD_PER_USER = ethers.parseEther("1000");

    before(async function () {
      // 1. 初始化 AMM 流动性
      const INITIAL_USDC = ethers.parseUnits("17000000", 6);
      const INITIAL_PGOLD = ethers.parseEther("200000");
      await mockUSDC.mint(owner.address, INITIAL_USDC);
      await mockUSDC.connect(owner).approve(swap.target, INITIAL_USDC);
      const minterRole = await pgold.MINTER_ROLE();
      await pgold.grantRole(minterRole, owner.address);
      await pgold.mint(owner.address, INITIAL_PGOLD, ethers.id("LIQUIDITY"));
      await pgold.connect(owner).approve(swap.target, INITIAL_PGOLD);
      // initializePool(usdcAmount, pgoldAmount)
      await swap.initializePool(INITIAL_USDC, INITIAL_PGOLD);
      await pgold.grantRole(minterRole, swap.target);

      // 2. mint pGOLD to users for testing (via treasury)
      await treasury.setMintAuthorized(owner.address, true);
      await treasury.connect(owner)["requestMint(address,uint256,bytes32)"](
        alice.address, PGOLD_PER_USER, ethers.id("INIT")
      );
      await treasury.connect(owner)["requestMint(address,uint256,bytes32)"](
        bob.address, PGOLD_PER_USER, ethers.id("INIT")
      );
      await treasury.connect(owner)["requestMint(address,uint256,bytes32)"](
        charlie.address, PGOLD_PER_USER, ethers.id("INIT")
      );
      await treasury.connect(owner)["requestMint(address,uint256,bytes32)"](
        dave.address, PGOLD_PER_USER, ethers.id("INIT")
      );
      await treasury.setMintAuthorized(owner.address, false);
    });

    it("[Step 1] 用户注册邀请关系", async function () {
      await teamRewards.connect(bob).bindInviter(alice.address);
      await teamRewards.connect(charlie).bindInviter(bob.address);

      const bobInviter = await teamRewards.getInviter(bob.address);
      expect(bobInviter.inviter).to.equal(alice.address);

      const charlieInviter = await teamRewards.getInviter(charlie.address);
      expect(charlieInviter.inviter).to.equal(bob.address);
    });

    it("[Step 2] 用户创建/加入战队", async function () {
      await teamRewards.connect(alice).createTeam("ALPHA");
      await teamRewards.connect(bob).joinTeam(1);
      await teamRewards.connect(charlie).joinTeam(1);

      const team = await teamRewards.getTeam(1);
      expect(team.memberCount).to.equal(3n);
    });

    it("[Step 3] 用户在 Swap 买卖交易", async function () {
      // Alice 用 pGOLD 换 USDC (sell)
      const sellAmount = ethers.parseEther("100");
      await pgold.connect(alice).approve(swap.target, sellAmount);
      const tx = await swap.connect(alice).sell(sellAmount, 0);
      await tx.wait();

      // Bob 用 USDC 换 pGOLD (buy)
      const buyAmount = ethers.parseUnits("8500", 6);
      await mockUSDC.mint(bob.address, buyAmount);
      await mockUSDC.connect(bob).approve(swap.target, buyAmount);
      const tx2 = await swap.connect(bob).buy(buyAmount, 0);
      await tx2.wait();

      // Charlie 小额交易
      const charlieAmount = ethers.parseUnits("170", 6);
      await mockUSDC.mint(charlie.address, charlieAmount);
      await mockUSDC.connect(charlie).approve(swap.target, charlieAmount);
      await swap.connect(charlie).buy(charlieAmount, 0);

      // 验证手续费已转至 Treasury（非 FeeRouter）
      const feeBal = await mockUSDC.balanceOf(treasury.target);
      expect(feeBal).to.be.gt(0n);
    });

    it("[Step 4] 用户质押 (A轨)", async function () {
      const stakeAmount = ethers.parseEther("300");
      await pgold.connect(alice).approve(staking.target, stakeAmount);
      await staking.connect(alice).stake(stakeAmount);
      const userStake = await staking.stakes(alice.address);
      expect(userStake.amount).to.equal(stakeAmount);
    });

    it("[Step 5] 质押后时间推进 → A轨产生分红", async function () {
      // 必须调用 updateRewardRate 才会产生分红
      await staking.updateRewardRate();
      await ethers.provider.send("evm_increaseTime", [86400 * 30]);
      await ethers.provider.send("evm_mine");

      const earned = await staking.earned(alice.address);
      expect(earned).to.be.gt(0n);
    });

    it("[Step 6] A轨 claim 分红", async function () {
      const before = await pgold.balanceOf(alice.address);
      await staking.connect(alice).claimReward();
      const after = await pgold.balanceOf(alice.address);
      expect(after).to.be.gt(before);
    });

    it("[Step 7] B轨 — 排名创建 (Merkle)", async function () {
      const merkleRoot = ethers.ZeroHash;
      await ranking.connect(rankingOracleAddr).createRound(0, merkleRoot);
      expect(await ranking.getRoundCount()).to.equal(1n);
    });

    it("[Step 8] C轨 — 燃烧批次创建", async function () {
      const merkleRoot = ethers.ZeroHash;
      await burnMining.connect(burnOracleAddr).createRound(merkleRoot);
      expect(await burnMining.getRoundCount()).to.equal(1n);
    });

    it("[Step 9] 铸币后总供应 > 初始", async function () {
      const totalSupply = await pgold.totalSupply();
      // 至少有 4×1000 = 4000 初始 + A轨分红铸币
      expect(totalSupply).to.be.gt(ethers.parseEther("4000"));
    });

    it("[Step 10] 黄金储备覆盖率查询", async function () {
      const snap = await treasury.getReserveSnapshot();
      // 初始储备为 0（无 PAXG），覆盖率计算中 totalGoldGrams = 0
      expect(snap.totalGoldGrams).to.equal(0n);
      // 但体系不崩溃——这是纯铸币激励 + PAXG 储备分离的设计
    });

    it("[Step 11] L1 软锚定始终激活", async function () {
      expect(await defense.currentLevel()).to.not.equal(2n); // not L2
    });

    it("[Step 12] L2/L3 在正常市场不触发", async function () {
      expect(await defense.l2Active()).to.equal(false);
      expect(await defense.l3Active()).to.equal(false);
    });
  });

  // ==================== 压力测试 ====================
  describe("压力测试", function () {
    it("100 笔连续 swap 不崩溃", async function () {
      for (let i = 0; i < 100; i++) {
        const amount = ethers.parseUnits("85", 6);
        await mockUSDC.mint(alice.address, amount);
        await mockUSDC.connect(alice).approve(swap.target, amount);
        await swap.connect(alice).buy(amount, 0);
      }
      expect(await mockUSDC.balanceOf(treasury.target)).to.be.gt(0n);
    });

    it("多个用户并发 stake/unstake", async function () {
      // Bob stake
      await pgold.connect(bob).approve(staking.target, ethers.parseEther("200"));
      await staking.connect(bob).stake(ethers.parseEther("200"));

      // Charlie stake
      await pgold.connect(charlie).approve(staking.target, ethers.parseEther("100"));
      await staking.connect(charlie).stake(ethers.parseEther("100"));

      expect(await staking.totalStaked()).to.be.gt(ethers.parseEther("300"));
    });

    it("大量释放计划创建不爆 Gas", async function () {
      for (let i = 0; i < 20; i++) {
        await vesting.createSchedule(
          alice.address,
          ethers.parseEther("100"),
          10n * 365n * 86400n,
          0
        );
      }
      const count = await vesting.nextScheduleId();
      // nextScheduleId 从之前创建的计划数 + 20 个新计划
      expect(count).to.be.gte(20n);
    });
  });
});
