// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @dev Mock Uniswap V3 Router for local Hardhat deployment
 *   Simulates PAXG purchase: USDC → PAXG at fixed rate $2644/PAXG
 */
contract MockUniswapRouter {
    using SafeERC20 for IERC20;

    IERC20 public paxg;
    IERC20 public usdc;
    uint256 public constant PAXG_PRICE_USDC = 2644; // 1 PAXG = $2644 (6 decimals)
    uint256 public constant USDC_DECIMALS = 1e6;

    constructor(address _paxg, address _usdc) {
        paxg = IERC20(_paxg);
        usdc = IERC20(_usdc);
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @dev Simulates Uniswap V3 exactInputSingle: USDC → PAXG
     */
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        require(params.tokenIn == address(usdc), "Mock: only USDC in");
        require(params.tokenOut == address(paxg), "Mock: only PAXG out");

        // Calculate PAXG output: usdcAmount * 1e18 / (PAXG_PRICE_USDC * USDC_DECIMALS)
        amountOut = (params.amountIn * 1e18) / (PAXG_PRICE_USDC * 1e6);

        // Transfer USDC from caller and give PAXG to recipient
        usdc.safeTransferFrom(msg.sender, address(this), params.amountIn);
        paxg.safeTransfer(params.recipient, amountOut);
    }
}
