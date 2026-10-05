// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDopplerBundler, CreateParams, PoolKey} from "./interfaces/IDopplerBundler.sol";

/// @notice Atomic ERC20 launch and first buy with output and expiry protection.
/// @dev Launch policy belongs to the frozen CreateParams, not to this contract.
/// There are deliberately no owner, withdrawal, upgrade or arbitrary-call paths.
contract MusegodLaunchGuard is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IDopplerBundler public immutable bundler;

    error InvalidBundler();
    error ZeroInput();
    error ZeroMinimumOutput();
    error NativeNumeraire();
    error Expired(uint256 deadline);
    error InputBalanceMismatch();
    error OutputBelowMinimum(uint128 amountOut, uint128 minAmountOut);
    error ResidualQuoteBalance();
    error ResidualAllowance();

    event GuardedLaunch(
        address indexed creator,
        address indexed asset,
        address indexed numeraire,
        uint128 amountIn,
        uint128 amountOut,
        uint128 minAmountOut,
        uint256 deadline,
        bytes32 poolId
    );

    constructor(IDopplerBundler officialBundler) {
        if (address(officialBundler).code.length == 0) revert InvalidBundler();
        bundler = officialBundler;
    }

    function createAndBuy(CreateParams calldata createData, uint128 amountIn, uint128 minAmountOut, uint256 deadline)
        external
        nonReentrant
        returns (address asset, PoolKey memory poolKey, address governance, address timelock, uint128 amountOut)
    {
        if (amountIn == 0) revert ZeroInput();
        if (minAmountOut == 0) revert ZeroMinimumOutput();
        if (createData.numeraire == address(0)) revert NativeNumeraire();
        if (block.timestamp > deadline) revert Expired(deadline);

        IERC20 quote = IERC20(createData.numeraire);
        uint256 guardBefore = _collectInput(quote, amountIn);
        quote.forceApprove(address(bundler), amountIn);
        (asset, poolKey, governance, timelock, amountOut) =
            bundler.bundle(createData, IDopplerBundler.VestingParams(false, 0, 0), amountIn, msg.sender);
        if (amountOut < minAmountOut) revert OutputBelowMinimum(amountOut, minAmountOut);
        quote.forceApprove(address(bundler), 0);
        if (quote.allowance(address(this), address(bundler)) != 0) revert ResidualAllowance();
        if (quote.balanceOf(address(this)) != guardBefore) revert ResidualQuoteBalance();

        emit GuardedLaunch(
            msg.sender,
            asset,
            createData.numeraire,
            amountIn,
            amountOut,
            minAmountOut,
            deadline,
            keccak256(abi.encode(poolKey))
        );
    }

    function _collectInput(IERC20 quote, uint128 amountIn) private returns (uint256 guardBefore) {
        uint256 callerBefore = quote.balanceOf(msg.sender);
        guardBefore = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 callerAfter = quote.balanceOf(msg.sender);
        uint256 guardAfter = quote.balanceOf(address(this));
        // Check both sides so neither sender-side nor receiver-side tax is accepted.
        if (
            callerAfter > callerBefore || callerBefore - callerAfter != amountIn || guardAfter < guardBefore
                || guardAfter - guardBefore != amountIn
        ) {
            revert InputBalanceMismatch();
        }
    }
}
