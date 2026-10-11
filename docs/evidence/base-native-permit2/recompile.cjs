// Offline reproduction. Supply official solc 0.8.28/0.8.17 soljson.js paths.
// It never performs RPC, installs packages, or runs package scripts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const folder=__dirname;
for(const[name,compilerPath]of[['proxy',process.argv[2]],['permit2',process.argv[3]]]){
 if(!compilerPath)throw Error('Supply official soljson paths for 0.8.28 and 0.8.17');
 const solc=require(path.resolve(compilerPath)),input=fs.readFileSync(path.join(folder,name+'-compiler-input.json'),'utf8'),result=JSON.parse(fs.readFileSync(path.join(folder,name+'-build-result.json'),'utf8'));
 const version=solc.cwrap('solidity_version','string',[])();if(version!==result.compilerVersion)throw Error('Compiler version mismatch');
 if(crypto.createHash('sha256').update(input).digest('hex')!==result.inputSha256)throw Error('Input hash mismatch');
 const output=JSON.parse(solc.cwrap('solidity_compile','string',['string','number','number'])(input,0,0));
 if(output.errors?.some(e=>e.severity==='error'))throw Error('Compiler errors');
 const fq=name==='proxy'?['src/v3/RelayApprovalProxyV3.sol','RelayApprovalProxyV3']:['src/Permit2.sol','Permit2'];
 const generated=output.contracts[fq[0]][fq[1]].evm.deployedBytecode;let code=generated.object;
 // Map actual immutable values by their checked byte offsets rather than unstable AST ids.
 const valueRefs=Object.entries(result.immutableReferences).sort((a,b)=>a[1][0].start-b[1][0].start);
 for(const refs of Object.values(generated.immutableReferences))for(const ref of refs){
  const matching=valueRefs.find(([,entries])=>entries.some(e=>e.start===ref.start&&e.length===ref.length));if(!matching)throw Error('Immutable position mismatch');
  let value;
  if(name==='proxy')value=ref.start===4088?'000000000000000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3':'000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
  else value=ref.start===6945?'0000000000000000000000000000000000000000000000000000000000001237':'448684463b1f7965c1ec7c249cee11520df24c07242efc2b20f6e54c85614fad';
  // ADDRESS words must be precisely one 32-byte slot; avoid copying compiler IDs.
  value=value.slice(-64);if(value.length!==ref.length*2)throw Error('Immutable value size mismatch');
  code=code.slice(0,ref.start*2)+value+code.slice((ref.start+ref.length)*2);
 }
 const recorded=fs.readFileSync(path.join(folder,name+'-runtime.hex'),'utf8').trim();
 if('0x'+code!==recorded)throw Error('Full runtime mismatch');
 process.stdout.write(JSON.stringify({name,compilerVersion:version,fullRuntimeMatch:true,runtimeBytes:code.length/2})+'\n');
}
