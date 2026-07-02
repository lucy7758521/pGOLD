// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../core/RoleRegistry.sol";
import "../core/Treasury.sol";

/**
 * @dev Chainlink Aggregator V3 最小接口
 */
interface IAggregatorV3 {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

/**
 * @title GoldOracle
 * @notice 金价 + PAXG 价格预言机
 * @dev
 *   从 Chainlink Price Feed 读取 XAU/USD 和 PAXG/USD 价格，
 *   验证数据新鲜度后写入 Treasury，供全协议使用。
 *
 *   Chainlink 数据源（Arbitrum）：
 *   - XAU/USD: Chainlink Data Streams 或 Price Feed
 *   - PAXG/USD: 可通过 PAXG/ETH × ETH/USD 计算
 *
 *   更新权限：GOLD_ORACLE_ROLE（可由 Keeper 网络自动化）
 */
contract GoldOracle is AccessControl {
    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    Treasury public immutable treasury;

    // ──────────────────────────────────────────────
    // Chainlink Price Feeds（可更新）
    // ──────────────────────────────────────────────
    IAggregatorV3 public goldFeed;     // XAU/USD
    IAggregatorV3 public paxgFeed;     // PAXG/USD（或 PAXG/ETH，需二次计算）

    // ──────────────────────────────────────────────
    // 配置
    // ──────────────────────────────────────────────
    uint256 public constant MAX_STALENESS = 1 hours;    // 最大数据陈旧时间
    uint256 public constant MIN_UPDATE_INTERVAL = 5 minutes; // 最小更新间隔

    uint256 public lastGoldUpdate;
    uint256 public lastPAXGUpdate;

    uint256 public goldPriceUSD;    // XAU 价格 (USD/oz, 8 decimals)
    uint256 public paxgPriceUSD;    // PAXG 价格 (USD/oz, 8 decimals)

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event GoldPriceUpdated(uint256 price, uint256 timestamp);
    event PAXGPriceUpdated(uint256 price, uint256 timestamp);
    event FeedUpdated(address oldFeed, address newFeed, string feedType);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _treasury, address _goldFeed, address _paxgFeed) {
        require(_treasury != address(0), "Oracle: zero treasury");
        treasury = Treasury(_treasury);
        goldFeed = IAggregatorV3(_goldFeed);
        paxgFeed = IAggregatorV3(_paxgFeed);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.GOLD_ORACLE_ROLE, msg.sender);
        _grantRole(RoleRegistry.GOLD_ORACLE_ROLE, address(this)); // for updateAll() internal delegation
    }

    // ──────────────────────────────────────────────
    // 价格更新
    // ──────────────────────────────────────────────
    /**
     * @notice 从 Chainlink 拉取最新金价并写入 Treasury
     */
    function updateGoldPrice() external onlyRole(RoleRegistry.GOLD_ORACLE_ROLE) {
        require(block.timestamp >= lastGoldUpdate + MIN_UPDATE_INTERVAL, "Oracle: too frequent");

        (, int256 answer, , uint256 updatedAt, ) = goldFeed.latestRoundData();
        require(answer > 0, "Oracle: invalid gold price");
        require(block.timestamp - updatedAt <= MAX_STALENESS, "Oracle: stale gold price");

        uint8 feedDecimals = goldFeed.decimals();

        // 统一为 8 decimals
        uint256 price;
        if (feedDecimals <= 8) {
            price = uint256(answer) * (10 ** (8 - feedDecimals));
        } else {
            price = uint256(answer) / (10 ** (feedDecimals - 8));
        }

        goldPriceUSD = price;
        lastGoldUpdate = block.timestamp;

        // 将 XAU/oz 转为 USD/g 写入 Treasury
        // 1 oz = 31.1035g (×10000 = 311035)
        // goldPriceGram = price(per oz, 8dec) / 31.1035 → (price * 10000) / 311035
        uint256 goldPriceGram = (price * 10000) / 311035;
        treasury.updateGoldPrice(goldPriceGram);

        emit GoldPriceUpdated(price, block.timestamp);
    }

    /**
     * @notice 从 Chainlink 拉取最新 PAXG 价格并写入 Treasury
     */
    function updatePAXGPrice() external onlyRole(RoleRegistry.GOLD_ORACLE_ROLE) {
        require(block.timestamp >= lastPAXGUpdate + MIN_UPDATE_INTERVAL, "Oracle: too frequent");

        (, int256 answer, , uint256 updatedAt, ) = paxgFeed.latestRoundData();
        require(answer > 0, "Oracle: invalid PAXG price");
        require(block.timestamp - updatedAt <= MAX_STALENESS, "Oracle: stale PAXG price");

        uint8 feedDecimals = paxgFeed.decimals();

        uint256 price;
        if (feedDecimals <= 8) {
            price = uint256(answer) * (10 ** (8 - feedDecimals));
        } else {
            price = uint256(answer) / (10 ** (feedDecimals - 8));
        }

        paxgPriceUSD = price;
        lastPAXGUpdate = block.timestamp;

        treasury.updatePAXGPrice(price);

        emit PAXGPriceUpdated(price, block.timestamp);
    }

    /**
     * @notice 一次性更新金价+PAXG价格
     */
    function updateAll() external onlyRole(RoleRegistry.GOLD_ORACLE_ROLE) {
        this.updateGoldPrice();
        this.updatePAXGPrice();
    }

    // ──────────────────────────────────────────────
    // 管理
    // ──────────────────────────────────────────────
    function setGoldFeed(address _feed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_feed != address(0), "Oracle: zero feed");
        emit FeedUpdated(address(goldFeed), _feed, "GOLD");
        goldFeed = IAggregatorV3(_feed);
    }

    function setPAXGFeed(address _feed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_feed != address(0), "Oracle: zero feed");
        emit FeedUpdated(address(paxgFeed), _feed, "PAXG");
        paxgFeed = IAggregatorV3(_feed);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    /**
     * @notice 获取黄金克价 (USD/g, 8 decimals)
     */
    function getGoldPricePerGram() external view returns (uint256) {
        if (goldPriceUSD == 0) return 0;
        return (goldPriceUSD * 10000) / 311035;
    }

    /**
     * @notice GenesisPool 兼容接口 — 获取金价 (USD/g, 18 decimals)
     * @return price 黄金克价 (USD/g, 18 decimals)
     * @return updatedAt 最后更新时间戳
     */
    function getGoldPrice() external view returns (uint256 price, uint256 updatedAt) {
        if (goldPriceUSD == 0) return (0, 0);
        price = (goldPriceUSD * 1e14) / 311035; // XAU/oz(8dec) → USD/g(18dec): ×1e14 ÷311035
        updatedAt = lastGoldUpdate;
    }

    /**
     * @notice 获取 PAXG 相对于金价的溢价 (BPS)
     */
    function getPAXGPremium() external view returns (int256) {
        if (goldPriceUSD == 0 || paxgPriceUSD == 0) return 0;
        // premium = (PAXG_price - Gold_price) / Gold_price * 10000
        return (int256(paxgPriceUSD) - int256(goldPriceUSD)) * 10000 / int256(goldPriceUSD);
    }
}
