// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWethForwarderSwapper {
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function beneficiary() external view returns (address);
    function tokenToBeneficiary() external view returns (address);
}
interface IWethForwarderVault {
    function weth() external view returns (address);
    function musegod() external view returns (address);
    function swapper() external view returns (address);
}

/// @notice Anyone can forward approved WETH from the fixed source to the fixed buyback BudgetVault.
/// @dev There is no owner, module authority, arbitrary call, withdrawal or beneficiary change.
/// Approval covers any WETH at the source, without identifying its origin. Forwarding is not burning.
contract MusegodWethForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public constant MUSEGOD = 0x0379E228F6887c6F18bf394042ECAF81B308cb2e;
    // One day of maximum Vault throughput per treasury approval; spending still
    // obeys the Vault's independent 0.01 WETH rolling 300-second cap.
    uint256 public constant MAX_ALLOWANCE = 2.88 ether;

    address public immutable source;
    IERC20 public immutable weth;
    address public immutable swapper;
    address public immutable vault;
    uint256 public totalForwarded;

    error InvalidConfiguration();
    error InvalidAmount();
    error InfiniteAllowance();
    error AllowanceAboveCap();
    error BalanceMismatch();

    event Forwarded(address indexed caller, uint256 amount);

    constructor(address source_, address weth_, address swapper_, address vault_) {
        if (
            _unsafeAddress(source_) || _unsafeAddress(weth_) || _unsafeAddress(swapper_) || source_ == weth_
                || source_ == swapper_ || weth_ == swapper_ || weth_.code.length == 0 || swapper_.code.length == 0
        ) revert InvalidConfiguration();
        _requireBurnSwapper(swapper_);
        if (vault_.code.length == 0 || vault_ == source_ || vault_ == swapper_ ||
            IWethForwarderVault(vault_).weth() != weth_ || IWethForwarderVault(vault_).musegod() != MUSEGOD ||
            IWethForwarderVault(vault_).swapper() != swapper_) revert InvalidConfiguration();
        // A counterfactual source can be bound before its account is deployed. It still needs approval.
        source = source_;
        weth = IERC20(weth_);
        swapper = swapper_;
        vault = vault_;
    }

    function forward(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (address(weth).code.length == 0 || swapper.code.length == 0) revert InvalidConfiguration();
        _requireBurnSwapper(swapper);
        uint256 sourceBefore = weth.balanceOf(source);
        if (amount > sourceBefore) revert InvalidAmount();
        uint256 approved = weth.allowance(source, address(this));
        if (approved == type(uint256).max) revert InfiniteAllowance();
        if (approved > MAX_ALLOWANCE) revert AllowanceAboveCap();
        uint256 vaultBefore = weth.balanceOf(vault);
        uint256 forwarderBefore = weth.balanceOf(address(this));

        weth.safeTransferFrom(source, vault, amount);
        if (
            weth.balanceOf(source) != sourceBefore - amount || weth.balanceOf(vault) != vaultBefore + amount
                || weth.balanceOf(address(this)) != forwarderBefore
        ) revert BalanceMismatch();

        totalForwarded += amount;
        emit Forwarded(msg.sender, amount);
    }

    function _unsafeAddress(address value) private view returns (bool) {
        return value == address(0) || value == DEAD || value == address(this) || value == MUSEGOD;
    }

    function _requireBurnSwapper(address value) private view {
        IWethForwarderSwapper s = IWethForwarderSwapper(value);
        if (s.owner() != address(0) || s.paused() || s.beneficiary() != DEAD || s.tokenToBeneficiary() != MUSEGOD) {
            revert InvalidConfiguration();
        }
    }
}
