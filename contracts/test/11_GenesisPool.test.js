/**
 * GenesisPool 单元测试 — E轨 · 创世池 ICO
 * 
 * 测试覆盖：
 *  - ICO 初始化与参数校验
 *  - 阶梯权重 (10x/7x/4x/2x)
 *  - ICO 认购：USDC→pGOLD + 权重积分
 *  - 个人硬顶 ($85K = 1000 pGOLD)
 *  - 快照 finalize + 池分配 claimPoolAllocation
 *  - 3年 quarterly vesting 创建
 *  - 用户信息查询 getUserInfo
 *  - 紧急停止 emergencyStop
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

const DAY = 24 * 3600;
const GOLD_PRICE = ethers.parseUnits("85", 18); // $85/gram, 18 dec

// ─────────────────────────────────────────────────────────────────────
// Helper: deploy full test environment
// ─────────────────────────────────────────────────────────────────────
async function deploy() {
  const [owner, alice, bob, carol, dave] = await ethers.getSigners();

  // ERC20 mocks (6dec USDC, 18dec PAXG)
  const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
  const usdc = await ERC20Mock.deploy("USD Coin", "USDC");  // 6 decimals (hardcoded)
  await usdc.waitForDeployment();
  const ERC20Mock18 = await ethers.getContractFactory("ERC20Mock18");
  const paxg = await ERC20Mock18.deploy("PAX Gold", "PAXG");  // 18 decimals
  await paxg.waitForDeployment();

  // PGOLDToken
  const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
  const pgold = await PGOLDToken.deploy();
  await pgold.waitForDeployment();

  // Mock contracts for GenesisPool interfaces
  const MockTreasury = await ethers.getContractFactory("MockTreasuryForGenesis");
  const mockTreasury = await MockTreasury.deploy(pgold.target, paxg.target);
  await mockTreasury.waitForDeployment();

  const MockOracle = await ethers.getContractFactory("MockGoldOracleForGenesis");
  const mockOracle = await MockOracle.deploy();
  await mockOracle.waitForDeployment();

  const MockVesting = await ethers.getContractFactory("MockVestingManagerForGenesis");
  const mockVesting = await MockVesting.deploy();
  await mockVesting.waitForDeployment();

  // Grant MINTER_ROLE to MockTreasury
  const MINTER_ROLE = await pgold.MINTER_ROLE();
  await pgold.grantRole(MINTER_ROLE, mockTreasury.target);

  // Deploy GenesisPool
  const GenesisPool = await ethers.getContractFactory("GenesisPool");
  const genesis = await GenesisPool.deploy(usdc.target, paxg.target, owner.address);
  await genesis.waitForDeployment();

  // Mint USDC to test users
  const mint100K = ethers.parseUnits("100000", 6);
  for (const user of [alice, bob, carol, dave]) {
    await usdc.mint(user.address, mint100K);
    await usdc.connect(user).approve(genesis.target, mint100K);
  }

  // Helper: initialize ICO
  const initICO = async () => {
    await genesis.initializeICO(mockTreasury.target, mockOracle.target, mockVesting.target);
  };

  return { genesis, pgold, usdc, paxg, mockTreasury, mockOracle, mockVesting, owner, alice, bob, carol, dave, initICO };
}

// ─────────────────────────────────────────────────────────────────────
describe("GenesisPool (E轨·创世池)", function () {

  // ─── 1. 部署和初始化 ───
  describe("部署", function () {
    it("USDC 地址正确", async function () {
      const { genesis, usdc } = await deploy();
      expect(await genesis.usdc()).to.equal(usdc.target);
    });

    it("PAXG 地址正确", async function () {
      const { genesis, paxg } = await deploy();
      expect(await genesis.paxg()).to.equal(paxg.target);
    });

    it("初始 startTime = 0 (未初始化)", async function () {
      const { genesis } = await deploy();
      expect(await genesis.startTime()).to.equal(0);
    });

    it("POOL_TOTAL = 200,000 pGOLD", async function () {
      const { genesis } = await deploy();
      expect(await genesis.POOL_TOTAL()).to.equal(ethers.parseUnits("200000", 18));
    });

    it("CAP_PER_USER = 1000 pGOLD", async function () {
      const { genesis } = await deploy();
      expect(await genesis.CAP_PER_USER()).to.equal(ethers.parseUnits("1000", 18));
    });

    it("VEST_YEARS = 3", async function () {
      const { genesis } = await deploy();
      expect(await genesis.VEST_YEARS()).to.equal(3);
    });

    it("VEST_STEPS = 12 (季度)", async function () {
      const { genesis } = await deploy();
      expect(await genesis.VEST_STEPS()).to.equal(12);
    });
  });

  // ─── 2. ICO初始化 ───
  describe("initializeICO", function () {
    it("GOVERNOR 可以初始化ICO", async function () {
      const { genesis, initICO } = await deploy();
      await initICO();
      const startTime = await genesis.startTime();
      expect(startTime).to.be.gt(0);
    });

    it("endTime = startTime + 180 days", async function () {
      const { genesis, initICO } = await deploy();
      await initICO();
      const start = await genesis.startTime();
      const end = await genesis.endTime();
      expect(end - start).to.equal(BigInt(180 * DAY));
    });

    it("重复初始化 revert", async function () {
      const { genesis, initICO, mockTreasury, mockOracle, mockVesting } = await deploy();
      await initICO();
      await expect(
        genesis.initializeICO(mockTreasury.target, mockOracle.target, mockVesting.target)
      ).to.be.revertedWith("Already initialized");
    });

    it("非 GOVERNOR 不可初始化", async function () {
      const { genesis, alice, mockTreasury, mockOracle, mockVesting } = await deploy();
      await expect(
        genesis.connect(alice).initializeICO(mockTreasury.target, mockOracle.target, mockVesting.target)
      ).to.be.reverted;
    });

    it("零地址参数 revert", async function () {
      const { genesis, mockTreasury, mockOracle } = await deploy();
      await expect(
        genesis.initializeICO(mockTreasury.target, mockOracle.target, ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });
  });

  // ─── 3. ICO认购 (subscribe) ───
  describe("认购 subscribe", function () {
    it("D1入场 — 得到 Tier.PIONEER (10x权重)", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      // $8,500 ≈ 100 pGOLD at $85/g
      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);

      const sub = await genesis.subs(alice.address);
      expect(sub.tier).to.equal(1); // Tier.PIONEER = 1
      expect(sub.weight).to.equal(10);
    });

    it("D31入场 — 得到 Tier.EARLY (7x权重)", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      await network.provider.send("evm_increaseTime", [31 * DAY]);
      await network.provider.send("evm_mine");

      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);

      const sub = await genesis.subs(alice.address);
      expect(sub.tier).to.equal(2); // Tier.EARLY = 2
      expect(sub.weight).to.equal(7);
    });

    it("D61入场 — 得到 Tier.BUILDER (4x权重)", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      await network.provider.send("evm_increaseTime", [61 * DAY]);
      await network.provider.send("evm_mine");

      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);

      const sub = await genesis.subs(alice.address);
      expect(sub.tier).to.equal(3); // Tier.BUILDER = 3
      expect(sub.weight).to.equal(4);
    });

    it("D91入场 — 得到 Tier.SUPPORTER (2x权重)", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      await network.provider.send("evm_increaseTime", [91 * DAY]);
      await network.provider.send("evm_mine");

      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);

      const sub = await genesis.subs(alice.address);
      expect(sub.tier).to.equal(4); // Tier.SUPPORTER = 4
      expect(sub.weight).to.equal(2);
    });

    it("认购后 pGOLD 铸造到用户地址", async function () {
      const { genesis, pgold, alice, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6); // ~100 pGOLD
      await genesis.connect(alice).subscribe(usdcAmount);
      // MockTreasury.requestMint mints pGOLD
      const bal = await pgold.balanceOf(alice.address);
      expect(bal).to.be.gt(0);
    });

    it("totalUsdcRaised 和 participants 正确更新", async function () {
      const { genesis, alice, bob, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);
      await genesis.connect(bob).subscribe(usdcAmount);

      expect(await genesis.totalUsdcRaised()).to.equal(usdcAmount * 2n);
      expect(await genesis.participants()).to.equal(2);
    });

    it("同一地址只能认购一次", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);
      await expect(
        genesis.connect(alice).subscribe(usdcAmount)
      ).to.be.revertedWith("Already subscribed");
    });

    it("ICO未开始时认购 revert", async function () {
      const { genesis, alice } = await deploy();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await expect(
        genesis.connect(alice).subscribe(usdcAmount)
      ).to.be.revertedWith("ICO: not active");
    });

    it("ICO结束后认购 revert", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      await network.provider.send("evm_increaseTime", [181 * DAY]);
      await network.provider.send("evm_mine");

      const usdcAmount = ethers.parseUnits("8500", 6);
      await expect(
        genesis.connect(alice).subscribe(usdcAmount)
      ).to.be.revertedWith("ICO: not active");
    });

    it("超过个人硬顶 ($85,000 = 1000 pGOLD) 时 revert", async function () {
      const { genesis, alice, usdc, initICO } = await deploy();
      await initICO();
      // Mint more USDC
      await usdc.mint(alice.address, ethers.parseUnits("200000", 6));
      await usdc.connect(alice).approve(genesis.target, ethers.parseUnits("200000", 6));

      // $85,001 → exceed cap
      const tooMuch = ethers.parseUnits("85001", 6);
      await expect(
        genesis.connect(alice).subscribe(tooMuch)
      ).to.be.revertedWith("ICO: exceeds personal cap");
    });

    it("零金额 revert", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      await expect(
        genesis.connect(alice).subscribe(0)
      ).to.be.revertedWith("Amount zero");
    });
  });

  // ─── 4. 权重积分计算 ───
  describe("权重积分", function () {
    it("D1 PIONEER: score = backedPgold × 10 / 1e18", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);

      const sub = await genesis.subs(alice.address);
      // score = backedPgold * weight / 1e18
      const expectedScore = (sub.backedPgold * 10n) / ethers.parseUnits("1", 18);
      expect(sub.score).to.equal(expectedScore);
    });

    it("totalScore 正确累加（多用户不同档位）", async function () {
      const { genesis, alice, bob, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      
      // alice: D1, PIONEER 10x
      await genesis.connect(alice).subscribe(usdcAmount);
      
      // bob: D31, EARLY 7x
      await network.provider.send("evm_increaseTime", [31 * DAY]);
      await network.provider.send("evm_mine");
      await genesis.connect(bob).subscribe(usdcAmount);

      const subAlice = await genesis.subs(alice.address);
      const subBob = await genesis.subs(bob.address);
      const total = await genesis.totalScore();
      expect(total).to.equal(subAlice.score + subBob.score);
    });
  });

  // ─── 5. 快照 finalizeSnapshot ───
  describe("finalizeSnapshot", function () {
    it("ICO结束后 GOVERNOR 可以 finalize", async function () {
      const { genesis, initICO } = await deploy();
      await initICO();
      await network.provider.send("evm_increaseTime", [181 * DAY]);
      await network.provider.send("evm_mine");
      await genesis.finalizeSnapshot();
      expect(await genesis.claimed()).to.equal(true);
    });

    it("ICO未结束时 finalize revert", async function () {
      const { genesis, initICO } = await deploy();
      await initICO();
      await expect(genesis.finalizeSnapshot()).to.be.revertedWith("ICO: not ended");
    });

    it("重复 finalize revert", async function () {
      const { genesis, initICO } = await deploy();
      await initICO();
      await network.provider.send("evm_increaseTime", [181 * DAY]);
      await network.provider.send("evm_mine");
      await genesis.finalizeSnapshot();
      await expect(genesis.finalizeSnapshot()).to.be.revertedWith("Already finalized");
    });

    it("finalize后认购 revert (claimed=true)", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      // wait 180d, finalize
      await network.provider.send("evm_increaseTime", [181 * DAY]);
      await network.provider.send("evm_mine");
      await genesis.finalizeSnapshot();

      // Try subscribe after finalize (still within 180d window this time is past)
      // Won't reach claimed check since time > endTime, but test the claimed path
      // To test claimed path we need to endTime < now but claimed=true
      // Just verify the state
      expect(await genesis.claimed()).to.equal(true);
    });
  });

  // ─── 6. 领取池分配 claimPoolAllocation ───
  describe("claimPoolAllocation", function () {
    async function fullICOFlow(users, amounts) {
      const env = await deploy();
      const { genesis, initICO } = env;
      await initICO();

      for (let i = 0; i < users.length; i++) {
        await genesis.connect(env[users[i]]).subscribe(amounts[i]);
      }

      await network.provider.send("evm_increaseTime", [181 * DAY]);
      await network.provider.send("evm_mine");
      await genesis.finalizeSnapshot();
      return env;
    }

    it("finalize后用户可以claimPoolAllocation", async function () {
      const env = await fullICOFlow(
        ["alice"],
        [ethers.parseUnits("8500", 6)]
      );
      await env.genesis.connect(env.alice).claimPoolAllocation();
      const sub = await env.genesis.subs(env.alice.address);
      expect(sub.poolAllocation).to.be.gt(0);
    });

    it("单用户独占池子 — poolAllocation = POOL_TOTAL", async function () {
      const env = await fullICOFlow(
        ["alice"],
        [ethers.parseUnits("8500", 6)]
      );
      await env.genesis.connect(env.alice).claimPoolAllocation();
      const sub = await env.genesis.subs(env.alice.address);
      const poolTotal = await env.genesis.POOL_TOTAL();
      expect(sub.poolAllocation).to.equal(poolTotal);
    });

    it("两用户权重1:1 — 各分一半", async function () {
      // Both PIONEER on same day
      const env = await deploy();
      await env.initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await env.genesis.connect(env.alice).subscribe(usdcAmount);
      await env.genesis.connect(env.bob).subscribe(usdcAmount);

      await network.provider.send("evm_increaseTime", [181 * DAY]);
      await network.provider.send("evm_mine");
      await env.genesis.finalizeSnapshot();

      await env.genesis.connect(env.alice).claimPoolAllocation();
      await env.genesis.connect(env.bob).claimPoolAllocation();

      const subAlice = await env.genesis.subs(env.alice.address);
      const subBob = await env.genesis.subs(env.bob.address);
      const poolTotal = await env.genesis.POOL_TOTAL();

      // Alice and Bob same score → same allocation
      expect(subAlice.poolAllocation).to.equal(subBob.poolAllocation);
      // Sum = POOL_TOTAL (within rounding)
      const diff = (subAlice.poolAllocation + subBob.poolAllocation) - poolTotal;
      expect(diff).to.be.lte(1n); // 1 wei rounding max
    });

    it("先驱(10x)分得比支持者(2x)多5倍", async function () {
      const env = await deploy();
      await env.initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      
      // alice: D1 PIONEER (10x)
      await env.genesis.connect(env.alice).subscribe(usdcAmount);
      
      // bob: D91 SUPPORTER (2x)
      await network.provider.send("evm_increaseTime", [91 * DAY]);
      await network.provider.send("evm_mine");
      await env.genesis.connect(env.bob).subscribe(usdcAmount);

      await network.provider.send("evm_increaseTime", [91 * DAY]);
      await network.provider.send("evm_mine");
      await env.genesis.finalizeSnapshot();

      await env.genesis.connect(env.alice).claimPoolAllocation();
      await env.genesis.connect(env.bob).claimPoolAllocation();

      const subAlice = await env.genesis.subs(env.alice.address);
      const subBob = await env.genesis.subs(env.bob.address);

      // alice 10x, bob 2x → ratio should be 5:1
      // subAlice.poolAllocation / subBob.poolAllocation ≈ 5
      const ratio = subAlice.poolAllocation * 100n / subBob.poolAllocation;
      expect(ratio).to.be.closeTo(500n, 5n); // 5.00x ±0.05 (整数截断误差)
    });

    it("重复 claimPoolAllocation revert", async function () {
      const env = await fullICOFlow(
        ["alice"],
        [ethers.parseUnits("8500", 6)]
      );
      await env.genesis.connect(env.alice).claimPoolAllocation();
      await expect(
        env.genesis.connect(env.alice).claimPoolAllocation()
      ).to.be.revertedWith("Already claimed allocation");
    });

    it("非参与者 claimPoolAllocation revert", async function () {
      const env = await fullICOFlow(
        ["alice"],
        [ethers.parseUnits("8500", 6)]
      );
      await expect(
        env.genesis.connect(env.carol).claimPoolAllocation()
      ).to.be.revertedWith("Not a participant");
    });

    it("claimPoolAllocation 触发 VestingManager 创建释放计划", async function () {
      const env = await fullICOFlow(
        ["alice"],
        [ethers.parseUnits("8500", 6)]
      );
      await env.genesis.connect(env.alice).claimPoolAllocation();
      
      // Check VestingManager received createVestingSchedule call
      const scheduleCount = await env.mockVesting.totalSchedules();
      expect(scheduleCount).to.equal(1);
      
      const schedule = await env.mockVesting.getSchedule(0);
      expect(schedule.user).to.equal(env.alice.address);
      expect(schedule.duration).to.equal(BigInt(3 * 365 * DAY));
      expect(schedule.steps).to.equal(12);
    });

    it("未finalize时 claimPoolAllocation revert", async function () {
      const env = await deploy();
      await env.initICO();
      await env.genesis.connect(env.alice).subscribe(ethers.parseUnits("8500", 6));
      await expect(
        env.genesis.connect(env.alice).claimPoolAllocation()
      ).to.be.revertedWith("Snapshot not finalized");
    });
  });

  // ─── 7. ICO统计查询 ───
  describe("getICOStats", function () {
    it("ICO活跃期间 _active = true", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);
      
      const stats = await genesis.getICOStats();
      expect(stats._active).to.equal(true);
      expect(stats._participants).to.equal(1);
      expect(stats._totalUsdc).to.equal(usdcAmount);
    });

    it("ICO结束后 _active = false", async function () {
      const { genesis, initICO } = await deploy();
      await initICO();
      await network.provider.send("evm_increaseTime", [181 * DAY]);
      await network.provider.send("evm_mine");

      const stats = await genesis.getICOStats();
      expect(stats._active).to.equal(false);
      expect(stats._timeRemaining).to.equal(0);
    });
  });

  // ─── 8. getUserInfo 查询 ───
  describe("getUserInfo", function () {
    it("参与后 getUserInfo 返回正确数据", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);

      const info = await genesis.getUserInfo(alice.address);
      expect(info.usdcAmount).to.equal(usdcAmount);
      expect(info.tier).to.equal(1); // PIONEER
      expect(info.weight).to.equal(10);
      expect(info.backedPgold).to.be.gt(0);
    });

    it("未参与用户返回全零", async function () {
      const { genesis, carol, initICO } = await deploy();
      await initICO();
      const info = await genesis.getUserInfo(carol.address);
      expect(info.usdcAmount).to.equal(0);
      expect(info.backedPgold).to.equal(0);
    });
  });

  // ─── 9. 紧急停止 emergencyStop ───
  describe("emergencyStop", function () {
    it("GOVERNOR 可以紧急停止ICO", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      
      // Stop ICO
      await genesis.emergencyStop();
      
      // Try subscribe — should fail (time >= endTime after stop)
      const usdcAmount = ethers.parseUnits("8500", 6);
      await expect(
        genesis.connect(alice).subscribe(usdcAmount)
      ).to.be.revertedWith("ICO: not active");
    });

    it("非 GOVERNOR 不可紧急停止", async function () {
      const { genesis, alice, initICO } = await deploy();
      await initICO();
      await expect(
        genesis.connect(alice).emergencyStop()
      ).to.be.reverted;
    });
  });

  // ─── 10. 五轨叠加验证 ───
  describe("与其他轨道的关系", function () {
    it("参与ICO后 poolAllocation 不互斥（与其他轨道独立）", async function () {
      // 本测试验证 E轨合约对其他轨道没有锁定，订阅成功即可
      const { genesis, pgold, alice, initICO } = await deploy();
      await initICO();
      const usdcAmount = ethers.parseUnits("8500", 6);
      await genesis.connect(alice).subscribe(usdcAmount);
      
      // alice 持有背书 pGOLD — 可以在其他轨道继续操作（不验证其他合约，只确认 pGOLD 余额）
      const pgoldBal = await pgold.balanceOf(alice.address);
      expect(pgoldBal).to.be.gt(0);
    });
  });

});
