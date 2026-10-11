// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey} from "./interfaces/IDopplerBundler.sol";

interface IBaseCollectorFees {
    function getPoolKey(bytes32 poolId) external view returns (PoolKey memory);
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256);
    function collectFees(bytes32 poolId) external returns (uint128, uint128);
}

/// @notice Credits the isolated Base buyback fee share and releases it to a fixed native Splits Automation.
/// @dev Non-upgradeable. No swap, bridge, arbitrary call, allowance, withdrawal or recipient-change API.
/// Native Automation has its own mutable signer/owner/provider trust boundary after funds are released.
/// Claims remain available during pause; pause stops every outgoing transfer from this Collector.
contract MusegodBaseFeeCollector is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BASE_INITIALIZER = 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544;
    address public constant BASE_REHYPE = 0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215;
    uint256 public constant SOURCE_CHAIN_ID = 8453;
    uint256 public constant LP_SHARE = 0.228e18;
    uint256 public constant HOOK_SHARE = 0.24e18;

    address public immutable initializer;
    address public immutable rehype;
    address public immutable governor;
    address public immutable automationReceiver;
    bytes32 public immutable initializerCodeHash;
    bytes32 public immutable rehypeCodeHash;
    bytes32 public immutable automationReceiverCodeHash;
    bool public paused = true;
    mapping(address => uint256) public pendingFees;
    mapping(address => uint256) public totalClaimed;
    mapping(address => uint256) public totalReleased;
    mapping(address => bool) public verifiedAssets;
    mapping(address => uint256) public pendingUntracked;
    mapping(address => uint256) public totalUntrackedSynced;
    mapping(address => uint256) public totalUntrackedReleased;

    error InvalidConfiguration();
    error Unauthorized();
    error Paused();
    error InvalidPool();
    error DependencyChanged();
    error InvalidAmount();
    error BalanceMismatch();
    error NoValidClaim();

    event FeesClaimed(bytes32 indexed poolId, address indexed manager, address indexed token, uint256 amount);
    event ClaimFailed(bytes32 indexed poolId, address indexed manager, bytes reason);
    event FeesReleased(address indexed token, address indexed receiver, uint256 amount);
    event UntrackedSynced(address indexed token, uint256 amount);
    event UntrackedReleased(address indexed token, address indexed receiver, uint256 amount);
    event PausedChanged(bool paused);

    constructor(address initializer_, address rehype_, address governor_, address automationReceiver_) {
        if (
            block.chainid != SOURCE_CHAIN_ID || initializer_ != BASE_INITIALIZER || rehype_ != BASE_REHYPE
                || initializer_.code.length == 0 || rehype_.code.length == 0 || governor_ == address(0)
                || automationReceiver_.code.length == 0 || automationReceiver_ == governor_
                || automationReceiver_ == initializer_ || automationReceiver_ == rehype_
        ) revert InvalidConfiguration();
        initializer = initializer_;
        rehype = rehype_;
        governor = governor_;
        automationReceiver = automationReceiver_;
        initializerCodeHash = initializer_.codehash;
        rehypeCodeHash = rehype_.codehash;
        automationReceiverCodeHash = automationReceiver_.codehash;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert Unauthorized();
        _;
    }

    function pause() external onlyGovernor {
        paused = true;
        emit PausedChanged(true);
    }

    function resume() external onlyGovernor {
        _dependencies();
        paused = false;
        emit PausedChanged(false);
    }

    /// @dev A proxy implementation/signers change is checked by the deployment/runtime verifier,
    /// not by extcodehash. These hashes only pin runtime at the three immutable addresses.
    function _dependencies() private view {
        if (
            initializer.codehash != initializerCodeHash || rehype.codehash != rehypeCodeHash
                || automationReceiver.codehash != automationReceiverCodeHash
        ) revert DependencyChanged();
    }

    function untrackedBalance(address token) public view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 tracked = pendingFees[token] + pendingUntracked[token];
        return balance > tracked ? balance - tracked : 0;
    }

    /// @notice Anyone may claim both managers. One manager's failure does not roll back the other claim.
    function claimFees(bytes32 poolId) external nonReentrant {
        _dependencies();
        bool succeeded;
        try this.claimFrom(initializer, poolId) { succeeded = true; }
        catch (bytes memory reason) { emit ClaimFailed(poolId, initializer, reason); }
        try this.claimFrom(rehype, poolId) { succeeded = true; }
        catch (bytes memory reason) { emit ClaimFailed(poolId, rehype, reason); }
        if (!succeeded) revert NoValidClaim();
    }

    /// @dev Restricted subtransaction; no arbitrary manager, asset or beneficiary is accepted.
    function claimFrom(address manager, bytes32 poolId) external {
        if (msg.sender != address(this)) revert Unauthorized();
        if (manager != initializer && manager != rehype) revert InvalidPool();
        IBaseCollectorFees fm = IBaseCollectorFees(manager);
        PoolKey memory key = fm.getPoolKey(poolId);
        if (
            key.currency0 == address(0) || key.currency0 >= key.currency1 || key.currency0.code.length == 0
                || key.currency1.code.length == 0 || key.hooks != initializer || key.tickSpacing != 10
                || key.fee != 0x800000 || keccak256(abi.encode(key)) != poolId
                || fm.getShares(poolId, address(this)) < (manager == initializer ? LP_SHARE : HOOK_SHARE)
        ) revert InvalidPool();
        verifiedAssets[key.currency0] = true;
        verifiedAssets[key.currency1] = true;
        uint256 before0 = IERC20(key.currency0).balanceOf(address(this));
        uint256 before1 = IERC20(key.currency1).balanceOf(address(this));
        fm.collectFees(poolId);
        uint256 after0 = IERC20(key.currency0).balanceOf(address(this));
        uint256 after1 = IERC20(key.currency1).balanceOf(address(this));
        if (after0 < before0 || after1 < before1) revert BalanceMismatch();
        _credit(poolId, manager, key.currency0, after0 - before0);
        _credit(poolId, manager, key.currency1, after1 - before1);
    }

    function _credit(bytes32 poolId, address manager, address token, uint256 amount) private {
        pendingFees[token] += amount;
        totalClaimed[token] += amount;
        emit FeesClaimed(poolId, manager, token, amount);
    }

    /// @notice Recovers unsolicited balances of actual verified pool assets without calling them fee income.
    /// @dev External manager payouts and donations are indistinguishable by balance alone. They remain a separate
    /// unknown bucket, never increment totalClaimed and never emit FeesClaimed/FeesReleased. A zero-credit
    /// claimFees on a valid pool can register its assets before recovery. Synchronization is allowed while paused.
    function syncUntracked(address token) external nonReentrant {
        _dependencies();
        if (!verifiedAssets[token]) revert InvalidPool();
        uint256 amount = untrackedBalance(token);
        if (amount == 0) revert InvalidAmount();
        pendingUntracked[token] += amount;
        totalUntrackedSynced[token] += amount;
        emit UntrackedSynced(token, amount);
    }

    /// @notice Releases only verified manager receipts, including the newly launched meme-token side.
    /// @dev Donations are never credited. Issuer seizure/rebasing shortfalls block releases until solvent.
    function releaseFees(address token, uint256 amount) external nonReentrant {
        if (paused) revert Paused();
        _dependencies();
        if (amount == 0 || amount > pendingFees[token]) revert InvalidAmount();
        pendingFees[token] -= amount;
        totalReleased[token] += amount;
        _release(token, amount);
        emit FeesReleased(token, automationReceiver, amount);
    }

    /// @notice Forwards recovered unknown balances to the same fixed Automation, separately from verified fees.
    function releaseUntracked(address token, uint256 amount) external nonReentrant {
        if (paused) revert Paused();
        _dependencies();
        if (!verifiedAssets[token] || amount == 0 || amount > pendingUntracked[token]) revert InvalidAmount();
        pendingUntracked[token] -= amount;
        totalUntrackedReleased[token] += amount;
        _release(token, amount);
        emit UntrackedReleased(token, automationReceiver, amount);
    }

    function _release(address token, uint256 amount) private {
        uint256 beforeCollector = IERC20(token).balanceOf(address(this));
        if (beforeCollector < pendingFees[token] + pendingUntracked[token] + amount) revert BalanceMismatch();
        uint256 beforeReceiver = IERC20(token).balanceOf(automationReceiver);
        IERC20(token).safeTransfer(automationReceiver, amount);
        uint256 afterCollector = IERC20(token).balanceOf(address(this));
        uint256 afterReceiver = IERC20(token).balanceOf(automationReceiver);
        if (
            afterCollector > beforeCollector || beforeCollector - afterCollector != amount
                || afterReceiver < beforeReceiver || afterReceiver - beforeReceiver != amount
        ) revert BalanceMismatch();
    }
}
