// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GenesisPool — E轨 · 创世池
 * @dev 感谢协议最早的信仰者。ICO认购 + 阶梯权重 + 3年线性释放。
 *
 * 核心设计:
 * - 用户USDC全额购PAXG → 获得1:1完全背书的pGOLD（通过ITreasury.mintBacked）
 * - 创世池200K pGOLD预铸 → 按阶梯权重分配给ICO参与者
 * - 阶梯权重: D1-30=10x, D31-60=7x, D61-90=4x, D91-180=2x
 * - 释放: 3年线性，每季度1/12
 * - 个人硬顶: $85,000 = 1,000 pGOLD
 * - 不互斥: 与A/B/C/D轨独立叠加
 *
 * 预铸pGOLD的背书: 未来手续费收入的15%逐步购买PAXG填补预铸坑
 * （由Treasury的backfillFromFees机制执行，不在本合约内）
 */
contract GenesisPool is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    uint256 public constant POOL_TOTAL = 200_000e18;      // 200K pGOLD genesis pool
    uint256 public constant CAP_PER_USER = 1_000e18;      // max 1,000 pGOLD per user
    uint256 public constant VEST_YEARS = 3;
    uint256 public constant VEST_STEPS = 12;               // quarterly vesting
    uint256 public constant USDC_DECIMALS = 1e6;
    uint256 public constant PGOLD_PER_GRAM = 1e18;

    // ──────────────────────────────────────────────
    // Tier weights
    // ──────────────────────────────────────────────
    enum Tier { NONE, PIONEER, EARLY, BUILDER, SUPPORTER }

    function _tierWeight(Tier t) internal pure returns (uint256) {
        if (t == Tier.PIONEER)   return 10;
        if (t == Tier.EARLY)     return 7;
        if (t == Tier.BUILDER)   return 4;
        if (t == Tier.SUPPORTER) return 2;
        return 0;
    }

    // ──────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────
    IERC20 public usdc;             // USDC token
    IERC20 public paxg;             // PAXG (gold reserve)
    address public treasury;        // Treasury contract
    address public goldOracle;      // Gold price oracle
    address public vestingManager;  // Vesting engine

    uint256 public startTime;       // ICO start timestamp
    uint256 public endTime;         // ICO end = startTime + 180 days
    bool public claimed;            // Snapshot calculated + pool locked

    uint256 public totalUsdcRaised;
    uint256 public totalPgoldMinted;
    uint256 public totalScore;      // sum of all weight scores
    uint256 public participants;    // unique participant count
    uint256 public totalPoolAllocated; // cumulative genesis pool pGOLD allocated

    struct Subscription {
        uint256 usdcAmount;         // USDC deposited
        uint256 goldGrams;          // PAXG purchased (troy ounces × 31.1035)
        uint256 backedPgold;        // 1:1 gold-backed pGOLD minted
        Tier    tier;               // entry tier
        uint256 weight;             // tier weight multiplier at entry
        uint256 score;              // backedPgold × weight
        uint256 poolAllocation;     // genesis pool pGOLD allocated (set at claim)
        uint256 claimedPgold;       // genesis pool pGOLD already claimed
        uint256 lastClaimBlock;     // last vesting claim block
    }
    mapping(address => Subscription) public subs;

    // ──────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────
    event Subscribed(address indexed user, uint256 usdcAmount, uint256 backedPgold, Tier tier, uint256 score);
    event PoolClaimed(address indexed user, uint256 poolAllocation);
    event VestingClaimed(address indexed user, uint256 amount);
    event ICOClosed(uint256 totalUsdc, uint256 totalPgold, uint256 participants);
    event SnapshotFinalized();

    // ──────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────
    constructor(
        address _usdc,
        address _paxg,
        address _admin
    ) {
        require(_usdc != address(0), "Invalid USDC");
        require(_paxg != address(0), "Invalid PAXG");
        require(_admin != address(0), "Invalid admin");
        usdc = IERC20(_usdc);
        paxg = IERC20(_paxg);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNOR_ROLE, _admin);
    }

    // ──────────────────────────────────────────────
    // Governance: start ICO
    // ──────────────────────────────────────────────
    function initializeICO(
        address _treasury,
        address _goldOracle,
        address _vestingManager
    ) external onlyRole(GOVERNOR_ROLE) {
        require(startTime == 0, "Already initialized");
        require(_treasury != address(0) && _goldOracle != address(0) && _vestingManager != address(0), "Zero address");
        treasury = _treasury;
        goldOracle = _goldOracle;
        vestingManager = _vestingManager;
        startTime = block.timestamp;
        endTime = startTime + 180 days;
    }

    // ──────────────────────────────────────────────
    // Core: subscribe (ICO participation)
    // ──────────────────────────────────────────────
    function subscribe(uint256 usdcAmount) external nonReentrant {
        require(startTime > 0 && block.timestamp < endTime, "ICO: not active");
        require(!claimed, "ICO: snapshot finalized");
        require(usdcAmount > 0, "Amount zero");

        Subscription storage sub = subs[msg.sender];
        require(sub.backedPgold == 0, "Already subscribed"); // one entry per address

        // Determine tier from block timestamp
        uint256 elapsed = block.timestamp - startTime;
        Tier tier;
        if (elapsed <= 30 days) {
            tier = Tier.PIONEER;
        } else if (elapsed <= 60 days) {
            tier = Tier.EARLY;
        } else if (elapsed <= 90 days) {
            tier = Tier.BUILDER;
        } else {
            tier = Tier.SUPPORTER;
        }
        uint256 weight = _tierWeight(tier);

        // Estimate gold grams from oracle price (for cap check)
        // USDC(6dec) × 1e30 ÷ goldPrice(18dec) → grams in 18 decimal
        //   = usdc(6dec) × 1e12 / goldPrice(18dec) × 1e18
        //   $8,500 × 1e30 / (85 × 1e18) = 100 × 1e18 = 100 g in 18-dec
        uint256 goldPrice = _getGoldPrice();
        uint256 goldGramsEstimate = (usdcAmount * 1e30) / goldPrice;

        // Cap check
        require(goldGramsEstimate <= CAP_PER_USER, "ICO: exceeds personal cap");

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Approve then swap USDC for PAXG via Treasury
        usdc.safeIncreaseAllowance(treasury, usdcAmount);
        uint256 paxgReceived = ITreasury(treasury).swapUSDCforPAXG(usdcAmount);

        // Calculate actual gold purchased (in grams, 18 decimals)
        // PAXG has 18 decimals, 1 PAXG = 1 troy oz = 31.1035 grams
        uint256 actualGoldGrams = (paxgReceived * 311035) / 10000; // × 31.1035

        // Calculate score from ACTUAL gold grams after swap (not estimate)
        uint256 score = (actualGoldGrams * weight) / 1e18;

        // Mint backed pGOLD via Treasury → delivered to user
        ITreasury(treasury).requestMint(msg.sender, actualGoldGrams);

        // Store subscription
        sub.usdcAmount = usdcAmount;
        sub.goldGrams = actualGoldGrams;
        sub.backedPgold = actualGoldGrams;
        sub.tier = tier;
        sub.weight = weight;
        sub.score = score;

        totalUsdcRaised += usdcAmount;
        totalPgoldMinted += actualGoldGrams;
        totalScore += score;
        participants++;

        emit Subscribed(msg.sender, usdcAmount, actualGoldGrams, tier, score);
    }

    // ──────────────────────────────────────────────
    // Governance: finalize snapshot (after 180d)
    // ──────────────────────────────────────────────
    function finalizeSnapshot() external onlyRole(GOVERNOR_ROLE) nonReentrant {
        require(block.timestamp >= endTime, "ICO: not ended");
        require(!claimed, "Already finalized");
        claimed = true;
        emit SnapshotFinalized();
    }

    // ──────────────────────────────────────────────
    // Core: claim pool allocation (called once per user after snapshot)
    // ──────────────────────────────────────────────
    function claimPoolAllocation() external nonReentrant {
        require(claimed, "Snapshot not finalized");
        Subscription storage sub = subs[msg.sender];
        require(sub.backedPgold > 0, "Not a participant");
        require(sub.poolAllocation == 0, "Already claimed allocation");

        uint256 totalPool = POOL_TOTAL;
        if (totalScore > 0) {
            sub.poolAllocation = (totalPool * sub.score) / totalScore;
        }
        require(totalPoolAllocated + sub.poolAllocation <= POOL_TOTAL, "GenesisPool: pool exhausted");
        totalPoolAllocated += sub.poolAllocation;

        // Queue vesting: 3yr quarterly linear release via VestingManager
        IVestingManager(vestingManager).createVestingSchedule(
            msg.sender,
            sub.poolAllocation,
            block.timestamp,
            VEST_YEARS * 365 days,
            VEST_STEPS
        );

        emit PoolClaimed(msg.sender, sub.poolAllocation);
    }

    // ──────────────────────────────────────────────
    // View: pending claimable (delegated to VestingManager)
    // ──────────────────────────────────────────────
    function pendingClaimable(address user) external view returns (uint256) {
        return IVestingManager(vestingManager).claimable(user);
    }

    // ──────────────────────────────────────────────
    // View: user info
    // ──────────────────────────────────────────────
    function getUserInfo(address user) external view returns (
        uint256 usdcAmount,
        uint256 backedPgold,
        uint256 poolAllocation,
        uint256 vested,
        uint256 pending,
        Tier tier,
        uint256 weight
    ) {
        Subscription memory sub = subs[user];
        tier = sub.tier;
        weight = sub.weight;
        usdcAmount = sub.usdcAmount;
        backedPgold = sub.backedPgold;
        poolAllocation = sub.poolAllocation;
        if (sub.poolAllocation > 0 && vestingManager != address(0)) {
            (vested, pending) = IVestingManager(vestingManager).getVestingState(user);
        }
    }

    // ──────────────────────────────────────────────
    // View: ICO stats
    // ──────────────────────────────────────────────
    function getICOStats() external view returns (
        uint256 _totalUsdc,
        uint256 _totalPgoldMinted,
        uint256 _totalScore,
        uint256 _participants,
        uint256 _timeRemaining,
        bool _active
    ) {
        _totalUsdc = totalUsdcRaised;
        _totalPgoldMinted = totalPgoldMinted;
        _totalScore = totalScore;
        _participants = participants;
        _active = (startTime > 0 && block.timestamp < endTime && !claimed);
        _timeRemaining = _active ? (endTime - block.timestamp) : 0;
    }

    // ──────────────────────────────────────────────
    // Internal: get gold price from oracle
    // ──────────────────────────────────────────────
    function _getGoldPrice() internal view returns (uint256) {
        // GoldOracle returns price in USD per gram, 18 decimals
        (uint256 price, ) = IGoldOracle(goldOracle).getGoldPrice();
        return price;
    }

    // ──────────────────────────────────────────────
    // Governance: emergency pause subscription
    // ──────────────────────────────────────────────
    function emergencyStop() external onlyRole(GOVERNOR_ROLE) {
        endTime = block.timestamp;
        emit ICOClosed(totalUsdcRaised, totalPgoldMinted, participants);
    }
}

// ──────────────────────────────────────────────
// Minimal interfaces
// ──────────────────────────────────────────────
interface ITreasury {
    function swapUSDCforPAXG(uint256 usdcAmount) external returns (uint256 paxgAmount);
    function requestMint(address to, uint256 pgoldAmount) external;
    function backfillGenesisPool(uint256 usdcAmount) external;
}

interface IGoldOracle {
    function getGoldPrice() external view returns (uint256 price, uint256 updatedAt);
    function getPAXGPremium() external view returns (int256 premiumBPS);
}

interface IVestingManager {
    function createVestingSchedule(address user, uint256 amount, uint256 start, uint256 duration, uint256 steps) external returns (uint256 scheduleId);
    function claimable(address user) external view returns (uint256);
    function getVestingState(address user) external view returns (uint256 vested, uint256 pending);
}
