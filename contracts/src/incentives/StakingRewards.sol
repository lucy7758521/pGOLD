// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../core/PGOLDToken.sol";
import "../core/Treasury.sol";
import "../core/ConfigManager.sol";

/**
 * @title StakingRewards
 * @notice A 轨：持有分红 — 年化 3.5%
 * @dev
 *   用户质押 pGOLD，按比例分享年度分红池。
 *   分红来源于纯铸币，按质押份额 + 时间加权分配。
 *   分红累积按秒计，用户随时可领取。
 *
 *   逻辑类似 Synthetix StakingRewards，简化版。
 */
contract StakingRewards is AccessControl, ReentrancyGuard {
    // ──────────────────────────────────────────────
    // 结构
    // ──────────────────────────────────────────────
    struct Stake {
        uint256 amount;                   // 质押量
        uint256 userRewardPerTokenPaid;   // 上次结算时的 rewardPerToken 快照
        uint256 rewards;                  // 待领取奖励
        uint256 lastStakeTime;            // 最后质押时间
        uint256 accumulatedRewards;       // 累计已领取奖励
    }

    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    PGOLDToken public immutable pGOLD;
    Treasury public immutable treasury;
    ConfigManager public immutable config;

    // ──────────────────────────────────────────────
    // 状态
    // ──────────────────────────────────────────────
    uint256 public totalStaked;                       // 总质押量
    uint256 public rewardPerTokenStored;              // 累计每 token 奖励
    uint256 public lastUpdateTime;                    // 最后更新时间
    uint256 public rewardRate;                        // 每秒分发率 (pGOLD wei)
    uint256 public totalRewardsDistributed;           // 累计已分发

    mapping(address => Stake) public stakes;

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);
    event RewardRateUpdated(uint256 newRate);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _pGOLD, address _treasury, address _config) {
        require(_pGOLD != address(0), "Staking: zero pGOLD");
        pGOLD = PGOLDToken(_pGOLD);
        treasury = Treasury(_treasury);
        config = ConfigManager(_config);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 奖励率管理（由协议触发）
    // ──────────────────────────────────────────────
    /**
     * @notice 更新奖励率（基于总质押量和 APR）
     * @dev 每年或质押量大幅变化时调用
     */
    function updateRewardRate() external {
        // checkpoint existing accumulation before changing rate
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = block.timestamp;

        if (totalStaked == 0) {
            rewardRate = 0;
        } else {
            // rewardRate = totalStaked * APR / 365天 / 86400秒
            uint256 apr = config.dividendAPR(); // 基点 (350 = 3.50%)
            rewardRate = (totalStaked * apr) / 10000 / 365 / 86400;
        }
        emit RewardRateUpdated(rewardRate);
    }

    // ──────────────────────────────────────────────
    // 质押
    // ──────────────────────────────────────────────
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "Staking: zero");
        _updateReward(msg.sender);

        pGOLD.transferFrom(msg.sender, address(this), amount);
        stakes[msg.sender].amount += amount;
        totalStaked += amount;

        emit Staked(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    // 解质押
    // ──────────────────────────────────────────────
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Staking: zero");
        Stake storage s = stakes[msg.sender];
        require(s.amount >= amount, "Staking: insufficient");

        _updateReward(msg.sender);
        s.amount -= amount;
        totalStaked -= amount;

        pGOLD.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    // 领取奖励
    // ──────────────────────────────────────────────
    function claimReward() external nonReentrant returns (uint256 reward) {
        _updateReward(msg.sender);
        reward = stakes[msg.sender].rewards;
        require(reward > 0, "Staking: no reward");

        stakes[msg.sender].rewards = 0;
        stakes[msg.sender].accumulatedRewards += reward;
        totalRewardsDistributed += reward;

        treasury.requestMint(msg.sender, reward, bytes32("STAKING"));

        emit RewardClaimed(msg.sender, reward);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    function earned(address account) public view returns (uint256) {
        Stake storage s = stakes[account];
        return s.rewards + (s.amount * (rewardPerToken() - s.userRewardPerTokenPaid)) / 1e18;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((block.timestamp - lastUpdateTime) * rewardRate * 1e18) / totalStaked;
    }

    function getStakeInfo(address account) external view returns (
        uint256 staked, uint256 earned_, uint256 accumulated
    ) {
        Stake storage s = stakes[account];
        return (s.amount, earned(account), s.accumulatedRewards);
    }

    // ──────────────────────────────────────────────
    // 内部
    // ──────────────────────────────────────────────
    function _updateReward(address account) private {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = block.timestamp;
        if (account != address(0)) {
            stakes[account].rewards = earned(account);
            stakes[account].userRewardPerTokenPaid = rewardPerTokenStored;
        }
    }
}
