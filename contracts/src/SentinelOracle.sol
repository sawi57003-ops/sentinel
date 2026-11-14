// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SentinelOracle
/// @notice Agent-updated USD price feed for B20 tokens.
/// @dev Prices are 8-decimal USD (Chainlink style: $343.88 -> 34388000000).
///      The agent updates prices daily from the official Coinbase Tokenized
///      Stocks API NAV / Chainlink NAV. A price older than MAX_AGE is stale
///      and contributes 0 to SentinelVault.totalAssets().
contract SentinelOracle is Ownable {
    uint256 public constant MAX_AGE = 48 hours;

    mapping(address => uint256) public price; // token => USD price, 8 decimals
    mapping(address => uint256) public updatedAt;

    event PriceUpdated(address indexed token, uint256 price, uint256 updatedAt);

    constructor(address agent) Ownable(agent) {}

    function setPrice(address token, uint256 priceUsd8dp) external onlyOwner {
        require(token != address(0), "zero token");
        require(priceUsd8dp > 0, "zero price");
        price[token] = priceUsd8dp;
        updatedAt[token] = block.timestamp;
        emit PriceUpdated(token, priceUsd8dp, block.timestamp);
    }

    function setPrices(address[] calldata tokens, uint256[] calldata prices) external onlyOwner {
        require(tokens.length == prices.length, "length");
        for (uint256 i; i < tokens.length; i++) {
            require(tokens[i] != address(0), "zero token");
            require(prices[i] > 0, "zero price");
            price[tokens[i]] = prices[i];
            updatedAt[tokens[i]] = block.timestamp;
            emit PriceUpdated(tokens[i], prices[i], block.timestamp);
        }
    }

    /// @notice Returns price and freshness; never reverts so the vault can skip stale tokens.
    function tryGetPrice(address token) external view returns (uint256 priceUsd, bool fresh) {
        uint256 p = price[token];
        uint256 t = updatedAt[token];
        if (p == 0 || t == 0) return (0, false);
        if (block.timestamp - t > MAX_AGE) return (p, false);
        return (p, true);
    }
}
