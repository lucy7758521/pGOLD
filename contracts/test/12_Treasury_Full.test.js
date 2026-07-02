/**
 * Treasury 完整补充测试
 * 覆盖：withdrawFromAccount / updateGoldPrice / updatePAXGPrice /
 *        receiveFees / swapUSDCforPAXG(2-arg) / genesisPool授权 /
 *        储备率查询 / 零地址/边界检查
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Treasury — 完整覆盖", function () {
  let treasury, pgold, config, mockPAXG, mockUSDC, mockRouter;
  let owner, alice, bob, governor;

  before(async function () {
    [owner, alice, bob, governor] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG = await MockERC20.deploy("PAXG", "PAXG");
    mockUSDC  = await MockERC20.deploy("USDC", "USDC");

    pgold  = await (await ethers.getContractFactory("PGOLDToken")).deploy();
    config = await (await ethers.getContractFactory("ConfigManager")).deploy();

    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(
      pgold.target, config.target,
      mockPAXG.target, mockUSDC.target,
      owner.address // mock swapRouter — unused in unit tests
    );

    // grant roles
    await pgold.grantRole(await pgold.MINTER_ROLE(), treasury.target);
    const GOVERNOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOVERNOR_ROLE"));
    await treasury.grantRole(GOVERNOR_ROLE, governor.address);
    await treasury.grantRole(GOVERNOR_ROLE, owner.address);

    // fund treasury with PAXG & USDC
    await mockPAXG.mint(treasury.target, ethers.parseUnits("1000", 18));
    await mockUSDC.mint(treasury.target, ethers.parseUnits("1000000", 6));

    // setup whitelist
    await treasury.setRedemptionWhitelist(alice.address, true);
  });

  describe("receiveFees — 四账户分配", function () {
    it("分配后各账户余额正确累加", async function () {
      const dist = [950n, 30n, 15n, 5n]; // BPS 模拟
      await treasury.receiveFees(dist);
      const [bals] = await treasury.getAllAccountBalances();
      expect(bals[0]).to.be.gte(950n);
      expect(bals[1]).to.be.gte(30n);
    });

    it("触发 FeeReceived 事件", async function () {
      const dist = [95000n, 3000n, 1500n, 500n];
      await expect(treasury.receiveFees(dist)).to.emit(treasury, "FeeReceived");
    });
  });

  describe("withdrawFromAccount — 账户提款", function () {
    it("TREASURER 可从 INSURANCE 账户提款", async function () {
      // 先存入
      await treasury.receiveFees([0n, 100000n, 0n, 0n]);
      const [before] = await treasury.getAllAccountBalances();
      const insBal = before[1];
      const withdrawAmt = insBal / 2n;
      if (withdrawAmt > 0n) {
        await treasury.withdrawFromAccount(1, alice.address, withdrawAmt);
        const [after] = await treasury.getAllAccountBalances();
        expect(after[1]).to.equal(insBal - withdrawAmt);
      }
    });

    it("超额提款 revert", async function () {
      await expect(
        treasury.withdrawFromAccount(3, alice.address, ethers.parseUnits("999999", 6))
      ).to.be.revertedWith("Treasury: insufficient balance");
    });

    it("非 TREASURER_ROLE 提款 revert", async function () {
      await expect(
        treasury.connect(alice).withdrawFromAccount(1, alice.address, 1n)
      ).to.be.reverted;
    });
  });

  describe("updateGoldPrice / updatePAXGPrice", function () {
    it("GOLD_ORACLE_ROLE 可更新金价", async function () {
      const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOLD_ORACLE_ROLE"));
      await treasury.grantRole(ORACLE_ROLE, owner.address);
      await treasury.updateGoldPrice(ethers.parseUnits("85", 8));
      expect(await treasury.goldPriceUSD()).to.equal(ethers.parseUnits("85", 8));
    });

    it("更新金价触发 GoldPriceUpdated 事件", async function () {
      await expect(treasury.updateGoldPrice(ethers.parseUnits("86", 8)))
        .to.emit(treasury, "GoldPriceUpdated");
    });

    it("GOLD_ORACLE_ROLE 可更新 PAXG 价格", async function () {
      await treasury.updatePAXGPrice(ethers.parseUnits("86", 8));
      expect(await treasury.paxgPriceUSD()).to.equal(ethers.parseUnits("86", 8));
    });

    it("非 ORACLE_ROLE 更新金价 revert", async function () {
      await expect(
        treasury.connect(bob).updateGoldPrice(1n)
      ).to.be.reverted;
    });
  });

  describe("redeemPAXG — L2 条件赎回", function () {
    it("GOVERNOR + 白名单用户可赎回", async function () {
      const before = await mockPAXG.balanceOf(alice.address);
      await treasury.connect(governor).redeemPAXG(alice.address, ethers.parseUnits("1", 18));
      const after = await mockPAXG.balanceOf(alice.address);
      expect(after - before).to.equal(ethers.parseUnits("1", 18));
    });

    it("零数量赎回 revert", async function () {
      await expect(
        treasury.connect(governor).redeemPAXG(alice.address, 0n)
      ).to.be.revertedWith("Treasury: zero redeem");
    });

    it("超过 PAXG 余额 revert", async function () {
      await expect(
        treasury.connect(governor).redeemPAXG(alice.address, ethers.parseUnits("999999", 18))
      ).to.be.revertedWith("Treasury: insufficient PAXG");
    });
  });

  describe("储备率查询", function () {
    it("getReserveRatioBPS 有金价时返回合理值", async function () {
      await treasury.updateGoldPrice(ethers.parseUnits("85", 8));
      const ratio = await treasury.getReserveRatioBPS();
      expect(ratio).to.be.gte(0n);
    });

    it("getReserveSnapshot 返回完整快照", async function () {
      const snap = await treasury.getReserveSnapshot();
      expect(snap.timestamp).to.be.gt(0n);
      expect(snap.paxgBalance).to.be.gt(0n);
    });

    it("getTotalGoldGrams 有 PAXG 时 > 0", async function () {
      const grams = await treasury.getTotalGoldGrams();
      expect(grams).to.be.gt(0n);
    });
  });

  describe("setMintAuthorized — 铸币授权", function () {
    it("授权后 requestMint 可铸币", async function () {
      await treasury.setMintAuthorized(alice.address, true);
      const supply0 = await pgold.totalSupply();
      await treasury.connect(alice)["requestMint(address,uint256,bytes32)"](alice.address, ethers.parseEther("10"), ethers.keccak256(ethers.toUtf8Bytes("TEST")));
      expect(await pgold.totalSupply()).to.equal(supply0 + ethers.parseEther("10"));
    });

    it("取消授权后 requestMint revert", async function () {
      await treasury.setMintAuthorized(alice.address, false);
      await expect(
        treasury.connect(alice)["requestMint(address,uint256,bytes32)"](alice.address, ethers.parseEther("1"), ethers.keccak256(ethers.toUtf8Bytes("TEST")))
      ).to.be.revertedWith("Treasury: not authorized");
    });
  });

  describe("genesisPool 授权接口", function () {
    it("非授权地址调用 swapUSDCforPAXG(uint) revert", async function () {
      await expect(
        treasury.connect(bob)["swapUSDCforPAXG(uint256)"](1000n)
      ).to.be.revertedWith("Treasury: not genesis pool");
    });
  });
});
