// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../core/RoleRegistry.sol";
import "../core/PGOLDToken.sol";
import "./FeeRouter.sol";

/**
 * @title PGOLDSwap
 * @notice pGOLD 内部 AMM — x*y=k 恒定乘积做市商
 * @dev
 *   这是 pGOLD 协议的交易引擎，所有激励数据源：
 *   - 交易手续费自动路由至 FeeRouter → Treasury
 *   - 每笔 Swap 发出详细事件，链下索引器据此计算排名/盈亏/返佣
 *   - 外部 DEX 交易不追踪、不激励、协议无收入
 *
 *   单一池：USDC / pGOLD
 *   手续费：0.25%（从 USDC 侧扣除）
 *
 *   ⚠️ 不可升级合约 — 交易逻辑永不改变
 */
contract PGOLDSwap is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    // 常量
    // ──────────────────────────────────────────────
    uint256 public constant FEE_RATE = 25;               // 0.25% (BPS)
    uint256 public constant BPS_DENOMINATOR = 10000;

    // ──────────────────────────────────────────────
    // 不可变引用
    // ──────────────────────────────────────────────
    PGOLDToken public immutable pGOLD;
    IERC20 public immutable USDC;
    FeeRouter public immutable feeRouter;

    // ──────────────────────────────────────────────
    // 池状态
    // ──────────────────────────────────────────────
    uint256 public reserveUSDC;    // USDC 储备量 (wei, 6 decimals)
    uint256 public reservePGOLD;   // pGOLD 储备量 (wei, 18 decimals)
    uint256 public constantProduct; // k = x*y (用于验证不变性)

    // ──────────────────────────────────────────────
    // 统计数据
    // ──────────────────────────────────────────────
    uint256 public totalVolumeUSDC;     // 累计交易量（以 USDC 计）
    uint256 public totalFeesCollected;   // 累计手续费
    uint256 public totalSwapCount;       // 累计交易笔数

    // ──────────────────────────────────────────────
    // 价格追踪
    // ──────────────────────────────────────────────
    uint256 public lastPrice; // 最近成交价 (USDC/pGOLD, 8 decimals)

    // ──────────────────────────────────────────────
    // 交易记录（链下索引用）
    // ──────────────────────────────────────────────
    enum SwapDirection { BUY, SELL }

    struct SwapRecord {
        address trader;
        SwapDirection direction;
        uint256 amount;        // 交易 pGOLD 量
        uint256 usdcAmount;    // 对应的 USDC 量
        uint256 price;         // 成交价
        uint256 fee;           // 手续费
        uint256 timestamp;
    }

    // ──────────────────────────────────────────────
    // 事件（详细数据供后端索引）
    // ──────────────────────────────────────────────
    event Swapped(
        address indexed trader,
        SwapDirection indexed direction,
        uint256 pGOLDAmount,
        uint256 usdcAmount,
        uint256 price,
        uint256 fee,
        uint256 timestamp,
        uint256 swapIndex
    );

    event LiquidityAdded(
        address indexed provider,
        uint256 usdcAmount,
        uint256 pgoldAmount,
        uint256 lpTokens
    );

    event LiquidityRemoved(
        address indexed provider,
        uint256 usdcAmount,
        uint256 pgoldAmount,
        uint256 lpTokens
    );

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _pGOLD, address _usdc, address _feeRouter) {
        require(_pGOLD != address(0), "Swap: zero pGOLD");
        require(_usdc != address(0), "Swap: zero USDC");
        require(_feeRouter != address(0), "Swap: zero router");

        pGOLD = PGOLDToken(_pGOLD);
        USDC = IERC20(_usdc);
        feeRouter = FeeRouter(_feeRouter);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 价格查询
    // ──────────────────────────────────────────────
    /**
     * @notice 获取当前 pGOLD 价格
     * @return price USDC/pGOLD (8 decimals)
     */
    function getPrice() public view returns (uint256) {
        if (reservePGOLD == 0) return 0;
        // reserveUSDC (6 dec) / reservePGOLD (18 dec) → 需要调整精度
        // price = reserveUSDC * 1e20 / reservePGOLD → 8 decimals
        return (reserveUSDC * 1e20) / reservePGOLD;
    }

    /**
     * @notice 计算买入 pGOLD 的输出
     * @param usdcIn 投入 USDC 量
     * @return pgoldOut 获得的 pGOLD 量（已扣费）
     * @return fee 手续费
     */
    function getBuyQuote(uint256 usdcIn) public view returns (uint256 pgoldOut, uint256 fee) {
        require(usdcIn > 0, "Swap: zero input");
        fee = (usdcIn * FEE_RATE) / BPS_DENOMINATOR;
        uint256 usdcAfterFee = usdcIn - fee;
        pgoldOut = (usdcAfterFee * reservePGOLD) / (reserveUSDC + usdcAfterFee);
    }

    /**
     * @notice 计算卖出 pGOLD 的输出
     * @param pgoldIn 投入 pGOLD 量
     * @return usdcOut 获得的 USDC 量（已扣费）
     * @return fee 手续费
     */
    function getSellQuote(uint256 pgoldIn) public view returns (uint256 usdcOut, uint256 fee) {
        require(pgoldIn > 0, "Swap: zero input");
        uint256 usdcOutGross = (pgoldIn * reserveUSDC) / (reservePGOLD + pgoldIn);
        fee = (usdcOutGross * FEE_RATE) / BPS_DENOMINATOR;
        usdcOut = usdcOutGross - fee;
    }

    // ──────────────────────────────────────────────
    // 买入 pGOLD（用 USDC 买）
    // ──────────────────────────────────────────────
    function buy(uint256 usdcIn, uint256 minPGOLDOut) external nonReentrant returns (uint256 pgoldOut) {
        require(usdcIn > 0, "Swap: zero input");
        require(reserveUSDC > 0 && reservePGOLD > 0, "Swap: pool not initialized");

        uint256 fee;
        (pgoldOut, fee) = getBuyQuote(usdcIn);
        require(pgoldOut >= minPGOLDOut, "Swap: slippage");
        require(pgoldOut <= reservePGOLD, "Swap: insufficient reserve");

        // 扣 USDC
        USDC.safeTransferFrom(msg.sender, address(this), usdcIn);

        // 手续费直接转给 Treasury，FeeRouter 仅做分配记账
        USDC.safeTransfer(address(feeRouter.treasury()), fee);
        feeRouter.routeFee(fee);

        // 更新储备
        reserveUSDC += (usdcIn - fee);
        reservePGOLD -= pgoldOut;
        constantProduct = reserveUSDC * reservePGOLD;

        // 发 pGOLD
        pGOLD.transfer(msg.sender, pgoldOut);

        // 记录
        totalVolumeUSDC += usdcIn;
        totalFeesCollected += fee;
        totalSwapCount++;
        lastPrice = (usdcIn * 1e20) / pgoldOut;

        emit Swapped(
            msg.sender, SwapDirection.BUY, pgoldOut, usdcIn,
            lastPrice, fee, block.timestamp, totalSwapCount
        );
    }

    // ──────────────────────────────────────────────
    // 卖出 pGOLD（换 USDC）
    // ──────────────────────────────────────────────
    function sell(uint256 pgoldIn, uint256 minUSDCOut) external nonReentrant returns (uint256 usdcOut) {
        require(pgoldIn > 0, "Swap: zero input");
        require(reserveUSDC > 0 && reservePGOLD > 0, "Swap: pool not initialized");

        uint256 fee;
        (usdcOut, fee) = getSellQuote(pgoldIn);
        require(usdcOut >= minUSDCOut, "Swap: slippage");
        require(usdcOut <= reserveUSDC, "Swap: insufficient reserve");

        // 扣 pGOLD
        pGOLD.transferFrom(msg.sender, address(this), pgoldIn);

        // 手续费直接转给 Treasury，FeeRouter 仅做分配记账
        USDC.safeTransfer(address(feeRouter.treasury()), fee);
        feeRouter.routeFee(fee);

        // 更新储备
        reservePGOLD += pgoldIn;
        reserveUSDC -= (usdcOut + fee);
        constantProduct = reserveUSDC * reservePGOLD;

        // 发 USDC
        USDC.safeTransfer(msg.sender, usdcOut);

        // 记录
        totalVolumeUSDC += (usdcOut + fee);
        totalFeesCollected += fee;
        totalSwapCount++;
        lastPrice = ((usdcOut + fee) * 1e20) / pgoldIn;

        emit Swapped(
            msg.sender, SwapDirection.SELL, pgoldIn, usdcOut + fee,
            lastPrice, fee, block.timestamp, totalSwapCount
        );
    }

    // ──────────────────────────────────────────────
    // 初始流动性注入（一次性）
    // ──────────────────────────────────────────────
    function initializePool(uint256 usdcAmount, uint256 pgoldAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(reserveUSDC == 0 && reservePGOLD == 0, "Swap: already initialized");
        require(usdcAmount > 0 && pgoldAmount > 0, "Swap: zero amount");

        USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);
        pGOLD.transferFrom(msg.sender, address(this), pgoldAmount);

        reserveUSDC = usdcAmount;
        reservePGOLD = pgoldAmount;
        constantProduct = reserveUSDC * reservePGOLD;
        lastPrice = (usdcAmount * 1e20) / pgoldAmount;

        emit LiquidityAdded(msg.sender, usdcAmount, pgoldAmount, 0);
    }

    // ──────────────────────────────────────────────
    // 添加流动性
    // ──────────────────────────────────────────────
    function addLiquidity(uint256 usdcAmount, uint256 pgoldAmount) external nonReentrant {
        require(reserveUSDC > 0, "Swap: pool not initialized");
        require(usdcAmount > 0 && pgoldAmount > 0, "Swap: zero amount");

        USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);
        pGOLD.transferFrom(msg.sender, address(this), pgoldAmount);

        reserveUSDC += usdcAmount;
        reservePGOLD += pgoldAmount;
        constantProduct = reserveUSDC * reservePGOLD;

        emit LiquidityAdded(msg.sender, usdcAmount, pgoldAmount, 0);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    function getReserves() external view returns (uint256 usdc, uint256 pgold, uint256 k) {
        return (reserveUSDC, reservePGOLD, constantProduct);
    }

    function getStats() external view returns (
        uint256 volume, uint256 fees, uint256 swaps, uint256 price
    ) {
        return (totalVolumeUSDC, totalFeesCollected, totalSwapCount, lastPrice);
    }
}
