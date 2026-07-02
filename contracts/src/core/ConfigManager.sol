// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./RoleRegistry.sol";

/**
 * @title ConfigManager
 * @notice pGOLD 协议全局参数管理
 * @dev
 *   - 所有激励参数集中管理，链上可查
 *   - 修改需 GOVERNOR_ROLE 权限，含时间锁延迟生效
 *   - 核心参数变更触发事件，供前端和后端监听
 *
 *   ⚠️ 手续费分配比例（FeeRouter）不在此管理，硬编码不可改
 */
contract ConfigManager is AccessControl {
    // ──────────────────────────────────────────────
    // 时间锁
    // ──────────────────────────────────────────────
    uint256 public constant TIMELOCK_DELAY = 2 days; // 参数修改延迟 2 天生效

    struct PendingParam {
        uint256 value;
        uint256 effectiveAt;
    }

    // ──────────────────────────────────────────────
    // A 轨：持有分红
    // ──────────────────────────────────────────────
    uint256 public dividendAPR; // 年化收益率，基点表示（350 = 3.50%）
    event DividendAPRUpdated(uint256 oldValue, uint256 newValue);

    // ──────────────────────────────────────────────
    // B 轨：排名激励
    // ──────────────────────────────────────────────
    uint256 public monthlyMultiplier;  // 月榜倍数（300 = 300%）
    uint256 public quarterlyMultiplier; // 季榜倍数（500 = 500%）
    uint256 public annualMultiplier;   // 年榜倍数（1000 = 1000%）
    uint256 public rankingVestingYears; // 排名激励释放年限（10）

    event RankingParamsUpdated(
        uint256 monthly, uint256 quarterly, uint256 annual, uint256 vestingYears
    );

    // ──────────────────────────────────────────────
    // C 轨：燃烧挖矿
    // ──────────────────────────────────────────────
    uint256 public burnCompensationRate; // 亏损补偿率（1000 = 1000%）
    uint256 public burnVestingYears;     // 燃烧挖矿释放年限（10）
    uint256 public burnMinHoldingDays;   // 最低持仓天数要求

    event BurnParamsUpdated(uint256 compensationRate, uint256 vestingYears, uint256 minHoldingDays);

    // ──────────────────────────────────────────────
    // D 轨：战队奖励
    // ──────────────────────────────────────────────
    uint256 public directInviteRate;   // 直邀返佣比例（20 = 20%）
    uint256 public indirectInviteRate;  // 间邀返佣比例（5 = 5%）
    uint256 public teamBonusRate;       // 战队竞赛奖励基数（20 = 手续费×20%）
    uint256 public teamCaptainShare;    // 队长分润比例（30 = 30%）
    uint256 public topTeamCount;        // 战队月榜获奖数量（10）

    event TeamParamsUpdated(
        uint256 directInvite, uint256 indirectInvite,
        uint256 teamBonus, uint256 captainShare, uint256 topCount
    );

    // ──────────────────────────────────────────────
    // 交易参数
    // ──────────────────────────────────────────────
    uint256 public tradeFeeRate; // 交易手续费（25 = 0.25%，基点）
    event TradeFeeRateUpdated(uint256 oldValue, uint256 newValue);

    // ──────────────────────────────────────────────
    // 价格防线参数
    // ──────────────────────────────────────────────
    uint256 public l2DiscountThreshold; // L2 条件赎回触发折价阈值（300 = 3%，基点）
    uint256 public l2DurationThreshold; // L2 持续时间阈值（7 天，秒）
    uint256 public l3DiscountThreshold; // L3 稳定基金触发折价阈值（1000 = 10%，基点）
    uint256 public l3DurationThreshold; // L3 持续时间阈值（48 小时，秒）

    event DefenseParamsUpdated(
        uint256 l2Discount, uint256 l2Duration,
        uint256 l3Discount, uint256 l3Duration
    );

    // ──────────────────────────────────────────────
    // 待定参数（时间锁）
    // ──────────────────────────────────────────────
    mapping(bytes32 => PendingParam) private pendingParams;

    // ──────────────────────────────────────────────
    // 构造函数：写入默认值
    // ──────────────────────────────────────────────
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RoleRegistry.GOVERNOR_ROLE, msg.sender);

        // A 轨
        dividendAPR = 350; // 3.50%

        // B 轨
        monthlyMultiplier = 300;
        quarterlyMultiplier = 500;
        annualMultiplier = 1000;
        rankingVestingYears = 10;

        // C 轨
        burnCompensationRate = 1000;
        burnVestingYears = 10;
        burnMinHoldingDays = 30;

        // D 轨
        directInviteRate = 20;
        indirectInviteRate = 5;
        teamBonusRate = 20;
        teamCaptainShare = 30;
        topTeamCount = 10;

        // 交易
        tradeFeeRate = 25; // 0.25%

        // 防线
        l2DiscountThreshold = 300; // 3%
        l2DurationThreshold = 7 days;
        l3DiscountThreshold = 1000; // 10%
        l3DurationThreshold = 48 hours;
    }

    // ──────────────────────────────────────────────
    // 参数查询
    // ──────────────────────────────────────────────
    /**
     * @notice 一次性返回所有参数快照，供前端初始化时调用
     */
    function getAllParams() external view returns (
        uint256 dividendAPR_,
        uint256 monthlyMultiplier_, uint256 quarterlyMultiplier_, uint256 annualMultiplier_,
        uint256 rankingVestingYears_,
        uint256 burnCompensationRate_, uint256 burnVestingYears_, uint256 burnMinHoldingDays_,
        uint256 directInviteRate_, uint256 indirectInviteRate_,
        uint256 teamBonusRate_, uint256 teamCaptainShare_, uint256 topTeamCount_,
        uint256 tradeFeeRate_,
        uint256 l2Discount_, uint256 l2Duration_, uint256 l3Discount_, uint256 l3Duration_
    ) {
        return (
            dividendAPR,
            monthlyMultiplier, quarterlyMultiplier, annualMultiplier, rankingVestingYears,
            burnCompensationRate, burnVestingYears, burnMinHoldingDays,
            directInviteRate, indirectInviteRate, teamBonusRate, teamCaptainShare, topTeamCount,
            tradeFeeRate,
            l2DiscountThreshold, l2DurationThreshold, l3DiscountThreshold, l3DurationThreshold
        );
    }
}
