import { parseSwapMessage, type SwapMessage } from "./swap-stream";
export type LiveStatus={connected:boolean;receiving:boolean;receivedAt:number|null};
type Listener={status(value:LiveStatus):void;event(message:SwapMessage):Promise<boolean>};
type Socket={addEventListener(name:string,fn:(event:any)=>void):void;close():void};
export function createSwapConnection(options:{chainId:number;pool:string;createSocket():Socket;visible():boolean;watchVisibility(fn:()=>void):()=>void}){
 const listeners=new Set<Listener>();let socket:Socket|null=null,retry:ReturnType<typeof setTimeout>|undefined,quiet:ReturnType<typeof setTimeout>|undefined,deadline:ReturnType<typeof setTimeout>|undefined,unwatch:(()=>void)|undefined,failures=0;
 let state:LiveStatus={connected:false,receiving:false,receivedAt:null};
 const publish=(value:LiveStatus)=>{state=value;for(const l of listeners)l.status(value);};
 function disconnect(){clearTimeout(quiet);clearTimeout(deadline);const old=socket;socket=null;old?.close();publish({connected:false,receiving:false,receivedAt:null});}
 function failed(current:Socket|null){if(current!==socket)return;disconnect();if(listeners.size&&options.visible()&&!retry){const delay=Math.min(60_000,2000*2**Math.min(failures++,5));retry=setTimeout(()=>{retry=undefined;connect();},delay);}}
 function connect(){if(socket||retry||!listeners.size||!options.visible())return;let current:Socket;try{current=options.createSocket();}catch{failed(null);return;}socket=current;deadline=setTimeout(()=>failed(current),15_000);
  current.addEventListener('open',()=>{if(current!==socket)return;clearTimeout(deadline);publish({connected:true,receiving:false,receivedAt:null});});
  current.addEventListener('error',()=>failed(current));current.addEventListener('close',()=>failed(current));
  current.addEventListener('message',event=>{if(current!==socket||!state.connected||!options.visible()||typeof event.data!=='string')return;const message=parseSwapMessage(event.data,options.chainId,options.pool);if(!message)return;
   void Promise.all([...listeners].map(l=>l.event(message).catch(()=>false))).then(changes=>{if(current!==socket||!options.visible()||!changes.some(Boolean))return;failures=0;publish({connected:true,receiving:true,receivedAt:Date.now()});clearTimeout(quiet);quiet=setTimeout(()=>publish({...state,receiving:false}),30_000);});
  });
 }
 const visibility=()=>{if(!options.visible()){clearTimeout(retry);retry=undefined;disconnect();}else connect();};
 return {subscribe(listener:Listener){listeners.add(listener);listener.status(state);if(listeners.size===1){unwatch=options.watchVisibility(visibility);connect();}return()=>{listeners.delete(listener);if(!listeners.size){unwatch?.();unwatch=undefined;clearTimeout(retry);retry=undefined;disconnect();failures=0;}};}};
}
let shared:{key:string;connection:ReturnType<typeof createSwapConnection>;subscribers:number}|undefined;
/** Token pages mount one live consumer; subscribers for that pool share the tab's socket. */
export function subscribeSwapStream(chainId:number,pool:string,listener:Listener){
 const key=`${chainId}:${pool}`;
 if(shared&&shared.key!==key&&shared.subscribers)throw Error("A tab may display only one active market stream");
 if(!shared||shared.key!==key){const url=new URL(`/api/chains/${chainId}/market/stream`,location.origin);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('pool',pool);
  shared={key,subscribers:0,connection:createSwapConnection({chainId,pool,createSocket:()=>new WebSocket(url),visible:()=>document.visibilityState==='visible',watchVisibility:fn=>{document.addEventListener('visibilitychange',fn);return()=>document.removeEventListener('visibilitychange',fn);}})};
 }
 const entry=shared;entry.subscribers++;const off=entry.connection.subscribe(listener);return()=>{off();entry.subscribers--;};
}
