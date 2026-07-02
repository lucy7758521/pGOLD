// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../core/RoleRegistry.sol";
import "../core/Treasury.sol";

/**
 * @title FeeRouter
 * @notice 手续费路由 — 硬编码四账户分配
 * @dev
 *   所有交易手续费通过此合约分配至 Treasury 的四账户。
 *   分配比例硬编码在合约中，不可修改：
 *   - GOLD_RESERVE: 95%  → 购 PAXG 增厚储备
 *   - INSURANCE:     3%  → 稳定基金（L3 防线资金来源）
 *   - LIQUIDITY:    1.5% → PGOLDSwap 流动性引导
 *   - EMERGENCY:    0.5% → 极端黑天鹅应急
 *
 *   运营经费由团队从外部解决，不从手续费中提取。
 *   ⚠️ 不可升级 — 分配比例永不改变，用户信任基石
 */
contract FeeRouter is AccessControl {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    // 硬编码分配比例（BPS, 共 10000）
    // ──────────────────────────────────────────────
    uint256 public constant GOLD_RESERVE_SHARE = 9500; // 95.00%
    uint256 public constant INSURANCE_SHARE     =  300; //  3.00%
    uint256 public constant LIQUIDITY_SHARE     =  150; //  1.50%
    uint256 public constant EMERGENCY_SHARE     =   50; //  0.50%
    uint256 public constant TOTAL_SHARES        = 10000;

    // ──────────────────────────────────────────────
    // 不可变引用
    // ──────────────────────────────────────────────
    Treasury public immutable treasury;
    IERC20 public immutable USDC;

    // ──────────────────────────────────────────────
    // 统计
    // ──────────────────────────────────────────────
    uint256 public totalFeesCollected;

    // ──────────────────────────────────────────────
    // 仅 PGOLDSwap 可触发手续费分配
    // ──────────────────────────────────────────────
    address public swapContract;

    event SwapContractSet(address oldAddr, address newAddr);
    event FeesRouted(
        uint256 total,
        uint256 goldReserve, uint256 insurance, uint256 liquidity, uint256 emergency
    );

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _treasury, address _usdc) {
        require(_treasury != address(0), "FeeRouter: zero treasury");
        require(_usdc != address(0), "FeeRouter: zero USDC");
        treasury = Treasury(_treasury);
        USDC = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // SET: PGOLDSwap 地址（一次性设置）
    // ──────────────────────────────────────────────
    function setSwapContract(address _swap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_swap != address(0), "FeeRouter: zero swap");
        require(swapContract == address(0), "FeeRouter: already set");
        swapContract = _swap;
        emit SwapContractSet(address(0), _swap);
    }

    // ──────────────────────────────────────────────
    // 手续费路由（由 PGOLDSwap 调用）
    // ──────────────────────────────────────────────
    /**
     * @notice 手续费路由主入口
     * @param feeAmount 手续费 USDC 总额（已从用户处扣除）
     * @dev 仅 PGOLDSwap 可调用。USDC 已在调用前转入此合约。
     */
    function routeFee(uint256 feeAmount) external {
        require(msg.sender == swapContract, "FeeRouter: only swap");
        require(feeAmount > 0, "FeeRouter: zero fee");

        uint256[4] memory distribution = calculateDistribution(feeAmount);

        // USDC 已由 PGOLDSwap 直接转入 Treasury
        // FeeRouter 仅负责分配记账
        treasury.receiveFees(distribution);

        totalFeesCollected += feeAmount;

        emit FeesRouted(
            feeAmount,
            distribution[0], distribution[1], distribution[2], distribution[3]
        );
    }

    // ──────────────────────────────────────────────
    // 内部分配计算（硬编码，不可改）
    // ──────────────────────────────────────────────
    function calculateDistribution(uint256 total) public pure returns (uint256[4] memory) {
        return [
            (total * GOLD_RESERVE_SHARE) / TOTAL_SHARES, // 95%
            (total * INSURANCE_SHARE)     / TOTAL_SHARES, //  3%
            (total * LIQUIDITY_SHARE)     / TOTAL_SHARES, // 1.5%
            (total * EMERGENCY_SHARE)     / TOTAL_SHARES  // 0.5%
        ];
    }
}
