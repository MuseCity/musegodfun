// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MusegodWethForwarder} from "../src/MusegodWethForwarder.sol";

interface WethForwarderVm {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function getNonce(address) external view returns (uint64);
    function etch(address, bytes calldata) external;
}

contract ForwarderTokenMock {
    enum Mode {
        Normal,
        ReturnFalse,
        Taxed,
        Noop,
        ExtraDebit,
        ReenterIgnore,
        ReenterPropagate,
        MintToForwarder
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    Mode public mode;
    address public reentryTarget;
    bool public reentrySucceeded;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function configure(Mode mode_, address target) external {
        mode = mode_;
        reentryTarget = target;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 approved = allowance[sender][msg.sender];
        require(approved >= amount, "allowance");
        if (approved != type(uint256).max) allowance[sender][msg.sender] = approved - amount;
        if (mode == Mode.Noop) return true;

        balanceOf[sender] -= mode == Mode.ExtraDebit ? amount + 1 : amount;
        balanceOf[recipient] += mode == Mode.Taxed ? amount - 1 : amount;
        if (mode == Mode.MintToForwarder) balanceOf[msg.sender] += 1;
        if (mode == Mode.ReenterIgnore || mode == Mode.ReenterPropagate) {
            (reentrySucceeded,) = reentryTarget.call(abi.encodeCall(MusegodWethForwarder.forward, (1)));
            if (mode == Mode.ReenterPropagate) require(reentrySucceeded, "reentry rejected");
        }
        return mode != Mode.ReturnFalse;
    }
}

contract ForwarderSwapperMock {
    address public owner;
    bool public paused;
    address public beneficiary = 0x000000000000000000000000000000000000dEaD;
    address public tokenToBeneficiary = 0x0379E228F6887c6F18bf394042ECAF81B308cb2e;

    function configure(address owner_, bool paused_, address beneficiary_, address output_) external {
        owner = owner_;
        paused = paused_;
        beneficiary = beneficiary_;
        tokenToBeneficiary = output_;
    }
}

contract ForwarderNonSwapperMock {}

contract MusegodWethForwarderTest {
    struct ModuleCall {
        address target;
        uint256 value;
        bytes data;
    }

    WethForwarderVm constant vm = WethForwarderVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant SOURCE = address(0x500CE);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant MUSEGOD = 0x0379E228F6887c6F18bf394042ECAF81B308cb2e;
    ForwarderTokenMock weth;
    ForwarderSwapperMock swapper;
    MusegodWethForwarder forwarder;

    event Forwarded(address indexed caller, uint256 amount);

    function setUp() public {
        weth = new ForwarderTokenMock();
        swapper = new ForwarderSwapperMock();
        forwarder = new MusegodWethForwarder(SOURCE, address(weth), address(swapper));
        weth.mint(SOURCE, 1000);
    }

    function testAnyCallerForwardsApprovedWethToOnlyFixedRecipient() public {
        _approve(300);
        vm.expectEmit(true, false, false, true, address(forwarder));
        emit Forwarded(ALICE, 125);
        vm.prank(ALICE);
        forwarder.forward(125);
        require(weth.balanceOf(SOURCE) == 875 && weth.balanceOf(address(swapper)) == 125, "transfer");
        require(weth.balanceOf(ALICE) == 0 && weth.balanceOf(address(forwarder)) == 0, "caller paid");
        require(forwarder.totalForwarded() == 125 && weth.allowance(SOURCE, address(forwarder)) == 175, "accounting");
        require(forwarder.source() == SOURCE && address(forwarder.weth()) == address(weth), "fixed source/token");
        require(forwarder.swapper() == address(swapper) && forwarder.MUSEGOD() == MUSEGOD, "fixed target");
    }

    function testWithoutSourceApprovalEvenFundedCallerCannotForward() public {
        weth.mint(ALICE, 200);
        vm.prank(ALICE);
        weth.approve(address(forwarder), 200);
        vm.expectRevert();
        vm.prank(ALICE);
        forwarder.forward(100);
        _unchanged(0, 0);
        require(weth.balanceOf(ALICE) == 200, "caller funds changed");
    }

    function testCallerCannotRedirectUsingExtraCalldata() public {
        _approve(100);
        vm.prank(ALICE);
        (bool success,) = address(forwarder).call(
            abi.encodePacked(abi.encodeCall(MusegodWethForwarder.forward, (100)), abi.encode(ALICE))
        );
        require(success, "fixed call failed");
        require(weth.balanceOf(ALICE) == 0 && weth.balanceOf(address(swapper)) == 100, "redirected");
        (success,) = address(forwarder).call(abi.encodeWithSignature("forwardTo(uint256,address)", 1, ALICE));
        require(!success, "arbitrary recipient accepted");
    }

    function testExistingBalancesAndDonationsArePreserved() public {
        ForwarderTokenMock unrelated = new ForwarderTokenMock();
        unrelated.mint(SOURCE, 444);
        unrelated.mint(address(forwarder), 555);
        weth.mint(address(swapper), 777);
        weth.mint(address(forwarder), 888);
        _approve(100);
        vm.prank(ALICE);
        forwarder.forward(100);
        require(weth.balanceOf(SOURCE) == 900 && weth.balanceOf(address(swapper)) == 877, "actual delta");
        require(weth.balanceOf(address(forwarder)) == 888 && weth.balanceOf(ALICE) == 0, "weth donation swept");
        require(unrelated.balanceOf(SOURCE) == 444 && unrelated.balanceOf(address(forwarder)) == 555, "other token");
        require(forwarder.totalForwarded() == 100, "donation counted");
    }

    function testFiniteAllowanceCanBeExhaustedAndCannotBeExceeded() public {
        _approve(150);
        forwarder.forward(100);
        vm.prank(BOB);
        forwarder.forward(50);
        require(
            weth.allowance(SOURCE, address(forwarder)) == 0 && forwarder.totalForwarded() == 150, "finite allowance"
        );
        vm.expectRevert();
        forwarder.forward(1);
        require(weth.balanceOf(SOURCE) == 850 && weth.balanceOf(address(swapper)) == 150, "exhausted changed funds");
        require(forwarder.totalForwarded() == 150, "exhausted counter");
    }

    function testInsufficientAllowanceRollsBack() public {
        _approve(99);
        vm.expectRevert();
        forwarder.forward(100);
        _unchanged(99, 0);
    }

    function testApprovalRevocationBlocksSubsequentForwarding() public {
        _approve(type(uint256).max);
        forwarder.forward(100);
        _approve(0);
        vm.expectRevert();
        forwarder.forward(1);
        require(weth.balanceOf(SOURCE) == 900 && weth.balanceOf(address(swapper)) == 100, "revocation ignored");
        require(forwarder.totalForwarded() == 100, "revoked counter");
    }

    function testMaximumAllowancePersistsForFutureDeposits() public {
        _approve(type(uint256).max);
        forwarder.forward(1000);
        weth.mint(SOURCE, 200);
        vm.prank(BOB);
        forwarder.forward(200);
        require(weth.balanceOf(SOURCE) == 0 && weth.balanceOf(address(swapper)) == 1200, "future deposit");
        require(weth.allowance(SOURCE, address(forwarder)) == type(uint256).max, "max allowance consumed");
        require(forwarder.totalForwarded() == 1200, "max accounting");
    }

    function testZeroAmountAndInsufficientBalanceRevert() public {
        _approve(type(uint256).max);
        vm.expectRevert(MusegodWethForwarder.InvalidAmount.selector);
        forwarder.forward(0);
        vm.expectRevert(MusegodWethForwarder.InvalidAmount.selector);
        forwarder.forward(1001);
        _unchanged(type(uint256).max, 0);
    }

    function testFalseReturnRollsBackTransferAndAllowance() public {
        _rejectMode(ForwarderTokenMock.Mode.ReturnFalse, false);
    }

    function testTaxedTransferRollsBackTransferAndAllowance() public {
        _rejectMode(ForwarderTokenMock.Mode.Taxed, true);
    }

    function testNoopTransferRollsBackAllowance() public {
        _rejectMode(ForwarderTokenMock.Mode.Noop, true);
    }

    function testExtraDebitRollsBackTransferAndAllowance() public {
        _rejectMode(ForwarderTokenMock.Mode.ExtraDebit, true);
    }

    function testForwarderBalanceChangeRollsBackTransferAndAllowance() public {
        _rejectMode(ForwarderTokenMock.Mode.MintToForwarder, true);
    }

    function testReentrantTransferCannotForwardAgain() public {
        _approve(200);
        weth.configure(ForwarderTokenMock.Mode.ReenterIgnore, address(forwarder));
        vm.prank(ALICE);
        forwarder.forward(100);
        require(!weth.reentrySucceeded(), "reentered");
        require(weth.balanceOf(SOURCE) == 900 && weth.balanceOf(address(swapper)) == 100, "reentrant delta");
        require(
            weth.allowance(SOURCE, address(forwarder)) == 100 && forwarder.totalForwarded() == 100,
            "reentrant accounting"
        );
    }

    function testPropagatedReentryFailureRollsBackAllFunds() public {
        _rejectMode(ForwarderTokenMock.Mode.ReenterPropagate, false);
    }

    function testAllowsCounterfactualSourceButStillRequiresApproval() public {
        address undeployed = address(0xC0FFEE);
        require(undeployed.code.length == 0, "source already deployed");
        MusegodWethForwarder other = new MusegodWethForwarder(undeployed, address(weth), address(swapper));
        weth.mint(undeployed, 100);
        vm.expectRevert();
        other.forward(100);
        require(weth.balanceOf(undeployed) == 100 && other.totalForwarded() == 0, "unapproved source");
    }

    function testRejectsZeroDeadAndMusegodInAnyArgument() public {
        address[3] memory invalid = [address(0), DEAD, MUSEGOD];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
            new MusegodWethForwarder(invalid[i], address(weth), address(swapper));
            vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
            new MusegodWethForwarder(SOURCE, invalid[i], address(swapper));
            vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
            new MusegodWethForwarder(SOURCE, address(weth), invalid[i]);
        }
    }

    function testRejectsDuplicatedArguments() public {
        vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
        new MusegodWethForwarder(address(weth), address(weth), address(swapper));
        vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
        new MusegodWethForwarder(address(swapper), address(weth), address(swapper));
        vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
        new MusegodWethForwarder(SOURCE, address(weth), address(weth));
    }

    function testRejectsSelfInAnyArgument() public {
        for (uint256 i; i < 3; ++i) {
            uint64 nonce = vm.getNonce(address(this));
            require(nonce > 0 && nonce < 128, "unexpected nonce");
            address predicted =
                address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), bytes1(uint8(nonce)))))));
            vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
            new MusegodWethForwarder(
                i == 0 ? predicted : SOURCE, i == 1 ? predicted : address(weth), i == 2 ? predicted : address(swapper)
            );
        }
    }

    function testRequiresWethAndSwapperCodeAndCorrectInterface() public {
        vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
        new MusegodWethForwarder(SOURCE, ALICE, address(swapper));
        vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
        new MusegodWethForwarder(SOURCE, address(weth), ALICE);
        ForwarderNonSwapperMock invalid = new ForwarderNonSwapperMock();
        vm.expectRevert();
        new MusegodWethForwarder(SOURCE, address(weth), address(invalid));
    }

    function testRejectsSwapperOwnerPausedWrongBeneficiaryAndWrongOutput() public {
        for (uint256 i; i < 4; ++i) {
            swapper.configure(i == 0 ? ALICE : address(0), i == 1, i == 2 ? ALICE : DEAD, i == 3 ? ALICE : MUSEGOD);
            vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
            new MusegodWethForwarder(SOURCE, address(weth), address(swapper));
        }
    }

    function testChangedSwapperConfigurationBlocksForwarding() public {
        _approve(100);
        for (uint256 i; i < 4; ++i) {
            swapper.configure(i == 0 ? ALICE : address(0), i == 1, i == 2 ? ALICE : DEAD, i == 3 ? ALICE : MUSEGOD);
            vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
            forwarder.forward(100);
            _unchanged(100, 0);
        }
    }

    function testDependencyCodeLossBlocksForwarding() public {
        _approve(100);
        bytes memory oldCode = address(swapper).code;
        vm.etch(address(swapper), hex"");
        vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
        forwarder.forward(100);
        vm.etch(address(swapper), oldCode);
        vm.etch(address(weth), hex"");
        vm.expectRevert(MusegodWethForwarder.InvalidConfiguration.selector);
        forwarder.forward(100);
        require(forwarder.totalForwarded() == 0, "lost code counter");
    }

    function testNoOwnerSetterModuleCallOrDonationSweep() public {
        weth.mint(address(forwarder), 200);
        (bool success,) = address(forwarder).call(abi.encodeWithSignature("owner()"));
        require(!success, "owner exists");
        (success,) = address(forwarder).call(abi.encodeWithSignature("setSwapper(address)", ALICE));
        require(!success, "target mutable");
        (success,) = address(forwarder).call(abi.encodeWithSignature("withdraw(address,uint256)", ALICE, 200));
        require(!success, "withdraw exists");
        (success,) = address(forwarder).call(
            abi.encodeWithSignature(
                "executeFromModule((address,uint256,bytes))",
                ModuleCall(address(weth), 0, abi.encodeWithSignature("transfer(address,uint256)", ALICE, 200))
            )
        );
        require(!success, "module call exists");
        (success,) = address(forwarder).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", ALICE, hex""));
        require(!success, "upgrade exists");
        require(weth.balanceOf(address(forwarder)) == 200 && weth.balanceOf(ALICE) == 0, "donation lost");
        require(forwarder.totalForwarded() == 0, "donation credited");
    }

    function testFuzzExactForwardingWithPreexistingBalances(uint96 rawAmount, uint96 rawDonation) public {
        uint256 amount = uint256(rawAmount) + 1;
        uint256 donation = uint256(rawDonation);
        weth.mint(SOURCE, amount);
        weth.mint(address(swapper), donation);
        weth.mint(address(forwarder), donation);
        _approve(amount);
        vm.prank(ALICE);
        forwarder.forward(amount);
        require(weth.balanceOf(SOURCE) == 1000, "fuzz source");
        require(weth.balanceOf(address(swapper)) == donation + amount, "fuzz recipient");
        require(weth.balanceOf(address(forwarder)) == donation && weth.balanceOf(ALICE) == 0, "fuzz donation");
        require(
            weth.allowance(SOURCE, address(forwarder)) == 0 && forwarder.totalForwarded() == amount, "fuzz accounting"
        );
    }

    function _approve(uint256 amount) private {
        vm.prank(SOURCE);
        weth.approve(address(forwarder), amount);
    }

    function _unchanged(uint256 approved, uint256 donated) private view {
        require(weth.balanceOf(SOURCE) == 1000 && weth.balanceOf(address(swapper)) == 0, "funds changed");
        require(
            weth.balanceOf(address(forwarder)) == donated && weth.allowance(SOURCE, address(forwarder)) == approved,
            "allowance/donation"
        );
        require(forwarder.totalForwarded() == 0, "counter changed");
    }

    function _rejectMode(ForwarderTokenMock.Mode mode_, bool balanceError) private {
        weth.mint(address(forwarder), 77);
        _approve(100);
        weth.configure(mode_, address(forwarder));
        if (balanceError) vm.expectRevert(MusegodWethForwarder.BalanceMismatch.selector);
        else vm.expectRevert();
        forwarder.forward(100);
        _unchanged(100, 77);
    }
}
