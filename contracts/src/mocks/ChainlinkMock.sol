// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @dev Mock Chainlink AggregatorV3 — for local Hardhat deployment simulation
 */
contract MockChainlinkAggregator {
    int256 private _answer;
    uint8 private _decimals;
    uint256 private _updatedAt;

    constructor(int256 initialAnswer, uint8 decimals_) {
        _answer = initialAnswer;
        _decimals = decimals_;
        _updatedAt = block.timestamp;
    }

    function setAnswer(int256 answer) external {
        _answer = answer;
        _updatedAt = block.timestamp;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, _answer, block.timestamp, _updatedAt, 1);
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
