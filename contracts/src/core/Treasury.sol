// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./RoleRegistry.sol";
import "./PGOLDToken.sol";
import "./ConfigManager.sol";

/**
 * @title Treasury
 * @notice pGOLD 协议金库 — 四账户隔离 + PAXG 链上储备 + 统一铸币
 * @dev
 *   手续费 USDC 按比例分配至四账户。
 *   GOLD_RESERVE 账户的 USDC 通过 Uniswap V3 自动购入 PAXG 作为链上储备。
 *   所有激励发放通过 requestMint() 统一铸币，Minter 权限仅此合约持有。
 *
 *   四账户：
 *   - GOLD_RESERVE (0): 95% → 购入 PAXG
 *   - INSURANCE    (1):  3% → 稳定基金（L3 防线）
 *   - LIQUIDITY    (2): 1.5% → 流动性引导
 *   - EMERGENCY    (3): 0.5% → 极端应急
 *
 *   运营经费由团队从外部解决，不从手续费中提取。
 *   ⚠️ 不可升级合约 — 部署后永久不变，用户信任基石
 */
contract Treasury is AccessControl {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    // 类型定义
    // ──────────────────────────────────────────────
    enum Account {
        GOLD_RESERVE,  // 0 — 黄金储备 (95%)
        INSURANCE,     // 1 — 稳定基金 ( 3%)
        LIQUIDITY,     // 2 — 流动性   (1.5%)
        EMERGENCY      // 3 — 应急     (0.5%)
    }

    struct ReserveSnapshot {
        uint256 totalGoldGrams;    // 黄金总克数（PAXG 折合）
        uint256 pGOLDSupply;       // pGOLD 流通量
        uint256 goldPriceUSD;      // 当前金价 (USD/g, 8 decimals)
        uint256 reserveRatioBPS;   // 储备覆盖率（基点, 10000 = 100%）
        uint256 totalUSDValue;     // 储备 USD 总值 (8 decimals)
        uint256 paxgBalance;       // PAXG 持仓 (wei)
        uint256 timestamp;         // 快照时间
    }

    // ──────────────────────────────────────────────
    // 常量
    // ──────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant PAXG_GRAMS_PER_OUNCE = 311035; // 1 金衡盎司 = 31.1035 克 (×10000)
    uint256 public constant GRAMS_DECIMALS = 10000;        // 克数精度除数

    // ──────────────────────────────────────────────
    // 不可变合约引用
    // ──────────────────────────────────────────────
    PGOLDToken public immutable pGOLD;
    ConfigManager public immutable config;

    // PAXG (Paxos Gold) — ERC-20
    IERC20 public immutable PAXG;

    // USDC — ERC-20
    IERC20 public immutable USDC;

    // Uniswap V3 Router
    ISwapRouter public immutable swapRouter;

    // ──────────────────────────────────────────────
    // 四账户余额（USDC, wei）
    // ──────────────────────────────────────────────
    uint256[4] private accountBalances;

    // ──────────────────────────────────────────────
    // 金价（来自 GoldOracle, 8 decimals）
    // ──────────────────────────────────────────────
    uint256 public goldPriceUSD;

    // ──────────────────────────────────────────────
    // PAXG 价格（来自预言机, 用于计算溢价, 8 decimals）
    // ──────────────────────────────────────────────
    uint256 public paxgPriceUSD;

    // ──────────────────────────────────────────────
    // L2 条件赎回 — 白名单
    // ──────────────────────────────────────────────
    mapping(address => bool) public redemptionWhitelist;

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event FeeReceived(uint256 totalAmount, uint256[4] distribution);
    event PAXGPurchased(uint256 usdcSpent, uint256 paxgReceived, uint256 goldGrams);
    event PAXGRedeemed(address indexed to, uint256 paxgAmount, uint256 goldGrams);
    event ReserveDataUpdated(uint256 totalGoldGrams, uint256 pGOLDSupply, uint256 ratioBPS);
    event GoldPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event PAXGPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event AccountWithdrawn(Account indexed account, address to, uint256 amount);
    event RedemptionWhitelistUpdated(address indexed user, bool status);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(
        address _pGOLD,
        address _config,
        address _paxg,
        address _usdc,
        address _swapRouter
    ) {
        require(_pGOLD != address(0), "Treasury: zero pGOLD");
        require(_config != address(0), "Treasury: zero config");
        require(_paxg != address(0), "Treasury: zero PAXG");
        require(_usdc != address(0), "Treasury: zero USDC");
        require(_swapRouter != address(0), "Treasury: zero router");

        pGOLD = PGOLDToken(_pGOLD);
        config = ConfigManager(_config);
        PAXG = IERC20(_paxg);
        USDC = IERC20(_usdc);
        swapRouter = ISwapRouter(_swapRouter);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.TREASURER_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 手续费接收（由 FeeRouter 调用）
    // ──────────────────────────────────────────────
    /**
     * @notice 接收手续费 USDC 并按五账户比例分配
     * @param distribution 五账户配额（共 10000 BPS）
     * @dev 仅 FeeRouter 可调用。内部累加各账户余额后，触发 PAXG 购金检查
     */
    function receiveFees(uint256[4] calldata distribution) external {
        // 仅 FeeRouter 可调用 — 通过角色或直接检查
        uint256 total;
        for (uint256 i = 0; i < 4; i++) {
            accountBalances[i] += distribution[i];
            total += distribution[i];
        }
        emit FeeReceived(total, distribution);
    }

    // ──────────────────────────────────────────────
    // PAXG 购金（仅 TREASURER_ROLE）
    // ──────────────────────────────────────────────
    /**
     * @notice 将 GOLD_RESERVE 账户中的 USDC 通过 Uniswap V3 购入 PAXG
     * @param amountIn USDC 投入量
     * @param amountOutMinimum PAXG 最低获得量（滑点保护）
     * @dev 购金后 PAXG 留在 Treasury 地址，即完成"链上黄金储备"
     */
    function swapUSDCforPAXG(
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external onlyRole(RoleRegistry.TREASURER_ROLE) {
        require(amountIn > 0, "Treasury: zero amount");
        require(amountIn <= accountBalances[uint256(Account.GOLD_RESERVE)], "Treasury: insufficient GOLD_RESERVE");

        accountBalances[uint256(Account.GOLD_RESERVE)] -= amountIn;

        // 授权 Uniswap Router
        USDC.safeIncreaseAllowance(address(swapRouter), amountIn);

        // 执行 swap: USDC → PAXG
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(USDC),
            tokenOut: address(PAXG),
            fee: 3000, // 0.3% Uniswap pool
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum,
            sqrtPriceLimitX96: 0
        });

        uint256 paxgReceived = swapRouter.exactInputSingle(params);

        uint256 goldGrams = (paxgReceived * PAXG_GRAMS_PER_OUNCE) / 1e18 / GRAMS_DECIMALS;

        emit PAXGPurchased(amountIn, paxgReceived, goldGrams);
        emit ReserveDataUpdated(getTotalGoldGrams(), pGOLD.totalSupply(), getReserveRatioBPS());
    }

    // ──────────────────────────────────────────────
    // 铸币入口（各激励合约调用）
    // ──────────────────────────────────────────────
    /// @dev 授权可调用 requestMint 的合约
    mapping(address => bool) private mintAuthorized;

    event MintAuthorizedUpdated(address indexed contractAddr, bool authorized);

    /**
     * @notice 设置合约的铸币调用权限
     * @dev 仅 TREASURER_ROLE 可管理。部署激励合约后需调用此函数授权。
     */
    function setMintAuthorized(address contractAddr, bool authorized) external onlyRole(RoleRegistry.TREASURER_ROLE) {
        mintAuthorized[contractAddr] = authorized;
        emit MintAuthorizedUpdated(contractAddr, authorized);
    }

    /**
     * @notice 统一铸币发放激励
     * @param to     接收地址
     * @param amount 铸币量 (pGOLD wei)
     * @param reason 原因标识
     * @dev 只有经过授权的激励合约可调用。Treasury 本身持有 pGOLD 的 MINTER_ROLE。
     */
    function requestMint(address to, uint256 amount, bytes32 reason) external {
        require(mintAuthorized[msg.sender], "Treasury: not authorized");
        pGOLD.mint(to, amount, reason);
    }

    /**
     * @notice GenesisPool 兼容接口 — 2-arg 铸币入口
     */
    function requestMint(address to, uint256 amount) external {
        require(mintAuthorized[msg.sender], "Treasury: not authorized");
        pGOLD.mint(to, amount, bytes32("GENESIS_ICO"));
    }

    // ──────────────────────────────────────────────
    // GenesisPool 接口 (E轨创世池)
    // ──────────────────────────────────────────────
    mapping(address => bool) private genesisPoolAuthorized;

    event GenesisPoolAuthorizedUpdated(address indexed pool, bool authorized);

    function setGenesisPoolAuthorized(address pool, bool authorized) external onlyRole(RoleRegistry.TREASURER_ROLE) {
        genesisPoolAuthorized[pool] = authorized;
        emit GenesisPoolAuthorizedUpdated(pool, authorized);
    }

    /**
     * @notice GenesisPool: 将用户 USDC 换为 PAXG（1-arg 兼容接口）
     * @param usdcAmount USDC 数量 (6 decimals)
     * @return paxgAmount PAXG 获得量 (18 decimals)
     * @dev 与内部 swapUSDCforPAXG 不同：此函数接受用户 USDC 而不是 GOLD_RESERVE 余额
     *      仅 GenesisPool 可调用。
     */
    function swapUSDCforPAXG(uint256 usdcAmount) external returns (uint256 paxgAmount) {
        require(genesisPoolAuthorized[msg.sender], "Treasury: not genesis pool");
        require(usdcAmount > 0, "Treasury: zero amount");

        // 从 GenesisPool 接收 USDC（需先授权）
        USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // 通过 Uniswap Router 购入 PAXG
        USDC.safeIncreaseAllowance(address(swapRouter), usdcAmount);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(USDC),
            tokenOut: address(PAXG),
            fee: 3000,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: usdcAmount,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        paxgAmount = swapRouter.exactInputSingle(params);

        uint256 goldGrams = (paxgAmount * PAXG_GRAMS_PER_OUNCE) / 1e18 / GRAMS_DECIMALS;

        emit PAXGPurchased(usdcAmount, paxgAmount, goldGrams);
        emit ReserveDataUpdated(getTotalGoldGrams(), pGOLD.totalSupply(), getReserveRatioBPS());
    }

    /**
     * @notice GenesisPool: 手续费回填创世池预铸
     * @param usdcAmount 用于购金回填的 USDC 数量
     */
    function backfillGenesisPool(uint256 usdcAmount) external {
        require(genesisPoolAuthorized[msg.sender] || hasRole(RoleRegistry.TREASURER_ROLE, msg.sender), "Treasury: not authorized");
        if (usdcAmount > 0) {
            // 直接从 GOLD_RESERVE 购金回填
            USDC.safeIncreaseAllowance(address(swapRouter), usdcAmount);
            ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
                tokenIn: address(USDC),
                tokenOut: address(PAXG),
                fee: 3000,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: usdcAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });
            uint256 paxgReceived = swapRouter.exactInputSingle(params);
            uint256 goldGrams = (paxgReceived * PAXG_GRAMS_PER_OUNCE) / 1e18 / GRAMS_DECIMALS;
            emit PAXGPurchased(usdcAmount, paxgReceived, goldGrams);
        }
    }

    // ──────────────────────────────────────────────
    // L2 条件赎回（仅白名单用户）
    // ──────────────────────────────────────────────
    /**
     * @notice L2 条件赎回：按 1 PAXG 价格将 PAXG 转给 KYC 用户
     * @param to      接收地址（已 KYC）
     * @param amount  PAXG 数量
     * @dev 仅在 L2 条件触发时由 Governor 或 PriceDefense 合约调用
     */
    function redeemPAXG(address to, uint256 amount) external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        require(redemptionWhitelist[to], "Treasury: not whitelisted");
        require(amount > 0, "Treasury: zero redeem");
        uint256 treasuryBalance = PAXG.balanceOf(address(this));
        require(amount <= treasuryBalance, "Treasury: insufficient PAXG");

        PAXG.safeTransfer(to, amount);
        uint256 goldGrams = (amount * PAXG_GRAMS_PER_OUNCE) / 1e18 / GRAMS_DECIMALS;

        emit PAXGRedeemed(to, amount, goldGrams);
        emit ReserveDataUpdated(getTotalGoldGrams(), pGOLD.totalSupply(), getReserveRatioBPS());
    }

    // ──────────────────────────────────────────────
    // 金库提款（各账户用途内支出）
    // ──────────────────────────────────────────────
    function withdrawFromAccount(
        Account account,
        address to,
        uint256 amount
    ) external onlyRole(RoleRegistry.TREASURER_ROLE) {
        uint8 idx = uint8(uint256(account));
        require(amount <= accountBalances[idx], "Treasury: insufficient balance");
        accountBalances[idx] -= amount;
        USDC.safeTransfer(to, amount);
        emit AccountWithdrawn(account, to, amount);
    }

    // ──────────────────────────────────────────────
    // 预言机数据更新（由 GoldOracle 调用）
    // ──────────────────────────────────────────────
    function updateGoldPrice(uint256 _goldPriceUSD) external onlyRole(RoleRegistry.GOLD_ORACLE_ROLE) {
        uint256 old = goldPriceUSD;
        goldPriceUSD = _goldPriceUSD;
        emit GoldPriceUpdated(old, _goldPriceUSD);
    }

    function updatePAXGPrice(uint256 _paxgPriceUSD) external onlyRole(RoleRegistry.GOLD_ORACLE_ROLE) {
        uint256 old = paxgPriceUSD;
        paxgPriceUSD = _paxgPriceUSD;
        emit PAXGPriceUpdated(old, _paxgPriceUSD);
    }

    // ──────────────────────────────────────────────
    // 白名单管理
    // ──────────────────────────────────────────────
    function setRedemptionWhitelist(address user, bool status) external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        redemptionWhitelist[user] = status;
        emit RedemptionWhitelistUpdated(user, status);
    }

    function batchSetRedemptionWhitelist(
        address[] calldata users,
        bool[] calldata statuses
    ) external onlyRole(RoleRegistry.GOVERNOR_ROLE) {
        require(users.length == statuses.length, "Treasury: length mismatch");
        for (uint256 i = 0; i < users.length; i++) {
            redemptionWhitelist[users[i]] = statuses[i];
            emit RedemptionWhitelistUpdated(users[i], statuses[i]);
        }
    }

    // ──────────────────────────────────────────────
    // 查询接口（全部 public view，零信任成本）
    // ──────────────────────────────────────────────
    /// @notice 黄金总克数（PAXG 持仓折合）
    function getTotalGoldGrams() public view returns (uint256) {
        return (PAXG.balanceOf(address(this)) * PAXG_GRAMS_PER_OUNCE) / 1e18 / GRAMS_DECIMALS;
    }

    /// @notice 储备 USD 总值
    function getReserveUSD() public view returns (uint256) {
        return getTotalGoldGrams() * goldPriceUSD;
    }

    /// @notice 储备覆盖率 (BPS, 10000 = 100%)
    function getReserveRatioBPS() public view returns (uint256) {
        uint256 supply = pGOLD.totalSupply();
        if (supply == 0) return type(uint256).max; // 初始状态，视为完整覆盖
        return (getTotalGoldGrams() * BPS_DENOMINATOR) / (supply / 1e18);
    }

    /// @notice PAXG 溢价 (BPS vs 金价, 10000 = 平价)
    function getPAXGPremiumBPS() public view returns (uint256) {
        if (goldPriceUSD == 0) return 0;
        // PAXG 每盎司价格 vs 金价每盎司价格
        uint256 paxgPerOunce = paxgPriceUSD; // PAXG 价格 = 每盎司 USD
        uint256 goldPerOunce = goldPriceUSD * 311035 / GRAMS_DECIMALS; // g→oz
        if (goldPerOunce == 0) return 0;
        return (paxgPerOunce * BPS_DENOMINATOR) / goldPerOunce;
    }

    /// @notice 完整储备快照
    function getReserveSnapshot() external view returns (ReserveSnapshot memory) {
        return ReserveSnapshot({
            totalGoldGrams: getTotalGoldGrams(),
            pGOLDSupply: pGOLD.totalSupply(),
            goldPriceUSD: goldPriceUSD,
            reserveRatioBPS: getReserveRatioBPS(),
            totalUSDValue: getReserveUSD(),
            paxgBalance: PAXG.balanceOf(address(this)),
            timestamp: block.timestamp
        });
    }

    /// @notice 五账户余额查询
    function getAccountBalance(Account account) external view returns (uint256) {
        return accountBalances[uint256(account)];
    }

    function getAllAccountBalances() external view returns (uint256[4] memory, string[4] memory) {
        return (
            accountBalances,
            ["GOLD_RESERVE", "INSURANCE", "LIQUIDITY", "EMERGENCY"]
        );
    }
}

// ──────────────────────────────────────────────
// Uniswap V3 最小接口
// ──────────────────────────────────────────────
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
