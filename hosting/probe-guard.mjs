import http from 'node:http';
import net from 'node:net';
import {validUpgrade} from './socket-upgrade.mjs';

export function forwardUpgrade(req,socket,head,port,onClose=()=>{}) {
  socket.pause();socket.setNoDelay(true);
  const upstream=net.connect(port,'127.0.0.1');upstream.setNoDelay(true);
  const cleanup=()=>{onClose();socket.destroy();upstream.destroy();};
  socket.on('error',cleanup);socket.on('close',cleanup);
  upstream.on('error',cleanup);upstream.on('close',cleanup);
  upstream.on('connect',()=>{
    const headers=[];
    for(let i=0;i<req.rawHeaders.length;i+=2)headers.push(req.rawHeaders[i]+': '+req.rawHeaders[i+1]);
    upstream.write('GET / HTTP/1.1\r\n'+headers.join('\r\n')+'\r\n\r\n');
    if(head.length)upstream.write(head);
    upstream.pipe(socket);socket.pipe(upstream);socket.resume();
  });
  return upstream;
}

// The former game port receives HTTP probes as well as WebSocket traffic.
// Keep it as a protocol boundary: HTTP is handled here, never by Godot.
export function createProbeGuard(gamePort,{log=console.log}={}) {
  let total=0,lastLog=0;
  const sockets=new Set();
  function record(req,kind) {
    total++;
    if(Date.now()-lastLog<60000)return;
    lastLog=Date.now();
    const path=req?.url==='/'?'root':req?.url==='/healthz'?'healthz':'other';
    // No header values, addresses, query strings, tokens or request bodies.
    log('TAVRYL_PROBE_GUARD '+JSON.stringify({kind,total,method:req?.method||'unknown',path,headerNames:Object.keys(req?.headers||{}).sort()}));
  }
  const server=http.createServer((req,res)=>{
    record(req,'http');
    res.writeHead(400,{'Connection':'close','Content-Length':'0'});res.end();
  });
  server.on('clientError',(_err,socket)=>{record(null,'invalid_http');socket.destroy();});
  server.on('upgrade',(req,socket,head)=>{
    if(!validUpgrade(req.headers)||req.method!=='GET'||req.url!=='/'||sockets.size>=24){
      record(req,'invalid_upgrade');socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;
    }
    sockets.add(socket);forwardUpgrade(req,socket,head,gamePort,()=>sockets.delete(socket));
  });
  server.headersTimeout=5000;server.requestTimeout=5000;
  server.probeCount=()=>total;
  server.stop=()=>{for(const socket of sockets)socket.destroy();server.close();};
  return server;
}
