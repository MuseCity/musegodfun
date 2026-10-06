// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MusegodQuotePair, MusegodQuoteParams} from "./MusegodBuybackOracle.sol";

interface IMusegodSplitsSwapper {
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function beneficiary() external view returns (address);
    function tokenToBeneficiary() external view returns (address);
    function oracle() external view returns (address);
    function defaultScaledOfferFactor() external view returns (uint32);
    function flash(MusegodQuoteParams[] calldata, bytes calldata) external returns (uint256);
}

interface IMusegodRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

/// @notice Any wallet can settle fixed WETH/MUSEGOD Swapper offers and receive this trade's surplus.
/// @dev Stranded or donated balances cannot subsidize a trade or be withdrawn. There is no owner.
contract MusegodBuybackExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint24 public constant POOL_FEE = 10000;
    IMusegodSplitsSwapper public immutable swapper;
    IMusegodRouter02 public immutable router;
    IERC20 public immutable weth;
    IERC20 public immutable musegod;

    bool private active;
    bool private callbackConsumed;
    uint256 private inputAmount;
    uint256 private minimumProfit;
    uint256 private wethBefore;
    uint256 private museBefore;
    uint256 private outputAmount;
    uint256 private requiredAmount;

    error InvalidConfiguration();
    error InvalidAmount();
    error Expired();
    error InvalidCallback();
    error BalanceMismatch();
    error InsufficientOutput();
    error IncompleteSettlement();
    error ResidualAllowance();

    event Executed(address indexed caller, uint256 wethAmount, uint256 museToDead, uint256 profit);

    constructor(address swapper_, address router_, address weth_, address musegod_) {
        if (
            swapper_.code.length == 0 || router_.code.length == 0 || weth_.code.length == 0 || musegod_.code.length == 0
                || weth_ == musegod_
        ) revert InvalidConfiguration();
        IMusegodSplitsSwapper s = IMusegodSplitsSwapper(swapper_);
        if (
            s.owner() != address(0) || s.paused() || s.beneficiary() != DEAD || s.tokenToBeneficiary() != musegod_
                || s.oracle().code.length == 0 || s.defaultScaledOfferFactor() != 985000
        ) revert InvalidConfiguration();
        swapper = s;
        router = IMusegodRouter02(router_);
        weth = IERC20(weth_);
        musegod = IERC20(musegod_);
    }

    function execute(uint256 amount, uint256 minProfit, uint256 deadline)
        external
        nonReentrant
        returns (uint256 museToDead, uint256 profit)
    {
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        wethBefore = weth.balanceOf(address(this));
        museBefore = musegod.balanceOf(address(this));
        inputAmount = amount;
        minimumProfit = minProfit;
        callbackConsumed = false;
        active = true;

        MusegodQuoteParams[] memory params = new MusegodQuoteParams[](1);
        params[0] = MusegodQuoteParams(MusegodQuotePair(address(weth), address(musegod)), uint128(amount), "");
        uint256 settled = swapper.flash(params, "");
        if (!callbackConsumed || settled < requiredAmount) revert IncompleteSettlement();
        active = false;
        musegod.forceApprove(address(swapper), 0);
        if (
            musegod.allowance(address(this), address(swapper)) != 0
                || weth.allowance(address(this), address(router)) != 0
        ) revert ResidualAllowance();
        if (
            weth.balanceOf(address(this)) != wethBefore
                || musegod.balanceOf(address(this)) != museBefore + outputAmount - requiredAmount
        ) revert BalanceMismatch();

        museToDead = requiredAmount;
        profit = outputAmount - requiredAmount;
        if (profit < minProfit) revert InsufficientOutput();
        if (profit != 0) musegod.safeTransfer(msg.sender, profit);
        if (musegod.balanceOf(address(this)) != museBefore) revert BalanceMismatch();
        emit Executed(msg.sender, amount, museToDead, profit);
    }

    function swapperFlashCallback(address tokenToBeneficiary, uint256 amountToBeneficiary, bytes calldata data)
        external
    {
        if (
            msg.sender != address(swapper) || !active || callbackConsumed || tokenToBeneficiary != address(musegod)
                || data.length != 0 || amountToBeneficiary == 0
        ) revert InvalidCallback();
        callbackConsumed = true;
        if (weth.balanceOf(address(this)) != wethBefore + inputAmount || musegod.balanceOf(address(this)) != museBefore)
        {
            revert BalanceMismatch();
        }
        weth.forceApprove(address(router), inputAmount);
        uint256 output = router.exactInputSingle(
            IMusegodRouter02.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(musegod),
                fee: POOL_FEE,
                recipient: address(this),
                amountIn: inputAmount,
                amountOutMinimum: amountToBeneficiary + minimumProfit,
                sqrtPriceLimitX96: 0
            })
        );
        weth.forceApprove(address(router), 0);
        if (weth.allowance(address(this), address(router)) != 0) revert ResidualAllowance();
        if (weth.balanceOf(address(this)) != wethBefore || musegod.balanceOf(address(this)) != museBefore + output) {
            revert BalanceMismatch();
        }
        if (output < amountToBeneficiary + minimumProfit) revert InsufficientOutput();
        outputAmount = output;
        requiredAmount = amountToBeneficiary;
        musegod.forceApprove(address(swapper), amountToBeneficiary);
    }
}
