// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MusegodLaunchGuard} from "../src/MusegodLaunchGuard.sol";
import {IDopplerBundler, CreateParams, PoolKey} from "../src/interfaces/IDopplerBundler.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract QuoteToken {
    enum Mode {
        Standard,
        NoReturn,
        ZeroReset,
        ReceiverTax,
        SenderTax,
        Rebase,
        FalseReturn,
        ResidualApprove
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    Mode public mode;
    address public callbackTarget;
    bytes public callbackData;
    bool public reentrySucceeded;
    bytes public reentryResult;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function setMode(Mode value) external {
        mode = value;
    }

    function seedAllowance(address owner, address spender, uint256 amount) external {
        allowance[owner][spender] = amount;
    }

    function callback(address target, bytes memory data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (mode == Mode.ZeroReset) require(amount == 0 || allowance[msg.sender][spender] == 0, "reset first");
        allowance[msg.sender][spender] = mode == Mode.ResidualApprove && amount == 0 ? 1 : amount;
        if (mode == Mode.NoReturn) {
            assembly {
                return(0, 0)
            }
        }
        return mode != Mode.FalseReturn;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 debit = mode == Mode.SenderTax ? amount + 1 : amount;
        uint256 credit = mode == Mode.ReceiverTax ? amount - 1 : amount;
        require(allowance[sender][msg.sender] >= amount, "allowance");
        require(balanceOf[sender] >= debit, "balance");
        allowance[sender][msg.sender] -= amount;
        balanceOf[sender] -= debit;
        balanceOf[recipient] += credit;
        if (mode == Mode.Rebase) balanceOf[sender] += 1;
        if (callbackTarget != address(0)) {
            (reentrySucceeded, reentryResult) = callbackTarget.call(callbackData);
        }
        if (mode == Mode.NoReturn) {
            assembly {
                return(0, 0)
            }
        }
        return mode != Mode.FalseReturn;
    }
}

contract LaunchToken {
    mapping(address => uint256) public balanceOf;

    constructor(address recipient, uint128 output) {
        balanceOf[recipient] = output;
    }
}

contract MockBundler is IDopplerBundler {
    using SafeERC20 for IERC20;

    address public constant airlock = address(0xA1);
    address public constant poolManager = address(0xB1);
    uint128 public output = 1_000;
    uint128 public unspent;
    uint256 public createdCount;
    address public lastRecipient;
    address public lastPayer;
    uint128 public observedAllowance;
    bool public shouldRevert;
    bool public reenter;
    bool public reentrySucceeded;
    bytes public reentryResult;
    mapping(bytes32 => bool) private usedSalt;

    function configure(uint128 value, uint128 leave, bool fail) external {
        output = value;
        unspent = leave;
        shouldRevert = fail;
    }

    function setReenter(bool value) external {
        reenter = value;
    }

    function predict(bytes32 salt, address recipient) external view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            salt,
                            keccak256(abi.encodePacked(type(LaunchToken).creationCode, abi.encode(recipient, output)))
                        )
                    )
                )
            )
        );
    }

    function bundle(CreateParams calldata data, VestingParams calldata vesting, uint128 amountIn, address recipient)
        external
        payable
        returns (address asset, PoolKey memory key, address governance, address timelock, uint128 amountOut)
    {
        require(!vesting.permissionlessClaim && vesting.vestingDuration == 0 && vesting.cliffDuration == 0, "vesting");
        require(msg.value == 0, "value");
        require(!usedSalt[data.salt], "duplicate salt");
        usedSalt[data.salt] = true;
        lastRecipient = recipient;
        lastPayer = msg.sender;
        observedAllowance = uint128(IERC20(data.numeraire).allowance(msg.sender, address(this)));
        if (reenter) {
            (reentrySucceeded, reentryResult) = msg.sender.call(
                abi.encodeCall(MusegodLaunchGuard.createAndBuy, (data, amountIn, uint128(1), block.timestamp))
            );
        }
        asset = address(new LaunchToken{salt: data.salt}(recipient, output));
        createdCount += 1;
        IERC20(data.numeraire).safeTransferFrom(msg.sender, address(this), amountIn - unspent);
        require(!shouldRevert, "bundler failure");
        key = asset < data.numeraire
            ? PoolKey(asset, data.numeraire, 0x800000, 10, address(0xC1))
            : PoolKey(data.numeraire, asset, 0x800000, 10, address(0xC1));
        return (asset, key, address(0xD1), address(0xE1), output);
    }
}

