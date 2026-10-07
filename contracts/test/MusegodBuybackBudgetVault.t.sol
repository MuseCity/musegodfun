// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {MusegodBuybackBudgetVault} from "../src/MusegodBuybackBudgetVault.sol";
import {MusegodTickMath} from "../src/MusegodBuybackOracle.sol";
import {EngineToken} from "./MusegodFeeEngine.t.sol";
interface BudgetVm { function warp(uint256) external; function prank(address) external; function expectRevert() external; function expectRevert(bytes4) external; }
contract BudgetPool {
    address public token0; address public token1; uint24 public fee = 10000; uint128 public liquidity = 1;
    int24 public spot; int24 public shortTick; int24 public longTick; bool public noHistory;
    constructor(address a, address b) { token0 = a < b ? a : b; token1 = a < b ? b : a; }
    function configure(int24 a,int24 b,int24 c,bool d) external { spot=a;shortTick=b;longTick=c;noHistory=d; }
    function slot0() external view returns(uint160,int24,uint16,uint16,uint16,uint8,bool) { return (MusegodTickMath.getSqrtRatioAtTick(spot),spot,0,2048,2048,0,true); }
    function observe(uint32[] calldata) external view returns (int56[] memory t,uint160[] memory l) {
        require(!noHistory,"OLD"); t=new int56[](3); l=new uint160[](3);
        t[0]=-int56(longTick)*1800; t[1]=-int56(shortTick)*300; l[1]=1;l[2]=2;
    }
}
contract BudgetOracle { address public weth;address public musegod;address public museWethPool;
    constructor(address w,address m,address p) {weth=w;musegod=m;museWethPool=p;}}
