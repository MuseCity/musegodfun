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
    mapping(address => uint256) private shares;
    mapping(address => uint256) private last0;
    mapping(address => uint256) private last1;
    uint256 private cumulative0;
    uint256 private cumulative1;
    function configure(PoolKey calldata key_, address beneficiary_, uint256 share_, uint256 a0, uint256 a1) external {
        shares[beneficiary] = 0;
        key = key_; beneficiary = beneficiary_; share = share_; amount0 = a0; amount1 = a1;
        shares[beneficiary_] = share_;
        last0[beneficiary_] = cumulative0; last1[beneficiary_] = cumulative1;
    }
    function seedBeneficiary(address account, uint256 value) external { shares[account] = value; last0[account] = cumulative0; last1[account] = cumulative1; }
    function faults(bool fail_, bool decrease_) external { fail = fail_; decreaseBalance = decrease_; }
    function getPoolKey(bytes32) external view returns (PoolKey memory) { return key; }
    function getShares(bytes32, address account) external view returns (uint256) { return shares[account]; }
    function collectFees(bytes32) external returns (uint128, uint128) {
        require(!fail);
        if (decreaseBalance) NativeCollectorToken(key.currency0).burn(msg.sender, 1);
        else { cumulative0 += amount0; cumulative1 += amount1; _release(msg.sender); }
        return (999, 999); // Only actual balance increments, never nominal return values, are credited.
    }
    // Mirrors the deployed FeesManager: a zero-share caller can collect cumulative fees and update to an
    // existing beneficiary. Both addresses are released before their shares are merged. Fee units are normalized
    // to the configured initial share so the mock's requested initial payouts remain exact integers.
    function updateBeneficiary(bytes32, address next) external {
        require(next != msg.sender);
        _release(msg.sender); _release(next);
        if (shares[next] == 0) { last0[next] = cumulative0; last1[next] = cumulative1; }
        shares[next] += shares[msg.sender]; shares[msg.sender] = 0;
    }
    function _release(address account) private {
        if (shares[account] == 0) return;
        uint256 a0 = (cumulative0 - last0[account]) * shares[account] / share;
        uint256 a1 = (cumulative1 - last1[account]) * shares[account] / share;
        last0[account] = cumulative0; last1[account] = cumulative1;
        NativeCollectorToken(key.currency0).mint(account, a0); NativeCollectorToken(key.currency1).mint(account, a1);
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
    function testInsufficientOrAbsentCollectorSharesRejected() public {
        NativeCollectorManager(INITIALIZER).configure(key, CALLER, 0.228e18, 40, 60);
        NativeCollectorManager(REHYPE).configure(key, address(collector), 0.239e18, 10, 20);
        vm.expectRevert(Collector.NoValidClaim.selector); claim();
    }
    function testAdditionalBeneficiarySharesCannotDisableClaims() public {
        NativeCollectorManager(INITIALIZER).seedBeneficiary(CALLER, 0.1e18);
        vm.prank(CALLER); NativeCollectorManager(INITIALIZER).updateBeneficiary(poolId, address(collector));
        require(NativeCollectorManager(INITIALIZER).getShares(poolId, address(collector)) > collector.LP_SHARE());
        claim(); require(collector.pendingFees(address(token0)) >= 50);
    }
    function testZeroShareUpdateBypassRecoversIntoUnknownWithoutFakingFeeIncome() public {
        NativeCollectorManager(REHYPE).faults(true, false);
        vm.prank(CALLER); NativeCollectorManager(INITIALIZER).collectFees(poolId);
        require(token0.balanceOf(CALLER) == 0);
        vm.prank(CALLER); NativeCollectorManager(INITIALIZER).updateBeneficiary(poolId, address(collector));
        require(token0.balanceOf(address(collector)) == 40); require(collector.pendingFees(address(token0)) == 0);
        // Register the actual pool assets even when this next claim has no fresh fee.
        NativeCollectorManager(INITIALIZER).configure(key, address(collector), 0.228e18, 0, 0);
        claim(); collector.syncUntracked(address(token0));
        require(collector.pendingUntracked(address(token0)) == 40); require(collector.totalClaimed(address(token0)) == 0);
        require(collector.totalUntrackedSynced(address(token0)) == 40);
        resume(); collector.releaseUntracked(address(token0), 40);
        require(token0.balanceOf(RECEIVER) == 40); require(collector.totalReleased(address(token0)) == 0);
        require(collector.totalUntrackedReleased(address(token0)) == 40);
    }
    function testUnknownDonationRecoveryNeverMixesWithClaimedFees() public {
        claim(); token0.mint(address(collector), 123); collector.syncUntracked(address(token0));
        require(collector.pendingFees(address(token0)) == 50); require(collector.pendingUntracked(address(token0)) == 123);
        require(collector.untrackedBalance(address(token0)) == 0);
        vm.expectRevert(Collector.Paused.selector); collector.releaseUntracked(address(token0), 123);
        resume(); collector.releaseUntracked(address(token0), 123); collector.releaseFees(address(token0), 50);
        require(token0.balanceOf(RECEIVER) == 173); require(collector.totalReleased(address(token0)) == 50);
        require(collector.totalClaimed(address(token0)) == 50); require(collector.totalUntrackedReleased(address(token0)) == 123);
    }
    function testUnverifiedAssetCannotSyncAndBothBucketsEnforceSolvency() public {
        NativeCollectorToken unknown = new NativeCollectorToken(); unknown.mint(address(collector), 5);
        vm.expectRevert(Collector.InvalidPool.selector); collector.syncUntracked(address(unknown));
        claim(); token0.mint(address(collector), 5); collector.syncUntracked(address(token0)); resume();
        token0.burn(address(collector), 1);
        vm.expectRevert(Collector.BalanceMismatch.selector); collector.releaseUntracked(address(token0), 1);
        vm.expectRevert(Collector.BalanceMismatch.selector); collector.releaseFees(address(token0), 1);
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
    function testUnknownReleaseTaxAndReentrancyRollBackBothBuckets() public {
        claim(); token0.mint(address(collector), 12); collector.syncUntracked(address(token0)); resume();
        token0.configure(1, false);
        vm.expectRevert(Collector.BalanceMismatch.selector); collector.releaseUntracked(address(token0), 12);
        require(collector.pendingUntracked(address(token0)) == 12); require(collector.totalUntrackedReleased(address(token0)) == 0);
        require(collector.pendingFees(address(token0)) == 50); require(token0.balanceOf(RECEIVER) == 0);
        token0.configure(0, true);
        vm.expectRevert(bytes4(keccak256("ReentrancyGuardReentrantCall()"))); collector.releaseUntracked(address(token0), 12);
        require(collector.pendingUntracked(address(token0)) == 12); require(collector.pendingFees(address(token0)) == 50);
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
    function testFuzzFeeAndUnknownConservation(uint128 feeAmount, uint128 unknownAmount) public {
        NativeCollectorManager(INITIALIZER).configure(key, address(collector), 0.228e18, feeAmount, 0);
        NativeCollectorManager(REHYPE).configure(key, address(collector), 0.24e18, 0, 0);
        claim(); token0.mint(address(collector), unknownAmount);
        if (unknownAmount != 0) collector.syncUntracked(address(token0));
        resume();
        if (unknownAmount != 0) collector.releaseUntracked(address(token0), unknownAmount);
        require(collector.pendingFees(address(token0)) == feeAmount); require(collector.totalClaimed(address(token0)) == feeAmount);
        if (feeAmount != 0) collector.releaseFees(address(token0), feeAmount);
        require(collector.totalReleased(address(token0)) == feeAmount); require(collector.totalUntrackedReleased(address(token0)) == unknownAmount);
        require(collector.pendingFees(address(token0)) == 0 && collector.pendingUntracked(address(token0)) == 0);
        require(token0.balanceOf(RECEIVER) == uint256(feeAmount) + unknownAmount);
    }
}
