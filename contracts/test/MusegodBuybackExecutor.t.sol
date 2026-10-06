// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MusegodBuybackExecutor, IMusegodRouter02, IMusegodSplitsSwapper} from "../src/MusegodBuybackExecutor.sol";
import {MusegodQuoteParams} from "../src/MusegodBuybackOracle.sol";

interface BuybackExecutorVm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

contract ExecutorTokenMock {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public tax;
    bool public residualApprove;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function configure(bool tax_, bool residual_) external {
        tax = tax_;
        residualApprove = residual_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = residualApprove && amount == 0 ? 1 : amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        require(allowance[sender][msg.sender] >= amount, "allowance");
        allowance[sender][msg.sender] -= amount;
        _transfer(sender, recipient, amount);
        return true;
    }

    function _transfer(address sender, address recipient, uint256 amount) private {
        balanceOf[sender] -= amount;
        balanceOf[recipient] += tax ? amount - 1 : amount;
    }
}

contract ExecutorSwapperMock is IMusegodSplitsSwapper {
    enum Mode {
        Normal,
        DoubleCallback,
        SkipCallback,
        PartialInput,
        WrongToken,
        WrongData,
        UnderPull,
        WrongReturn,
        FailSettlement
    }

    address public owner;
    bool public paused;
    address public constant beneficiary = 0x000000000000000000000000000000000000dEaD;
    address public tokenToBeneficiary;
    address public oracle;
    uint32 public defaultScaledOfferFactor = 985000;
    ExecutorTokenMock public weth;
    ExecutorTokenMock public muse;
    Mode public mode;
    uint256 public required = 985;

    constructor(ExecutorTokenMock weth_, ExecutorTokenMock muse_) {
        weth = weth_;
        muse = muse_;
        tokenToBeneficiary = address(muse_);
        oracle = address(this);
    }

    function configure(Mode mode_, uint256 required_) external {
        mode = mode_;
        required = required_;
    }

    function setOwner(address value) external {
        owner = value;
    }

    function invokeCallback(address target) external {
        MusegodBuybackExecutor(target).swapperFlashCallback(address(muse), required, "");
    }

    function flash(MusegodQuoteParams[] calldata params, bytes calldata data) external returns (uint256) {
        require(
            params.length == 1 && params[0].quotePair.base == address(weth)
                && params[0].quotePair.quote == address(muse) && params[0].data.length == 0,
            "bad offer"
        );
        uint256 amount = params[0].baseAmount;
        weth.transfer(msg.sender, mode == Mode.PartialInput ? amount - 1 : amount);
        if (mode == Mode.SkipCallback) return required;
        bytes memory callbackData = mode == Mode.WrongData ? bytes(hex"01") : data;
        MusegodBuybackExecutor(msg.sender).swapperFlashCallback(
            mode == Mode.WrongToken ? address(weth) : address(muse), required, callbackData
        );
        if (mode == Mode.DoubleCallback) invokeCallbackInternal(msg.sender);
        require(mode != Mode.FailSettlement, "settlement failed");
        muse.transferFrom(msg.sender, beneficiary, mode == Mode.UnderPull ? required - 1 : required);
        return mode == Mode.WrongReturn ? 0 : required;
    }

    function invokeCallbackInternal(address target) private {
        MusegodBuybackExecutor(target).swapperFlashCallback(address(muse), required, "");
    }
}

contract ExecutorRouterMock is IMusegodRouter02 {
    ExecutorTokenMock public weth;
    ExecutorTokenMock public muse;
    uint256 public output = 1000;
    uint256 public returnValue = 1000;
    uint256 public consume = 100;
    bool public shouldRevert;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;

    constructor(ExecutorTokenMock weth_, ExecutorTokenMock muse_) {
        weth = weth_;
        muse = muse_;
    }

    function configure(uint256 output_, uint256 return_, uint256 consume_, bool fail) external {
        output = output_;
        returnValue = return_;
        consume = consume_;
        shouldRevert = fail;
    }

    function setReentry(address target, bytes memory data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256) {
        require(
            params.tokenIn == address(weth) && params.tokenOut == address(muse) && params.fee == 10000
                && params.recipient == msg.sender && params.sqrtPriceLimitX96 == 0,
            "router params"
        );
        require(!shouldRevert, "router revert");
        require(output >= params.amountOutMinimum, "minimum output");
        weth.transferFrom(msg.sender, address(this), consume);
        if (reentryTarget != address(0)) (reentrySucceeded,) = reentryTarget.call(reentryData);
        muse.mint(msg.sender, output);
        return returnValue;
    }
}