contract BudgetSwapper {
    address public owner;bool public paused;address public beneficiary=address(0xdead);address public tokenToBeneficiary;address public oracle;
    uint32 public defaultScaledOfferFactor=985000;
    constructor(address m,address o) {tokenToBeneficiary=m;oracle=o;}
    function debit(EngineToken token,uint256 amount) external { token.transfer(msg.sender,amount); }
}
contract BudgetExecutor {
    address public swapper; address public weth; address public musegod; bool public fail; bool public reenter; bool public reentered;
    constructor(address s,address w,address m) {swapper=s;weth=w;musegod=m;}
    function configure(bool f,bool r) external {fail=f;reenter=r;}
    function execute(uint256 amount,uint256 minimum,uint256 deadline) external returns(uint256,uint256) {
        require(!fail && block.timestamp <= deadline && minimum <= amount/100,"execution unavailable");
        if(reenter) (reentered,) = msg.sender.call(abi.encodeWithSignature("execute(uint256,uint256,uint256)",amount,0,deadline));
        BudgetSwapper(swapper).debit(EngineToken(weth),amount);
        EngineToken(musegod).mint(address(0xdead),amount*100);
        EngineToken(musegod).mint(msg.sender,amount/100);
        return(amount*100,amount/100);
    }
}
contract MusegodBuybackBudgetVaultTest {
    BudgetVm constant vm=BudgetVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EngineToken weth;EngineToken muse;BudgetPool pool;BudgetOracle oracle;BudgetSwapper swapper;BudgetExecutor executor;MusegodBuybackBudgetVault vault;
    function setUp() public {
        vm.warp(1000);weth=new EngineToken();muse=new EngineToken();pool=new BudgetPool(address(weth),address(muse));
        oracle=new BudgetOracle(address(weth),address(muse),address(pool));swapper=new BudgetSwapper(address(muse),address(oracle));
        executor=new BudgetExecutor(address(swapper),address(weth),address(muse));
        vault=new MusegodBuybackBudgetVault(address(weth),address(muse),address(oracle),address(swapper),address(executor));
        weth.mint(address(vault),1 ether);
    }
    function _run(uint256 amount) private { vault.execute(amount,0,block.timestamp+60); }
    function testAtomicSettlementPreservesDonationsAndPaysOnlyNewProfit() public {
        muse.mint(address(vault),777);weth.mint(address(swapper),888);
        vm.prank(address(7));_run(0.005 ether);
        require(weth.balanceOf(address(swapper))==888 && muse.balanceOf(address(vault))==777);
        require(muse.balanceOf(address(7))==0.005 ether/100 && vault.totalSpent()==0.005 ether);
        require(muse.balanceOf(address(0xdead))==vault.totalBurned());
    }
    function testRollingBoundaryCannotDoubleSpendAcrossEpoch() public {
        vm.warp(1199);_run(0.006 ether);vm.warp(1200);_run(0.004 ether);
        vm.expectRevert(MusegodBuybackBudgetVault.BudgetExceeded.selector);_run(1);
        vm.warp(1498);vm.expectRevert(MusegodBuybackBudgetVault.BudgetExceeded.selector);_run(1);
        vm.warp(1499);require(vault.rollingSpent()==0.004 ether);_run(0.006 ether);
        vm.warp(1500);require(vault.rollingSpent()==0.006 ether);
    }
    function testSameSecondAndDifferentCallersShareOneBudget() public {
        for(uint256 i;i<10;++i){vm.prank(address(uint160(i+7)));_run(0.001 ether);}
        require(vault.rollingSpent()==0.01 ether);vm.expectRevert(MusegodBuybackBudgetVault.BudgetExceeded.selector);_run(1);
    }
    function testExecutionFailureRollsBackBudgetAndTransfer() public {
        executor.configure(true,false);vm.expectRevert();_run(0.005 ether);
        require(vault.rollingSpent()==0 && weth.balanceOf(address(vault))==1 ether && weth.balanceOf(address(swapper))==0);
        executor.configure(false,false);_run(0.005 ether);
    }
    function testPriceDeviationAndMissingHistoryKeepFundsAvailableForRetry() public {
        pool.configure(300,0,0,false);vm.expectRevert(MusegodBuybackBudgetVault.PriceDeviation.selector);_run(1e14);
        pool.configure(0,150,-150,false);vm.expectRevert(MusegodBuybackBudgetVault.PriceDeviation.selector);_run(1e14);
        pool.configure(0,0,0,true);vm.expectRevert();_run(1e14);
        require(vault.rollingSpent()==0);pool.configure(0,0,0,false);_run(1e14);
    }
    function testReentrancyAndNoStandingAllowances() public {
        executor.configure(false,true);_run(1e14);require(!executor.reentered());
        require(weth.allowance(address(vault),address(executor))==0 && weth.allowance(address(vault),address(swapper))==0);
    }
    function testLongIdleExpiresAllBucketsAndNewDepositDoesNotExpandCap() public {
        _run(0.01 ether);weth.mint(address(vault),1 ether);vm.expectRevert(MusegodBuybackBudgetVault.BudgetExceeded.selector);_run(1);
        vm.warp(block.timestamp+86400);require(vault.rollingSpent()==0);_run(0.01 ether);
    }
    function testNoWithdrawalOwnerOrAlternativeExecutionTarget() public {
        (bool ok,)=address(vault).call(abi.encodeWithSignature("withdraw(address,uint256)",address(this),1));require(!ok);
        (ok,)=address(vault).call(abi.encodeWithSignature("owner()"));require(!ok);
    }
    function testFuzzCumulativeBudget(uint96 a,uint96 b) public {
        uint256 first=uint256(a)%1e16+1;_run(first);uint256 next=uint256(b)%1e16+1;
        if(first+next>1e16){vm.expectRevert(MusegodBuybackBudgetVault.BudgetExceeded.selector);_run(next);}else{_run(next);}
        require(vault.rollingSpent()<=1e16);
    }

    function testDenseSecondsExpireExactlyAndQueueWraps() public {
        for (uint256 i; i < 610; ++i) {
            vm.warp(1000 + i); _run(1);
            require(vault.rollingSpent() == (i < 300 ? i + 1 : 300));
        }
        vm.warp(1908); require(vault.rollingSpent() == 1);
        vm.warp(1909); require(vault.rollingSpent() == 0);
        _run(0.01 ether); require(vault.rollingSpent() == 0.01 ether);
    }

    function testLongIdleClearsDenseQueueWithoutScanningOldStorage() public {
        for (uint256 i; i < 300; ++i) { vm.warp(1000 + i); _run(1); }
        vm.warp(1600);
        uint256 beforeGas = gasleft();
        _run(1);
        require(beforeGas - gasleft() < 250000, "idle reset rescanned expired slots");
        require(vault.rollingSpent() == 1);
    }

    function testFirstExecutionHasNoCold300SlotScan() public {
        uint256 beforeGas = gasleft();
        _run(0.001 ether);
        require(beforeGas - gasleft() < 450000, "first execution exceeds budget accounting gas ceiling");
        beforeGas = gasleft();
        require(vault.rollingSpent() == 0.001 ether);
        require(beforeGas - gasleft() < 12000, "live budget view should not scan empty slots");
    }

    function testFuzzRollingQueueMatchesIndependentReceiptModel(uint256 seed) public {
        uint256[32] memory times; uint256[32] memory amounts;
        uint256 nowTime = 1000;
        for (uint256 i; i < 32; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            nowTime += seed % 401; vm.warp(nowTime);
            uint256 expected;
            for (uint256 j; j < i; ++j) if (nowTime - times[j] < 300) expected += amounts[j];
            require(vault.rollingSpent() == expected, "independent rolling model before execution");
            uint256 amount = (seed >> 32) % 1e16 + 1;
            if (amount + expected > 1e16) {
                vm.expectRevert(MusegodBuybackBudgetVault.BudgetExceeded.selector); _run(amount);
            } else {
                _run(amount); times[i] = nowTime; amounts[i] = amount; expected += amount;
            }
            require(vault.rollingSpent() == expected, "independent rolling model after execution");
        }
    }
}
