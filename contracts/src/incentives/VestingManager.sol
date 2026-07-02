// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../core/RoleRegistry.sol";
import "../core/PGOLDToken.sol";
import "../core/Treasury.sol";

/**
 * @title VestingManager
 * @notice 统一线性释放引擎
 * @dev
 *   所有需要分期释放的激励（燃烧挖矿 10 年、排名激励 10 年）
 *   统一通过此合约创建释放计划、查询可领取量、执行领取。
 *
 *   释放公式：已释放 = 总量 × min(当前已过时间, 释放周期) / 释放周期
 *   可领取 = 已释放 - 已领取
 *
 *   释放计划一经创建不可修改。
 */
contract VestingManager is AccessControl {
    // ──────────────────────────────────────────────
    // 类型
    // ──────────────────────────────────────────────
    enum ScheduleType {
        BURN_MINING,        // 燃烧挖矿 10 年
        RANKING_MONTHLY,    // 月榜 7 年
        RANKING_QUARTERLY,  // 季榜 7 年
        RANKING_ANNUAL,     // 年榜 7 年
        GENESIS_POOL        // E轨创世池 3 年
    }

    struct VestingSchedule {
        uint256 totalAmount;      // 释放总量 (pGOLD wei)
        uint256 claimedAmount;    // 已领取量
        uint256 startTime;        // 开始时间戳
        uint256 duration;         // 释放周期（秒）
        address beneficiary;       // 当前受益人（可转移给 vPGOLD 合约托管）
        address originalBeneficiary; // 原始受益人（创建时固定，用于 vPGOLD 鉴权防抢跑）
        ScheduleType scheduleType; // 类型
        bool exists;             // 是否存在
    }

    // ──────────────────────────────────────────────
    // 存储
    // ──────────────────────────────────────────────
    uint256 public nextScheduleId;
    mapping(uint256 => VestingSchedule) public schedules;

    // 每个受益人持有的计划 ID 列表
    mapping(address => uint256[]) private beneficiarySchedules;

    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    PGOLDToken public immutable pGOLD;
    Treasury public immutable treasury;

    // 允许创建释放计划的合约（激励合约）
    mapping(address => bool) public authorizedCreators;

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event ScheduleCreated(
        uint256 indexed id, address indexed beneficiary, uint256 totalAmount,
        uint256 startTime, uint256 duration, ScheduleType scheduleType
    );
    event Claimed(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event CreatorAuthorized(address indexed contractAddr, bool authorized);
    event BeneficiaryTransferred(uint256 indexed id, address indexed oldBeneficiary, address indexed newBeneficiary);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _pGOLD, address _treasury) {
        require(_pGOLD != address(0), "Vesting: zero pGOLD");
        require(_treasury != address(0), "Vesting: zero treasury");
        pGOLD = PGOLDToken(_pGOLD);
        treasury = Treasury(_treasury);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 权限管理
    // ──────────────────────────────────────────────
    function setAuthorizedCreator(address creator, bool authorized) external onlyRole(DEFAULT_ADMIN_ROLE) {
        authorizedCreators[creator] = authorized;
        emit CreatorAuthorized(creator, authorized);
    }

    modifier onlyAuthorizedCreator() {
        require(authorizedCreators[msg.sender], "Vesting: not authorized");
        _;
    }

    // ──────────────────────────────────────────────
    // 创建释放计划
    // ──────────────────────────────────────────────
    /**
     * @notice 创建新的线性释放计划
     * @param beneficiary 受益人
     * @param totalAmount 总释放量
     * @param duration    释放周期（秒）
     * @param scheduleType 计划类型
     * @return scheduleId 计划 ID
     */
    function createSchedule(
        address beneficiary,
        uint256 totalAmount,
        uint256 duration,
        ScheduleType scheduleType
    ) external onlyAuthorizedCreator returns (uint256 scheduleId) {
        require(beneficiary != address(0), "Vesting: zero beneficiary");
        require(totalAmount > 0, "Vesting: zero amount");
        require(duration > 0, "Vesting: zero duration");

        scheduleId = nextScheduleId++;
        schedules[scheduleId] = VestingSchedule({
            totalAmount: totalAmount,
            claimedAmount: 0,
            startTime: block.timestamp,
            duration: duration,
            beneficiary: beneficiary,
            originalBeneficiary: beneficiary,
            scheduleType: scheduleType,
            exists: true
        });
        beneficiarySchedules[beneficiary].push(scheduleId);

        emit ScheduleCreated(scheduleId, beneficiary, totalAmount, block.timestamp, duration, scheduleType);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    /**
     * @notice 计算已释放量
     */
    function getVestedAmount(uint256 scheduleId) public view returns (uint256) {
        VestingSchedule storage s = schedules[scheduleId];
        if (!s.exists) return 0;
        if (block.timestamp >= s.startTime + s.duration) {
            return s.totalAmount; // 完全释放
        }
        return (s.totalAmount * (block.timestamp - s.startTime)) / s.duration;
    }

    /**
     * @notice 计算可领取量
     */
    function getClaimableAmount(uint256 scheduleId) public view returns (uint256) {
        VestingSchedule storage s = schedules[scheduleId];
        if (!s.exists) return 0;
        uint256 vested = getVestedAmount(scheduleId);
        if (vested <= s.claimedAmount) return 0;
        return vested - s.claimedAmount;
    }

    /**
     * @notice 获取受益人所有计划 ID
     */
    function getBeneficiarySchedules(address beneficiary) external view returns (uint256[] memory) {
        uint256[] storage ids = beneficiarySchedules[beneficiary];
        // 过滤掉已转移给他人/合约托管的脏数据，只返回当前仍属于该受益人的计划
        uint256 count = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            if (schedules[ids[i]].beneficiary == beneficiary) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            if (schedules[ids[i]].beneficiary == beneficiary) {
                result[idx++] = ids[i];
            }
        }
        return result;
    }

    /**
     * @notice 转移释放计划的受益人（用于 vPGOLD 包装托管）
     * @dev 仅当前受益人可调用。转移后原受益人丧失 claim 权（防双花），
     *      新受益人（通常为 vPGOLD 合约）获得 claim 权。originalBeneficiary 永不变。
     * @param scheduleId     释放计划 ID
     * @param newBeneficiary 新受益人地址
     */
    function transferBeneficiary(uint256 scheduleId, address newBeneficiary) external {
        VestingSchedule storage s = schedules[scheduleId];
        require(s.exists, "Vesting: not found");
        require(msg.sender == s.beneficiary, "Vesting: not beneficiary");
        require(newBeneficiary != address(0), "Vesting: zero new beneficiary");
        require(newBeneficiary != s.beneficiary, "Vesting: same beneficiary");

        address old = s.beneficiary;
        s.beneficiary = newBeneficiary;
        // 登记到新受益人名下（旧记录通过 getBeneficiarySchedules 过滤清除）
        beneficiarySchedules[newBeneficiary].push(scheduleId);

        emit BeneficiaryTransferred(scheduleId, old, newBeneficiary);
    }

    /**
     * @notice 获取单个计划详情（返回结构体）
     */
    function getSchedule(uint256 scheduleId) external view returns (VestingSchedule memory) {
        return schedules[scheduleId];
    }

    /**
     * @notice 批量获取多个计划信息
     */
    function getSchedules(uint256[] calldata ids) external view returns (VestingSchedule[] memory) {
        VestingSchedule[] memory result = new VestingSchedule[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            result[i] = schedules[ids[i]];
        }
        return result;
    }

    // ──────────────────────────────────────────────
    // 领取
    // ──────────────────────────────────────────────
    /**
     * @notice 领取已释放代币
     * @param scheduleId 释放计划 ID
     */
    function claim(uint256 scheduleId) external returns (uint256 amount) {
        VestingSchedule storage s = schedules[scheduleId];
        require(s.exists, "Vesting: not found");
        require(s.beneficiary == msg.sender, "Vesting: not beneficiary");

        amount = getClaimableAmount(scheduleId);
        require(amount > 0, "Vesting: nothing to claim");

        s.claimedAmount += amount;

        // 通过 Treasury 统一铸币
        treasury.requestMint(msg.sender, amount, bytes32("VESTING"));

        emit Claimed(scheduleId, msg.sender, amount);
    }

    /**
     * @notice 批量领取多个计划的已释放代币
     */
    function claimMultiple(uint256[] calldata scheduleIds) external returns (uint256 totalAmount) {
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            uint256 scheduleId = scheduleIds[i];
            VestingSchedule storage s = schedules[scheduleId];
            if (!s.exists || s.beneficiary != msg.sender) continue;

            uint256 amount = getClaimableAmount(scheduleId);
            if (amount == 0) continue;

            s.claimedAmount += amount;
            totalAmount += amount;
        }
        require(totalAmount > 0, "Vesting: nothing to claim");

        treasury.requestMint(msg.sender, totalAmount, bytes32("VESTING_MULTI"));

        // 发射多个事件
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            emit Claimed(scheduleIds[i], msg.sender, 0); // 统一事件
        }
    }

    // ──────────────────────────────────────────────
    // GenesisPool 兼容接口 (E轨创世池)
    // ──────────────────────────────────────────────
    /**
     * @notice GenesisPool 专用创建释放计划接口
     * @param user       受益人
     * @param amount     总释放量 (pGOLD wei)
     * @param start      开始时间戳
     * @param duration   释放周期（秒）
     * @return scheduleId 计划 ID
     */
    function createVestingSchedule(
        address user,
        uint256 amount,
        uint256 start,
        uint256 duration,
        uint256  /* steps (reserved for future use) */
    ) external onlyAuthorizedCreator returns (uint256 scheduleId) {
        require(user != address(0), "Vesting: zero user");
        require(amount > 0, "Vesting: zero amount");
        require(duration > 0, "Vesting: zero duration");

        scheduleId = nextScheduleId++;
        schedules[scheduleId] = VestingSchedule({
            totalAmount: amount,
            claimedAmount: 0,
            startTime: start,
            duration: duration,
            beneficiary: user,
            originalBeneficiary: user,
            scheduleType: ScheduleType.GENESIS_POOL,
            exists: true
        });
        beneficiarySchedules[user].push(scheduleId);
        emit ScheduleCreated(scheduleId, user, amount, start, duration, ScheduleType.GENESIS_POOL);
    }

    /**
     * @notice 查询用户所有释放计划的总可领取量 (GenesisPool 兼容)
     */
    function claimable(address user) external view returns (uint256 total) {
        uint256[] storage ids = beneficiarySchedules[user];
        for (uint256 i = 0; i < ids.length; i++) {
            if (schedules[ids[i]].beneficiary != user) continue; // 跳过已转出托管的
            total += getClaimableAmount(ids[i]);
        }
    }

    /**
     * @notice 查询用户释放状态快照 (GenesisPool 兼容)
     * @return vested  已释放总量
     * @return pending 待释放总量
     */
    function getVestingState(address user) external view returns (uint256 vested, uint256 pending) {
        uint256[] storage ids = beneficiarySchedules[user];
        for (uint256 i = 0; i < ids.length; i++) {
            if (schedules[ids[i]].beneficiary != user) continue; // 跳过已转出托管的
            VestingSchedule storage s = schedules[ids[i]];
            vested += getVestedAmount(ids[i]);
            pending += s.totalAmount - getVestedAmount(ids[i]);
        }
    }
}
