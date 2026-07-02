// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

/**
 * @title RoleRegistry
 * @notice pGOLD 协议全局角色常量定义
 * @dev 所有合约共享此角色定义，确保跨合约权限一致性
 */
library RoleRegistry {
    // ── 协议管理角色 ──
    /// @dev 可升级合约的管理员（ProxyAdmin）
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @dev 协议治理（参数修改、紧急操作）
    bytes32 internal constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @dev 暂停/恢复操作
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ── 业务角色 ──
    /// @dev pGOLD 代币铸币权（Treasury 合约）
    bytes32 internal constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev 手续费路由（FeeRouter 合约）
    bytes32 internal constant FEE_ROUTER_ROLE = keccak256("FEE_ROUTER_ROLE");

    /// @dev 排名数据提交（后端签名者）
    bytes32 internal constant RANKING_ORACLE_ROLE = keccak256("RANKING_ORACLE_ROLE");

    /// @dev 金价预言机数据提交
    bytes32 internal constant GOLD_ORACLE_ROLE = keccak256("GOLD_ORACLE_ROLE");

    /// @dev 战队数据提交
    bytes32 internal constant TEAM_ORACLE_ROLE = keccak256("TEAM_ORACLE_ROLE");

    /// @dev 金库管理操作
    bytes32 internal constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
}
