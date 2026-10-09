// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MusegodBaseFeeCollector as Collector} from "../src/MusegodBaseFeeCollector.sol";
import {PoolKey} from "../src/interfaces/IDopplerBundler.sol";

interface CollectorVm {
    function etch(address, bytes calldata) external;
    function chainId(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract NativeCollectorToken {
    mapping(address => uint256) public balanceOf;
    uint256 public transferTax;
    bool public callback;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function burn(address from, uint256 amount) external { balanceOf[from] -= amount; }
    function configure(uint256 tax, bool callback_) external { transferTax = tax; callback = callback_; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (callback) Collector(msg.sender).releaseFees(address(this), 1);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - transferTax;
        return true;
    }
}

contract NativeCollectorManager {
    PoolKey private key;
    address public beneficiary;
    uint256 public share;
    uint256 public amount0;
    uint256 public amount1;
    bool public fail;
    bool public decreaseBalance;
    function configure(PoolKey calldata key_, address beneficiary_, uint256 share_, uint256 a0, uint256 a1) external {
        key = key_; beneficiary = beneficiary_; share = share_; amount0 = a0; amount1 = a1;
    }
    function faults(bool fail_, bool decrease_) external { fail = fail_; decreaseBalance = decrease_; }
    function getPoolKey(bytes32) external view returns (PoolKey memory) { return key; }
    function getShares(bytes32, address account) external view returns (uint256) { return account == beneficiary ? share : 0; }
    function collectFees(bytes32) external returns (uint128, uint128) {
        require(!fail);
        if (decreaseBalance) NativeCollectorToken(key.currency0).burn(msg.sender, 1);
        else NativeCollectorToken(key.currency0).mint(msg.sender, amount0);
        NativeCollectorToken(key.currency1).mint(msg.sender, amount1);
        return (999, 999); // Only actual balance increments, never nominal return values, are credited.
    }
}

contract NativeAutomationFixture { }

contract MusegodBaseFeeCollectorTest {
    CollectorVm constant vm = CollectorVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant INITIALIZER = 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544;
    address constant REHYPE = 0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215;
    address constant GOVERNOR = address(0x111);
    address constant RECEIVER = address(0x222);
    address constant CALLER = address(0x333);
    Collector collector;
    NativeCollectorToken token0;
    NativeCollectorToken token1;
    PoolKey key;
    bytes32 poolId;

    function setUp() public {
        vm.chainId(8453);
        vm.etch(INITIALIZER, address(new NativeCollectorManager()).code);
        vm.etch(REHYPE, address(new NativeCollectorManager()).code);
        vm.etch(RECEIVER, address(new NativeAutomationFixture()).code);
        NativeCollectorToken a = new NativeCollectorToken();
        NativeCollectorToken b = new NativeCollectorToken();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        collector = new Collector(INITIALIZER, REHYPE, GOVERNOR, RECEIVER);
        key = PoolKey(address(token0), address(token1), 0x800000, 10, INITIALIZER);
        poolId = keccak256(abi.encode(key));
        NativeCollectorManager(INITIALIZER).configure(key, address(collector), 0.228e18, 40, 60);
        NativeCollectorManager(REHYPE).configure(key, address(collector), 0.24e18, 10, 20);
    }
    function resume() private { vm.prank(GOVERNOR); collector.resume(); }
    function claim() private { vm.prank(CALLER); collector.claimFees(poolId); }

    function testInitialPauseAndFixedEconomicShares() public view {
        require(collector.paused()); require(collector.automationReceiver() == RECEIVER);
        require(collector.LP_SHARE() == 0.228e18); require(collector.HOOK_SHARE() == 0.24e18);
    }
    function testPermissionlessClaimDuringPauseCreditsBothTokenSidesExactly() public {
        claim(); require(collector.pendingFees(address(token0)) == 50);
        require(collector.pendingFees(address(token1)) == 80); require(collector.totalClaimed(address(token1)) == 80);
    }
    function testClaimRehypeFailureKeepsInitializerFees() public {
        NativeCollectorManager(REHYPE).faults(true, false); claim(); require(collector.pendingFees(address(token0)) == 40);
    }
    function testClaimInitializerFailureKeepsRehypeFees() public {
        NativeCollectorManager(INITIALIZER).faults(true, false); claim(); require(collector.pendingFees(address(token0)) == 10);
    }
    function testBothInvalidManagersReject() public {
        NativeCollectorManager(INITIALIZER).faults(true, false); NativeCollectorManager(REHYPE).faults(true, false);
        vm.expectRevert(Collector.NoValidClaim.selector); claim();
    }
    function testExternalClaimFromRejected() public {
        vm.expectRevert(Collector.Unauthorized.selector); collector.claimFrom(INITIALIZER, poolId);
    }
    function testWrongPoolHashRejected() public {
        vm.expectRevert(Collector.NoValidClaim.selector); collector.claimFees(bytes32(uint256(44)));
    }
    function testWrongHookFeeAndSpacingRejected() public {
        for (uint256 i; i < 3; ++i) {
            PoolKey memory invalid = key;
            if (i == 0) invalid.hooks = REHYPE;
            else if (i == 1) invalid.fee = 3000;
            else invalid.tickSpacing = 60;
            NativeCollectorManager(INITIALIZER).configure(invalid, address(collector), 0.228e18, 40, 60);
            NativeCollectorManager(REHYPE).configure(invalid, address(collector), 0.24e18, 10, 20);
            vm.expectRevert(Collector.NoValidClaim.selector); collector.claimFees(keccak256(abi.encode(invalid)));
        }
    }
    function testOtherBeneficiaryAndDoubleCountedSharesRejected() public {
        NativeCollectorManager(INITIALIZER).configure(key, CALLER, 0.228e18, 40, 60);
        NativeCollectorManager(REHYPE).configure(key, address(collector), 0.48e18, 10, 20);
        vm.expectRevert(Collector.NoValidClaim.selector); claim();
    }
    function testBalanceDecreaseNotCreditedAndOtherManagerSurvives() public {
        token0.mint(address(collector), 5); NativeCollectorManager(INITIALIZER).faults(false, true);
        claim(); require(collector.pendingFees(address(token0)) == 10); require(collector.untrackedBalance(address(token0)) == 5);
    }
    function testPausedBlocksAllRelease() public {
        claim(); vm.expectRevert(Collector.Paused.selector); collector.releaseFees(address(token0), 1);
    }
    function testOnlyGovernorCanResumeAndPause() public {
        vm.expectRevert(Collector.Unauthorized.selector); collector.resume();
        resume(); vm.expectRevert(Collector.Unauthorized.selector); collector.pause();
        vm.prank(GOVERNOR); collector.pause(); require(collector.paused());
    }
    function testPermissionlessReleaseIncludesNewMemeSideAndNoSecondCut() public {
        claim(); resume(); vm.prank(CALLER); collector.releaseFees(address(token1), 80);
        require(token1.balanceOf(RECEIVER) == 80); require(collector.totalReleased(address(token1)) == 80);
        require(collector.pendingFees(address(token1)) == 0);
    }
    function testDonationsCannotBeReleasedAndStayUntracked() public {
        token0.mint(address(collector), 123); claim(); resume();
        vm.expectRevert(Collector.InvalidAmount.selector); collector.releaseFees(address(token0), 51);
        collector.releaseFees(address(token0), 50); require(token0.balanceOf(RECEIVER) == 50);
        require(collector.untrackedBalance(address(token0)) == 123);
    }
    function testZeroReleaseRejected() public {
        resume(); vm.expectRevert(Collector.InvalidAmount.selector); collector.releaseFees(address(token0), 0);
    }
    function testTransferTaxRollsBackLedgerAndBalance() public {
        claim(); resume(); token0.configure(1, false);
        vm.expectRevert(Collector.BalanceMismatch.selector); collector.releaseFees(address(token0), 50);
        require(collector.pendingFees(address(token0)) == 50); require(collector.totalReleased(address(token0)) == 0);
        require(token0.balanceOf(RECEIVER) == 0);
    }
    function testIssuerSeizureShortfallBlocksRelease() public {
        claim(); resume(); token0.burn(address(collector), 1);
        vm.expectRevert(Collector.BalanceMismatch.selector); collector.releaseFees(address(token0), 1);
        require(collector.pendingFees(address(token0)) == 50);
    }
    function testReentrancyRollsBack() public {
        claim(); resume(); token0.configure(0, true);
        vm.expectRevert(bytes4(keccak256("ReentrancyGuardReentrantCall()"))); collector.releaseFees(address(token0), 1);
        require(collector.pendingFees(address(token0)) == 50);
    }
    function testChangedManagerOrAccountCodeBlocksClaimAndResume() public {
        vm.etch(RECEIVER, hex"60006000fd");
        vm.expectRevert(Collector.DependencyChanged.selector); claim();
        vm.prank(GOVERNOR); vm.expectRevert(Collector.DependencyChanged.selector); collector.resume();
    }
    function testChangedDependencyBlocksReleaseButPauseAlwaysWorks() public {
        claim(); resume(); vm.etch(REHYPE, hex"60006000fd");
        vm.expectRevert(Collector.DependencyChanged.selector); collector.releaseFees(address(token0), 1);
        vm.prank(GOVERNOR); collector.pause(); require(collector.paused());
    }
    function testWrongChainAndEOAReceiverRejectConstruction() public {
        vm.chainId(4663); vm.expectRevert(Collector.InvalidConfiguration.selector);
        new Collector(INITIALIZER, REHYPE, GOVERNOR, RECEIVER);
        vm.chainId(8453); vm.expectRevert(Collector.InvalidConfiguration.selector);
        new Collector(INITIALIZER, REHYPE, GOVERNOR, CALLER);
    }
    function testFuzzReleasedFeeConservation(uint128 amount) public {
        NativeCollectorManager(INITIALIZER).configure(key, address(collector), 0.228e18, amount, 0);
        NativeCollectorManager(REHYPE).configure(key, address(collector), 0.24e18, 0, 0);
        claim(); resume();
        if (amount != 0) collector.releaseFees(address(token0), amount);
        require(collector.totalClaimed(address(token0)) == amount);
        require(collector.totalReleased(address(token0)) == amount); require(collector.pendingFees(address(token0)) == 0);
    }
}
