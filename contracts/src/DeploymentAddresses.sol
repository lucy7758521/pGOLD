// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

/**
 * @title DeploymentAddresses
 * @notice Arbitrum 主网关键合约地址参考
 * @dev 部署时需验证地址有效性
 */
library DeploymentAddresses {
    // ── Arbitrum One 主网 ──
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;      // USDC (Arbitrum)
    address constant PAXG = address(0);                                         // PAXG on Arbitrum (部署前填入)
    address constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant CHAINLINK_XAU_USD = address(0);                             // XAU/USD Chainlink Feed (部署前填入)

    // ── Arbitrum Sepolia 测试网 ──
    address constant USDC_SEPOLIA = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address constant UNISWAP_V3_ROUTER_SEPOLIA = address(0);
}
