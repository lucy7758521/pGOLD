// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "../core/RoleRegistry.sol";
import "../core/ConfigManager.sol";
import "./VestingManager.sol";

/**
 * @title RankingRewards
 * @notice B 轨：排名激励 — 月/季/年 Top 100，10 年线性释放
 * @dev
 *   基于 PGOLDSwap 交易量的排名激励：
 *   - 月榜 Top 100：300% 奖励基数
 *   - 季榜 Top 100：500% 奖励基数
 *   - 年榜 Top 100：1000% 奖励基数
 *
 *   递进覆盖：年榜吸收季榜+月榜，季榜吸收月榜。不叠加。
 *   硬顶：年榜 1000%
 *
 *   奖励基数 = 存入量 × 倍数（排名是门票，存入量决定奖励基数）
 *   后端计算排名+Merkle 树 → 用户 Merkle Proof 领取
 */
contract RankingRewards is AccessControl, ReentrancyGuard {
    // ──────────────────────────────────────────────
    // 类型
    // ──────────────────────────────────────────────
    enum RankPeriod { MONTHLY, QUARTERLY, ANNUAL }

    struct RankingRound {
        bytes32 merkleRoot;
        RankPeriod period;
        uint256 timestamp;
        uint256 multiplier;         // 奖励倍数（基点）
        uint256 totalRewardBase;    // 总奖励基数
        bool finalized;
    }

    struct UserStake {
        uint256 amount;             // 存入量（决定奖励基数）
        bool active;
    }

    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    ConfigManager public immutable config;
    VestingManager public immutable vestingManager;

    // ──────────────────────────────────────────────
    // 状态
    // ──────────────────────────────────────────────
    uint256 public totalStaked;
    uint256 public totalRewardsDistributed;

    RankingRound[] public rounds;
    mapping(address => UserStake) public userStakes;

    // 防重入
    mapping(address => mapping(uint256 => bool)) public claimed;

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event StakeDeposited(address indexed user, uint256 amount);
    event StakeWithdrawn(address indexed user, uint256 amount);
    event RoundCreated(uint256 indexed roundId, RankPeriod period, bytes32 merkleRoot, uint256 multiplier);
    event RewardClaimed(
        address indexed user, uint256 roundId, RankPeriod period,
        uint256 rewardBase, uint256 totalReward, uint256 vestingId
    );

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _config, address _vestingManager) {
        require(_config != address(0), "Rank: zero config");
        config = ConfigManager(_config);
        vestingManager = VestingManager(_vestingManager);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.RANKING_ORACLE_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 存入（决定奖励基数）
    // ──────────────────────────────────────────────
    /**
     * @notice 存入 pGOLD 确定奖励基数
     * @param amount 存入量 — 排名是门票，存入量决定赚多少
     * @dev 存入越多，同等排名下奖励越高
     */
    function depositStake(uint256 amount) external nonReentrant {
        require(amount > 0, "Rank: zero");
        userStakes[msg.sender].amount += amount;
        userStakes[msg.sender].active = true;
        totalStaked += amount;
        emit StakeDeposited(msg.sender, amount);
    }

    function withdrawStake(uint256 amount) external nonReentrant {
        UserStake storage s = userStakes[msg.sender];
        require(s.active, "Rank: not active");
        require(s.amount >= amount, "Rank: insufficient");
        s.amount -= amount;
        totalStaked -= amount;
        if (s.amount == 0) s.active = false;
        emit StakeWithdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    // 创建排名轮次（后端提交 Merkle Root）
    // ──────────────────────────────────────────────
    function createRound(
        RankPeriod period,
        bytes32 merkleRoot
    ) external onlyRole(RoleRegistry.RANKING_ORACLE_ROLE) returns (uint256) {
        uint256 multiplier;
        if (period == RankPeriod.MONTHLY) {
            multiplier = config.monthlyMultiplier();      // 300
        } else if (period == RankPeriod.QUARTERLY) {
            multiplier = config.quarterlyMultiplier();    // 500
        } else {
            multiplier = config.annualMultiplier();       // 1000
        }

        uint256 roundId = rounds.length;
        rounds.push(RankingRound({
            merkleRoot: merkleRoot,
            period: period,
            timestamp: block.timestamp,
            multiplier: multiplier,
            totalRewardBase: 0,
            finalized: false
        }));

        emit RoundCreated(roundId, period, merkleRoot, multiplier);
        return roundId;
    }

    // ──────────────────────────────────────────────
    // 领取排名奖励（Merkle Proof）
    // ──────────────────────────────────────────────
    /**
     * @notice 用户凭 Merkle Proof 领取排名奖励
     * @dev
     *   Merkle leaf = keccak256(user, rank, stakeAmount, isAbsorbed, absorbingRoundId)
     *   奖励 = 存入量 × 倍数（递进覆盖逻辑在后端计算，前端仅验证叶子）
     */
    function claimReward(
        uint256 roundId,
        uint256 rank,          // 排名 (1-100)
        uint256 stakeAmount,   // 存入量（后端取快照时的值）
        bool isAbsorbed,       // 是否被更高周期吸收（吸收后奖励为 0）
        uint256 absorbingRoundId, // 吸收此奖励的更高周期轮次 ID
        bytes32[] calldata proof
    ) external nonReentrant returns (uint256 vestingId) {
        require(roundId < rounds.length, "Rank: invalid round");
        require(!claimed[msg.sender][roundId], "Rank: already claimed");

        RankingRound storage round = rounds[roundId];

        bytes32 leaf = keccak256(
            abi.encodePacked(msg.sender, rank, stakeAmount, isAbsorbed, absorbingRoundId)
        );
        require(MerkleProof.verify(proof, round.merkleRoot, leaf), "Rank: invalid proof");

        claimed[msg.sender][roundId] = true;

        uint256 totalReward;
        if (!isAbsorbed) {
            // 奖励 = 存入量 × 倍数
            totalReward = (stakeAmount * round.multiplier) / 100;
        }
        // isAbsorbed = true → totalReward = 0，已被更高周期吸收

        round.totalRewardBase += totalReward;
        totalRewardsDistributed += totalReward;

        if (totalReward > 0) {
            uint256 vestingYears = config.rankingVestingYears(); // 10
            uint256 duration = vestingYears * 365 days;

            VestingManager.ScheduleType sType;
            if (round.period == RankPeriod.MONTHLY) {
                sType = VestingManager.ScheduleType.RANKING_MONTHLY;
            } else if (round.period == RankPeriod.QUARTERLY) {
                sType = VestingManager.ScheduleType.RANKING_QUARTERLY;
            } else {
                sType = VestingManager.ScheduleType.RANKING_ANNUAL;
            }

            vestingId = vestingManager.createSchedule(
                msg.sender, totalReward, duration, sType
            );
        }

        emit RewardClaimed(msg.sender, roundId, round.period, stakeAmount, totalReward, vestingId);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    function getRoundCount() external view returns (uint256) {
        return rounds.length;
    }

    function getRound(uint256 roundId) external view returns (RankingRound memory) {
        return rounds[roundId];
    }

    function getStake(address user) external view returns (uint256 amount, bool active) {
        UserStake storage s = userStakes[user];
        return (s.amount, s.active);
    }
}
