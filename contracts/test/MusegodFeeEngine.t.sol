// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MusegodFeeEngine} from "../src/MusegodFeeEngine.sol";
import {PoolKey} from "../src/interfaces/IDopplerBundler.sol";

interface VmEngine {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function etch(address, bytes calldata) external;
    function getNonce(address) external view returns (uint64);
}

contract EngineToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public tax;
    bool public badReset;
    address public blockedRecipient;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setTax(bool enabled) external {
        tax = enabled;
    }

    function setBadReset(bool enabled) external {
        badReset = enabled;
    }

    function setBlockedRecipient(address recipient) external {
        blockedRecipient = recipient;
    }

    function approve(address to, uint256 amount) external returns (bool) {
        allowance[msg.sender][to] = badReset && amount == 0 ? 1 : amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != blockedRecipient, "recipient unavailable");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - (tax ? 1 : 0);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract EngineManager {
    mapping(bytes32 => PoolKey) public getPoolKey;
    mapping(bytes32 => mapping(address => uint256)) public getShares;
    mapping(bytes32 => uint256) public owed0;
    mapping(bytes32 => uint256) public owed1;
    bool public fail;

    function configure(PoolKey memory key, address beneficiary, uint256 share) external returns (bytes32 id) {
        id = keccak256(abi.encode(key));
        getPoolKey[id] = key;
        getShares[id][beneficiary] = share;
    }

    function accrue(bytes32 id, uint256 amount0, uint256 amount1) external {
        owed0[id] += amount0;
        owed1[id] += amount1;
        PoolKey memory key = getPoolKey[id];
        EngineToken(key.currency0).mint(address(this), amount0);
        EngineToken(key.currency1).mint(address(this), amount1);
    }

    function setFail(bool value) external {
        fail = value;
    }

    function collectFees(bytes32 id) external returns (uint128, uint128) {
        require(!fail, "manager unavailable");
        PoolKey memory key = getPoolKey[id];
        uint256 a = owed0[id];
        uint256 b = owed1[id];
        owed0[id] = 0;
        owed1[id] = 0;
        if (a != 0) EngineToken(key.currency0).transfer(msg.sender, a);
        if (b != 0) EngineToken(key.currency1).transfer(msg.sender, b);
        // The protocol return is total collected, not the caller's receipt.
        return (777777, 888888);
    }
}

