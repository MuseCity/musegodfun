// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MusegodNftFeeVault as Vault} from "../src/MusegodNftFeeVault.sol";
import {MusegodNftFeeVaultFactory as Factory} from "../src/MusegodNftFeeVaultFactory.sol";

interface VaultVm {
    function etch(address, bytes calldata) external;
    function chainId(uint256) external;
    function expectRevert(bytes4) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function deal(address, uint256) external;
}

contract NftFixture {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
}

contract FeeTokenFixture {
    mapping(address => uint256) public balanceOf;
    bool public reject;
    address public reenter;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function configure(bool reject_, address reenter_) external { reject = reject_; reenter = reenter_; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(!reject, "paused asset");
        if (reenter != address(0)) {
            bytes32[] memory none = new bytes32[](0);
            address[] memory tokens = new address[](0);
            Vault(payable(reenter)).sweep(none, tokens);
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Mirrors the deployed managers: collectFees pays only the caller's own accrued amount.
contract ManagerFixture {
    FeeTokenFixture public token;
    mapping(address => uint256) public accrued;
    bool public fail;
    function configure(FeeTokenFixture token_, bool fail_) external { token = token_; fail = fail_; }
    function accrue(address beneficiary, uint256 amount) external { accrued[beneficiary] += amount; }
    function collectFees(bytes32) external returns (uint128, uint128) {
        require(!fail, "manager down");
        uint256 amount = accrued[msg.sender];
        accrued[msg.sender] = 0;
        token.mint(msg.sender, amount);
        return (uint128(amount), 0);
    }
    /// Zero-share push, as in-repo evidence shows for Base.
    function pushTo(address beneficiary) external {
        uint256 amount = accrued[beneficiary];
        accrued[beneficiary] = 0;
        token.mint(beneficiary, amount);
    }
}

contract RejectEtherFixture {
    receive() external payable { revert("ether rejected"); }
}

/// Returns one 32-byte word for any call, so the caller's (uint128,uint128) decode fails.
contract ShortReturnSourceFixture {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

/// Returns 64 bytes whose first word does not fit in uint128, so the caller's strict ABI decode fails.
contract DirtyReturnSourceFixture {
    fallback() external {
        assembly {
            mstore(0, not(0))
            mstore(32, 0)
            return(0, 64)
        }
    }
}

/// Stand-in runtime for the Tokenbound account proxy; the factory only checks that code exists there.
contract ProxyFixture {
    fallback() external payable {}
}

contract RegistryFixture {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external pure returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encode(implementation, salt, chainId, tokenContract, tokenId)))));
    }
}

