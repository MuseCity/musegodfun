// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey} from "./interfaces/IDopplerBundler.sol";

interface IMusegodFeesManager {
    function getPoolKey(bytes32 poolId) external view returns (PoolKey memory);
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256);
    function collectFees(bytes32 poolId) external returns (uint128, uint128);
}

interface IFeeEngineOracle {
    function quoteToWeth(address token, uint256 amount) external view returns (uint256);
    function quoteWethToMuse(uint256 amount) external view returns (uint256);
    function assetFeeds(address token) external view returns (address, uint32, uint8, uint8, bool);
}

interface IFeeEngineSwapper {
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function beneficiary() external view returns (address);
    function tokenToBeneficiary() external view returns (address);
    function oracle() external view returns (address);
    function defaultScaledOfferFactor() external view returns (uint32);
}

/// @notice Public fee collection, constrained WETH conversion and forwarding.
/// @dev No owner, beneficiary migration, arbitrary withdrawal, upgrade or target.
/// Only balance increments received from the two fixed fee managers are credited.
/// Unpriced credited currencies are forwarded only to the immutable Automation account.
contract MusegodFeeEngine is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant WINDOW_SECONDS = 300;
    uint256 public constant LP_SHARE = 0.228e18;
    uint256 public constant HOOK_SHARE = 0.24e18;
    bytes4 private constant KYBER_SWAP = 0xe21fd0e9;

    address public immutable initializer;
    address public immutable rehype;
    IFeeEngineOracle public immutable oracle;
    address public immutable swapper;
    IERC20 public immutable weth;
    IERC20 public immutable muse;
    address public immutable router;
    address public immutable routerExecutor;
    address public immutable automation;
    bytes32 public immutable routerCodeHash;
    bytes32 public immutable routerExecutorCodeHash;

    struct Window {
        uint256 startsAt;
        uint256 limit;
        uint256 used;
    }

    mapping(address token => uint256 amount) public pending;
    mapping(address token => Window) public window;
    mapping(address token => uint256 amount) public totalClaimed;
    mapping(address token => uint256 amount) public totalForwarded;
    mapping(address token => uint256 amount) public totalConverted;
    mapping(address token => uint256 amount) public totalAutomationForwarded;
    uint256 public totalConvertedWeth;
    uint256 public totalDirectBurned;

    // ABI of the source-verified Robinhood MetaAggregationRouterV2.
    struct SwapDescription {
        address srcToken;
        address dstToken;
        address[] srcReceivers;
        uint256[] srcAmounts;
        address[] feeReceivers;
        uint256[] feeAmounts;
        address dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
        bytes permit;
    }

    struct SwapExecutionParams {
        address callTarget;
        address approveTarget;
        bytes targetData;
        SwapDescription desc;
        bytes clientData;
    }

    struct SimpleSwapData {
        address[] firstPools;
        uint256[] firstSwapAmounts;
        bytes[] swapDatas;
        uint256 deadline;
        bytes positiveSlippageData;
    }

    error InvalidConfiguration();
    error OnlySelf();
    error InvalidPool();
    error NoValidClaim();
    error InvalidAmount();
    error WindowExceeded();
    error Expired();
    error ZeroQuote();
    error InvalidRoute();
    error DependencyChanged();
    error InputBalanceMismatch();
    error OutputBelowMinimum();
    error ResidualAllowance();
    error TransferMismatch();
    error PricedAsset();

    event FeesClaimed(bytes32 indexed poolId, address indexed manager, address indexed token, uint256 amount);
    event ClaimFailed(bytes32 indexed poolId, address indexed manager, bytes reason);
    event Converted(address indexed token, uint256 amountIn, uint256 wethOut, uint256 minWethOut);
    event Forwarded(address indexed token, uint256 amount, address indexed swapper);
    event DirectBurn(uint256 amount);
    event ForwardFailed(address indexed token, bytes reason);
    event UnpricedForwarded(address indexed token, uint256 amount, address indexed automation);

    constructor(
        address initializer_,
        address rehype_,
        address oracle_,
        address swapper_,
        address weth_,
        address muse_,
        address router_,
        address routerExecutor_,
        address automation_
    ) {
        if (
            initializer_ == rehype_ || weth_ == muse_ || initializer_.code.length == 0 || rehype_.code.length == 0
                || oracle_.code.length == 0 || swapper_.code.length == 0 || weth_.code.length == 0 || muse_.code.length == 0
                || router_.code.length == 0 || routerExecutor_.code.length == 0 || automation_.code.length == 0
                || automation_ == address(0) || automation_ == DEAD || automation_ == address(this)
                || automation_ == initializer_ || automation_ == rehype_ || automation_ == oracle_
                || automation_ == swapper_ || automation_ == weth_ || automation_ == muse_ || automation_ == router_
                || automation_ == routerExecutor_
        ) revert InvalidConfiguration();
        IFeeEngineSwapper s = IFeeEngineSwapper(swapper_);
        if (
            s.owner() != address(0) || s.paused() || s.beneficiary() != DEAD || s.tokenToBeneficiary() != muse_
                || s.oracle() != oracle_ || s.defaultScaledOfferFactor() != 985000
        ) revert InvalidConfiguration();
        initializer = initializer_;
        rehype = rehype_;
        oracle = IFeeEngineOracle(oracle_);
        swapper = swapper_;
        weth = IERC20(weth_);
        muse = IERC20(muse_);
        router = router_;
        routerExecutor = routerExecutor_;
        automation = automation_;
        routerCodeHash = router_.codehash;
        routerExecutorCodeHash = routerExecutor_.codehash;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    function claimFees(bytes32 poolId) external nonReentrant {
        _claimFees(poolId);
    }

    function claimAndForward(bytes32 poolId) external nonReentrant {
        address[4] memory currencies = _claimFees(poolId);
        // External self calls give each forwarding action its own revert boundary.
        if (pending[address(muse)] != 0) {
            try this.burnClaimedMuse() {}
            catch (bytes memory reason) {
                emit ForwardFailed(address(muse), reason);
            }
        }
        if (pending[address(weth)] != 0) {
            try this.forwardClaimedWeth() {}
            catch (bytes memory reason) {
                emit ForwardFailed(address(weth), reason);
            }
        }
        for (uint256 i; i < currencies.length; ++i) {
            if (currencies[i] == address(0)) continue;
            try this.releaseClaimedUnpriced(currencies[i]) {}
            catch (bytes memory reason) {
                emit ForwardFailed(currencies[i], reason);
            }
        }
    }

    function _claimFees(bytes32 poolId) private returns (address[4] memory currencies) {
        bool succeeded;
        try this.claimFrom(initializer, poolId) returns (address currency0, address currency1) {
            succeeded = true;
            currencies[0] = currency0;
            currencies[1] = currency1;
        } catch (bytes memory reason) {
            emit ClaimFailed(poolId, initializer, reason);
        }
        try this.claimFrom(rehype, poolId) returns (address currency0, address currency1) {
            succeeded = true;
            currencies[2] = currency0;
            currencies[3] = currency1;
        } catch (bytes memory reason) {
            emit ClaimFailed(poolId, rehype, reason);
        }
        if (!succeeded) revert NoValidClaim();
    }

    /// @dev Restricted subtransaction; callers cannot inject another fee source.
    function claimFrom(address manager, bytes32 poolId) external onlySelf returns (address, address) {
        if (manager != initializer && manager != rehype) revert InvalidPool();
        IMusegodFeesManager fm = IMusegodFeesManager(manager);
        PoolKey memory key = fm.getPoolKey(poolId);
        uint256 share = fm.getShares(poolId, address(this));
        if (
            key.currency0 == address(0) || key.currency0 >= key.currency1 || key.hooks != initializer
                || key.tickSpacing != 10 || key.fee != 0x800000 || keccak256(abi.encode(key)) != poolId
                || share != (manager == initializer ? LP_SHARE : HOOK_SHARE)
        ) revert InvalidPool();
        uint256 before0 = IERC20(key.currency0).balanceOf(address(this));
        uint256 before1 = IERC20(key.currency1).balanceOf(address(this));
        fm.collectFees(poolId);
        uint256 after0 = IERC20(key.currency0).balanceOf(address(this));
        uint256 after1 = IERC20(key.currency1).balanceOf(address(this));
        if (after0 < before0 || after1 < before1) revert InputBalanceMismatch();
        _credit(key.currency0, after0 - before0);
        _credit(key.currency1, after1 - before1);
        emit FeesClaimed(poolId, manager, key.currency0, after0 - before0);
        emit FeesClaimed(poolId, manager, key.currency1, after1 - before1);
        return (key.currency0, key.currency1);
    }

    function _credit(address token, uint256 amount) private {
        if (amount == 0) return;
        _syncWindow(token); // New receipts never increase the current window's quota.
        pending[token] += amount;
        totalClaimed[token] += amount;
    }

    function _syncWindow(address token) private {
        Window storage w = window[token];
        uint256 start = block.timestamp / WINDOW_SECONDS * WINDOW_SECONDS;
        if (w.startsAt != start || (w.limit == 0 && w.used == 0 && pending[token] == 0)) {
            w.startsAt = start;
            w.limit = pending[token] / 10;
            w.used = 0;
        }
    }

    function _consume(address token, uint256 amount) private {
        if (amount == 0 || amount > pending[token]) revert InvalidAmount();
        _syncWindow(token);
        Window storage w = window[token];
        if (amount > w.limit - w.used) revert WindowExceeded();
        w.used += amount;
        pending[token] -= amount;
    }

    function forwardWeth(uint256 amount) external nonReentrant {
        _forwardWeth(amount);
    }

    function forwardClaimedWeth() external onlySelf {
        _syncWindow(address(weth));
        Window memory w = window[address(weth)];
        uint256 amount = w.limit - w.used;
        if (amount > pending[address(weth)]) amount = pending[address(weth)];
        if (amount != 0) _forwardWeth(amount);
    }

    function _forwardWeth(uint256 amount) private {
        _requireBurnQuote(amount);
        _consume(address(weth), amount);
        _transferExact(weth, swapper, amount);
        totalForwarded[address(weth)] += amount;
        emit Forwarded(address(weth), amount, swapper);
    }

    function burnMuse(uint256 amount) external nonReentrant {
        _burnMuse(amount);
    }

    function burnClaimedMuse() external onlySelf {
        _burnMuse(pending[address(muse)]);
    }

    function _burnMuse(uint256 amount) private {
        if (amount == 0 || amount > pending[address(muse)]) revert InvalidAmount();
        pending[address(muse)] -= amount;
        _transferExact(muse, DEAD, amount);
        totalDirectBurned += amount;
        emit DirectBurn(amount);
    }

    /// @notice Only currencies with no configured feed use the fixed Automation account.
    /// @dev Stale or paused configured feeds remain eligible only for guarded conversion.
    function isUnpriced(address token) public view returns (bool) {
        if (token == address(weth) || token == address(muse)) return false;
        (address feed,,,,) = oracle.assetFeeds(token);
        return feed == address(0);
    }

    function releaseUnpriced(address token, uint256 amount) external nonReentrant {
        if (!isUnpriced(token)) revert PricedAsset();
        _releaseUnpriced(token, amount);
    }

    function releaseClaimedUnpriced(address token) external onlySelf {
        uint256 amount = pending[token];
        if (amount != 0 && isUnpriced(token)) _releaseUnpriced(token, amount);
    }

    function _releaseUnpriced(address token, uint256 amount) private {
        if (amount == 0 || amount > pending[token]) revert InvalidAmount();
        pending[token] -= amount;
        _transferExact(IERC20(token), automation, amount);
        totalAutomationForwarded[token] += amount;
        emit UnpricedForwarded(token, amount, automation);
    }

    function convertToWeth(
        address token,
        uint256 amount,
        bytes calldata routeData,
        uint256 minWethOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 wethOut) {
        if (block.timestamp > deadline) revert Expired();
        if (token == address(weth) || token == address(muse) || amount == 0) revert InvalidAmount();
        if (router.codehash != routerCodeHash || routerExecutor.codehash != routerExecutorCodeHash) {
            revert DependencyChanged();
        }
        uint256 quote = oracle.quoteToWeth(token, amount);
        if (quote == 0) revert ZeroQuote();
        uint256 minimum = quote - quote / 100; // ceil(99%): a tiny quote cannot become zero.
        if (minWethOut > minimum) minimum = minWethOut;
        _validateRoute(token, amount, routeData, minimum, deadline);
        _consume(token, amount);
        wethOut = _executeRoute(token, amount, routeData, minimum);
        _requireBurnQuote(wethOut);
        _transferExact(weth, swapper, wethOut);
        totalConverted[token] += amount;
        totalConvertedWeth += wethOut;
        totalForwarded[address(weth)] += wethOut;
        emit Converted(token, amount, wethOut, minimum);
        emit Forwarded(address(weth), wethOut, swapper);
    }

    function _executeRoute(address token, uint256 amount, bytes calldata routeData, uint256 minimum)
        private
        returns (uint256 wethOut)
    {
        IERC20 input = IERC20(token);
        uint256 inputBefore = input.balanceOf(address(this));
        uint256 wethBefore = weth.balanceOf(address(this));
        input.forceApprove(router, amount);
        (bool ok, bytes memory result) = router.call(routeData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        input.forceApprove(router, 0);
        if (input.allowance(address(this), router) != 0) revert ResidualAllowance();
        uint256 inputAfter = input.balanceOf(address(this));
        uint256 wethAfter = weth.balanceOf(address(this));
        if (inputAfter > inputBefore || inputBefore - inputAfter != amount) revert InputBalanceMismatch();
        if (wethAfter < wethBefore || wethAfter - wethBefore < minimum) revert OutputBelowMinimum();
        wethOut = wethAfter - wethBefore;
    }

    function _validateRoute(address token, uint256 amount, bytes calldata data, uint256 minimum, uint256 deadline)
        private
        view
    {
        if (data.length < 4 || bytes4(data[:4]) != KYBER_SWAP) revert InvalidRoute();
        SwapExecutionParams memory p = abi.decode(data[4:], (SwapExecutionParams));
        SwapDescription memory d = p.desc;
        // The fixed router's only mode branch is bit 0x20. Its current API uses
        // 0x200 with compressed executor data; that flag is otherwise unused.
        if (
            p.callTarget != routerExecutor || p.approveTarget != address(0) || d.srcToken != token
                || d.dstToken != address(weth) || d.dstReceiver != address(this) || d.amount != amount
                || d.minReturnAmount < minimum || d.permit.length != 0 || d.feeReceivers.length != 0
                || d.feeAmounts.length != 0
        ) revert InvalidRoute();
        if (d.flags == 0 || d.flags == 512) {
            if (
                d.srcReceivers.length != 1 || d.srcAmounts.length != 1 || d.srcReceivers[0] != routerExecutor
                    || d.srcAmounts[0] != amount || p.targetData.length == 0
            ) revert InvalidRoute();
            // Opaque route data can reach only the pinned executor. The outer
            // deadline, exact spend and oracle floor are enforced here regardless
            // of that external protocol's encoded route or fee behavior.
            return;
        }
        if (d.flags != 32 || d.srcReceivers.length != 0 || d.srcAmounts.length != 0) revert InvalidRoute();
        SimpleSwapData memory s = abi.decode(p.targetData, (SimpleSwapData));
        if (
            s.deadline < block.timestamp || s.deadline > deadline || s.positiveSlippageData.length != 0
                || s.firstPools.length == 0 || s.firstPools.length != s.firstSwapAmounts.length
                || s.firstPools.length != s.swapDatas.length
        ) revert InvalidRoute();
        uint256 sum;
        for (uint256 i; i < s.firstPools.length; ++i) {
            if (s.firstPools[i].code.length == 0 || s.firstSwapAmounts[i] == 0) revert InvalidRoute();
            sum += s.firstSwapAmounts[i];
        }
        if (sum != amount) revert InvalidRoute();
    }

    function _requireBurnQuote(uint256 amount) private view {
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        uint256 q = oracle.quoteWethToMuse(amount);
        if (q / 1_000_000 * 985_000 + q % 1_000_000 * 985_000 / 1_000_000 == 0) revert ZeroQuote();
    }

    function _transferExact(IERC20 token, address recipient, uint256 amount) private {
        uint256 ownBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        uint256 ownAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            ownAfter > ownBefore || ownBefore - ownAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert TransferMismatch();
    }
}
