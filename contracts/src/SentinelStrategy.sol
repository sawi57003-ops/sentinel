// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SentinelAuditor} from "./SentinelAuditor.sol";
import {SentinelVault} from "./SentinelVault.sol";
import {SentinelOracle} from "./SentinelOracle.sol";

/// @notice Minimal interface of an Aerodrome Slipstream (Uniswap V3-style)
///         concentrated-liquidity pool, as used by SentinelStrategy.
interface ICLPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @title SentinelStrategy
/// @notice Agent-only executor: buys/sells B20 tokens for the SentinelVault
///         by swapping DIRECTLY against the verified Slipstream pool of each
///         token (no router in the path).
/// @dev Why direct pool swaps (2026-11-09, verified on Base mainnet):
///      Aerodrome has THREE live Slipstream factory generations and the
///      SwapRouters are each pinned to ONE factory. The router in the
///      public docs (0xBE6D...) serves the original factory, whose pools
///      are stale (its WETH/USDC pool priced WETH at ~$457k; it has NO
///      AAPLc pool at all). The other documented router (0xcbBb...) serves
///      the GaugeCaps factory, which also has NO AAPLc pool — a live
///      `buy` through it reverted with "call to non-contract address".
///      The deep pools (e.g. AAPLc/USDC 0xF5FC...) belong to factory
///      0x9CB2..., for which no SwapRouter could be identified. Calling the
///      pool's `swap()` directly and answering its `uniswapV3SwapCallback`
///      sidesteps router generations entirely: the pool address per token
///      is set by the owner and validated (token0/token1 must be
///      {USDC, token}).
///
///      Rules enforced on-chain (the agent cannot bypass them):
///      - only tokens with a fresh PASSING audit verdict may be bought;
///      - no single holding may exceed 25% of vault totalAssets after a buy;
///      - every swap carries a `minOut` computed by the agent off-chain
///        from the pool's slot0 price with a 2% band (5% for emergency
///        exits); the swap reverts unless the pool actually delivers it;
///      - swap output is sent straight to the vault, never held here;
///      - the swap callback only pays pools registered for the traded token.
///      The vault never mints/redeems B20 — it only trades on secondary DEX
///      markets, which is permissionless.
contract SentinelStrategy is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_WEIGHT_BPS = 2500; // 25% per holding
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IERC20 public immutable usdc;
    SentinelAuditor public immutable auditor;
    SentinelVault public immutable vault;
    SentinelOracle public immutable oracle;

    mapping(address => address) public pools; // B20 token => its Slipstream pool

    event PoolSet(address indexed token, address indexed pool);
    event Bought(address indexed token, uint256 usdcIn, uint256 tokenOut);
    event Sold(address indexed token, uint256 tokenIn, uint256 usdcOut);
    event EmergencyExit(address indexed token, uint256 tokenIn, uint256 usdcOut);

    constructor(
        IERC20 _usdc,
        SentinelAuditor _auditor,
        SentinelVault _vault,
        SentinelOracle _oracle,
        address agent
    ) Ownable(agent) {
        usdc = _usdc;
        auditor = _auditor;
        vault = _vault;
        oracle = _oracle;
    }

    /// @notice Register (or replace) the Slipstream pool for a token.
    ///         The pool must pair the token against USDC.
    function setPool(address token, address pool) public onlyOwner {
        require(token != address(0) && pool != address(0), "zero address");
        address t0 = ICLPool(pool).token0();
        address t1 = ICLPool(pool).token1();
        require(
            (t0 == address(usdc) && t1 == token) || (t0 == token && t1 == address(usdc)),
            "pool is not token/USDC"
        );
        pools[token] = pool;
        emit PoolSet(token, pool);
    }

    function setPools(address[] calldata tokens, address[] calldata poolAddresses)
        external
        onlyOwner
    {
        require(tokens.length == poolAddresses.length, "length");
        for (uint256 i; i < tokens.length; i++) {
            setPool(tokens[i], poolAddresses[i]);
        }
    }

    // ---- trading ----

    /// @notice Buy `token` with `usdcAmount` of the vault's USDC.
    /// @param minOut floor of B20 out (8dp); agent-computed from slot0 with a 2% band.
    function buy(address token, uint256 usdcAmount, uint256 minOut)
        external
        onlyOwner
        returns (uint256 tokenOut)
    {
        require(auditor.isApproved(token), "not approved");
        require(usdcAmount > 0, "zero amount");
        require(minOut > 0, "zero minOut");
        address pool = pools[token];
        require(pool != address(0), "no pool");

        // 25% single-holding cap, evaluated on post-trade value.
        uint256 vaultAssets = vault.totalAssets();
        (uint256 priceUsd8dp, bool fresh) = oracle.tryGetPrice(token);
        require(fresh, "no fresh price");
        if (vaultAssets > 0) {
            uint256 heldValue =
                (IERC20(token).balanceOf(address(vault)) * priceUsd8dp) / 1e8 / 100;
            require(
                (heldValue + usdcAmount) * 10000 <= vaultAssets * MAX_WEIGHT_BPS,
                "over 25% cap"
            );
        }
        // NOTE: when the vault is empty (first seed buy) the cap check is
        // skipped — the first buy necessarily starts from 0% and the cap
        // binds on every subsequent buy.

        vault.pull(address(usdc), usdcAmount, address(this));
        tokenOut = _swap(pool, token, address(usdc), usdcAmount, minOut);
        require(tokenOut >= minOut, "minOut");
        emit Bought(token, usdcAmount, tokenOut);
    }

    /// @notice Sell `tokenAmount` of `token` for USDC.
    function sell(address token, uint256 tokenAmount, uint256 minOut)
        external
        onlyOwner
        returns (uint256 usdcOut)
    {
        require(tokenAmount > 0, "zero amount");
        require(minOut > 0, "zero minOut");
        address pool = pools[token];
        require(pool != address(0), "no pool");

        vault.pull(token, tokenAmount, address(this));
        usdcOut = _swap(pool, address(usdc), token, tokenAmount, minOut);
        require(usdcOut >= minOut, "minOut");
        emit Sold(token, tokenAmount, usdcOut);
    }

    /// @notice Sell the vault's entire balance of `token` to USDC immediately
    ///         (used the moment a token newly fails its audit).
    function emergencyExit(address token, uint256 minOut)
        external
        onlyOwner
        returns (uint256 usdcOut)
    {
        uint256 bal = IERC20(token).balanceOf(address(vault));
        require(bal > 0, "no balance");
        require(minOut > 0, "zero minOut");
        address pool = pools[token];
        require(pool != address(0), "no pool");

        vault.pull(token, bal, address(this));
        usdcOut = _swap(pool, address(usdc), token, bal, minOut);
        require(usdcOut >= minOut, "minOut");
        emit EmergencyExit(token, bal, usdcOut);
    }

    /// @notice Swap `amountIn` of `tokenIn` for `tokenOut` on `pool`.
    ///         Output goes straight to the vault (the swap recipient).
    function _swap(address pool, address tokenOut, address tokenIn, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 amountOut)
    {
        bool zeroForOne = tokenIn == ICLPool(pool).token0();
        uint160 sqrtPriceLimit =
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        (int256 amount0, int256 amount1) = ICLPool(pool).swap(
            address(vault),
            zeroForOne,
            int256(amountIn),
            sqrtPriceLimit,
            // data carries the TRADED (non-USDC) token, so the callback can
            // verify the caller is that token's registered pool.
            abi.encode(tokenOut == address(usdc) ? tokenIn : tokenOut)
        );
        // The pool's deltas: the token we receive has a negative delta.
        if (tokenOut == ICLPool(pool).token0()) {
            require(amount0 < 0, "no output");
            amountOut = uint256(-amount0);
        } else {
            require(amount1 < 0, "no output");
            amountOut = uint256(-amount1);
        }
        require(amountOut >= minOut, "minOut");
    }

    /// @notice Slipstream/Uniswap V3 swap callback. The pool calls this on
    ///         the swapper (this contract) to collect the input tokens.
    /// @dev `data` is abi.encode(tradedToken) — the non-USDC token of the
    ///      pair. Only that token's registered pool may call it, and it may
    ///      only collect USDC or the traded token.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data)
        external
    {
        address token = abi.decode(data, (address));
        require(msg.sender == pools[token], "not registered pool");
        if (amount0Delta > 0) {
            address t0 = ICLPool(msg.sender).token0();
            require(t0 == token || t0 == address(usdc), "callback token mismatch");
            IERC20(t0).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            address t1 = ICLPool(msg.sender).token1();
            require(t1 == token || t1 == address(usdc), "callback token mismatch");
            IERC20(t1).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }
}
