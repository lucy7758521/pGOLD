require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  paths: {
    sources: "./src",
    cache: "./cache",
    artifacts: "./artifacts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    // ── Arbitrum One 主网 ──
    arbitrum: {
      url: process.env.ARBITRUM_RPC || "https://arb1.arbitrum.io/rpc",
      accounts,
      chainId: 42161,
    },
    // ── Arbitrum Sepolia 测试网 ──
    "arbitrum-sepolia": {
      url: process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
      accounts,
      chainId: 421614,
    },
    // ── 本地开发 ──
    hardhat: {
      chainId: 31337,
    },
  },
  // ── 合约验证 (Arbiscan) ──
  etherscan: {
    apiKey: {
      arbitrum: process.env.ARBISCAN_API_KEY || "",
      "arbitrum-sepolia": process.env.ARBISCAN_API_KEY || "",
    },
  },
  sourcify: {
    enabled: false,
  },
  // ── Gas 报告 (开发用) ──
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    token: "ETH",
  },
};