contract MusegodBuybackExecutorTest {
    BuybackExecutorVm constant vm = BuybackExecutorVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ExecutorTokenMock weth;
    ExecutorTokenMock muse;
    ExecutorSwapperMock swapper;
    ExecutorRouterMock router;
    MusegodBuybackExecutor executor;
    address constant ALICE = address(0xA11CE);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        vm.warp(1000);
        weth = new ExecutorTokenMock();
        muse = new ExecutorTokenMock();
        swapper = new ExecutorSwapperMock(weth, muse);
        router = new ExecutorRouterMock(weth, muse);
        executor = new MusegodBuybackExecutor(address(swapper), address(router), address(weth), address(muse));
        weth.mint(address(swapper), 10000);
    }

    function testAnyoneSettlesAndReceivesOnlyTradeProfit() public {
        weth.mint(address(executor), 777);
        muse.mint(address(executor), 888);
        vm.prank(ALICE);
        (uint256 burned, uint256 profit) = executor.execute(100, 15, 1000);
        require(burned == 985 && profit == 15, "settlement amounts");
        require(muse.balanceOf(DEAD) == 985 && muse.balanceOf(ALICE) == 15, "beneficiaries");
        require(weth.balanceOf(address(executor)) == 777 && muse.balanceOf(address(executor)) == 888, "donation stolen");
        _zeroAllowance();
    }

    function testSequentialExecutionsDoNotReuseCallbackState() public {
        executor.execute(100, 0, 1000);
        executor.execute(100, 0, 1000);
        require(muse.balanceOf(DEAD) == 1970 && muse.balanceOf(address(this)) == 30, "second execution");
        _zeroAllowance();
    }

    function testFuzzProfitAndDonationIsolation(uint96 donation, uint64 rawAmount) public {
        uint256 amount = uint256(rawAmount) + 1;
        uint256 output = amount * 10;
        uint256 required = output * 985 / 1000;
        // Dust must still owe a nonzero delivery; execute accepts the full supported uint128 range.
        if (required == 0) required = 1;
        weth.mint(address(swapper), amount);
        weth.mint(address(executor), donation);
        muse.mint(address(executor), donation);
        swapper.configure(ExecutorSwapperMock.Mode.Normal, required);
        router.configure(output, output, amount, false);
        vm.prank(ALICE);
        (uint256 burned, uint256 profit) = executor.execute(amount, output - required, 1000);
        require(burned == required && profit == output - required, "fuzz settlement");
        require(muse.balanceOf(ALICE) == profit && muse.balanceOf(DEAD) == required, "fuzz recipient");
        require(
            weth.balanceOf(address(executor)) == donation && muse.balanceOf(address(executor)) == donation,
            "fuzz donation"
        );
        _zeroAllowance();
    }

    function testRejectDirectAndInactiveSwapperCallback() public {
        vm.expectRevert(MusegodBuybackExecutor.InvalidCallback.selector);
        executor.swapperFlashCallback(address(muse), 985, "");
        vm.expectRevert(MusegodBuybackExecutor.InvalidCallback.selector);
        swapper.invokeCallback(address(executor));
    }

    function testRejectRepeatedWrongTokenAndChangedDataCallbacks() public {
        swapper.configure(ExecutorSwapperMock.Mode.DoubleCallback, 985);
        vm.expectRevert(MusegodBuybackExecutor.InvalidCallback.selector);
        executor.execute(100, 0, 1000);
        swapper.configure(ExecutorSwapperMock.Mode.WrongToken, 985);
        vm.expectRevert(MusegodBuybackExecutor.InvalidCallback.selector);
        executor.execute(100, 0, 1000);
        swapper.configure(ExecutorSwapperMock.Mode.WrongData, 985);
        vm.expectRevert(MusegodBuybackExecutor.InvalidCallback.selector);
        executor.execute(100, 0, 1000);
    }

    function testRejectMissingCallbackAndWrongFlashReturn() public {
        swapper.configure(ExecutorSwapperMock.Mode.SkipCallback, 985);
        vm.expectRevert(MusegodBuybackExecutor.IncompleteSettlement.selector);
        executor.execute(100, 0, 1000);
        swapper.configure(ExecutorSwapperMock.Mode.WrongReturn, 985);
        vm.expectRevert(MusegodBuybackExecutor.IncompleteSettlement.selector);
        executor.execute(100, 0, 1000);
    }

    function testDonationsCannotSubsidizeLossOrIncompleteInput() public {
        weth.mint(address(executor), 10000);
        muse.mint(address(executor), 10000);
        router.configure(984, 984, 100, false);
        vm.expectRevert();
        executor.execute(100, 0, 1000);
        router.configure(1000, 1000, 100, false);
        swapper.configure(ExecutorSwapperMock.Mode.PartialInput, 985);
        vm.expectRevert(MusegodBuybackExecutor.BalanceMismatch.selector);
        executor.execute(100, 0, 1000);
        require(
            weth.balanceOf(address(executor)) == 10000 && muse.balanceOf(address(executor)) == 10000,
            "loss used donation"
        );
    }

    function testRejectUnspentInputFalseRouterReturnAndUnderPull() public {
        router.configure(1000, 1000, 99, false);
        vm.expectRevert(MusegodBuybackExecutor.BalanceMismatch.selector);
        executor.execute(100, 0, 1000);
        router.configure(1000, 999, 100, false);
        vm.expectRevert(MusegodBuybackExecutor.BalanceMismatch.selector);
        executor.execute(100, 0, 1000);
        router.configure(1000, 1000, 100, false);
        swapper.configure(ExecutorSwapperMock.Mode.UnderPull, 985);
        vm.expectRevert(MusegodBuybackExecutor.BalanceMismatch.selector);
        executor.execute(100, 0, 1000);
    }

    function testReentrantExecuteAndForgedCallbackFailWhileTradeSucceeds() public {
        router.setReentry(address(executor), abi.encodeCall(executor.execute, (100, 0, 1000)));
        executor.execute(100, 0, 1000);
        require(!router.reentrySucceeded(), "execute reentered");
        router.setReentry(address(executor), abi.encodeCall(executor.swapperFlashCallback, (address(muse), 985, "")));
        executor.execute(100, 0, 1000);
        require(!router.reentrySucceeded(), "callback forged");
    }

    function testProfitNotPaidBeforeSuccessfulSettlementAndRetryWorks() public {
        swapper.configure(ExecutorSwapperMock.Mode.FailSettlement, 985);
        vm.prank(ALICE);
        vm.expectRevert();
        executor.execute(100, 0, 1000);
        require(muse.balanceOf(ALICE) == 0 && muse.balanceOf(DEAD) == 0, "paid before settlement");
        require(weth.balanceOf(address(swapper)) == 10000, "input lost");
        swapper.configure(ExecutorSwapperMock.Mode.Normal, 985);
        executor.execute(100, 0, 1000);
    }

    function testMinimumProfitExpiryAndAmountBounds() public {
        vm.expectRevert();
        executor.execute(100, 16, 1000);
        vm.expectRevert(MusegodBuybackExecutor.Expired.selector);
        executor.execute(100, 0, 999);
        vm.expectRevert(MusegodBuybackExecutor.InvalidAmount.selector);
        executor.execute(0, 0, 1000);
        vm.expectRevert(MusegodBuybackExecutor.InvalidAmount.selector);
        executor.execute(uint256(type(uint128).max) + 1, 0, 1000);
    }

    function testRejectInputTaxAndResidualApproval() public {
        weth.configure(true, false);
        vm.expectRevert(MusegodBuybackExecutor.BalanceMismatch.selector);
        executor.execute(100, 0, 1000);
        weth.configure(false, true);
        vm.expectRevert(MusegodBuybackExecutor.ResidualAllowance.selector);
        executor.execute(100, 0, 1000);
    }

    function testRejectOwnedSwapperAtDeployment() public {
        swapper.setOwner(ALICE);
        vm.expectRevert(MusegodBuybackExecutor.InvalidConfiguration.selector);
        new MusegodBuybackExecutor(address(swapper), address(router), address(weth), address(muse));
    }

    function _zeroAllowance() private view {
        require(weth.allowance(address(executor), address(router)) == 0, "WETH allowance");
        require(muse.allowance(address(executor), address(swapper)) == 0, "MUSE allowance");
    }
}
