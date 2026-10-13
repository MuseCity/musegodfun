// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface INftVaultFeeSource {
    function collectFees(bytes32 poolId) external returns (uint128, uint128);
}

interface INftVaultTreasuryRegistry {
    function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        returns (address);
}

interface INftVaultTreasuryProxy {
    function initialize(address implementation) external;
}

interface INftVaultParameters {
    function parameters() external view returns (uint256 homeChainId, address nft, uint256 tokenId, address treasury);
}

/// @notice Doppler creator-fee beneficiary bound forever to one NFT. Anyone may sweep its fee share and
/// balances to the NFT's ERC-6551 treasury; whoever holds the NFT controls that treasury.
/// @dev No owner, upgrade, arbitrary call, beneficiary change or alternative recipient exists, so a holder
/// cannot redirect future fees before selling the NFT. Balance-based: Doppler's updateBeneficiary can push
/// accrued fees here without a claim. Every sweep first activates the treasury (canonical Tokenbound V3 account,
/// canonical implementation), which ends the window in which anyone could initialize it to another
/// guardian-trusted implementation. An account initialized by someone else before the first sweep keeps its
/// implementation; the vault cannot tell implementations apart and still forwards to it.
contract MusegodNftFeeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant REHYPE = 0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215;
    address public constant BASE_INITIALIZER = 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544;
    address public constant ROBINHOOD_INITIALIZER = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    address public constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address public constant TOKENBOUND_V3_PROXY = 0x55266d75D1a14E4572138116aF39863Ed6596E7F;
    address public constant TOKENBOUND_V3_IMPLEMENTATION = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;

    address public immutable factory;
    uint256 public immutable homeChainId;
    address public immutable nft;
    uint256 public immutable tokenId;
    address public immutable treasury;
    address public immutable initializer;

    error InvalidConfiguration();
    error Unauthorized();
    error EtherTransferFailed();
    error TreasuryMissing();

    event FeeClaimFailed(bytes32 indexed poolId, address indexed source, bytes reason);
    event Swept(address indexed token, address indexed treasury, uint256 amount);
    event SweepFailed(address indexed token, bytes reason);
    event TreasuryActivation(address indexed treasury, bool created, bool initialized);

    constructor() {
        (uint256 home, address nft_, uint256 id, address treasury_) = INftVaultParameters(msg.sender).parameters();
        address chainInitializer =
            block.chainid == 8453 ? BASE_INITIALIZER : block.chainid == 4663 ? ROBINHOOD_INITIALIZER : address(0);
        if (chainInitializer == address(0) || home != block.chainid || nft_.code.length == 0 || treasury_ == address(0)) {
            revert InvalidConfiguration();
        }
        factory = msg.sender;
        homeChainId = home;
        nft = nft_;
        tokenId = id;
        treasury = treasury_;
        initializer = chainInitializer;
    }

    receive() external payable {}

    /// @notice Claims this vault's Doppler shares for each pool from both fee sources, activates the treasury, then
    /// forwards each listed token's whole balance (address(0) = ETH) to the treasury. One failure never blocks the
    /// rest. If the treasury still has no code, nothing is forwarded and the claimed funds stay here.
    function sweep(bytes32[] calldata poolIds, address[] calldata tokens) external nonReentrant {
        for (uint256 i; i < poolIds.length; ++i) {
            _claim(initializer, poolIds[i]);
            _claim(REHYPE, poolIds[i]);
        }
        _activateTreasury();
        for (uint256 i; i < tokens.length; ++i) {
            try this.forward(tokens[i]) {}
            catch (bytes memory reason) {
                emit SweepFailed(tokens[i], reason);
            }
        }
    }

    /// @dev Self-call only, so a paused or hostile token is contained by try/catch in sweep.
    function forward(address token) external returns (uint256 amount) {
        if (msg.sender != address(this)) revert Unauthorized();
        if (treasury.code.length == 0) revert TreasuryMissing();
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount != 0) {
                (bool ok,) = treasury.call{value: amount}("");
                if (!ok) revert EtherTransferFailed();
            }
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (amount != 0) IERC20(token).safeTransfer(treasury, amount);
        }
        if (amount != 0) emit Swept(token, treasury, amount);
    }

    /// @dev Low-level call so one source can never block the other. A typed try/catch decodes the return value
    /// in this contract, so a source returning undecodable data (or having no code) would revert the whole
    /// sweep outside the catch. The return data is ignored: collectFees pays to msg.sender and the amounts are
    /// not needed. Only a revert is reported. A call to an address with no code returns ok = true and does
    /// nothing, so that case claims nothing and emits nothing.
    function _claim(address source, bytes32 poolId) private {
        (bool ok, bytes memory reason) = source.call(abi.encodeCall(INftVaultFeeSource.collectFees, (poolId)));
        if (!ok) emit FeeClaimFailed(poolId, source, reason);
    }

    /// @dev Creates the treasury account (the canonical registry is idempotent and returns an existing account), then
    /// initializes it to the canonical implementation. Low-level calls, like _claim: a failure, including
    /// AlreadyInitialized for an account someone initialized earlier, is recorded and ignored. A call to an address
    /// without code succeeds vacuously, so each step only counts when it observably took effect.
    function _activateTreasury() private {
        (bool ok, bytes memory result) = ERC6551_REGISTRY.call(
            abi.encodeCall(
                INftVaultTreasuryRegistry.createAccount, (TOKENBOUND_V3_PROXY, bytes32(0), homeChainId, nft, tokenId)
            )
        );
        bool created = ok && result.length == 32 && bytes32(result) == bytes32(uint256(uint160(treasury)));
        (ok,) = treasury.call(abi.encodeCall(INftVaultTreasuryProxy.initialize, (TOKENBOUND_V3_IMPLEMENTATION)));
        bool initialized = ok && treasury.code.length != 0;
        emit TreasuryActivation(treasury, created, initialized);
    }
}
