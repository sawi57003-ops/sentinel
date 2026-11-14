// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SentinelOracle} from "../src/SentinelOracle.sol";
import {SentinelAuditor} from "../src/SentinelAuditor.sol";
import {SentinelVault} from "../src/SentinelVault.sol";
import {SentinelStrategy} from "../src/SentinelStrategy.sol";

/// @notice Fork tests against Base mainnet (run: forge test --match-contract SentinelForkTest).
///
/// PLATFORM FINDINGS (2026-11-09, all verified live):
///  1. B20 tokens are Base NATIVE tokens — `eth_getCode` returns a single
///     byte `0xef` for every B20 token (and the policy registry
///     0x8453...0002). They execute in the Base node, not as EVM bytecode,
///     so Foundry/revm CANNOT execute them in a fork (any call reverts with
///     OpcodeNotFound). B20 behaviour was therefore proven OUTSIDE Foundry,
///     against the live node — see VERIFICATION.md:
///       * `cast call --from <AAPLc pool> AAPLc.transfer(burn, 1 AAPLc)` => true
///         (secondary transfer to the burn wallet is permissionless)
///       * `cast call` balanceOf/multiplier/decimals/totalSupply all agree
///         with the official Coinbase Tokenized Stocks API.
///  2. Aerodrome has THREE live Slipstream factory generations and each
///     SwapRouter is pinned to ONE factory. The documented router 0xBE6D...
///     serves the original factory (stale pools; its WETH/USDC pool priced
///     WETH at ~$457k, NO AAPLc pool). Router 0xcbBb... serves the
///     GaugeCaps factory (also NO AAPLc pool — a live `buy` through it
///     reverted "call to non-contract address"). The deep pools live under
///     factory 0x9CB2..., for which no SwapRouter could be identified.
///     SentinelStrategy therefore swaps DIRECTLY against the verified pool
///     (`pool.swap()` + `uniswapV3SwapCallback`), no router in the path.
///  3. What this fork test proves, on live Base state: the direct pool-swap
///     path works against the real WETH/USDC Slipstream pool
///     (0x4A7a..., $9.2M liq, factory 0x9CB2... — the SAME factory as the
///     deep B20 pools), including the callback payment flow, and the full
///     Sentinel flow (deposit -> verdict -> buy -> sell / emergency exit).
///     WETH stands in for B20 here ONLY because B20 cannot execute under
///     revm. The production universe is B20 (8dp); WETH's 18dp means
///     totalAssets() is not asserted in this file.
contract SentinelForkTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant WETH_USDC_POOL = 0x4A7af46bC8aBc00048c6c7920a1488DAF568366c;

    address agent = address(0xA11CE);
    address user = address(0xBEEF);

    SentinelOracle oracle;
    SentinelAuditor auditor;
    SentinelVault vault;
    SentinelStrategy strategy;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("base"));
        vm.startPrank(agent);
        oracle = new SentinelOracle(agent);
        auditor = new SentinelAuditor(agent);
        vault = new SentinelVault(IERC20(USDC), oracle, agent);
        strategy = new SentinelStrategy(IERC20(USDC), auditor, vault, oracle, agent);
        vault.setOperator(address(strategy));
        vault.addHolding(WETH);
        strategy.setPool(WETH, WETH_USDC_POOL);
        // WETH ~$2,117.31 (Dexscreener, 2026-11-09). 8dp oracle price.
        oracle.setPrice(WETH, 211731000000);
        vm.stopPrank();
        deal(USDC, user, 100e6);
    }

    function _deposit5() internal {
        vm.startPrank(user);
        IERC20(USDC).approve(address(vault), 5e6);
        vault.deposit(5e6, user);
        vm.stopPrank();
        vm.prank(agent);
        auditor.publishVerdict(WETH, 85, true, keccak256("audit-weth"));
    }

    function testForkBuyWethWithRealPool() public {
        _deposit5();
        // $1 USDC -> WETH at ~$2,117.31 ~= 0.0004723 WETH = 472.3e12 wei.
        // (Router probe 2026-11-09: $1 -> 471,988,830,494,745 wei.)
        vm.prank(agent);
        uint256 out = strategy.buy(WETH, 1e6, 460000000000000);
        assertGt(out, 460000000000000);
        assertGt(IERC20(WETH).balanceOf(address(vault)), 0);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 4e6);
    }

    function testForkBuySellRoundTrip() public {
        _deposit5();
        vm.prank(agent);
        uint256 out = strategy.buy(WETH, 1e6, 460000000000000);
        vm.prank(agent);
        uint256 usdcOut = strategy.sell(WETH, out, 980000);
        assertGt(usdcOut, 980000);
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0);
    }

    function testForkEmergencyExitAfterFail() public {
        _deposit5();
        vm.prank(agent);
        strategy.buy(WETH, 1e6, 460000000000000);
        vm.prank(agent);
        auditor.publishVerdict(WETH, 40, false, keccak256("audit-weth-fail"));
        vm.prank(agent);
        uint256 usdcOut = strategy.emergencyExit(WETH, 950000);
        assertGt(usdcOut, 950000);
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0);
    }

    function testForkCallbackRejectsUnregisteredPool() public {
        _deposit5();
        // a random caller (not a registered pool) must not be able to drain
        // the strategy through the swap callback
        vm.prank(user);
        vm.expectRevert("not registered pool");
        strategy.uniswapV3SwapCallback(1, 0, abi.encode(WETH));
    }
}