contract MusegodNftFeeVaultTest {
    VaultVm constant vm = VaultVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address constant REHYPE = 0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215;
    address constant BASE_INITIALIZER = 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544;
    address constant RH_INITIALIZER = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    address constant PROXY = 0x55266d75D1a14E4572138116aF39863Ed6596E7F;

    event VaultDeployed(
        uint256 indexed homeChainId, address indexed nft, uint256 indexed tokenId, address vault, address treasury
    );
    event FeeClaimFailed(bytes32 indexed poolId, address indexed source, bytes reason);
    event Swept(address indexed token, address indexed treasury, uint256 amount);
    event SweepFailed(address indexed token, bytes reason);

    Factory factory;
    NftFixture nft;
    FeeTokenFixture token;
    FeeTokenFixture paused;

    function setUp() public {
        vm.chainId(4663);
        vm.etch(REGISTRY, address(new RegistryFixture()).code);
        vm.etch(PROXY, address(new ProxyFixture()).code);
        vm.etch(REHYPE, address(new ManagerFixture()).code);
        vm.etch(RH_INITIALIZER, address(new ManagerFixture()).code);
        token = new FeeTokenFixture();
        paused = new FeeTokenFixture();
        paused.configure(true, address(0));
        ManagerFixture(REHYPE).configure(token, false);
        ManagerFixture(RH_INITIALIZER).configure(token, false);
        nft = new NftFixture();
        nft.mint(address(0xA11CE), 7);
        factory = new Factory();
    }

    function testDeployMatchesPredictionAndTreasury() public {
        address predicted = factory.vaultFor(4663, address(nft), 7);
        address vault = factory.deploy(4663, address(nft), 7);
        require(vault == predicted, "address");
        require(Vault(payable(vault)).treasury() == RegistryFixture(REGISTRY).account(PROXY, bytes32(0), 4663, address(nft), 7), "treasury");
        require(Vault(payable(vault)).initializer() == RH_INITIALIZER, "initializer");
        (uint256 home,,,) = factory.parameters();
        require(home == 0, "parameters cleared");
        require(factory.deploy(4663, address(nft), 7) == vault, "idempotent");
    }

    function testDeployRejectsForeignHomeChainAndCodelessNft() public {
        vm.expectRevert(Factory.InvalidConfiguration.selector);
        factory.deploy(1, address(nft), 7);
        vm.expectRevert(Factory.InvalidConfiguration.selector);
        factory.deploy(4663, address(0xBEEF), 7);
    }

    function testDeployEmitsVaultDeployed() public {
        address predicted = factory.vaultFor(4663, address(nft), 7);
        address treasury = factory.treasuryFor(4663, address(nft), 7);
        vm.expectEmit(true, true, true, true, address(factory));
        emit VaultDeployed(4663, address(nft), 7, predicted, treasury);
        factory.deploy(4663, address(nft), 7);
    }

    function testDeployRejectsUnsupportedChain() public {
        vm.chainId(1);
        // The factory guard cannot fire here: homeChainId == block.chainid, the NFT and the Tokenbound proxy
        // have code. The revert is the vault constructor's chainInitializer == address(0) branch. Both
        // contracts declare InvalidConfiguration() so the selector is the same; name the vault's as the source.
        vm.expectRevert(Vault.InvalidConfiguration.selector);
        factory.deploy(1, address(nft), 7);
    }

    function testDeployRejectsMissingTokenboundProxy() public {
        vm.etch(PROXY, "");
        vm.expectRevert(Factory.InvalidConfiguration.selector);
        factory.deploy(4663, address(nft), 7);
    }

    function testSweepClaimsBothSourcesAndForwardsToTreasury() public {
        address vault = factory.deploy(4663, address(nft), 7);
        ManagerFixture(REHYPE).accrue(vault, 30);
        ManagerFixture(RH_INITIALIZER).accrue(vault, 12);
        bytes32[] memory pools = new bytes32[](1);
        pools[0] = keccak256("pool");
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        address treasury = Vault(payable(vault)).treasury();
        vm.expectEmit(true, true, false, true, vault);
        emit Swept(address(token), treasury, 42);
        Vault(payable(vault)).sweep(pools, tokens);
        require(token.balanceOf(treasury) == 42, "forwarded");
        require(token.balanceOf(vault) == 0, "emptied");
    }

    function testSweepForwardsPushedBalancesWithoutClaim() public {
        address vault = factory.deploy(4663, address(nft), 7);
        ManagerFixture(REHYPE).accrue(vault, 5);
        ManagerFixture(REHYPE).pushTo(vault);
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        Vault(payable(vault)).sweep(new bytes32[](0), tokens);
        require(token.balanceOf(Vault(payable(vault)).treasury()) == 5, "pushed fees forwarded");
    }

    function testSourceAndTokenFailuresAreIsolated() public {
        address vault = factory.deploy(4663, address(nft), 7);
        ManagerFixture(RH_INITIALIZER).configure(token, true);
        ManagerFixture(REHYPE).accrue(vault, 9);
        paused.mint(vault, 3);
        bytes32[] memory pools = new bytes32[](1);
        pools[0] = keccak256("pool");
        address[] memory tokens = new address[](2);
        tokens[0] = address(paused);
        tokens[1] = address(token);
        address treasury = Vault(payable(vault)).treasury();
        vm.expectEmit(true, true, false, true, vault);
        emit FeeClaimFailed(pools[0], RH_INITIALIZER, abi.encodeWithSignature("Error(string)", "manager down"));
        vm.expectEmit(true, false, false, true, vault);
        emit SweepFailed(address(paused), abi.encodeWithSignature("Error(string)", "paused asset"));
        vm.expectEmit(true, true, false, true, vault);
        emit Swept(address(token), treasury, 9);
        Vault(payable(vault)).sweep(pools, tokens);
        require(token.balanceOf(treasury) == 9, "healthy token forwarded");
        require(paused.balanceOf(vault) == 3, "paused token stays");
    }

    function testEtherIsForwarded() public {
        address vault = factory.deploy(4663, address(nft), 7);
        vm.deal(vault, 1 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        address treasury = Vault(payable(vault)).treasury();
        vm.expectEmit(true, true, false, true, vault);
        emit Swept(address(0), treasury, 1 ether);
        Vault(payable(vault)).sweep(new bytes32[](0), tokens);
        require(treasury.balance == 1 ether, "ether");
    }

    function testForwardIsSelfOnlyAndNoRedirectExists() public {
        address vault = factory.deploy(4663, address(nft), 7);
        vm.expectRevert(Vault.Unauthorized.selector);
        Vault(payable(vault)).forward(address(token));
        (bool ok,) = vault.call(abi.encodeWithSignature("updateBeneficiary(bytes32,address)", bytes32(0), address(this)));
        require(!ok, "no redirect path");
    }

    function testReentrantTokenCannotReenterSweep() public {
        address vault = factory.deploy(4663, address(nft), 7);
        FeeTokenFixture hostile = new FeeTokenFixture();
        hostile.configure(false, vault);
        hostile.mint(vault, 4);
        address[] memory tokens = new address[](1);
        tokens[0] = address(hostile);
        vm.expectEmit(true, false, false, true, vault);
        emit SweepFailed(address(hostile), abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        Vault(payable(vault)).sweep(new bytes32[](0), tokens);
        require(hostile.balanceOf(vault) == 4, "reentry rolled back that token only");
    }

    function testBaseInitializerClaimsAndForwardsFees() public {
        vm.chainId(8453);
        vm.etch(BASE_INITIALIZER, address(new ManagerFixture()).code);
        ManagerFixture(BASE_INITIALIZER).configure(token, false);
        address vault = factory.deploy(8453, address(nft), 7);
        require(Vault(payable(vault)).initializer() == BASE_INITIALIZER, "base initializer");
        ManagerFixture(BASE_INITIALIZER).accrue(vault, 6);
        ManagerFixture(REHYPE).accrue(vault, 4);
        bytes32[] memory pools = new bytes32[](1);
        pools[0] = keccak256("base pool");
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        Vault(payable(vault)).sweep(pools, tokens);
        require(token.balanceOf(Vault(payable(vault)).treasury()) == 10, "base fees forwarded");
    }

    function testRejectingEtherTreasuryDoesNotBlockToken() public {
        address vault = factory.deploy(4663, address(nft), 7);
        address treasury = Vault(payable(vault)).treasury();
        vm.etch(treasury, address(new RejectEtherFixture()).code);
        vm.deal(vault, 1 ether);
        token.mint(vault, 8);
        address[] memory tokens = new address[](2);
        tokens[0] = address(0);
        tokens[1] = address(token);
        Vault(payable(vault)).sweep(new bytes32[](0), tokens);
        require(vault.balance == 1 ether, "rejected ether stays");
        require(treasury.balance == 0, "no ether received");
        require(token.balanceOf(treasury) == 8, "healthy token forwarded after ether failure");
        require(token.balanceOf(vault) == 0, "token emptied");
    }

    function _sweepFeeToken(address vault) internal {
        bytes32[] memory pools = new bytes32[](1);
        pools[0] = keccak256("pool");
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        Vault(payable(vault)).sweep(pools, tokens);
    }

    function _requireForwarded(address vault, uint256 amount) internal view {
        require(token.balanceOf(Vault(payable(vault)).treasury()) == amount, "healthy source forwarded");
        require(token.balanceOf(vault) == 0, "vault emptied");
    }

    function testShortReturnInitializerDoesNotBlockRehype() public {
        address vault = factory.deploy(4663, address(nft), 7);
        vm.etch(RH_INITIALIZER, address(new ShortReturnSourceFixture()).code);
        ManagerFixture(REHYPE).accrue(vault, 11);
        _sweepFeeToken(vault);
        _requireForwarded(vault, 11);
    }

    function testShortReturnRehypeDoesNotBlockInitializer() public {
        address vault = factory.deploy(4663, address(nft), 7);
        vm.etch(REHYPE, address(new ShortReturnSourceFixture()).code);
        ManagerFixture(RH_INITIALIZER).accrue(vault, 13);
        _sweepFeeToken(vault);
        _requireForwarded(vault, 13);
    }

    function testDirtyReturnSourceDoesNotBlockOtherSource() public {
        address vault = factory.deploy(4663, address(nft), 7);
        vm.etch(RH_INITIALIZER, address(new DirtyReturnSourceFixture()).code);
        ManagerFixture(REHYPE).accrue(vault, 17);
        _sweepFeeToken(vault);
        _requireForwarded(vault, 17);
    }

    function testCodelessInitializerDoesNotBlockRehype() public {
        address vault = factory.deploy(4663, address(nft), 7);
        vm.etch(RH_INITIALIZER, "");
        ManagerFixture(REHYPE).accrue(vault, 19);
        _sweepFeeToken(vault);
        _requireForwarded(vault, 19);
    }

    function testCodelessRehypeDoesNotBlockInitializer() public {
        address vault = factory.deploy(4663, address(nft), 7);
        vm.etch(REHYPE, "");
        ManagerFixture(RH_INITIALIZER).accrue(vault, 23);
        _sweepFeeToken(vault);
        _requireForwarded(vault, 23);
    }

    function testFuzzVaultForIsUniquePerNft(uint256 a, uint256 b) public view {
        if (a == b) return;
        require(factory.vaultFor(4663, address(nft), a) != factory.vaultFor(4663, address(nft), b), "unique");
    }
}
