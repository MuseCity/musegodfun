// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MusegodNftFeeVault} from "./MusegodNftFeeVault.sol";

interface IERC6551RegistryView {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address);
}

/// @notice Deploys one MusegodNftFeeVault per NFT at a CREATE2 address anyone can predict, so a launch can
/// name a vault before it exists. Permissionless and idempotent; no owner.
contract MusegodNftFeeVaultFactory {
    address public constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address public constant TOKENBOUND_V3_PROXY = 0x55266d75D1a14E4572138116aF39863Ed6596E7F;

    struct Parameters {
        uint256 homeChainId;
        address nft;
        uint256 tokenId;
        address treasury;
    }

    bytes32 public immutable VAULT_INIT_CODE_HASH;
    Parameters public parameters;

    error InvalidConfiguration();

    event VaultDeployed(uint256 indexed homeChainId, address indexed nft, uint256 indexed tokenId, address vault, address treasury);

    constructor() {
        VAULT_INIT_CODE_HASH = keccak256(type(MusegodNftFeeVault).creationCode);
    }

    function saltFor(uint256 homeChainId, address nft, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(homeChainId, nft, tokenId));
    }

    function treasuryFor(uint256 homeChainId, address nft, uint256 tokenId) public view returns (address) {
        return IERC6551RegistryView(ERC6551_REGISTRY).account(TOKENBOUND_V3_PROXY, bytes32(0), homeChainId, nft, tokenId);
    }

    function vaultFor(uint256 homeChainId, address nft, uint256 tokenId) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), saltFor(homeChainId, nft, tokenId), VAULT_INIT_CODE_HASH)
                    )
                )
            )
        );
    }

    function deploy(uint256 homeChainId, address nft, uint256 tokenId) external returns (address vault) {
        vault = vaultFor(homeChainId, nft, tokenId);
        if (vault.code.length != 0) return vault;
        if (homeChainId != block.chainid || nft.code.length == 0) revert InvalidConfiguration();
        address treasury = treasuryFor(homeChainId, nft, tokenId);
        parameters = Parameters(homeChainId, nft, tokenId, treasury);
        address deployed = address(new MusegodNftFeeVault{salt: saltFor(homeChainId, nft, tokenId)}());
        delete parameters;
        if (deployed != vault) revert InvalidConfiguration();
        emit VaultDeployed(homeChainId, nft, tokenId, deployed, treasury);
    }
}
