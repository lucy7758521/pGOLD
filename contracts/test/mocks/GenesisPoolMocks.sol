// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../../src/core/PGOLDToken.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Mock Treasury for GenesisPool tests
 *   swapUSDCforPAXG: 1 USDC = 1/85 PAXG (approx, 18dec)
 *   requestMint: mints pGOLD to user
 */
contract MockTreasuryForGenesis {
    PGOLDToken public pgold;
    IERC20 public paxg;
    // 1 PAXG = 1 troy oz = 31.1035 grams. gold price = $85/g
    // 1 USDC buys (1/85) grams PAXG (18 dec)
    // But PAXG is oz-based: 1 PAXG = 31.1035g, price = 31.1035*85 = $2643.8
    // So 1 USDC buys 1/2643.8 PAXG (18 dec)
    uint256 public constant PAXG_PRICE_USDC = 2644; // per PAXG (6dec input, 18dec out)

    constructor(address _pgold, address _paxg) {
        pgold = PGOLDToken(_pgold);
        paxg = ERC20(_paxg);
    }

    function swapUSDCforPAXG(uint256 usdcAmount) external returns (uint256 paxgAmount) {
        // usdcAmount in 6 dec (USDC), return PAXG in 18 dec
        // paxgAmount = usdcAmount * 1e18 / (PAXG_PRICE_USDC * 1e6)
        paxgAmount = (usdcAmount * 1e18) / (PAXG_PRICE_USDC * 1e6);
        // In test we just give the caller PAXG via paxg balance (we hold them)
        // For simplicity, just track - actual transfer not needed for unit test
    }

    function requestMint(address to, uint256 pgoldAmount) external {
        // Mint pGOLD to user (treasury has MINTER_ROLE)
        pgold.mint(to, pgoldAmount, bytes32("GENESIS_ICO"));
    }

    function backfillGenesisPool(uint256) external {
        // no-op in test
    }
}

/**
 * @dev Mock GoldOracle — fixed gold price $85/gram
 *   Returns 85e18 (USD per gram, 18 decimals)
 */
contract MockGoldOracleForGenesis {
    uint256 public goldPricePerGram = 85e18; // $85 per gram, 18 dec

    function setGoldPrice(uint256 price) external {
        goldPricePerGram = price;
    }

    function getGoldPrice() external view returns (uint256 price, uint256 updatedAt) {
        price = goldPricePerGram;
        updatedAt = block.timestamp;
    }

    function getPAXGPremium() external pure returns (int256 premiumBPS) {
        return 0;
    }
}

/**
 * @dev Mock VestingManager for GenesisPool — records schedule creation
 */
contract MockVestingManagerForGenesis {
    struct Schedule {
        address user;
        uint256 amount;
        uint256 start;
        uint256 duration;
        uint256 steps;
    }
    Schedule[] public schedules;
    mapping(address => uint256) public userScheduleId;

    function createVestingSchedule(
        address user,
        uint256 amount,
        uint256 start,
        uint256 duration,
        uint256 steps
    ) external returns (uint256 scheduleId) {
        scheduleId = schedules.length;
        schedules.push(Schedule(user, amount, start, duration, steps));
        userScheduleId[user] = scheduleId;
    }

    function claimable(address) external pure returns (uint256) {
        return 0;
    }

    function getVestingState(address) external pure returns (uint256 vested, uint256 pending) {
        return (0, 0);
    }

    function getSchedule(uint256 id) external view returns (Schedule memory) {
        return schedules[id];
    }

    function totalSchedules() external view returns (uint256) {
        return schedules.length;
    }
}
