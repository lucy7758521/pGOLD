/**
 * GoldOracle 完整补充测试
 * 覆盖：updateGoldPrice / updatePAXGPrice / updateAll /
 *        staleness检查 / 频率限制 / setGoldFeed / setPAXGFeed /
 *        getGoldPricePerGram / getGoldPrice / getPAXGPremium
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

describe("GoldOracle — 完整覆盖", function () {
  let oracle, treasury, pgold, config, mockPAXG, mockUSDC, mockRouter;
  let goldFeed, paxgFeed;
  let owner, alice;

  before(async function () {
    [owner, alice] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    mockPAXG   = await MockERC20.deploy("PAXG","PAXG");
    mockUSDC   = await MockERC20.deploy("USDC","USDC");
    pgold      = await (await ethers.getContractFactory("PGOLDToken")).deploy();
    config     = await (await ethers.getContractFactory("ConfigManager")).deploy();
    treasury   = await (await ethers.getContractFactory("Treasury")).deploy(
      pgold.target, config.target, mockPAXG.target, mockUSDC.target, owner.address
    );
    await pgold.grantRole(await pgold.MINTER_ROLE(), treasury.target);

    // 部署 Chainlink mock feeds
    const ChainlinkMock = await ethers.getContractFactory("MockChainlinkAggregator");
    // XAU/USD: $2650/oz = 265000000000 (8 decimals)
    goldFeed = await ChainlinkMock.deploy(265000000000n, 8);
    // PAXG/USD: $2660/oz
    paxgFeed = await ChainlinkMock.deploy(266000000000n, 8);

    oracle = await (await ethers.getContractFactory("GoldOracle")).deploy(
      treasury.target, goldFeed.target, paxgFeed.target
    );

    // 授权 oracle 写入 treasury
    const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOLD_ORACLE_ROLE"));
    await treasury.grantRole(ORACLE_ROLE, oracle.target);
    await treasury.grantRole(ORACLE_ROLE, owner.address);
  });

  describe("部署", function () {
    it("treasury 地址正确", async function () {
      expect(await oracle.treasury()).to.equal(treasury.target);
    });
    it("goldFeed 地址正确", async function () {
      expect(await oracle.goldFeed()).to.equal(goldFeed.target);
    });
    it("paxgFeed 地址正确", async function () {
      expect(await oracle.paxgFeed()).to.equal(paxgFeed.target);
    });
    it("初始 goldPriceUSD = 0", async function () {
      expect(await oracle.goldPriceUSD()).to.equal(0n);
    });
  });

  describe("updateGoldPrice", function () {
    it("ORACLE_ROLE 可更新金价", async function () {
      await oracle.updateGoldPrice();
      expect(await oracle.goldPriceUSD()).to.equal(265000000000n);
    });
    it("触发 GoldPriceUpdated 事件", async function () {
      // 推进 5 分钟满足最小更新间隔
      await network.provider.send("evm_increaseTime", [301]);
      await network.provider.send("evm_mine");
      await expect(oracle.updateGoldPrice()).to.emit(oracle, "GoldPriceUpdated");
    });
    it("频率限制 — 5分钟内重复更新 revert", async function () {
      await expect(oracle.updateGoldPrice()).to.be.revertedWith("Oracle: too frequent");
    });
    it("非 ORACLE_ROLE 更新金价 revert", async function () {
      await expect(oracle.connect(alice).updateGoldPrice()).to.be.reverted;
    });
    it("price <= 0 时 revert", async function () {
      const BadFeed = await ethers.getContractFactory("MockChainlinkAggregator");
      const badFeed = await BadFeed.deploy(0n, 8);
      await oracle.setGoldFeed(badFeed.target);
      await network.provider.send("evm_increaseTime", [301]);
      await network.provider.send("evm_mine");
      await expect(oracle.updateGoldPrice()).to.be.revertedWith("Oracle: invalid gold price");
      // 恢复
      await oracle.setGoldFeed(goldFeed.target);
    });
  });

  describe("updatePAXGPrice", function () {
    it("ORACLE_ROLE 可更新 PAXG 价格", async function () {
      await network.provider.send("evm_increaseTime", [301]);
      await network.provider.send("evm_mine");
      await oracle.updatePAXGPrice();
      expect(await oracle.paxgPriceUSD()).to.equal(266000000000n);
    });
    it("触发 PAXGPriceUpdated 事件", async function () {
      await network.provider.send("evm_increaseTime", [301]);
      await network.provider.send("evm_mine");
      await expect(oracle.updatePAXGPrice()).to.emit(oracle, "PAXGPriceUpdated");
    });
    it("频率限制 — 5分钟内重复更新 revert", async function () {
      await expect(oracle.updatePAXGPrice()).to.be.revertedWith("Oracle: too frequent");
    });
  });

  describe("updateAll", function () {
    it("一次更新金价和 PAXG 价格", async function () {
      await network.provider.send("evm_increaseTime", [301]);
      await network.provider.send("evm_mine");
      await oracle.updateAll();
      expect(await oracle.goldPriceUSD()).to.be.gt(0n);
      expect(await oracle.paxgPriceUSD()).to.be.gt(0n);
    });
  });

  describe("setGoldFeed / setPAXGFeed", function () {
    it("ADMIN 可更换 goldFeed", async function () {
      const ChainlinkMock = await ethers.getContractFactory("MockChainlinkAggregator");
      const newFeed = await ChainlinkMock.deploy(270000000000n, 8);
      await expect(oracle.setGoldFeed(newFeed.target)).to.emit(oracle, "FeedUpdated");
      expect(await oracle.goldFeed()).to.equal(newFeed.target);
      await oracle.setGoldFeed(goldFeed.target); // 恢复
    });
    it("ADMIN 可更换 paxgFeed", async function () {
      const ChainlinkMock = await ethers.getContractFactory("MockChainlinkAggregator");
      const newFeed = await ChainlinkMock.deploy(271000000000n, 8);
      await expect(oracle.setPAXGFeed(newFeed.target)).to.emit(oracle, "FeedUpdated");
      await oracle.setPAXGFeed(paxgFeed.target); // 恢复
    });
    it("零地址 setGoldFeed revert", async function () {
      await expect(oracle.setGoldFeed(ethers.ZeroAddress)).to.be.revertedWith("Oracle: zero feed");
    });
    it("非 ADMIN 设置 feed revert", async function () {
      await expect(oracle.connect(alice).setGoldFeed(goldFeed.target)).to.be.reverted;
    });
  });

  describe("查询接口", function () {
    it("getGoldPricePerGram 返回 USD/g (8 decimals)", async function () {
      const gram = await oracle.getGoldPricePerGram();
      expect(gram).to.be.gt(0n);
      // $2650/oz ÷ 31.1035 ≈ $85.2/g → 8520000000
      expect(gram).to.be.gt(8000000000n);
    });
    it("getGoldPrice 返回 18 decimals 价格和时间戳", async function () {
      const [price, updatedAt] = await oracle.getGoldPrice();
      expect(price).to.be.gt(0n);
      expect(updatedAt).to.be.gt(0n);
    });
    it("getPAXGPremium 返回溢价 BPS", async function () {
      const premium = await oracle.getPAXGPremium();
      // PAXG $2660 > Gold $2650 → 溢价 > 0
      expect(premium).to.be.gt(0n);
    });
    it("金价为 0 时 getGoldPricePerGram 返回 0", async function () {
      const ChainlinkMock = await ethers.getContractFactory("MockChainlinkAggregator");
      const zeroPriceFeed = await ChainlinkMock.deploy(100000000n, 8);
      const OracleFactory = await ethers.getContractFactory("GoldOracle");
      const freshOracle = await OracleFactory.deploy(treasury.target, zeroPriceFeed.target, zeroPriceFeed.target);
      expect(await freshOracle.getGoldPricePerGram()).to.equal(0n);
    });
  });
});
