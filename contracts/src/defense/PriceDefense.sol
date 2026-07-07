// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../core/RoleRegistry.sol";
import "../core/ConfigManager.sol";
import "../core/Treasury.sol";
import "../amm/PGOLDSwap.sol";

/**
 * @title PriceDefense
 * @notice 三层价格防线 — 防御 pGOLD 价格脱锚
 * @dev
 *   L1 软锚定：始终激活
 *     - 当 pGOLD 折价 > 1% 时触发社区警报
 *     - 当 pGOLD 折价 > 2% 时限制大额卖单
 *     - 不涉及资金操作，纯防御信号
 *
 *   L2 条件赎回：折价 > 3% 持续 7 天
 *     - Treasury 将 PAXG 按 1:1 比例转给白名单 KYC 用户
 *     - 每人有赎回上限
 *     - 激活后自动触发，Governor 可手动关闭
 *
 *   L3 稳定基金：折价 > 10% 持续 48 小时
 *     - 使用 INSURANCE 账户资金在 PGOLDSwap 中买入 pGOLD
 *     - 买入的 pGOLD 销毁（减少流通量提升价格）
 *     - 买入量有上限（INSURANCE 账户余额的 50% 单次）
 *
 *   所有防线触发基于 PGOLDSwap 的实时价格 vs 金价。
 */
