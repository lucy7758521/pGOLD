// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "../core/RoleRegistry.sol";
import "../core/PGOLDToken.sol";
import "../core/ConfigManager.sol";
import "./VestingManager.sol";

/**
 * @title BurnMining
 * @notice C 轨：燃烧挖矿 — 手续费补偿 1000%，10 年线性释放
 * @dev
 *   用户在本协议 PGOLDSwap 中交易产生的手续费，
 *   协议补偿手续费额的 1000%（纯铸币），分 10 年线性释放。
 *
 *   流程：
 *   1. 用户质押资格保证金（burn stake），参与燃烧挖矿
 *   2. 后端统计用户累计手续费（USDC），按金价换算为 pGOLD，生成 Merkle 树
 *   3. 协议提交 Merkle Root → 用户 Merkle Proof 领取补偿
 *   4. 补偿通过 VestingManager 创建 10 年线性释放计划
 *
 *   资格保证金锁定期满后可全额取回。
 */
contract BurnMining is AccessControl, ReentrancyGuard {
    // ──────────────────────────────────────────────
    // 类型
    // ──────────────────────────────────────────────
    struct BurnStake {
        uint256 amount;        // 锁定量
        uint256 lockUntil;     // 解锁时间
        bool active;
    }

    struct CompensationRound {
        bytes32 merkleRoot;
        uint256 timestamp;
        uint256 totalCompensation; // 本轮总补偿量
        bool finalized;
    }

    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    PGOLDToken public immutable pGOLD;
    ConfigManager public immutable config;
    VestingManager public immutable vestingManager;

    // ──────────────────────────────────────────────
    // 状态
    // ──────────────────────────────────────────────
    uint256 public totalStaked;
    uint256 public totalCompensationDistributed;

    // 补偿上限（链上强制，防超额铸币）
    uint256 public maxCompPerRound;    // 单轮补偿上限 (pGOLD, wei)
    uint256 public maxTotalComp;       // 累计补偿上限 (pGOLD, wei)

    mapping(address => BurnStake) public burnStakes;
    CompensationRound[] public rounds;

    // 防重入：用户/轮次 → 已领取
    mapping(address => mapping(uint256 => bool)) public claimed;

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event StakeLocked(address indexed user, uint256 amount, uint256 lockUntil);
    event StakeWithdrawn(address indexed user, uint256 amount);
    event RoundCreated(uint256 indexed roundId, bytes32 merkleRoot);
    event CompensationCapsUpdated(uint256 maxPerRound, uint256 maxTotal);
    event CompensationClaimed(
        address indexed user, uint256 roundId, uint256 loss, uint256 compensation, uint256 vestingId
    );

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _pGOLD, address _config, address _vestingManager) {
        require(_pGOLD != address(0), "Burn: zero pGOLD");
        pGOLD = PGOLDToken(_pGOLD);
        config = ConfigManager(_config);
        vestingManager = VestingManager(_vestingManager);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.RANKING_ORACLE_ROLE, msg.sender);

        // 默认上限（可由 GOVERNOR 调整）：
        // 单轮 ≤ 50,000 pGOLD（≈$4.25M），累计 ≤ 6,000,000 pGOLD（≈$510M）
        maxCompPerRound = 50000 ether;
        maxTotalComp = 6000000 ether;
    }

    // ──────────────────────────────────────────────
    // 质押资格保证金
    // ──────────────────────────────────────────────
    /**
     * @notice 质押 pGOLD 获取燃烧挖矿资格
     * @param amount 质押量（必须 ≥ 最低要求）
     */
    function lockStake(uint256 amount) external nonReentrant {
        require(amount >= 100e18, "Burn: below minimum"); // 最低 100 pGOLD
        require(!burnStakes[msg.sender].active, "Burn: already active");

        uint256 minDays = config.burnMinHoldingDays();
        uint256 lockUntil = block.timestamp + (minDays * 1 days);

        pGOLD.transferFrom(msg.sender, address(this), amount);
        burnStakes[msg.sender] = BurnStake(amount, lockUntil, true);
        totalStaked += amount;

        emit StakeLocked(msg.sender, amount, lockUntil);
    }

    /**
     * @notice 追加质押
     */
    function addStake(uint256 amount) external nonReentrant {
        BurnStake storage s = burnStakes[msg.sender];
        require(s.active, "Burn: not active");
        pGOLD.transferFrom(msg.sender, address(this), amount);
        s.amount += amount;
        totalStaked += amount;
        emit StakeLocked(msg.sender, amount, s.lockUntil);
    }

    /**
     * @notice 取回资格保证金（锁定期满后）
     */
    function withdrawStake() external nonReentrant {
        BurnStake storage s = burnStakes[msg.sender];
        require(s.active, "Burn: not active");
        require(block.timestamp >= s.lockUntil, "Burn: still locked");

        uint256 amount = s.amount;
        s.amount = 0;
        s.active = false;
        totalStaked -= amount;

        pGOLD.transfer(msg.sender, amount);
        emit StakeWithdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    // SET: 补偿上限（治理可调）
    // ──────────────────────────────────────────────
    function setCompensationCaps(uint256 perRound, uint256 total) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxCompPerRound = perRound;
        maxTotalComp = total;
        emit CompensationCapsUpdated(perRound, total);
    }

    // ──────────────────────────────────────────────
    // 创建补偿轮次（后端 Merkle Root）
    // ──────────────────────────────────────────────
    function createRound(bytes32 merkleRoot) external onlyRole(RoleRegistry.RANKING_ORACLE_ROLE) returns (uint256) {
        uint256 roundId = rounds.length;
        rounds.push(CompensationRound({
            merkleRoot: merkleRoot,
            timestamp: block.timestamp,
            totalCompensation: 0,
            finalized: false
        }));
        emit RoundCreated(roundId, merkleRoot);
        return roundId;
    }

    // ──────────────────────────────────────────────
    // 领取补偿（Merkle Proof）
    // ──────────────────────────────────────────────
    /**
     * @notice 用户凭 Merkle Proof 领取燃烧挖矿补偿
     * @param roundId    补偿轮次 ID
     * @param loss       累计手续费换算的 pGOLD 金额 (wei)
     * @param proof      Merkle 证明
     * @return vestingId 释放计划 ID
     */
    function claimCompensation(
        uint256 roundId,
        uint256 loss,
        bytes32[] calldata proof
    ) external nonReentrant returns (uint256 vestingId) {
        require(roundId < rounds.length, "Burn: invalid round");
        require(!claimed[msg.sender][roundId], "Burn: already claimed");
        require(burnStakes[msg.sender].active, "Burn: no active stake");

        CompensationRound storage round = rounds[roundId];

        // 验证 Merkle Proof
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, loss));
        require(MerkleProof.verify(proof, round.merkleRoot, leaf), "Burn: invalid proof");

        claimed[msg.sender][roundId] = true;

        // 计算补偿：累计手续费 × 1000%
        uint256 compensationRate = config.burnCompensationRate(); // 1000
        uint256 compensation = (loss * compensationRate) / 100;    // loss × 10

        // 链上上限检查
        require(round.totalCompensation + compensation <= maxCompPerRound, "Burn: round cap exceeded");
        require(totalCompensationDistributed + compensation <= maxTotalComp, "Burn: total cap exceeded");

        round.totalCompensation += compensation;
        totalCompensationDistributed += compensation;

        // 创建 10 年线性释放计划
        uint256 vestingYears = config.burnVestingYears(); // 10
        uint256 duration = vestingYears * 365 days;
        vestingId = vestingManager.createSchedule(
            msg.sender,
            compensation,
            duration,
            VestingManager.ScheduleType.BURN_MINING
        );

        emit CompensationClaimed(msg.sender, roundId, loss, compensation, vestingId);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    function getRoundCount() external view returns (uint256) {
        return rounds.length;
    }

    function getRound(uint256 roundId) external view returns (CompensationRound memory) {
        return rounds[roundId];
    }

    function getBurnStake(address user) external view returns (uint256 amount, uint256 lockUntil, bool active) {
        BurnStake storage s = burnStakes[user];
        return (s.amount, s.lockUntil, s.active);
    }
}
