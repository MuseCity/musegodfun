import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { SwapService } from "./swap-service";
/** Read-only RFC6455 endpoint. No client application frames are accepted. */
export function attachSwapSockets(server:Server,chains:Map<number,SwapService>){
 const clients=new Set<Socket>(),ips=new Map<Socket,string>();
 server.on('upgrade',(request,socket,head)=>{void (async()=>{
  const url=new URL(request.url??'/',`http://${request.headers.host}`),match=/^\/api\/chains\/(4663|8453)\/market\/stream$/.exec(url.pathname),service=match?chains.get(Number(match[1])):undefined;
  const key=request.headers['sec-websocket-key'],origin=request.headers.origin;
  const reject=()=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  if(!service||request.method!=='GET'||request.headers.upgrade?.toLowerCase()!=='websocket'||request.headers['sec-websocket-version']!=='13'||typeof key!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(key)||head.length||clients.size>=128||origin&&origin!==url.origin)return reject();
  const ip=(socket as Socket).remoteAddress??"unknown";if([...ips.values()].filter(value=>value===ip).length>=8)return reject();
  const pool=(url.searchParams.get('pool')??'').toLowerCase();if(!await service.pool(pool))return reject();
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');
  const client=socket as Socket;clients.add(client);ips.set(client,ip);
  const listener:Parameters<typeof service.listeners.add>[0]=message=>{if(message.pool!==pool)return;const bytes=Buffer.from(JSON.stringify(message)),header=Buffer.alloc(bytes.length<126?2:bytes.length<=65535?4:10);header[0]=0x81;
   if(bytes.length<126)header[1]=bytes.length;else if(bytes.length<=65535){header[1]=126;header.writeUInt16BE(bytes.length,2);}else{header[1]=127;header.writeBigUInt64BE(BigInt(bytes.length),2);}
   if(client.writableLength>1_048_576){client.destroy();return;}client.write(Buffer.concat([header,bytes]));};
  service.listeners.add(listener);const cleanup=()=>{clients.delete(client);ips.delete(client);service.listeners.delete(listener);};client.on('close',cleanup);client.on('error',cleanup);
  client.on('data',()=>{client.end(Buffer.from([0x88,0x00]));});
 })().catch(()=>socket.destroy());});
 server.once('close',()=>{for(const client of clients)client.destroy();});
 return ()=>{for(const client of clients)client.destroy();};
}
