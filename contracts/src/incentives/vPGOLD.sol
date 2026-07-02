// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "../core/PGOLDToken.sol";
import "../incentives/VestingManager.sol";

/**
 * @title vPGOLD
 * @notice 锁仓收益代币化 — 将 VestingManager 中的释放计划打包为可交易的 vPGOLD
 * @dev
 *   类似 Pendle (收益代币化) + Lido (流动性释放) 的思想结合。
 *   用户持有的释放计划可 mint 等量 vPGOLD，在二级市场交易。
 *   vPGOLD 持有者到期后可按比例兑换已释放的 pGOLD。
 *
 *   核心逻辑：
 *   1. 用户将释放计划包装 (wrap) → 获得 vPGOLD
 *   2. 买方购买 vPGOLD → 获得未来释放流的所有权
 *   3. 到期/按比例赎回 → vPGOLD 销毁，释放的 pGOLD 归持有人
 *
 *   vPGOLD : pGOLD = 1 : 1（基础锚定），实际交易价格由市场决定
 */
contract vPGOLD is ERC20, AccessControl {
    // ──────────────────────────────────────────────
    // 不可变
    // ──────────────────────────────────────────────
    PGOLDToken public immutable pGOLD;
    VestingManager public immutable vestingManager;

    // ──────────────────────────────────────────────
    // 状态
    // ──────────────────────────────────────────────
    uint256 public totalWrapped;             // 总包装量

    // scheduleId → 包装信息
    struct WrappedSchedule {
        address originalOwner;  // 原始持有人
        uint256 scheduleId;     // 释放计划 ID
        uint256 wrappedAt;      // 包装时间
        bool active;
    }

    mapping(uint256 => WrappedSchedule) public wrappedSchedules;

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event Wrapped(address indexed user, uint256 scheduleId, uint256 vPGOLDAmount);
    event Unwrapped(address indexed user, uint256 scheduleId, uint256 vPGOLDAmount);
    event Redeemed(address indexed holder, uint256 scheduleId, uint256 pGOLDAmount);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor(address _pGOLD, address _vestingManager) ERC20("Vested pGOLD", "vPGOLD") {
        require(_pGOLD != address(0), "vPGOLD: zero pGOLD");
        require(_vestingManager != address(0), "vPGOLD: zero vesting");
        pGOLD = PGOLDToken(_pGOLD);
        vestingManager = VestingManager(_vestingManager);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 包装（Wrap）：释放计划 → vPGOLD
    // ──────────────────────────────────────────────
    /**
     * @notice 将释放计划包装为可交易的 vPGOLD
     * @param scheduleId VestingManager 中的释放计划 ID
     * @dev 包装后原始释放计划的 pGOLD 归 vPGOLD 合约所有
     */
    function wrap(uint256 scheduleId) external returns (uint256 vAmount) {
        VestingManager.VestingSchedule memory schedule = vestingManager.getSchedule(scheduleId);
        require(schedule.exists, "vPGOLD: schedule not found");
        require(!wrappedSchedules[scheduleId].active, "vPGOLD: already wrapped");
        // 防双花：受益人必须已通过 transferBeneficiary 转给本合约托管，
        // 此时原用户已丧失直接 claim 权，避免"卖 vPGOLD + 领底层 pGOLD"双花。
        require(schedule.beneficiary == address(this), "vPGOLD: transfer beneficiary first");
        // 防抢跑：transferBeneficiary 仅原受益人可调，故 originalBeneficiary 即调用者
        require(schedule.originalBeneficiary == msg.sender, "vPGOLD: not original beneficiary");

        // 计算可包装量 = 总量 - 已领取（已被领取的部分不能包装）
        vAmount = schedule.totalAmount - schedule.claimedAmount;
        require(vAmount > 0, "vPGOLD: nothing to wrap");

        wrappedSchedules[scheduleId] = WrappedSchedule({
            originalOwner: msg.sender,
            scheduleId: scheduleId,
            wrappedAt: block.timestamp,
            active: true
        });

        totalWrapped += vAmount;
        _mint(msg.sender, vAmount);

        emit Wrapped(msg.sender, scheduleId, vAmount);
    }

    // ──────────────────────────────────────────────
    // 解包装（Unwrap）：vPGOLD → 释放计划
    // ──────────────────────────────────────────────
    /**
     * @notice 销毁 vPGOLD 恢复释放计划所有权
     * @param scheduleId 释放计划 ID
     * @param vAmount 销毁的 vPGOLD 量
     */
    function unwrap(uint256 scheduleId, uint256 vAmount) external {
        WrappedSchedule storage ws = wrappedSchedules[scheduleId];
        require(ws.active, "vPGOLD: not wrapped");
        require(ws.originalOwner == msg.sender, "vPGOLD: not owner");
        require(vAmount > 0, "vPGOLD: zero");

        _burn(msg.sender, vAmount);
        totalWrapped -= vAmount;

        // 仅当全部 vPGOLD 已销毁（无任何持有人）时，归还释放计划受益权给原始受益人。
        // 本合约是当前 beneficiary，有权调 transferBeneficiary 转回。
        if (totalSupply() == 0) {
            ws.active = false;
            vestingManager.transferBeneficiary(scheduleId, ws.originalOwner);
        }

        emit Unwrapped(msg.sender, scheduleId, vAmount);
    }

    // ──────────────────────────────────────────────
    // 领取已释放的 pGOLD
    // ──────────────────────────────────────────────
    /**
     * @notice vPGOLD 持有者领取对应释放计划的已释放 pGOLD
     * @dev 按 vPGOLD 持有比例分配
     */
    function claimUnderlying(uint256 scheduleId) external returns (uint256 pGOLDAmount) {
        WrappedSchedule storage ws = wrappedSchedules[scheduleId];
        require(ws.active, "vPGOLD: not wrapped");

        // 触发 VestingManager 的 claim（这会铸造 pGOLD 到本合约）
        vestingManager.claim(scheduleId);

        // 按 vPGOLD 持有比例分配给调用者
        uint256 userShare = balanceOf(msg.sender);
        uint256 totalVPGOLD = totalSupply();
        if (totalVPGOLD == 0) return 0;

        uint256 contractBalance = pGOLD.balanceOf(address(this));
        pGOLDAmount = (contractBalance * userShare) / totalVPGOLD;

        if (pGOLDAmount > 0) {
            pGOLD.transfer(msg.sender, pGOLDAmount);
        }

        emit Redeemed(msg.sender, scheduleId, pGOLDAmount);
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────
    function getWrappedSchedule(uint256 scheduleId) external view returns (WrappedSchedule memory) {
        return wrappedSchedules[scheduleId];
    }

    function getUnderlyingValue(uint256 scheduleId) external view returns (
        uint256 totalVested,
        uint256 claimed,
        uint256 claimable
    ) {
        WrappedSchedule storage ws = wrappedSchedules[scheduleId];
        if (!ws.active) return (0, 0, 0);
        totalVested = vestingManager.getVestedAmount(scheduleId);
        VestingManager.VestingSchedule memory s = vestingManager.getSchedule(scheduleId);
        claimed = s.claimedAmount;
        claimable = vestingManager.getClaimableAmount(scheduleId);
    }
}
