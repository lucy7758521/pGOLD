// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../core/PGOLDToken.sol";

/// @dev Minimal treasury stub for StakingRewards tests.
///      Forwards requestMint calls to PGOLDToken directly.
contract MockTreasuryStaking {
    PGOLDToken public immutable pGOLD;
    mapping(address => bool) public authorized;

    constructor(address _pGOLD) {
        pGOLD = PGOLDToken(_pGOLD);
    }

    function authorize(address contractAddr) external {
        authorized[contractAddr] = true;
    }

    function requestMint(address to, uint256 amount, bytes32 reason) external {
        require(authorized[msg.sender], "MockTreasury: not authorized");
        pGOLD.mint(to, amount, reason);
    }

    /// @dev Direct mint for test setup (no authorization check)
    function directMint(address to, uint256 amount) external {
        pGOLD.mint(to, amount, bytes32("TEST_SETUP"));
    }
}