contract MusegodLaunchGuardTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    QuoteToken private quote;
    MockBundler private official;
    MusegodLaunchGuard private guard;
    address private constant ALICE = address(0xAA);
    address private constant BOB = address(0xBB);
    uint128 private constant INPUT = 100;
    uint128 private constant OUTPUT = 1_000;

    function setUp() public {
        vm.warp(1_000);
        quote = new QuoteToken();
        official = new MockBundler();
        guard = new MusegodLaunchGuard(official);
        quote.mint(ALICE, 10_000);
        quote.mint(BOB, 10_000);
        vm.prank(ALICE);
        quote.approve(address(guard), INPUT);
        vm.prank(BOB);
        quote.approve(address(guard), INPUT);
    }

    function params(bytes32 salt) private view returns (CreateParams memory data) {
        return CreateParams(
            1e27,
            1e27,
            address(quote),
            address(1),
            hex"1122",
            address(2),
            hex"33",
            address(3),
            hex"4455",
            address(4),
            hex"66",
            address(5),
            salt
        );
    }

    function launch(address creator, bytes32 salt, uint128 minOut, uint256 expiry) private returns (address asset) {
        vm.prank(creator);
        (asset,,,,) = guard.createAndBuy(params(salt), INPUT, minOut, expiry);
    }

    function assertEq(uint256 a, uint256 b) private pure {
        require(a == b, "uint mismatch");
    }

    function assertEq(address a, address b) private pure {
        require(a == b, "address mismatch");
    }

    function assertRollback(address predicted) private view {
        assertEq(predicted.code.length, 0);
        assertEq(quote.balanceOf(ALICE), 10_000);
        assertEq(quote.balanceOf(address(guard)), 0);
        assertEq(quote.balanceOf(address(official)), 0);
        assertEq(quote.allowance(ALICE, address(guard)), INPUT);
        assertEq(quote.allowance(address(guard), address(official)), 0);
        assertEq(official.createdCount(), 0);
    }

    function testExactMinimumAndDeadlineEqualitySuccess() public {
        address asset = launch(ALICE, bytes32(uint256(1)), OUTPUT, block.timestamp);
        assertEq(LaunchToken(asset).balanceOf(ALICE), OUTPUT);
        assertEq(quote.balanceOf(ALICE), 9_900);
        assertEq(quote.balanceOf(address(guard)), 0);
        assertEq(quote.balanceOf(address(official)), INPUT);
        assertEq(quote.allowance(address(guard), address(official)), 0);
        assertEq(official.lastRecipient(), ALICE);
        assertEq(official.lastPayer(), address(guard));
        assertEq(official.observedAllowance(), INPUT);
        assertEq(address(guard.bundler()), address(official));
    }

    function testMinimumOneRawUnitHigherRollsBackCreationAndFunds() public {
        bytes32 salt = bytes32(uint256(1));
        address predicted = official.predict(salt, ALICE);
        vm.expectRevert(abi.encodeWithSelector(MusegodLaunchGuard.OutputBelowMinimum.selector, OUTPUT, OUTPUT + 1));
        launch(ALICE, salt, OUTPUT + 1, 1_300);
        assertRollback(predicted);
    }

    function testExpiredBeforeTakingTokens() public {
        vm.expectRevert(abi.encodeWithSelector(MusegodLaunchGuard.Expired.selector, 999));
        launch(ALICE, bytes32(uint256(1)), 1, 999);
        assertRollback(official.predict(bytes32(uint256(1)), ALICE));
    }

    function testZeroInput() public {
        vm.expectRevert(MusegodLaunchGuard.ZeroInput.selector);
        vm.prank(ALICE);
        guard.createAndBuy(params(bytes32(uint256(1))), 0, 1, 1_300);
    }

    function testZeroMinimum() public {
        vm.expectRevert(MusegodLaunchGuard.ZeroMinimumOutput.selector);
        launch(ALICE, bytes32(uint256(1)), 0, 1_300);
    }

    function testNativeNumeraire() public {
        CreateParams memory data = params(bytes32(uint256(1)));
        data.numeraire = address(0);
        vm.expectRevert(MusegodLaunchGuard.NativeNumeraire.selector);
        vm.prank(ALICE);
        guard.createAndBuy(data, INPUT, 1, 1_300);
    }

    function testRejectsEOABundler() public {
        vm.expectRevert(MusegodLaunchGuard.InvalidBundler.selector);
        new MusegodLaunchGuard(IDopplerBundler(ALICE));
    }

    function testNonPayableInterfaceRejectsValue() public {
        (bool success,) = address(guard).call{value: 1}(
            abi.encodeCall(
                MusegodLaunchGuard.createAndBuy, (params(bytes32(uint256(1))), INPUT, OUTPUT, uint256(1_300))
            )
        );
        require(!success, "accepted ETH");
    }

    function testNoReturnTokenWorks() public {
        quote.setMode(QuoteToken.Mode.NoReturn);
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertEq(quote.allowance(address(guard), address(official)), 0);
    }

    function testZeroResetApprovalWorksAndClearsAllowance() public {
        quote.setMode(QuoteToken.Mode.ZeroReset);
        quote.seedAllowance(address(guard), address(official), 1);
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertEq(official.observedAllowance(), INPUT);
        assertEq(quote.allowance(address(guard), address(official)), 0);
    }

    function rejectedTransferMode(QuoteToken.Mode mode) private {
        quote.setMode(mode);
        vm.expectRevert(MusegodLaunchGuard.InputBalanceMismatch.selector);
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertRollback(official.predict(bytes32(uint256(1)), ALICE));
    }

    function testReceiverTaxRejected() public {
        rejectedTransferMode(QuoteToken.Mode.ReceiverTax);
    }

    function testSenderTaxRejected() public {
        rejectedTransferMode(QuoteToken.Mode.SenderTax);
    }

    function testRebaseDuringTransferRejected() public {
        rejectedTransferMode(QuoteToken.Mode.Rebase);
    }

    function testFalseReturnRejected() public {
        quote.setMode(QuoteToken.Mode.FalseReturn);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(quote)));
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertRollback(official.predict(bytes32(uint256(1)), ALICE));
    }

    function testInsufficientAllowance() public {
        vm.prank(ALICE);
        quote.approve(address(guard), INPUT - 1);
        vm.expectRevert();
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertEq(quote.balanceOf(ALICE), 10_000);
        assertEq(official.createdCount(), 0);
    }

    function testInsufficientBalanceCannotConsumeDonation() public {
        quote.mint(address(guard), 200);
        address empty = address(0xCC);
        vm.prank(empty);
        quote.approve(address(guard), INPUT);
        vm.expectRevert();
        launch(empty, bytes32(uint256(1)), OUTPUT, 1_300);
        assertEq(quote.balanceOf(address(guard)), 200);
        assertEq(official.createdCount(), 0);
    }

    function testDonationPreservedAcrossMultipleCallers() public {
        quote.mint(address(guard), 200);
        address first = launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        address second = launch(BOB, bytes32(uint256(2)), OUTPUT, 1_300);
        assertEq(quote.balanceOf(address(guard)), 200);
        assertEq(LaunchToken(first).balanceOf(ALICE), OUTPUT);
        assertEq(LaunchToken(second).balanceOf(BOB), OUTPUT);
        assertEq(quote.balanceOf(ALICE), 9_900);
        assertEq(quote.balanceOf(BOB), 9_900);
        assertEq(quote.allowance(address(guard), address(official)), 0);
    }

    function testBundlerFailureRollsBackCreationAndFunds() public {
        official.configure(OUTPUT, 0, true);
        vm.expectRevert();
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertRollback(official.predict(bytes32(uint256(1)), ALICE));
    }

    function testUnspentQuoteRejectedAndRollsBack() public {
        official.configure(OUTPUT, 1, false);
        vm.expectRevert(MusegodLaunchGuard.ResidualQuoteBalance.selector);
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertRollback(official.predict(bytes32(uint256(1)), ALICE));
    }

    function testRefusedAllowanceCleanupRollsBack() public {
        quote.setMode(QuoteToken.Mode.ResidualApprove);
        vm.expectRevert(MusegodLaunchGuard.ResidualAllowance.selector);
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertRollback(official.predict(bytes32(uint256(1)), ALICE));
    }

    function testRepeatedSaltFailsWithoutSecondPayment() public {
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        vm.prank(ALICE);
        quote.approve(address(guard), INPUT);
        vm.expectRevert();
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        assertEq(quote.balanceOf(ALICE), 9_900);
        assertEq(official.createdCount(), 1);
        assertEq(quote.allowance(ALICE, address(guard)), INPUT);
    }

    function testBundlerReentryBlocked() public {
        official.setReenter(true);
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        require(!official.reentrySucceeded(), "reentered");
        bytes memory reason = official.reentryResult();
        bytes4 selector;
        assembly {
            selector := mload(add(reason, 32))
        }
        require(selector == ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "wrong error");
        assertEq(official.createdCount(), 1);
    }

    function testTokenCallbackReentryBlocked() public {
        quote.callback(
            address(guard),
            abi.encodeCall(
                MusegodLaunchGuard.createAndBuy, (params(bytes32(uint256(2))), INPUT, OUTPUT, uint256(1_300))
            )
        );
        launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        require(!quote.reentrySucceeded(), "reentered");
        bytes memory reason = quote.reentryResult();
        bytes4 selector;
        assembly {
            selector := mload(add(reason, 32))
        }
        require(selector == ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "wrong error");
        assertEq(official.createdCount(), 1);
    }

    function testGuardedLaunchEventContainsReceiptIdentity() public {
        vm.recordLogs();
        address asset = launch(ALICE, bytes32(uint256(1)), OUTPUT, 1_300);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(guard)) continue;
            found += 1;
            require(
                logs[i].topics[0]
                    == keccak256("GuardedLaunch(address,address,address,uint128,uint128,uint128,uint256,bytes32)"),
                "signature"
            );
            require(logs[i].topics[1] == bytes32(uint256(uint160(ALICE))), "creator");
            require(logs[i].topics[2] == bytes32(uint256(uint160(asset))), "asset");
            require(logs[i].topics[3] == bytes32(uint256(uint160(address(quote)))), "numeraire");
            (uint128 amountIn, uint128 amountOut, uint128 minimum, uint256 deadline, bytes32 id) =
                abi.decode(logs[i].data, (uint128, uint128, uint128, uint256, bytes32));
            assertEq(amountIn, INPUT);
            assertEq(amountOut, OUTPUT);
            assertEq(minimum, OUTPUT);
            assertEq(deadline, 1_300);
            PoolKey memory key = asset < address(quote)
                ? PoolKey(asset, address(quote), 0x800000, 10, address(0xC1))
                : PoolKey(address(quote), asset, 0x800000, 10, address(0xC1));
            require(id == keccak256(abi.encode(key)), "poolId");
        }
        assertEq(found, 1);
    }

    function testFuzzMinimumEnforcedWithAtomicRollback(uint128 output, uint128 minimum) public {
        if (minimum == 0) minimum = 1;
        official.configure(output, 0, false);
        address predicted = official.predict(bytes32(uint256(1)), ALICE);
        if (output < minimum) {
            vm.expectRevert(abi.encodeWithSelector(MusegodLaunchGuard.OutputBelowMinimum.selector, output, minimum));
            launch(ALICE, bytes32(uint256(1)), minimum, 1_300);
            assertRollback(predicted);
        } else {
            address asset = launch(ALICE, bytes32(uint256(1)), minimum, 1_300);
            assertEq(asset, predicted);
            assertEq(LaunchToken(asset).balanceOf(ALICE), output);
            assertEq(quote.balanceOf(address(guard)), 0);
            assertEq(quote.allowance(address(guard), address(official)), 0);
        }
    }
}
