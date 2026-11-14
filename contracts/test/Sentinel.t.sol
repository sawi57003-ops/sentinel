// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SentinelOracle} from "../src/SentinelOracle.sol";
import {SentinelAuditor} from "../src/SentinelAuditor.sol";
import {SentinelVault} from "../src/SentinelVault.sol";
import {SentinelStrategy} from "../src/SentinelStrategy.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockB20 is ERC20 {
    constructor(string memory name, string memory sym) ERC20(name, sym) {}
    function decimals() public pure override returns (uint8) { return 8; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Fixed-rate mock of a Slipstream (Uniswap V3-style) CL pool.
/// rate is tokenOut per tokenIn, scaled by 1e18 (applies on raw units).
/// Calls back into the swapper (strategy) for the input tokens, like a real pool.
contract MockPool {
    address public immutable token0;
    address public immutable token1;
    mapping(address => mapping(address => uint256)) public rate; // in => out => 1e18

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    function tickSpacing() external pure returns (int24) { return 10; }

    function setRate(address tokenIn, address tokenOut, uint256 r) external {
        rate[tokenIn][tokenOut] = r;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        uint256 r = rate[tokenIn][tokenOut];
        require(r > 0, "no rate");
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountOut = (amountIn * r) / 1e18;
        // collect input via callback, like a real CL pool
        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(amountOut);
        } else {
            amount0 = -int256(amountOut);
            amount1 = int256(amountIn);
        }
        SentinelStrategy(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}


contract SentinelTest is Test {
    address agent = address(0xA11CE);
    address user = address(0xBEEF);

    MockUSDC usdc;
    MockB20 aapl;
    MockB20 nvda;
    MockPool aaplPool;
    MockPool nvdaPool;
    SentinelOracle oracle;
    SentinelAuditor auditor;
    SentinelVault vault;
    SentinelStrategy strategy;

    // AAPL ~$345: 1 USDC (1e6) -> 1/345 token (1e8) ~= 289855 units.
    // rate = out/in = 289855 / 1e6, scaled 1e18 = 289855e12
    uint256 constant AAPL_RATE = 289855e12;
    // NVDA ~$177: 1 USDC -> ~564972 units
    uint256 constant NVDA_RATE = 564972e12;

    function setUp() public {
        vm.startPrank(agent);
        usdc = new MockUSDC();
        aapl = new MockB20("Apple Inc.", "AAPLc");
        nvda = new MockB20("NVIDIA Corp.", "NVDAc");
        aaplPool = new MockPool(address(usdc), address(aapl));
        nvdaPool = new MockPool(address(usdc), address(nvda));
        aaplPool.setRate(address(usdc), address(aapl), AAPL_RATE);
        aaplPool.setRate(address(aapl), address(usdc), 345_000_000 * 1e18 / 100_000_000); // $345/AAPL
        nvdaPool.setRate(address(usdc), address(nvda), NVDA_RATE);
        nvdaPool.setRate(address(nvda), address(usdc), 177_000_000 * 1e18 / 100_000_000); // $177/NVDA
        oracle = new SentinelOracle(agent);
        auditor = new SentinelAuditor(agent);
        vault = new SentinelVault(usdc, oracle, agent);
        strategy = new SentinelStrategy(usdc, auditor, vault, oracle, agent);
        vault.setOperator(address(strategy));
        vault.addHolding(address(aapl));
        vault.addHolding(address(nvda));
        strategy.setPool(address(aapl), address(aaplPool));
        strategy.setPool(address(nvda), address(nvdaPool));
        oracle.setPrice(address(aapl), 345_00000000); // $345
        oracle.setPrice(address(nvda), 177_00000000); // $177
        vm.stopPrank();

        // fund pools with B20 + USDC so mock swaps can pay out
        aapl.mint(address(aaplPool), 1000e8);
        nvda.mint(address(nvdaPool), 1000e8);
        usdc.mint(address(aaplPool), 1000e6);
        usdc.mint(address(nvdaPool), 1000e6);
        // fund user with USDC
        usdc.mint(user, 1000e6);
    }

    // ---- Auditor ----

    function testAuditorPublishAndApprove() public {
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, keccak256("report"));
        assertTrue(auditor.isApproved(address(aapl)));
        SentinelAuditor.Verdict memory v = auditor.getVerdict(address(aapl));
        assertEq(v.score, 85);
        assertTrue(v.passed);
    }

    function testAuditorRejectsInconsistentPass() public {
        vm.prank(agent);
        vm.expectRevert("passed!=score>=70");
        auditor.publishVerdict(address(aapl), 60, true, bytes32(0));
    }

    function testAuditorStaleVerdictNotApproved() public {
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
        vm.warp(block.timestamp + 8 days);
        assertFalse(auditor.isApproved(address(aapl)));
    }

    function testAuditorBatch() public {
        address[] memory toks = new address[](2);
        toks[0] = address(aapl);
        toks[1] = address(nvda);
        uint8[] memory scores = new uint8[](2);
        scores[0] = 90;
        scores[1] = 40;
        bool[] memory passed = new bool[](2);
        passed[0] = true;
        passed[1] = false;
        bytes32[] memory hashes = new bytes32[](2);
        vm.prank(agent);
        auditor.publishVerdictBatch(toks, scores, passed, hashes);
        assertTrue(auditor.isApproved(address(aapl)));
        assertFalse(auditor.isApproved(address(nvda)));
    }

    function testAuditorOnlyAgent() public {
        vm.prank(user);
        vm.expectRevert();
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
    }

    // ---- Oracle ----

    function testOracleStaleness() public {
        (uint256 p, bool fresh) = oracle.tryGetPrice(address(aapl));
        assertEq(p, 345_00000000);
        assertTrue(fresh);
        vm.warp(block.timestamp + 49 hours);
        (, fresh) = oracle.tryGetPrice(address(aapl));
        assertFalse(fresh);
    }

    // ---- Vault ----

    function _deposit(uint256 amount) internal returns (uint256 shares) {
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, user);
        vm.stopPrank();
    }

    function testVaultDepositAndWithdraw() public {
        uint256 shares = _deposit(10e6);
        assertEq(shares, 10e6);
        assertEq(vault.totalAssets(), 10e6);
        vm.prank(user);
        vault.withdraw(10e6, user, user);
        assertEq(usdc.balanceOf(user), 1000e6);
    }

    function testVaultMinDeposit() public {
        vm.startPrank(user);
        usdc.approve(address(vault), 1e6 - 1);
        vm.expectRevert("below min $1");
        vault.deposit(1e6 - 1, user);
        vm.stopPrank();
    }

    function testVaultMaxDeposit() public {
        vm.startPrank(user);
        usdc.approve(address(vault), 101e6);
        vm.expectRevert("above max $100");
        vault.deposit(101e6, user);
        vm.stopPrank();
    }

    function testVaultTvlCap() public {
        _deposit(100e6);
        // 5 more deposits of $100 would exceed $500; the 5th (total $500) is ok,
        // the 6th reverts. Deposit 4x $100 = $500 total, then 1 more.
        for (uint256 i; i < 4; i++) _deposit(100e6);
        assertEq(vault.totalAssets(), 500e6);
        vm.startPrank(user);
        usdc.approve(address(vault), 1e6);
        vm.expectRevert("TVL cap $500");
        vault.deposit(1e6, user);
        vm.stopPrank();
    }

    function testVaultPauseBlocksDeposit() public {
        vm.prank(agent);
        vault.pause();
        vm.startPrank(user);
        usdc.approve(address(vault), 10e6);
        vm.expectRevert();
        vault.deposit(10e6, user);
        vm.stopPrank();
    }

    function testVaultTotalAssetsWithHoldings() public {
        _deposit(10e6);
        // agent buys $2 of AAPL: vault holds ~$2 AAPL + $8 USDC = $10 total
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
        vm.prank(agent);
        strategy.buy(address(aapl), 2e6, 568116); // ~0.00579710 AAPL
        assertApproxEqAbs(vault.totalAssets(), 10e6, 1000); // within $0.001
        assertGt(aapl.balanceOf(address(vault)), 0);
    }

    function testVaultWithdrawBlockedWhenInvested() public {
        _deposit(10e6);
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
        vm.prank(agent);
        auditor.publishVerdict(address(nvda), 85, true, bytes32(0));
        vm.prank(agent);
        strategy.buy(address(aapl), 2e6, 568116);
        vm.prank(agent);
        strategy.buy(address(nvda), 2e6, 1107346);
        // only $6 USDC left; withdrawing $8 must revert
        vm.prank(user);
        vm.expectRevert();
        vault.withdraw(8e6, user, user);
        // withdrawing $6 works
        vm.prank(user);
        vault.withdraw(6e6, user, user);
    }

    function testVaultPullOnlyOperator() public {
        vm.prank(user);
        vm.expectRevert("not operator");
        vault.pull(address(usdc), 1, user);
    }

    // ---- Strategy ----

    function testStrategyBuyRequiresApproval() public {
        _deposit(10e6);
        vm.prank(agent);
        vm.expectRevert("not approved");
        strategy.buy(address(aapl), 1e6, 284058);
    }

    function testStrategyBuyAndSell() public {
        _deposit(10e6);
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
        vm.prank(agent);
        uint256 out = strategy.buy(address(aapl), 1e6, 284058);
        assertEq(out, 289855);
        assertEq(usdc.balanceOf(address(vault)), 9e6);
        vm.prank(agent);
        uint256 usdcOut = strategy.sell(address(aapl), out, 980000);
        assertApproxEqAbs(usdcOut, 1e6, 2000);
    }

    function testStrategyCap25Percent() public {
        _deposit(10e6);
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
        // $10 vault: buying $3 of AAPL = 30% > 25% cap must revert
        vm.prank(agent);
        vm.expectRevert("over 25% cap");
        strategy.buy(address(aapl), 3e6, 852174);
        // $2 = 20% is fine
        vm.prank(agent);
        strategy.buy(address(aapl), 2e6, 568116);
    }

    function testStrategyMinOutEnforced() public {
        _deposit(10e6);
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
        // mock pool pays 289855 for $1; a minOut above that must revert
        vm.prank(agent);
        vm.expectRevert("minOut");
        strategy.buy(address(aapl), 1e6, 300000);
    }

    function testStrategyEmergencyExit() public {
        _deposit(10e6);
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 85, true, bytes32(0));
        vm.prank(agent);
        strategy.buy(address(aapl), 2e6, 568116);
        // token now fails its audit
        vm.prank(agent);
        auditor.publishVerdict(address(aapl), 40, false, bytes32(0));
        vm.prank(agent);
        uint256 usdcOut = strategy.emergencyExit(address(aapl), 1900000);
        assertGt(usdcOut, 0);
        assertEq(aapl.balanceOf(address(vault)), 0);
    }

    function testStrategyOnlyAgent() public {
        vm.prank(user);
        vm.expectRevert();
        strategy.buy(address(aapl), 1e6, 284058);
    }
}
