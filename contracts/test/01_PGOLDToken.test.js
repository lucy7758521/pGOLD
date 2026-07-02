/**
 * PGOLDToken 单元测试
 * 覆盖：构造/mint/burn/transfer/暂停/PERMIT/角色控制
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("PGOLDToken", function () {
  let token, owner, treasury, alice, bob, minter;
  const REASON = ethers.encodeBytes32String("TEST");

  before(async function () {
    [owner, treasury, alice, bob, minter] = await hre.ethers.getSigners();
    const PGOLDToken = await ethers.getContractFactory("PGOLDToken");
    token = await PGOLDToken.deploy();
    await token.waitForDeployment();
    await token.grantRole(await token.MINTER_ROLE(), treasury.address);
  });

  // ==================== 构造 ====================
  describe("部署", function () {
    it("名称和符号正确", async function () {
      expect(await token.name()).to.equal("pGOLD");
      expect(await token.symbol()).to.equal("pGOLD");
    });

    it("精度为 18", async function () {
      expect(await token.decimals()).to.equal(18n);
    });

    it("初始流通量为 0", async function () {
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("默认状态非暂停", async function () {
      expect(await token.paused()).to.equal(false);
    });

    it("DEFAULT_ADMIN_ROLE 授予部署者", async function () {
      const adminRole = await token.DEFAULT_ADMIN_ROLE();
      expect(await token.hasRole(adminRole, owner.address)).to.equal(true);
    });

    it("MINTER_ROLE 已授予 Treasury", async function () {
      const minterRole = await token.MINTER_ROLE();
      expect(await token.hasRole(minterRole, treasury.address)).to.equal(true);
    });
  });

  // ==================== 铸币 ====================
  describe("铸币 (mint)", function () {
    it("MINTER 可 mint pGOLD", async function () {
      const amount = ethers.parseEther("1000");
      await token.connect(treasury).mint(alice.address, amount, REASON);
      expect(await token.balanceOf(alice.address)).to.equal(amount);
    });

    it("非 MINTER 不可 mint", async function () {
      const minterRole = await token.MINTER_ROLE();
      await expect(
        token.connect(alice).mint(bob.address, ethers.parseEther("100"), REASON)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, minterRole);
    });

    it("totalSupply 随 mint 累加", async function () {
      const before = await token.totalSupply();
      await token.connect(treasury).mint(bob.address, ethers.parseEther("500"), REASON);
      expect(await token.totalSupply()).to.equal(before + ethers.parseEther("500"));
    });
  });

  // ==================== 销毁 (自毁) ====================
  describe("销毁 (burn)", function () {
    it("持有者可 burn 自己的代币", async function () {
      const balBefore = await token.balanceOf(alice.address);
      const supplyBefore = await token.totalSupply();
      await token.connect(alice).burn(ethers.parseEther("200"));
      expect(await token.balanceOf(alice.address)).to.equal(balBefore - ethers.parseEther("200"));
      expect(await token.totalSupply()).to.equal(supplyBefore - ethers.parseEther("200"));
    });

    it("余额不足时 burn 失败", async function () {
      await expect(
        token.connect(bob).burn(ethers.parseEther("999999"))
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  // ==================== 转账 ====================
  describe("转账 (transfer)", function () {
    it("正常转账", async function () {
      await token.connect(treasury).mint(alice.address, ethers.parseEther("100"), REASON);
      await token.connect(alice).transfer(bob.address, ethers.parseEther("30"));
      // alice: 1000(mint) - 200(burn) + 100(remint) - 30(transfer) = 870
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("870"));
    });

    it("余额不足转账失败", async function () {
      await expect(
        token.connect(alice).transfer(bob.address, ethers.parseEther("999999"))
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  // ==================== 暂停 ====================
  describe("暂停 (pause)", function () {
    it("只有 PAUSER_ROLE 可暂停", async function () {
      await expect(token.connect(alice).pause())
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("owner 授予 PAUSER_ROLE 后可暂停", async function () {
      const pauserRole = await token.PAUSER_ROLE();
      await token.connect(owner).grantRole(pauserRole, alice.address);
      await token.connect(alice).pause();
      expect(await token.paused()).to.equal(true);
    });

    it("暂停后 mint 不可用", async function () {
      await expect(
        token.connect(treasury).mint(alice.address, ethers.parseEther("100"), REASON)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("暂停后 transfer 不可用", async function () {
      await expect(
        token.connect(alice).transfer(bob.address, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("unpause 后恢复正常", async function () {
      await token.connect(alice).unpause();
      expect(await token.paused()).to.equal(false);
      await token.connect(treasury).mint(alice.address, ethers.parseEther("50"), REASON);
      expect(await token.balanceOf(alice.address)).to.be.gt(0n);
    });
  });

  // ==================== ERC20Permit ====================
  describe("ERC20Permit", function () {
    it("PERMIT TYPEHASH 可用", async function () {
      expect(await token.eip712Domain()).to.not.be.empty;
    });

    it("nonces 从 0 开始", async function () {
      expect(await token.nonces(alice.address)).to.equal(0n);
    });
  });
});
