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
    IAggregatorV3 public paxgFeed;     // PAXG/USD 直接 feed（可选）
    IAggregatorV3 public paxgEthFeed;  // PAXG/ETH feed（两步计算模式）
    IAggregatorV3 public ethUsdFeed;   // ETH/USD feed（两步计算模式）
    bool public useTwoStepPAXG;        // true = PAXG/ETH × ETH/USD，false = 直接 PAXG/USD

    // ──────────────────────────────────────────────
    // 配置
    // ──────────────────────────────────────────────
    uint256 public constant MAX_STALENESS = 1 hours;    // 最大数据陈旧时间
    uint256 public constant MIN_UPDATE_INTERVAL = 5 minutes; // 最小更新间隔
    uint256 public constant MAX_PRICE_CHANGE_BPS = 1000; // 单次最大价格变化 10%

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
        useTwoStepPAXG = false;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.GOLD_ORACLE_ROLE, msg.sender);
        _grantRole(RoleRegistry.GOLD_ORACLE_ROLE, address(this));
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
        uint256 price = _to8(uint256(answer), feedDecimals);

        // 价格变化幅度检查（跳过首次设置）
        if (goldPriceUSD > 0) {
            uint256 maxChange = (goldPriceUSD * MAX_PRICE_CHANGE_BPS) / 10000;
            require(
                price >= goldPriceUSD - maxChange && price <= goldPriceUSD + maxChange,
                "Oracle: gold price change exceeds 10%"
            );
        }

        goldPriceUSD = price;
        lastGoldUpdate = block.timestamp;
        // 1 oz = 31.1035g (×10000 = 311035)
        // goldPriceGram = price(per oz, 8dec) / 31.1035 → (price * 10000) / 311035
        uint256 goldPriceGram = (price * 10000) / 311035;
        treasury.updateGoldPrice(goldPriceGram);

        emit GoldPriceUpdated(price, block.timestamp);
    }

    /**
     * @notice 从 Chainlink 拉取最新 PAXG 价格并写入 Treasury
     * @dev 支持两种模式：
     *   1. 直接模式：paxgFeed 返回 PAXG/USD
     *   2. 两步模式：paxgEthFeed(PAXG/ETH) × ethUsdFeed(ETH/USD) → PAXG/USD
     *      Arbitrum 主网无 PAXG/USD 直接 feed，必须用两步模式
     */
    function updatePAXGPrice() external onlyRole(RoleRegistry.GOLD_ORACLE_ROLE) {
        require(block.timestamp >= lastPAXGUpdate + MIN_UPDATE_INTERVAL, "Oracle: too frequent");

        uint256 price;

        if (useTwoStepPAXG) {
            require(address(paxgEthFeed) != address(0), "Oracle: paxgEthFeed not set");
            require(address(ethUsdFeed)  != address(0), "Oracle: ethUsdFeed not set");

            (, int256 paxgEth, , uint256 paxgEthAt, ) = paxgEthFeed.latestRoundData();
            (, int256 ethUsd, , uint256 ethUsdAt,  ) = ethUsdFeed.latestRoundData();

            require(paxgEth > 0, "Oracle: invalid PAXG/ETH price");
            require(ethUsd  > 0, "Oracle: invalid ETH/USD price");
            require(block.timestamp - paxgEthAt <= MAX_STALENESS, "Oracle: stale PAXG/ETH");
            require(block.timestamp - ethUsdAt  <= MAX_STALENESS, "Oracle: stale ETH/USD");

            uint8 paxgEthDec = paxgEthFeed.decimals();
            uint8 ethUsdDec  = ethUsdFeed.decimals();

            // 统一为 18 decimals 再相乘，结果截为 8 decimals
            // paxgEth(18dec) × ethUsd(18dec) / 1e18 → paxgUsd(18dec) → /1e10 → 8dec
            uint256 paxgEth18 = _to18(uint256(paxgEth), paxgEthDec);
            uint256 ethUsd18  = _to18(uint256(ethUsd),  ethUsdDec);
            price = (paxgEth18 * ethUsd18) / 1e18 / 1e10;
        } else {
            require(address(paxgFeed) != address(0), "Oracle: paxgFeed not set");

            (, int256 answer, , uint256 updatedAt, ) = paxgFeed.latestRoundData();
            require(answer > 0, "Oracle: invalid PAXG price");
            require(block.timestamp - updatedAt <= MAX_STALENESS, "Oracle: stale PAXG price");

            price = _to8(uint256(answer), paxgFeed.decimals());
        }

        if (paxgPriceUSD > 0) {
            uint256 maxChange = (paxgPriceUSD * MAX_PRICE_CHANGE_BPS) / 10000;
            require(
                price >= paxgPriceUSD - maxChange && price <= paxgPriceUSD + maxChange,
                "Oracle: PAXG price change exceeds 10%"
            );
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

    // 配置两步模式：PAXG/ETH × ETH/USD
    function setTwoStepPAXGFeeds(address _paxgEthFeed, address _ethUsdFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_paxgEthFeed != address(0), "Oracle: zero paxgEthFeed");
        require(_ethUsdFeed  != address(0), "Oracle: zero ethUsdFeed");
        emit FeedUpdated(address(paxgEthFeed), _paxgEthFeed, "PAXG/ETH");
        emit FeedUpdated(address(ethUsdFeed),  _ethUsdFeed,  "ETH/USD");
        paxgEthFeed  = IAggregatorV3(_paxgEthFeed);
        ethUsdFeed   = IAggregatorV3(_ethUsdFeed);
        useTwoStepPAXG = true;
    }

    function disableTwoStepPAXG() external onlyRole(DEFAULT_ADMIN_ROLE) {
        useTwoStepPAXG = false;
    }

    // ──────────────────────────────────────────────
    // 内部辅助
    // ──────────────────────────────────────────────
    function _to8(uint256 value, uint8 dec) internal pure returns (uint256) {
        if (dec <= 8) return value * (10 ** (8 - dec));
        return value / (10 ** (dec - 8));
    }

    function _to18(uint256 value, uint8 dec) internal pure returns (uint256) {
        if (dec <= 18) return value * (10 ** (18 - dec));
        return value / (10 ** (dec - 18));
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
