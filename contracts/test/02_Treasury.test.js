/**
 * Treasury 单元测试
 * 覆盖：五账户/PAXG储备/铸币授权/L2赎回/储备快照/账户余额查询
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("Treasury", function () {
  let treasury, pgold, config, mockPAXG, mockUSDC;
  let owner, alice, bob, keeper;

  before(async function () {
    [owner, alice, bob, keeper] = await hre.ethers.getSigners();

    // deploy mock ERC20 tokens (PAXG + USDC)
    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC = await MockERC20.deploy("USDC", "USDC");
    await mockPAXG.waitForDeployment();
    await mockUSDC.waitForDeployment();

    // deploy pGOLD
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    pgold = await PGOLDToken.deploy();
    await pgold.waitForDeployment();

    // deploy ConfigManager
    const ConfigManager = await ethers.getContractFactory("ConfigManager");
    config = await ConfigManager.deploy();
    await config.waitForDeployment();

    // deploy Treasury (5 constructor args)
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target,
      config.target,
      mockPAXG.target,
      mockUSDC.target,
      owner.address // mock swapRouter for unit tests
    );
    await treasury.waitForDeployment();

    // set Treasury as minter on pGOLD
    const minterRole = await pgold.MINTER_ROLE();
    await pgold.grantRole(minterRole, treasury.target);
  });

  // ==================== 部署 ====================
  describe("部署", function () {
    it("pGOLD 地址正确", async function () {
      expect(await treasury.pGOLD()).to.equal(pgold.target);
    });

    it("PAXG 地址正确", async function () {
      expect(await treasury.PAXG()).to.equal(mockPAXG.target);
    });

    it("USDC 地址正确", async function () {
      expect(await treasury.USDC()).to.equal(mockUSDC.target);
    });

    it("PAXG_GRAMS_PER_OUNCE = 311035 (×10000精度)", async function () {
      expect(await treasury.PAXG_GRAMS_PER_OUNCE()).to.equal(311035n);
    });

    it("初始四账户余额为 0", async function () {
      const balances = await treasury.getAllAccountBalances();
      // returns (uint256[4], string[4])
      for (const b of balances[0]) {
        expect(b).to.equal(0n);
      }
    });
  });

  // ==================== 账户管理 ====================
  describe("账户余额", function () {
    it("getAllAccountBalances 返回4个余额", async function () {
      const [balances, labels] = await treasury.getAllAccountBalances();
      expect(balances.length).to.equal(4);
      expect(labels.length).to.equal(4);
    });

    it("getAccountBalance(0) GOLD_RESERVE 查询正确", async function () {
      // 通过 receiveFees 正确分配 USDC（accountBalances 仅通过 receiveFees 更新）
      const U6 = (v) => ethers.parseUnits(v, 6);
      const distribution = [
        U6("9500"), U6("300"), U6("150"), U6("50"),
      ];
      await treasury.receiveFees(distribution);
      const bal = await treasury.getAccountBalance(0);
      expect(bal).to.equal(U6("9500"));
    });
  });

  // ==================== 铸币授权 ====================
  describe("铸币白名单", function () {
    it("TREASURER_ROLE 可授权 mint", async function () {
      // owner has TREASURER_ROLE from deployment
      await treasury.setMintAuthorized(alice.address, true);
      // mintAuthorized is private, no getter — trust the tx succeeded
    });

    it("授权后地址可调用 requestMint", async function () {
      await treasury.setMintAuthorized(alice.address, true);

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [alice.address],
      });
      await owner.sendTransaction({
        to: alice.address,
        value: ethers.parseEther("1"),
      });

      const signer = await ethers.getSigner(alice.address);
      await treasury.connect(signer)["requestMint(address,uint256,bytes32)"](
        bob.address,
        ethers.parseEther("500"),
        ethers.encodeBytes32String("TEST")
      );
      expect(await pgold.balanceOf(bob.address)).to.equal(ethers.parseEther("500"));

      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [alice.address],
      });
    });

    it("未授权地址调用 requestMint 失败", async function () {
      await expect(
        treasury.connect(bob)["requestMint(address,uint256,bytes32)"](
          bob.address,
          ethers.parseEther("100"),
          ethers.encodeBytes32String("TEST")
        )
      ).to.be.revertedWith("Treasury: not authorized");
    });

    it("可取消铸币授权", async function () {
      await treasury.setMintAuthorized(alice.address, false);
      // Verify by trying to mint — should fail
      await expect(
        treasury.connect(alice)["requestMint(address,uint256,bytes32)"](
          bob.address,
          ethers.parseEther("100"),
          ethers.encodeBytes32String("TEST")
        )
      ).to.be.reverted;
    });
  });

  // ==================== PAXG 储备查询 ====================
  describe("PAXG 储备查询", function () {
    it("初始 PAXG 余额为 0", async function () {
      expect(await mockPAXG.balanceOf(treasury.target)).to.equal(0n);
    });

    it("getTotalGoldGrams 返回 PAXG 折合的黄金克数", async function () {
      await mockPAXG.mint(treasury.target, ethers.parseUnits("100", 18));
      const grams = await treasury.getTotalGoldGrams();
      // 100 PAXG oz × 311035 / 10000 = 3110.35 grams
      expect(grams).to.equal(100n * 311035n / 10000n);
    });
  });

  // ==================== 储备快照 ====================
  describe("储备快照", function () {
    it("getReserveSnapshot 返回快照结构", async function () {
      const snap = await treasury.getReserveSnapshot();
      expect(snap.totalGoldGrams).to.equal(await treasury.getTotalGoldGrams());
      expect(snap.pGOLDSupply).to.equal(await pgold.totalSupply());
    });
  });

  // ==================== L2 条件赎回 ====================
  describe("赎回白名单 (需 GOVERNOR_ROLE)", function () {
    it("GOVERNOR_ROLE 可设置赎回白名单", async function () {
      // owner has GOVERNOR_ROLE from deployment... wait, does owner get GOVERNOR_ROLE?
      // Actually Treasury grants TREASURER_ROLE to deployer, not GOVERNOR_ROLE
      // Let's check: treasury.setRedemptionWhitelist needs GOVERNOR_ROLE
      // We need to grant GOVERNOR_ROLE to owner
      const governorRole = ethers.keccak256(ethers.toUtf8Bytes("GOVERNOR_ROLE"));
      // Check if owner has it — if not, grant it via DEFAULT_ADMIN_ROLE
      if (!await treasury.hasRole(governorRole, owner.address)) {
        // Treasury deployer only gets TREASURER_ROLE, need to grant GOVERNOR_ROLE
        // But deployer IS DEFAULT_ADMIN_ROLE
        await treasury.grantRole(governorRole, owner.address);
      }
      await treasury.setRedemptionWhitelist(alice.address, true);
      expect(await treasury.redemptionWhitelist(alice.address)).to.equal(true);
    });

    it("白名单用户可由 GOVERNOR 赎回 PAXG", async function () {
      await mockPAXG.mint(treasury.target, ethers.parseUnits("100", 18));
      await treasury.redeemPAXG(alice.address, ethers.parseUnits("10", 18));
      expect(await mockPAXG.balanceOf(alice.address)).to.equal(ethers.parseUnits("10", 18));
    });

    it("非白名单用户赎回失败", async function () {
      // redeemPAXG requires GOVERNOR_ROLE AND whitelist — the revert will be whitelist check
      // But actually GOVERNOR_ROLE check comes first. We already have GOVERNOR_ROLE from above.
      // The whitelist check is: require(redemptionWhitelist[to], "Treasury: not in redeem whitelist");
      await expect(
        treasury.redeemPAXG(bob.address, ethers.parseUnits("1", 18))
      ).to.be.revertedWith("Treasury: not whitelisted");
    });
  });

  // ==================== 权限 ====================
  describe("权限控制", function () {
    it("setMintAuthorized 仅 TREASURER_ROLE", async function () {
      await expect(
        treasury.connect(alice).setMintAuthorized(alice.address, true)
      ).to.be.reverted;
    });

    it("setRedemptionWhitelist 仅 GOVERNOR_ROLE", async function () {
      await expect(
        treasury.connect(alice).setRedemptionWhitelist(bob.address, true)
      ).to.be.reverted;
    });
  });
});