contract PriceDefense is AccessControl, ReentrancyGuard {
    // ──────────────────────────────────────────────
    // 防御状态
    // ──────────────────────────────────────────────
    enum DefenseLevel { NONE, L1, L2, L3 }

    struct DiscountTracker {
        uint256 discountStartTime;   // 折价开始时间
        uint256 maxDiscount;         // 最大折价记录
        bool active;
    }

    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    ConfigManager public immutable config;
    Treasury public immutable treasury;
    PGOLDSwap public immutable swap;

    // ──────────────────────────────────────────────
    // 状态
    // ──────────────────────────────────────────────
    DefenseLevel public currentLevel;
    DiscountTracker public discountTracker;

    bool public l2Active;    // L2 条件赎回激活
    bool public l3Active;    // L3 稳定基金激活

    uint256 public l2ActivatedAt;     // L2 激活时间
    uint256 public l3ActivatedAt;     // L3 激活时间

    uint256 public l2TotalRedeemed;   // L2 总赎回量
    uint256 public l3TotalBought;     // L3 总回购量

    uint256 public l2RedeemCapPerUser = 5000e18; // 每人最多赎回 5000 PAXG (~$425K)
    uint256 public l3MaxBuyPerTrigger = 50000e6;  // 单次回购最多 $50K USDC

    // 大额卖单限制（L1 激活时）
    uint256 public largeSellThreshold = 10000e18; // 10K pGOLD

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event DefenseLevelChanged(DefenseLevel oldLevel, DefenseLevel newLevel);
    event DiscountAlert(uint256 discountBPS, uint256 swapPrice, uint256 goldPrice);
    event L2Redeemed(address indexed user, uint256 paxgAmount, uint256 value);
    event L3Buyback(uint256 usdcSpent, uint256 pgoldBought, uint256 pgoldBurned);
    event L2Deactivated(uint256 totalRedeemed);
    event L3Deactivated(uint256 totalBought);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _config, address _treasury, address _swap) {
        require(_config != address(0), "Defense: zero config");
        config = ConfigManager(_config);
        treasury = Treasury(_treasury);
        swap = PGOLDSwap(_swap);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.GOVERNOR_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 核心：检查价格并触发防线
    // ──────────────────────────────────────────────
    /**
     * @notice 检查当前价格状态并自动触发防线
     * @dev 每 N 分钟由 Keeper 调用
     */
    function checkAndDefend() external {
        uint256 swapPrice = swap.getPrice();           // USDC/pGOLD (8 dec)
        uint256 goldPrice = treasury.goldPriceUSD();    // USD/g (8 dec) from GoldOracle

        if (swapPrice == 0 || goldPrice == 0) return;

        int256 discountBPS;
        if (swapPrice < goldPrice) {
            // 折价 = (金价 - swap价) / 金价 * 10000
            discountBPS = int256(((goldPrice - swapPrice) * 10000) / goldPrice);
        } else {
            // 溢价（正常情况），重置追踪器
            _resetDiscount();
            return;
        }

        // 更新折扣追踪器
        if (!discountTracker.active) {
            discountTracker.discountStartTime = block.timestamp;
            discountTracker.maxDiscount = uint256(discountBPS);
            discountTracker.active = true;
        } else {
            if (uint256(discountBPS) > discountTracker.maxDiscount) {
                discountTracker.maxDiscount = uint256(discountBPS);
            }
        }

        // ── L1 软锚定 ──
        if (discountBPS >= 100) { // 1% 折价
            if (currentLevel < DefenseLevel.L1) {
                _setLevel(DefenseLevel.L1);
            }
        }

        // ── L2 条件赎回 ──
        uint256 l2Threshold = config.l2DiscountThreshold(); // 300 = 3%
        uint256 l2Duration = config.l2DurationThreshold();   // 7 days
        if (discountBPS >= int256(l2Threshold) &&
            block.timestamp >= discountTracker.discountStartTime + l2Duration) {
            if (!l2Active) {
                _activateL2();
            }
        }

        // ── L3 稳定基金 ──
        uint256 l3Threshold = config.l3DiscountThreshold(); // 1000 = 10%
        uint256 l3Duration = config.l3DurationThreshold();   // 48 hours
        if (discountBPS >= int256(l3Threshold) &&
            block.timestamp >= discountTracker.discountStartTime + l3Duration) {
            if (!l3Active) {
                _activateL3();
            }
        }

        emit DiscountAlert(uint256(discountBPS), swapPrice, goldPrice);
    }

    // ──────────────────────────────────────────────
    // L2：条件赎回（白名单用户调用）
    // ──────────────────────────────────────────────
    /**
     * @notice L2 条件赎回：白名单用户按 1:1 赎回 PAXG
     * @param amount PAXG 数量
     */
    function redeemL2(uint256 amount) external nonReentrant {
        require(l2Active, "Defense: L2 not active");
        require(amount <= l2RedeemCapPerUser, "Defense: exceed cap");

        treasury.redeemPAXG(msg.sender, amount);
        l2TotalRedeemed += amount;

        emit L2Redeemed(msg.sender, amount, amount); // 1:1 redeem
    }

    // ──────────────────────────────────────────────
    // L3：稳定基金回购（Governor 调用）
    // ──────────────────────────────────────────────
    /**
     * @notice L3 稳定基金：用 INSURANCE 账户 USDC 在 PGOLDSwap 买入 pGOLD 并销毁
     * @param usdcAmount 回购 USDC 量
     */
    function buybackL3(uint256 usdcAmount) external nonReentrant onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        require(l3Active, "Defense: L3 not active");
        require(usdcAmount <= l3MaxBuyPerTrigger, "Defense: exceed limit");

        // 从 INSURANCE 账户提款
        treasury.withdrawFromAccount(Treasury.Account.INSURANCE, address(this), usdcAmount);

        // 授权 PGOLDSwap
        IERC20 usdc = IERC20(address(treasury.USDC()));
        usdc.approve(address(swap), usdcAmount);

        // 在 PGOLDSwap 买入 pGOLD
        uint256 pgoldBought = swap.buy(usdcAmount, 0, block.timestamp + 300);

        // 销毁买入的 pGOLD（减少流通量）
        PGOLDToken(address(treasury.pGOLD())).transfer(address(0xdead), pgoldBought);

        l3TotalBought += usdcAmount;

        emit L3Buyback(usdcAmount, pgoldBought, pgoldBought);
    }

    // ──────────────────────────────────────────────
    // 大额卖单检查（L1 及以上激活时调用）
    // ──────────────────────────────────────────────
    /**
     * @notice 检查卖单是否超过 L1 限额
     * @dev PGOLDSwap 在 sell() 中调用此函数
     */
    function checkLargeSell(uint256 pgoldAmount) external view {
        if (currentLevel >= DefenseLevel.L1) {
            require(pgoldAmount <= largeSellThreshold, "Defense: large sell restricted");
        }
    }

    // ──────────────────────────────────────────────
    // 管理（仅 Governor）
    // ──────────────────────────────────────────────
    function deactivateL2() external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        require(l2Active, "Defense: L2 not active");
        l2Active = false;
        emit L2Deactivated(l2TotalRedeemed);
    }

    function deactivateL3() external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        require(l3Active, "Defense: L3 not active");
        l3Active = false;
        emit L3Deactivated(l3TotalBought);
    }

    function resetDefense() external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        _resetDiscount();
        l2Active = false;
        l3Active = false;
        _setLevel(DefenseLevel.NONE);
    }

    function setLargeSellThreshold(uint256 threshold) external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        largeSellThreshold = threshold;
    }

    function setL2RedeemCapPerUser(uint256 cap) external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        l2RedeemCapPerUser = cap;
    }

    function setL3MaxBuyPerTrigger(uint256 max) external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        l3MaxBuyPerTrigger = max;
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    function getDefenseStatus() external view returns (
        DefenseLevel level,
        uint256 discountBPS,
        uint256 discountDuration,
        bool l2Active_,
        bool l3Active_,
        uint256 l2Redeemed,
        uint256 l3Bought
    ) {
        uint256 swapPrice = swap.getPrice();
        uint256 goldPrice = treasury.goldPriceUSD();
        uint256 discount = 0;
        if (swapPrice < goldPrice) {
            discount = ((goldPrice - swapPrice) * 10000) / goldPrice;
        }
        uint256 duration = discountTracker.active ?
            block.timestamp - discountTracker.discountStartTime : 0;

        return (
            currentLevel, discount, duration,
            l2Active, l3Active,
            l2TotalRedeemed, l3TotalBought
        );
    }

    // ──────────────────────────────────────────────
    // 内部
    // ──────────────────────────────────────────────
    function _activateL2() private {
        l2Active = true;
        l2ActivatedAt = block.timestamp;
        _setLevel(DefenseLevel.L2);
    }

    function _activateL3() private {
        l3Active = true;
        l3ActivatedAt = block.timestamp;
        _setLevel(DefenseLevel.L3);
    }

    function _resetDiscount() private {
        discountTracker.discountStartTime = 0;
        discountTracker.maxDiscount = 0;
        discountTracker.active = false;
    }

    function _setLevel(DefenseLevel newLevel) private {
        DefenseLevel old = currentLevel;
        currentLevel = newLevel;
        emit DefenseLevelChanged(old, newLevel);
    }
}
