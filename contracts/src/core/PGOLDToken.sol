// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title PGOLDToken
 * @notice pGOLD 核心代币 — 1 pGOLD = 1 克黄金
 * @dev
 *   - 铸币权限仅授予 Treasury（MINTER_ROLE）
 *   - 任何持有者可自行销毁（burn）
 *   - ERC-20 标准 + Permit (EIP-2612)
 *   - 暂停机制用于紧急安全防护
 *
 *   初始流通量: 0（所有代币通过 Treasury.requestMint() 铸造发放）
 */
contract PGOLDToken is ERC20, ERC20Permit, ERC20Burnable, AccessControl, Pausable {
    // ──────────────────────────────────────────────
    // 角色常量
    // ──────────────────────────────────────────────
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────
    event Minted(address indexed to, uint256 amount, bytes32 indexed reason);
    event BurnedByUser(address indexed from, uint256 amount);

    // ──────────────────────────────────────────────
    // 构造函数
    // ──────────────────────────────────────────────
    constructor() ERC20("pGOLD", "pGOLD") ERC20Permit("pGOLD") {
        // 部署者获得 DEFAULT_ADMIN_ROLE，可继续授予其他角色
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // ──────────────────────────────────────────────
    // 铸币 — 仅 MINTER_ROLE
    // ──────────────────────────────────────────────
    /**
     * @notice 铸造 pGOLD 代币
     * @param to     接收地址
     * @param amount 铸造量（1 pGOLD = 10^18 wei = 1 克黄金）
     * @param reason 铸币原因标识（如 bytes32("INCENTIVE")）
     * @dev 仅 Treasury 合约可调用
     */
    function mint(address to, uint256 amount, bytes32 reason) external onlyRole(MINTER_ROLE) {
        require(to != address(0), "PGOLD: mint to zero");
        require(amount > 0, "PGOLD: mint zero");
        _mint(to, amount);
        emit Minted(to, amount, reason);
    }

    // ──────────────────────────────────────────────
    // 暂停 / 恢复
    // ──────────────────────────────────────────────
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────
    // 暂停时阻断转账
    // ──────────────────────────────────────────────
    function _update(
        address from,
        address to,
        uint256 value
    ) internal virtual override whenNotPaused {
        super._update(from, to, value);
    }

    /**
     * @notice 获取当前代币总流通量
     * @return 总流通 pGOLD（以 wei 计，1e18 = 1 pGOLD = 1g 黄金）
     */
    function totalSupply() public view override returns (uint256) {
        return super.totalSupply();
    }

    /**
     * @notice 获取黄金克数表示的总流通量（仅用于前端展示）
     * @return 流通黄金克数（= totalSupply / 1e18）
     */
    function totalGoldGrams() external view returns (uint256) {
        return super.totalSupply() / 1e18;
    }
}
