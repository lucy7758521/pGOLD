// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "../core/RoleRegistry.sol";
import "../core/ConfigManager.sol";
import "../core/Treasury.sol";

/**
 * @title TeamRewards
 * @notice D 轨：战队奖励 — 推荐返佣 + 战队竞赛（纯铸币，即时到账）
 * @dev
 *   D1 推荐返佣：
 *   - 直邀 20%（以被邀请人手续费为基准）
 *   - 间邀 5%
 *   - 邀请关系上链注册，返佣每周期通过 Merkle 树发放
 *
 *   D2 战队竞赛：
 *   - 月榜 Top N 战队（默认 10）
 *   - 奖励基数 = 战队总手续费 × teamBonusRate%
 *   - 分配：队长 30% + 队员按交易量比例 70%
 *
 *   所有奖励即时到账（不锁仓），纯铸币发放。
 */
contract TeamRewards is AccessControl, ReentrancyGuard {
    // ──────────────────────────────────────────────
    // 类型
    // ──────────────────────────────────────────────
    struct Team {
        uint256 id;
        address captain;
        string name;             // 战队名（仅用于展示）
        uint256 memberCount;     // 成员数
        uint256 createdAt;
        bool active;
    }

    struct InviteRelation {
        address inviter;         // 邀请人
        uint256 boundAt;         // 绑定时间
        bool bound;
    }

    struct RewardRound {
        bytes32 referralRoot;    // D1 推荐返佣 Merkle Root
        bytes32 teamRoot;        // D2 战队竞赛 Merkle Root
        uint256 timestamp;
        uint256 totalReferralRewards;
        uint256 totalTeamRewards;
    }

    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    ConfigManager public immutable config;
    Treasury public immutable treasury;

    // ──────────────────────────────────────────────
    // 状态
    // ──────────────────────────────────────────────
    uint256 public nextTeamId = 1;
    mapping(uint256 => Team) public teams;
    mapping(address => uint256) public userTeam;         // 用户 → 战队 ID
    mapping(address => InviteRelation) public inviteRelations; // 被邀请人 → 邀请人关系

    RewardRound[] public rewardRounds;

    // 防重入
    mapping(address => mapping(uint256 => bool)) public referralClaimed; // 用户/轮次
    mapping(uint256 => mapping(uint256 => bool)) public teamRewardClaimed; // 战队/轮次

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event TeamCreated(uint256 indexed teamId, address captain, string name);
    event MemberJoined(uint256 indexed teamId, address member);
    event InviteBound(address indexed invitee, address indexed inviter);
    event RewardRoundCreated(uint256 indexed roundId);
    event ReferralClaimed(address indexed user, uint256 roundId, uint256 amount);
    event TeamRewardClaimed(uint256 indexed teamId, uint256 roundId, uint256 amount);
    event InviteRewardDistributed(uint256 indexed roundId, bytes32 merkleRoot, uint256 total);
    event TeamCompetitionDistributed(uint256 indexed roundId, bytes32 merkleRoot, uint256 total);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _config, address _treasury) {
        require(_config != address(0), "Team: zero config");
        config = ConfigManager(_config);
        treasury = Treasury(_treasury);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.TEAM_ORACLE_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 战队管理
    // ──────────────────────────────────────────────
    /**
     * @notice 创建战队
     * @param name 战队名称
     * @return teamId 战队 ID
     */
    function createTeam(string calldata name) external returns (uint256 teamId) {
        require(userTeam[msg.sender] == 0, "Team: already in team");
        require(bytes(name).length > 0 && bytes(name).length <= 32, "Team: invalid name");

        teamId = nextTeamId++;
        teams[teamId] = Team({
            id: teamId,
            captain: msg.sender,
            name: name,
            memberCount: 1,
            createdAt: block.timestamp,
            active: true
        });
        userTeam[msg.sender] = teamId;

        emit TeamCreated(teamId, msg.sender, name);
    }

    /**
     * @notice 加入战队
     * @param teamId 战队 ID
     * @dev 无人数上限
     */
    function joinTeam(uint256 teamId) external {
        require(userTeam[msg.sender] == 0, "Team: already in team");
        Team storage team = teams[teamId];
        require(team.active, "Team: not active");

        userTeam[msg.sender] = teamId;
        team.memberCount++;

        emit MemberJoined(teamId, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 邀请关系绑定
    // ──────────────────────────────────────────────
    /**
     * @notice 绑定邀请关系（被邀请人调用，一次性不可改）
     * @param inviter 邀请人地址
     */
    function bindInviter(address inviter) external {
        require(inviter != address(0), "Team: zero inviter");
        require(inviter != msg.sender, "Team: self invite");
        require(!inviteRelations[msg.sender].bound, "Team: already bound");

        inviteRelations[msg.sender] = InviteRelation({
            inviter: inviter,
            boundAt: block.timestamp,
            bound: true
        });

        emit InviteBound(msg.sender, inviter);
    }

    // ──────────────────────────────────────────────
    // 创建奖励轮次（后端 Oracle 提交）
    // ──────────────────────────────────────────────
    function createRewardRound(
        bytes32 referralRoot,
        bytes32 teamRoot
    ) external onlyRole(RoleRegistry.TEAM_ORACLE_ROLE) returns (uint256) {
        uint256 roundId = rewardRounds.length;
        rewardRounds.push(RewardRound({
            referralRoot: referralRoot,
            teamRoot: teamRoot,
            timestamp: block.timestamp,
            totalReferralRewards: 0,
            totalTeamRewards: 0
        }));
        emit RewardRoundCreated(roundId);
        return roundId;
    }

    // ──────────────────────────────────────────────
    // D1：领取推荐返佣（即时到账）
    // ──────────────────────────────────────────────
    /**
     * @notice 领取推荐返佣
     * @dev Merkle leaf = keccak256(user, totalFeePaid, directCount, directCommission, indirectCommission)
     */
    function claimReferral(
        uint256 roundId,
        uint256 totalFeePaid,        // 被邀请人总手续费（用于验证）
        uint256 directCount,         // 直邀人数
        uint256 directCommission,    // 直邀返佣总额
        uint256 indirectCommission,  // 间邀返佣总额
        bytes32[] calldata proof
    ) external nonReentrant {
        require(roundId < rewardRounds.length, "Team: invalid round");
        require(!referralClaimed[msg.sender][roundId], "Team: already claimed");

        RewardRound storage round = rewardRounds[roundId];

        bytes32 leaf = keccak256(
            abi.encodePacked(msg.sender, totalFeePaid, directCount, directCommission, indirectCommission)
        );
        require(MerkleProof.verify(proof, round.referralRoot, leaf), "Team: invalid proof");

        referralClaimed[msg.sender][roundId] = true;

        uint256 totalReward = directCommission + indirectCommission;
        round.totalReferralRewards += totalReward;

        if (totalReward > 0) {
            treasury.requestMint(msg.sender, totalReward, bytes32("TEAM_REFERRAL"));
        }

        emit ReferralClaimed(msg.sender, roundId, totalReward);
    }

    // ──────────────────────────────────────────────
    // D2：战队竞赛奖励（队长领取，即时到账）
    // ──────────────────────────────────────────────
    /**
     * @notice 战队队长领取战队竞赛奖励
     * @dev
     *   Merkle leaf = keccak256(teamId, rank, totalTeamFee, bonusBase, captainShare, memberShare)
     *   队长领取全部，然后按交易量比例分给队员（或队员自行 claim）
     *
     *   简化方案：队长领取全队奖金，链下自行分配
     *   captainShare 是队长的份额
     */
    function claimTeamReward(
        uint256 roundId,
        uint256 teamId,
        uint256 rank,               // 排名
        uint256 totalTeamFee,       // 战队总手续费
        uint256 bonusBase,          // 奖励基数 = totalTeamFee × 20%
        uint256 captainShare,       // 队长份额
        uint256 memberShare,        // 队员总份额
        bytes32[] calldata proof
    ) external nonReentrant {
        require(roundId < rewardRounds.length, "Team: invalid round");
        require(!teamRewardClaimed[teamId][roundId], "Team: already claimed");

        Team storage team = teams[teamId];
        require(team.captain == msg.sender, "Team: not captain");

        RewardRound storage round = rewardRounds[roundId];

        bytes32 leaf = keccak256(
            abi.encodePacked(teamId, rank, totalTeamFee, bonusBase, captainShare, memberShare)
        );
        require(MerkleProof.verify(proof, round.teamRoot, leaf), "Team: invalid proof");

        teamRewardClaimed[teamId][roundId] = true;

        uint256 totalReward = captainShare + memberShare;
        round.totalTeamRewards += totalReward;

        if (totalReward > 0) {
            // 全部发给队长，队员份额由队长链下分配
            treasury.requestMint(msg.sender, totalReward, bytes32("TEAM_COMPETITION"));
        }

        emit TeamRewardClaimed(teamId, roundId, totalReward);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    function getTeam(uint256 teamId) external view returns (Team memory) {
        return teams[teamId];
    }

    function getInviter(address user) external view returns (address inviter, uint256 boundAt, bool bound) {
        InviteRelation storage r = inviteRelations[user];
        return (r.inviter, r.boundAt, r.bound);
    }

    function getRoundCount() external view returns (uint256) {
        return rewardRounds.length;
    }

    function getRound(uint256 roundId) external view returns (RewardRound memory) {
        return rewardRounds[roundId];
    }

    function getUserTeam(address user) external view returns (uint256) {
        return userTeam[user];
    }
}
