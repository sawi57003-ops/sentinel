// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SentinelOracle} from "./SentinelOracle.sol";

/// @title SentinelVault
/// @notice ERC-4626 USDC vault holding USDC + audited B20 tokenized stocks.
///         EXPERIMENTAL DEMO — not financial advice. Hard caps keep the demo
///         small: $500 total TVL, $100 per deposit, $1 minimum.
/// @dev totalAssets() = USDC balance + B20 holdings valued at the agent's
///      oracle prices (8dp USD). Tokens with a missing/stale oracle price
///      contribute 0 (they are still withdrawable once repriced or sold).
///      Withdrawals settle in USDC from the vault's USDC balance; if the
///      vault is mostly invested, a withdrawal reverts until the agent sells.
///      Only the authorised strategy operator (SentinelStrategy) can pull
///      assets out of the vault for swaps.
contract SentinelVault is ERC4626, Ownable, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TVL = 500e6; // $500 USDC (6dp)
    uint256 public constant MAX_DEPOSIT = 100e6; // $100 per deposit
    uint256 public constant MIN_DEPOSIT = 1e6; // $1 minimum

    SentinelOracle public immutable oracle;
    address public operator; // SentinelStrategy, set by owner

    address[] public holdings; // B20 tokens counted in totalAssets()
    mapping(address => bool) public isHolding;

    event OperatorSet(address indexed operator);
    event HoldingAdded(address indexed token);
    event HoldingRemoved(address indexed token);

    error InsufficientUsdcLiquidity(uint256 available, uint256 requested);

    constructor(IERC20 usdc, SentinelOracle _oracle, address agent)
        ERC4626(usdc)
        ERC20("Sentinel B20 Index", "sB20")
        Ownable(agent)
    {
        oracle = _oracle;
    }

    function decimals() public view override(ERC4626) returns (uint8) {
        return 6; // shares track USDC (6dp)
    }

    // ---- admin ----

    function setOperator(address _operator) external onlyOwner {
        operator = _operator;
        emit OperatorSet(_operator);
    }

    function addHolding(address token) external onlyOwner {
        require(token != address(0), "zero token");
        require(!isHolding[token], "already holding");
        isHolding[token] = true;
        holdings.push(token);
        emit HoldingAdded(token);
    }

    function removeHolding(address token) external onlyOwner {
        require(isHolding[token], "not holding");
        isHolding[token] = false;
        uint256 len = holdings.length;
        for (uint256 i; i < len; i++) {
            if (holdings[i] == token) {
                holdings[i] = holdings[len - 1];
                holdings.pop();
                break;
            }
        }
        emit HoldingRemoved(token);
    }

    function holdingsList() external view returns (address[] memory) {
        return holdings;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---- strategy operator ----

    /// @notice Pull `amount` of `token` from the vault to `to`. Strategy only.
    function pull(address token, uint256 amount, address to) external {
        require(msg.sender == operator, "not operator");
        require(to != address(0), "zero to");
        IERC20(token).safeTransfer(to, amount);
    }

    // ---- ERC-4626 with caps ----

    function totalAssets() public view override returns (uint256) {
        uint256 total = IERC20(asset()).balanceOf(address(this));
        uint256 len = holdings.length;
        for (uint256 i; i < len; i++) {
            address token = holdings[i];
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal == 0) continue;
            (uint256 priceUsd8dp, bool fresh) = oracle.tryGetPrice(token);
            if (!fresh) continue; // stale/missing price contributes 0
            // bal is 8dp, price is 8dp USD -> value in USDC 6dp:
            // bal * price / 1e8 = USD 8dp; / 100 = USDC 6dp
            total += (bal * priceUsd8dp) / 1e8 / 100;
        }
        return total;
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        require(assets >= MIN_DEPOSIT, "below min $1");
        require(assets <= MAX_DEPOSIT, "above max $100");
        require(totalAssets() + assets <= MAX_TVL, "TVL cap $500");
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        uint256 assets = previewMint(shares);
        require(assets >= MIN_DEPOSIT, "below min $1");
        require(assets <= MAX_DEPOSIT, "above max $100");
        require(totalAssets() + assets <= MAX_TVL, "TVL cap $500");
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        uint256 usdcBal = IERC20(asset()).balanceOf(address(this));
        if (assets > usdcBal) revert InsufficientUsdcLiquidity(usdcBal, assets);
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        uint256 assets = previewRedeem(shares);
        uint256 usdcBal = IERC20(asset()).balanceOf(address(this));
        if (assets > usdcBal) revert InsufficientUsdcLiquidity(usdcBal, assets);
        return super.redeem(shares, receiver, owner);
    }
}