contract EngineOracle {
    address public weth;
    constructor(address weth_) { weth = weth_; }
    struct AssetFeed {
        address feed;
        uint32 maxAge;
        uint8 tokenDecimals;
        uint8 feedDecimals;
        bool checkOraclePaused;
    }

    mapping(address => AssetFeed) public assetFeeds;
    bool public fail;
    bool public paused;
    uint256 public scale = 2;

    function setFail(bool value) external {
        fail = value;
    }

    function setScale(uint256 value) external {
        scale = value;
    }

    function setFeed(address token, address feed) external {
        assetFeeds[token] = AssetFeed(feed, 86400, 18, 8, false);
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function quoteToWeth(address token, uint256 amount) external view returns (uint256) {
        require(!fail, "unavailable oracle");
        require(!paused, "paused asset");
        require(assetFeeds[token].feed != address(0), "unsupported asset");
        return amount * scale;
    }

    function quoteWethToMuse(uint256 amount) external view returns (uint256) {
        require(!fail, "unavailable oracle");
        return amount * scale;
    }
}

contract EngineSwapper {
    address public owner;
    bool public paused;
    address public constant beneficiary = 0x000000000000000000000000000000000000dEaD;
    address public tokenToBeneficiary;
    address public oracle;
    uint32 public defaultScaledOfferFactor = 985000;

    constructor(address token, address oracle_) {
        tokenToBeneficiary = token;
        oracle = oracle_;
    }
}

contract EngineExecutor {}

contract EngineAutomation {}
contract EngineVault {
    address public weth; address public musegod; address public oracle; address public swapper;
    constructor(address w,address m,address o,address s) { weth=w; musegod=m; oracle=o; swapper=s; }
}

contract EngineRouter {
    uint256 public output = 200;
    uint256 public unspent;
    bool public reenter;
    bool public reentered;

    function configure(uint256 value, uint256 leave) external {
        output = value;
        unspent = leave;
    }

    function setReenter(bool value) external {
        reenter = value;
    }

    function swap(MusegodFeeEngine.SwapExecutionParams calldata p) external returns (uint256, uint256) {
        EngineToken(p.desc.srcToken).transferFrom(msg.sender, p.callTarget, p.desc.amount - unspent);
        if (reenter) {
            (reentered,) = msg.sender.call(abi.encodeWithSignature("forwardWeth(uint256)", 1));
        }
        EngineToken(p.desc.dstToken).mint(p.desc.dstReceiver, output);
        return (output, 1);
    }
}

contract MusegodFeeEngineTest {
    VmEngine private constant vm = VmEngine(address(uint160(uint256(keccak256("hevm cheat code")))));
    EngineToken private weth;
    EngineToken private muse;
    EngineToken private asset;
    EngineManager private lp;
    EngineManager private hook;
    EngineOracle private oracle;
    EngineSwapper private swapper;
    EngineRouter private router;
    EngineExecutor private executor;
    EngineAutomation private automation;
    MusegodFeeEngine private engine;
    EngineVault private vault;
    bytes32 private poolId;
    PoolKey private key;
    address private constant STRANGER = address(0xAA);
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        vm.warp(1000);
        weth = new EngineToken();
        muse = new EngineToken();
        asset = new EngineToken();
        lp = new EngineManager();
        hook = new EngineManager();
        oracle = new EngineOracle(address(weth));
        oracle.setFeed(address(asset), address(oracle));
        swapper = new EngineSwapper(address(muse), address(oracle));
        router = new EngineRouter();
        executor = new EngineExecutor();
        automation = new EngineAutomation();
        vault = new EngineVault(address(weth), address(muse), address(oracle), address(swapper));
        engine = new MusegodFeeEngine(
            address(lp),
            address(hook),
            address(oracle),
            address(swapper),
            address(weth),
            address(muse),
            address(router),
            address(executor),
            address(automation), address(oracle), address(vault)
        );
        key = _key(address(asset), address(weth));
        poolId = _configure(key);
    }

    function _key(address a, address b) private view returns (PoolKey memory) {
        return a < b ? PoolKey(a, b, 0x800000, 10, address(lp)) : PoolKey(b, a, 0x800000, 10, address(lp));
    }

    function _configure(PoolKey memory k) private returns (bytes32 id) {
        id = lp.configure(k, address(engine), 0.228e18);
        hook.configure(k, address(engine), 0.24e18);
    }

    function _accrue(EngineManager manager, bytes32 id, PoolKey memory k, address token, uint256 amount) private {
        manager.accrue(id, k.currency0 == token ? amount : 0, k.currency1 == token ? amount : 0);
    }

    function _claimAsset(uint256 amount) private {
        _accrue(lp, poolId, key, address(asset), amount);
        vm.prank(STRANGER);
        engine.claimFees(poolId);
    }

    function _nextWindow() private {
        vm.warp(block.timestamp / 300 * 300 + 300);
    }

    function _route(uint256 amount, uint256 minOut, uint256 flags) private view returns (bytes memory) {
        address[] memory receivers = new address[](flags == 32 ? 0 : 1);
        uint256[] memory amounts = new uint256[](flags == 32 ? 0 : 1);
        bytes memory target;
        if (flags == 32) {
            address[] memory pools = new address[](1);
            pools[0] = address(executor);
            uint256[] memory first = new uint256[](1);
            first[0] = amount;
            bytes[] memory data = new bytes[](1);
            data[0] = hex"01";
            target = abi.encode(MusegodFeeEngine.SimpleSwapData(pools, first, data, block.timestamp + 60, hex""));
        } else {
            receivers[0] = address(executor);
            amounts[0] = amount;
            target = hex"aabb";
        }
        MusegodFeeEngine.SwapDescription memory d = MusegodFeeEngine.SwapDescription(
            address(asset),
            address(weth),
            receivers,
            amounts,
            new address[](0),
            new uint256[](0),
            address(engine),
            amount,
            minOut,
            flags,
            hex""
        );
        return abi.encodeWithSelector(
            EngineRouter.swap.selector,
            MusegodFeeEngine.SwapExecutionParams(address(executor), address(0), target, d, hex"")
        );
    }

    function _convert(uint256 amount, uint256 minOut, uint256 flags) private {
        engine.convertToWeth(address(asset), amount, _route(amount, minOut, flags), minOut, block.timestamp + 60);
    }

    function testPublicClaimUsesActualShareReceiptsAndDoesNotRepeat() public {
        _accrue(lp, poolId, key, address(asset), 700);
        _accrue(hook, poolId, key, address(asset), 300);
        vm.prank(STRANGER);
        engine.claimFees(poolId);
        require(engine.pending(address(asset)) == 1000 && engine.totalClaimed(address(asset)) == 1000);
        engine.claimFees(poolId);
        require(engine.pending(address(asset)) == 1000);
    }

    function testSecondManagerFailurePreservesFirstReceipt() public {
        _accrue(lp, poolId, key, address(asset), 1000);
        hook.setFail(true);
        engine.claimFees(poolId);
        require(engine.pending(address(asset)) == 1000);
    }

    function testFirstManagerFailurePreservesSecondReceipt() public {
        _accrue(hook, poolId, key, address(asset), 1000);
        lp.setFail(true);
        engine.claimFees(poolId);
        require(engine.pending(address(asset)) == 1000);
    }

    function testFakePoolAndWrongSharesCannotCredit() public {
        vm.expectRevert(MusegodFeeEngine.NoValidClaim.selector);
        engine.claimFees(bytes32(uint256(1)));
        lp.configure(key, address(engine), 1);
        hook.configure(key, address(engine), 1);
        _accrue(lp, poolId, key, address(asset), 1000);
        vm.expectRevert(MusegodFeeEngine.NoValidClaim.selector);
        engine.claimFees(poolId);
    }

    function testSelfHelpersCannotBeCalledPublicly() public {
        vm.expectRevert(MusegodFeeEngine.OnlySelf.selector);
        engine.claimFrom(address(lp), poolId);
        vm.expectRevert(MusegodFeeEngine.OnlySelf.selector);
        engine.forwardClaimedWeth();
        vm.expectRevert(MusegodFeeEngine.OnlySelf.selector);
        engine.burnClaimedMuse();
        vm.expectRevert(MusegodFeeEngine.OnlySelf.selector);
        engine.releaseClaimedUnpriced(address(asset));
    }

    function testDonationIsNotCreditedOrAvailableToCaller() public {
        asset.mint(address(engine), 500);
        _claimAsset(1000);
        _nextWindow();
        _convert(100, 198, 512);
        require(engine.pending(address(asset)) == 900 && asset.balanceOf(address(engine)) == 1400);
        require(weth.balanceOf(address(vault)) == 200 && engine.totalConvertedWeth() == 200);
    }

    function testOutOfBandPushAndDonationsSyncOnceAcrossManagers() public {
        _claimAsset(1000);
        asset.mint(address(engine), 700);
        engine.syncUntracked(poolId);
        require(engine.pending(address(asset)) == 1700 && engine.totalClaimed(address(asset)) == 1000);
        require(engine.totalSynced(address(asset)) == 700);
        engine.syncUntracked(poolId);
        require(engine.pending(address(asset)) == 1700 && engine.totalSynced(address(asset)) == 700);
        _claimAsset(300);
        engine.syncUntracked(poolId);
        require(engine.pending(address(asset)) == 2000 && engine.totalSynced(address(asset)) == 700);
    }

    function testDeficitNeverBecomesNewCreditOrSubsidizesProcessing() public {
        asset.mint(address(engine), 1000); engine.syncUntracked(poolId);
        vm.prank(address(engine)); asset.transfer(STRANGER, 1);
        engine.syncUntracked(poolId);
        require(engine.pending(address(asset)) == 1000 && engine.totalSynced(address(asset)) == 1000);
        oracle.setFeed(address(asset), address(0));
        vm.expectRevert(MusegodFeeEngine.InsolventBalance.selector);
        engine.releaseUnpriced(address(asset), 1);
    }

    function testSeizedCurrencyDoesNotBlockHealthyFeeCollectionOrForwarding() public {
        _claimAsset(1000);
        vm.prank(address(engine)); asset.transfer(STRANGER, 200);
        weth.mint(address(engine), 1000); engine.syncUntracked(poolId);
        require(engine.pending(address(asset)) == 1000 && asset.balanceOf(address(engine)) == 800);
        _accrue(lp, poolId, key, address(asset), 100);
        _accrue(hook, poolId, key, address(weth), 200);
        vm.warp(1300); engine.claimAndForward(poolId);
        require(engine.totalClaimed(address(asset)) == 1100 && engine.pending(address(asset)) == 1100);
        require(asset.balanceOf(address(engine)) == 900, "shortfall was not written off");
        require(engine.totalClaimed(address(weth)) == 200 && weth.balanceOf(address(vault)) == 100);
        require(engine.pending(address(weth)) == 1100, "healthy currency continues independently");
    }

    function testBeneficiaryShareIncreaseKeepsClaimsAndSyncAvailable() public {
        lp.configure(key, address(engine), 0.285e18);
        hook.configure(key, address(engine), 0.30e18);
        _claimAsset(1000);
        asset.mint(address(engine), 50);
        engine.syncUntracked(poolId);
        require(engine.pending(address(asset)) == 1050 && engine.totalSynced(address(asset)) == 50);
    }

    function testSyncedReceiptsDoNotIncreaseTheCurrentQuota() public {
        _claimAsset(1000); _nextWindow();
        asset.mint(address(engine), 9000); engine.syncUntracked(poolId);
        _convert(100, 198, 512);
        vm.expectRevert(MusegodFeeEngine.WindowExceeded.selector); _convert(1, 2, 512);
    }

    function testSharedCurrencyAcrossPoolsCannotDoubleSync() public {
        _claimAsset(1000); asset.mint(address(engine), 100);
        PoolKey memory k = _key(address(asset), address(muse)); bytes32 second = _configure(k);
        engine.syncUntracked(second); engine.syncUntracked(poolId);
        require(engine.pending(address(asset)) == 1100 && engine.totalSynced(address(asset)) == 100);
    }

    function testNewWindowWaitAndCumulativeQuota() public {
        _claimAsset(1000);
        vm.expectRevert(MusegodFeeEngine.WindowExceeded.selector);
        _convert(1, 2, 512);
        _nextWindow();
        router.configure(120, 0);
        _convert(60, 119, 512);
        router.configure(80, 0);
        _convert(40, 80, 512);
        vm.expectRevert(MusegodFeeEngine.WindowExceeded.selector);
        _convert(1, 2, 512);
    }

    function testNewIncomeDoesNotExpandCurrentWindow() public {
        _claimAsset(1000);
        _nextWindow();
        _claimAsset(9000);
        _convert(100, 198, 512);
        vm.expectRevert(MusegodFeeEngine.WindowExceeded.selector);
        _convert(1, 2, 512);
        _nextWindow();
        router.configure(1980, 0);
        _convert(990, 1961, 512);
    }

    function testSimpleAndUncompressedModesAreConstrained() public {
        _claimAsset(2000);
        _nextWindow();
        _convert(100, 198, 32);
        _convert(100, 198, 0);
        require(engine.totalConverted(address(asset)) == 200);
    }

    function testLowCallerMinimumCannotLowerOracleFloor() public {
        _claimAsset(1000);
        _nextWindow();
        bytes memory data = _route(100, 1, 512);
        vm.expectRevert(MusegodFeeEngine.InvalidRoute.selector);
        engine.convertToWeth(address(asset), 100, data, 1, block.timestamp + 60);
    }

    function testCannotChangeRecipientTargetOrAddPermitAndFees() public {
        _claimAsset(1000);
        _nextWindow();
        bytes memory data = _route(100, 198, 512);
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        MusegodFeeEngine.SwapExecutionParams memory p = abi.decode(body, (MusegodFeeEngine.SwapExecutionParams));
        for (uint256 i; i < 5; ++i) {
            MusegodFeeEngine.SwapExecutionParams memory changed =
                abi.decode(abi.encode(p), (MusegodFeeEngine.SwapExecutionParams));
            if (i == 0) changed.desc.dstReceiver = STRANGER;
            if (i == 1) changed.callTarget = address(lp);
            if (i == 2) changed.desc.permit = hex"01";
            if (i == 3) {
                changed.desc.feeReceivers = new address[](1);
                changed.desc.feeReceivers[0] = STRANGER;
            }
            if (i == 4) changed.desc.flags = 513;
            bytes memory route = abi.encodeWithSelector(EngineRouter.swap.selector, changed);
            vm.expectRevert(MusegodFeeEngine.InvalidRoute.selector);
            engine.convertToWeth(address(asset), 100, route, 198, block.timestamp + 60);
        }
        require(engine.pending(address(asset)) == 1000 && weth.balanceOf(STRANGER) == 0);
    }

    function testLowActualOutputRollsBackSpendAccountingAndApproval() public {
        _claimAsset(1000);
        _nextWindow();
        router.configure(197, 0);
        vm.expectRevert(MusegodFeeEngine.OutputBelowMinimum.selector);
        _convert(100, 198, 512);
        require(engine.pending(address(asset)) == 1000 && asset.allowance(address(engine), address(router)) == 0);
        require(weth.balanceOf(address(vault)) == 0 && asset.balanceOf(address(executor)) == 0);
    }

    function testPartialSpendIsRejectedAndDoesNotTouchDonation() public {
        _claimAsset(1000);
        _nextWindow();
        router.configure(200, 1);
        vm.expectRevert(MusegodFeeEngine.InputBalanceMismatch.selector);
        _convert(100, 198, 512);
        require(engine.pending(address(asset)) == 1000);
    }

    function testOracleFailureKeepsPendingAndAllowsRetry() public {
        _claimAsset(1000);
        _nextWindow();
        oracle.setFail(true);
        vm.expectRevert();
        _convert(100, 198, 512);
        require(engine.pending(address(asset)) == 1000);
        oracle.setFail(false);
        _convert(100, 198, 512);
    }

    function testForwardOracleFailureDoesNotUndoClaim() public {
        _accrue(lp, poolId, key, address(weth), 1000);
        engine.claimFees(poolId);
        _nextWindow();
        _accrue(lp, poolId, key, address(weth), 100);
        oracle.setFail(true);
        engine.claimAndForward(poolId);
        require(engine.pending(address(weth)) == 1100 && weth.balanceOf(address(vault)) == 0);
    }

    function testPublicWethForwardUsesQuotaAndKeepsDonations() public {
        weth.mint(address(engine), 100);
        _accrue(lp, poolId, key, address(weth), 1000);
        engine.claimFees(poolId);
        _nextWindow();
        vm.prank(STRANGER);
        engine.forwardWeth(100);
        require(weth.balanceOf(address(vault)) == 100 && weth.balanceOf(address(engine)) == 1000);
        require(engine.pending(address(weth)) == 900);
    }

    function testMuseGoesDirectlyToDeadWithoutOracle() public {
        PoolKey memory museKey = _key(address(muse), address(weth));
        bytes32 id = _configure(museKey);
        _accrue(lp, id, museKey, address(muse), 1000);
        muse.mint(address(engine), 100);
        oracle.setFail(true);
        vm.prank(STRANGER);
        engine.claimAndForward(id);
        require(muse.balanceOf(DEAD) == 1100 && engine.totalDirectBurned() == 1100);
        require(muse.balanceOf(address(engine)) == 0 && engine.pending(address(muse)) == 0 && engine.totalSynced(address(muse)) == 100);
    }

    function testExpiryAndDependencyCodeChange() public {
        _claimAsset(1000);
        _nextWindow();
        bytes memory data = _route(100, 198, 512);
        vm.expectRevert(MusegodFeeEngine.Expired.selector);
        engine.convertToWeth(address(asset), 100, data, 198, block.timestamp - 1);
        vm.etch(address(executor), hex"00");
        vm.expectRevert(MusegodFeeEngine.DependencyChanged.selector);
        _convert(100, 198, 512);
    }

    function testReentrancyAndResidualApproval() public {
        _claimAsset(2000);
        _nextWindow();
        router.setReenter(true);
        _convert(100, 198, 512);
        require(!router.reentered());
        asset.setBadReset(true);
        vm.expectRevert(MusegodFeeEngine.ResidualAllowance.selector);
        _convert(100, 198, 512);
    }

    function testTaxedForwardIsAtomic() public {
        _accrue(lp, poolId, key, address(weth), 1000);
        engine.claimFees(poolId);
        _nextWindow();
        weth.setTax(true);
        vm.expectRevert(MusegodFeeEngine.TransferMismatch.selector);
        engine.forwardWeth(100);
        require(engine.pending(address(weth)) == 1000 && weth.balanceOf(address(vault)) == 0);
    }

    function _deployWithAutomation(address receiver) private returns (MusegodFeeEngine) {
        return new MusegodFeeEngine(
            address(lp),
            address(hook),
            address(oracle),
            address(swapper),
            address(weth),
            address(muse),
            address(router),
            address(executor),
            receiver, address(oracle), address(vault)
        );
    }

    function testRejectUnsafeAutomationRecipients() public {
        address[10] memory invalid = [
            address(0),
            DEAD,
            address(lp),
            address(hook),
            address(oracle),
            address(swapper),
            address(weth),
            address(muse),
            address(router),
            address(executor)
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(MusegodFeeEngine.InvalidConfiguration.selector);
            _deployWithAutomation(invalid[i]);
        }
        uint64 nonce = vm.getNonce(address(this));
        require(nonce > 0 && nonce < 128);
        address predicted =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), bytes1(uint8(nonce)))))));
        vm.expectRevert(MusegodFeeEngine.InvalidConfiguration.selector);
        _deployWithAutomation(predicted);
        require(engine.automation() == address(automation));
    }

    function testAutomationRequiresDeployedCode() public {
        require(address(automation).code.length != 0 && engine.automation() == address(automation));
        vm.expectRevert(MusegodFeeEngine.InvalidConfiguration.selector);
        _deployWithAutomation(STRANGER);
        vm.expectRevert(MusegodFeeEngine.InvalidConfiguration.selector);
        _deployWithAutomation(address(0xBB));
        EngineAutomation empty = new EngineAutomation();
        vm.etch(address(empty), hex"");
        vm.expectRevert(MusegodFeeEngine.InvalidConfiguration.selector);
        _deployWithAutomation(address(empty));
    }

    function testPublicUnpricedReleaseUsesFixedAutomationWithoutQuotaAndKeepsDonation() public {
        EngineToken unknown = new EngineToken();
        PoolKey memory k = _key(address(unknown), address(weth));
        bytes32 id = _configure(k);
        unknown.mint(address(engine), 500);
        _accrue(lp, id, k, address(unknown), 1000);
        engine.claimFees(id);
        require(engine.isUnpriced(address(unknown)) && engine.pending(address(unknown)) == 1000);
        vm.prank(STRANGER);
        engine.releaseUnpriced(address(unknown), 400);
        require(unknown.balanceOf(address(automation)) == 400 && unknown.balanceOf(STRANGER) == 0);
        require(engine.pending(address(unknown)) == 600 && engine.totalAutomationForwarded(address(unknown)) == 400);
        vm.prank(STRANGER);
        engine.releaseUnpriced(address(unknown), 600);
        require(unknown.balanceOf(address(automation)) == 1000 && unknown.balanceOf(address(engine)) == 500);
        require(engine.pending(address(unknown)) == 0 && engine.totalAutomationForwarded(address(unknown)) == 1000);
        require(engine.totalConverted(address(unknown)) == 0 && engine.totalForwarded(address(unknown)) == 0);
        vm.expectRevert(MusegodFeeEngine.InvalidAmount.selector);
        engine.releaseUnpriced(address(unknown), 1);
    }

    function testUnpricedReleaseFailureAndAmountBoundsKeepPending() public {
        EngineToken unknown = new EngineToken();
        PoolKey memory k = _key(address(unknown), address(weth));
        bytes32 id = _configure(k);
        _accrue(lp, id, k, address(unknown), 1000);
        engine.claimFees(id);
        vm.expectRevert(MusegodFeeEngine.InvalidAmount.selector);
        engine.releaseUnpriced(address(unknown), 0);
        vm.expectRevert(MusegodFeeEngine.InvalidAmount.selector);
        engine.releaseUnpriced(address(unknown), 1001);
        unknown.setBlockedRecipient(address(automation));
        vm.expectRevert();
        engine.releaseUnpriced(address(unknown), 1000);
        require(engine.pending(address(unknown)) == 1000 && unknown.balanceOf(address(engine)) == 1000);
        require(engine.totalAutomationForwarded(address(unknown)) == 0 && unknown.balanceOf(address(automation)) == 0);
        unknown.setBlockedRecipient(address(0));
        engine.releaseUnpriced(address(unknown), 1000);
        require(engine.pending(address(unknown)) == 0 && unknown.balanceOf(address(automation)) == 1000);
    }

    function testConfiguredStaleOrPausedAssetCannotUseAutomationFallback() public {
        _claimAsset(1000);
        _nextWindow();
        require(!engine.isUnpriced(address(asset)));
        oracle.setFail(true);
        vm.expectRevert(MusegodFeeEngine.PricedAsset.selector);
        engine.releaseUnpriced(address(asset), 1000);
        vm.expectRevert();
        _convert(100, 198, 512);
        _accrue(lp, poolId, key, address(asset), 100);
        engine.claimAndForward(poolId);
        require(engine.pending(address(asset)) == 1100);
        oracle.setFail(false);
        oracle.setPaused(true);
        vm.expectRevert(MusegodFeeEngine.PricedAsset.selector);
        engine.releaseUnpriced(address(asset), 1100);
        vm.expectRevert();
        _convert(100, 198, 512);
        require(asset.balanceOf(address(automation)) == 0 && engine.totalAutomationForwarded(address(asset)) == 0);
    }

    function testWethAndMuseCannotUseUnpricedAutomationPath() public {
        _accrue(lp, poolId, key, address(weth), 1000);
        engine.claimFees(poolId);
        PoolKey memory k = _key(address(muse), address(weth));
        bytes32 id = _configure(k);
        _accrue(lp, id, k, address(muse), 1000);
        engine.claimFees(id);
        require(!engine.isUnpriced(address(weth)) && !engine.isUnpriced(address(muse)));
        vm.expectRevert(MusegodFeeEngine.PricedAsset.selector);
        engine.releaseUnpriced(address(weth), 1000);
        vm.expectRevert(MusegodFeeEngine.PricedAsset.selector);
        engine.releaseUnpriced(address(muse), 1000);
        require(engine.pending(address(weth)) == 1000 && engine.pending(address(muse)) == 1000);
        require(weth.balanceOf(address(automation)) == 0 && muse.balanceOf(address(automation)) == 0);
    }

    function testClaimAndForwardReleasesFutureMemeFeesButKeepsConfiguredAsset() public {
        EngineToken futureMeme = new EngineToken();
        PoolKey memory k = _key(address(futureMeme), address(asset));
        bytes32 id = _configure(k);
        _accrue(lp, id, k, address(futureMeme), 1000);
        _accrue(hook, id, k, address(futureMeme), 200);
        _accrue(hook, id, k, address(asset), 250);
        oracle.setFail(true);
        vm.prank(STRANGER);
        engine.claimAndForward(id);
        require(futureMeme.balanceOf(address(automation)) == 1200 && engine.pending(address(futureMeme)) == 0);
        require(
            engine.totalClaimed(address(futureMeme)) == 1200
                && engine.totalAutomationForwarded(address(futureMeme)) == 1200
        );
        require(engine.pending(address(asset)) == 250 && asset.balanceOf(address(automation)) == 0);
        require(futureMeme.balanceOf(STRANGER) == 0);
    }

    function testClaimAndForwardUnpricedFailurePreservesClaimAndOtherCurrency() public {
        EngineToken failing = new EngineToken();
        EngineToken other = new EngineToken();
        PoolKey memory k = _key(address(failing), address(other));
        bytes32 id = _configure(k);
        _accrue(lp, id, k, address(failing), 1000);
        _accrue(hook, id, k, address(other), 250);
        failing.setBlockedRecipient(address(automation));
        vm.prank(STRANGER);
        engine.claimAndForward(id);
        require(engine.totalClaimed(address(failing)) == 1000 && engine.pending(address(failing)) == 1000);
        require(failing.balanceOf(address(engine)) == 1000 && failing.balanceOf(address(automation)) == 0);
        require(engine.totalAutomationForwarded(address(failing)) == 0);
        require(engine.pending(address(other)) == 0 && other.balanceOf(address(automation)) == 250);
        require(engine.totalAutomationForwarded(address(other)) == 250);
        failing.setBlockedRecipient(address(0));
        engine.releaseUnpriced(address(failing), 1000);
        require(failing.balanceOf(address(automation)) == 1000 && engine.pending(address(failing)) == 0);
    }

    function testClaimAndForwardUsesRemainingManagerCurrency() public {
        EngineToken unknown = new EngineToken();
        PoolKey memory k = _key(address(unknown), address(weth));
        bytes32 id = _configure(k);
        _accrue(hook, id, k, address(unknown), 500);
        lp.setFail(true);
        engine.claimAndForward(id);
        require(unknown.balanceOf(address(automation)) == 500 && engine.totalClaimed(address(unknown)) == 500);
        require(engine.pending(address(unknown)) == 0 && engine.totalAutomationForwarded(address(unknown)) == 500);
    }

    function testUnpricedTaxedReleaseIsAtomic() public {
        EngineToken unknown = new EngineToken();
        PoolKey memory k = _key(address(unknown), address(weth));
        bytes32 id = _configure(k);
        _accrue(lp, id, k, address(unknown), 1000);
        engine.claimFees(id);
        unknown.setTax(true);
        vm.expectRevert(MusegodFeeEngine.TransferMismatch.selector);
        engine.releaseUnpriced(address(unknown), 1000);
        require(engine.pending(address(unknown)) == 1000 && unknown.balanceOf(address(engine)) == 1000);
        require(engine.totalAutomationForwarded(address(unknown)) == 0 && unknown.balanceOf(address(automation)) == 0);
    }

    function testOracleMetadataFailureKeepsCreditsAndCannotEnableFallback() public {
        _claimAsset(1000);
        vm.etch(address(oracle), hex"00");
        vm.expectRevert();
        engine.releaseUnpriced(address(asset), 1000);
        _accrue(lp, poolId, key, address(asset), 100);
        engine.claimAndForward(poolId);
        require(engine.pending(address(asset)) == 1100 && asset.balanceOf(address(engine)) == 1100);
        require(asset.balanceOf(address(automation)) == 0 && engine.totalAutomationForwarded(address(asset)) == 0);
    }

    function testFuzzUnpricedReleaseNeverSpendsDonatedBalances(uint96 fees, uint96 donation, uint96 released) public {
        EngineToken unknown = new EngineToken();
        PoolKey memory k = _key(address(unknown), address(weth));
        bytes32 id = _configure(k);
        uint256 credit = uint256(fees) + 1;
        uint256 amount = uint256(released) % credit + 1;
        unknown.mint(address(engine), donation);
        _accrue(lp, id, k, address(unknown), credit);
        engine.claimFees(id);
        vm.prank(STRANGER);
        engine.releaseUnpriced(address(unknown), amount);
        require(engine.pending(address(unknown)) == credit - amount);
        require(unknown.balanceOf(address(engine)) == uint256(donation) + credit - amount);
        require(unknown.balanceOf(address(automation)) == amount && unknown.balanceOf(STRANGER) == 0);
        require(engine.totalAutomationForwarded(address(unknown)) == amount);
    }

    function testFuzzWindowNeverUsesNewIncome(uint96 incoming, uint96 more) public {
        uint256 initial = uint256(incoming) + 1000;
        _claimAsset(initial);
        _nextWindow();
        _claimAsset(uint256(more));
        uint256 allowed = initial / 10;
        router.configure(allowed * 2, 0);
        _convert(allowed, allowed * 2, 512);
        vm.expectRevert(MusegodFeeEngine.WindowExceeded.selector);
        _convert(1, 2, 512);
        require(engine.pending(address(asset)) == initial + uint256(more) - allowed);
    }
}
