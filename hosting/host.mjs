import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { StateStore } from './state.mjs';
import { AdminStore } from './admin-store.mjs';
import { adminHandler,body,json } from './admin-http.mjs';
import { validUpgrade } from './socket-upgrade.mjs';
import {createProbeGuard,forwardUpgrade} from './probe-guard.mjs';

const port=Number(process.env.PORT || 10000);
const dataRoot=process.env.XDG_DATA_HOME || '/tmp/tavryl-data';
const statePath=process.env.TAVRYL_STATE_PATH || path.join(dataRoot,'Godot/app_userdata/ProjectAether/serveur_aether');
const gamePort=7002;
const gameHost='127.0.0.2';
let ready=false, stopping=false, child, store, timer, admin;
const probeGuards=[];
let cpuSample;
let cpuReading = false;
async function sampleCpu() {
  if (cpuReading) return;
  cpuReading = true;
  try {
    const [raw, mainThread] = await Promise.all([
      readFile('/sys/fs/cgroup/cpu.stat', 'utf8'),
      child?.pid ? readFile('/proc/'+child.pid+'/schedstat','utf8').catch(()=>'') : '',
    ]);
    const stats = Object.fromEntries(raw.trim().split('\n').map(line => line.trim().split(/\s+/)));
    const [runtime, wait] = mainThread.trim().split(/\s+/).map(Number);
    const now = {at:Date.now(), throttled:Number(stats.throttled_usec), usage:Number(stats.usage_usec), runtime, wait};
    if (cpuSample && now.throttled - cpuSample.throttled >= 100000) {
      console.log('TAVRYL_CPU_LIMIT window_ms='+(now.at-cpuSample.at)+
        ' throttled_ms='+Math.round((now.throttled-cpuSample.throttled)/1000)+
        ' cpu_ms='+Math.round((now.usage-cpuSample.usage)/1000)+
        ' main_run_ms='+Math.round((now.runtime-cpuSample.runtime)/1e6)+
        ' main_wait_ms='+Math.round((now.wait-cpuSample.wait)/1e6));
    }
    cpuSample=now;
  } catch { /* CPU accounting is optional on hosts without cgroup v2. */ }
  finally { cpuReading=false; }
}
const cpuTimer=setInterval(()=>{if(ready && sockets.size>0)void sampleCpu();else cpuSample=undefined;},1000);
cpuTimer.unref();
const handleAdmin=adminHandler(()=>admin);
const sockets=new Set();
const httpServer=http.createServer(async(req,res)=>{
  if(await handleAdmin(req,res))return;
  const allowed=req.method==='GET' && ['/', '/healthz'].includes(req.url);
  res.writeHead(allowed ? (ready ? 200 : 503) : 404,{
    'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(allowed ? {game:'Tavryl',status:ready?'ready':'starting',protocol:18,version:'0.18.28',hostRevision:'probe-guard-2',publicBeta:process.env.TAVRYL_PUBLIC_BETA==='1'} : {error:'not_found'}));
});
httpServer.headersTimeout=10000; httpServer.requestTimeout=10000;
httpServer.on('upgrade',(req,socket,head)=>{
	if(!validUpgrade(req.headers)) {
		socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
	}
  if(!ready || req.method!=='GET' || req.url!=='/' || req.headers.upgrade?.toLowerCase()!=='websocket' || sockets.size>=24) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
  }
  sockets.add(socket);
  forwardUpgrade(req,socket,head,gamePort,()=>sockets.delete(socket),gameHost);
});
const local=http.createServer(async(req,res)=>{
  if(req.method==='POST' && req.url?.startsWith('/moderation/') && admin && !stopping) {
    try {
      const value=await body(req);
      if(req.url==='/moderation/check')json(res,200,await admin.allowed(value.accountId));
      else if(req.url==='/moderation/presence')json(res,200,{bans:await admin.presence(value.players)});
      else json(res,404,{error:'not_found'});
    } catch {json(res,503,{error:'moderation_unavailable'});}
    return;
  }
  if(req.method!=='POST' || req.url!=='/commit' || stopping) {res.writeHead(404).end(); return;}
  try {await store.commit(); res.writeHead(204).end();}
  catch {res.writeHead(503).end(); void shutdown(75,'state commit failed');}
});
local.headersTimeout=5000; local.requestTimeout=5000;

async function shutdown(code, reason) {
  if(stopping) return; stopping=true; ready=false; clearInterval(timer); clearInterval(cpuTimer);
  console.log('TAVRYL_HOST_STOP',reason);
  for(const socket of sockets) socket.destroy();
  for(const guard of probeGuards)guard.stop();
  const exited=child && new Promise(resolve=>child.once('exit',resolve));
  child?.kill('SIGTERM');
  if(exited) await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,1500))]);
  try {await store?.commit();} catch {code=75;}
  try {await store?.close();} catch {}
  child?.kill('SIGKILL'); httpServer.close(); local.close(); process.exit(code);
}
process.on('SIGTERM',()=>void shutdown(0,'platform shutdown'));
process.on('SIGINT',()=>void shutdown(0,'operator shutdown'));
try {
  if(process.env.TAVRYL_PUBLIC_BETA!=='1' && (process.env.TAVRYL_BETA_KEY||'').length<12) throw Error('beta access code missing');
  httpServer.listen(port,'0.0.0.0');
  store=new StateStore(process.env.DATABASE_URL,statePath);
  store.db.on('error',()=>void shutdown(75,'database connection lost'));
  const restored=await store.open();
  admin=new AdminStore(store.db);await admin.open();
  console.log('TAVRYL_STATE_RESTORED files='+restored);
  await new Promise((resolve,reject)=>{local.once('error',reject);local.listen(7001,'127.0.0.1',resolve);});
  for(const probePort of [7000,gamePort]) {
    const guard=createProbeGuard(gamePort,{gameHost});probeGuards.push(guard);
    await new Promise((resolve,reject)=>{guard.once('error',reject);guard.listen(probePort,'127.0.0.1',resolve);});
  }
  const executable=process.env.TAVRYL_EXECUTABLE || '/app/tavryl-server';
  const extra=JSON.parse(process.env.TAVRYL_ENGINE_ARGS || '[]');
  const userArgs=JSON.parse(process.env.TAVRYL_USER_ARGS || '["--server"]').filter(arg=>!String(arg).startsWith('--port='));
  child=spawn(executable,[...extra,'--headless','--audio-driver','Dummy','--',...userArgs,'--port='+gamePort],{
    windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,TAVRYL_ADMIN_KEY:'',XDG_DATA_HOME:dataRoot,TAVRYL_REVERSE_PROXY:'1',TAVRYL_GAME_LOOPBACK:gameHost,TAVRYL_PERSISTENCE:'postgres',TAVRYL_MODERATION:'1'}});
  let buffer='';
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();
    const lines=buffer.split('\n'); buffer=lines.pop();
    for(const line of lines) {
      console.log(line);
      if(line.includes('TAVRYL_SERVER_READY')) {ready=true;console.log('TAVRYL_PUBLIC_READY');}
    }
  });
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  child.on('error',()=>void shutdown(1,'game failed to launch'));
  child.on('exit',code=>{if(!stopping)void shutdown(code||1,'game exited');});
  // Snapshot checkpoints on disconnect as well. This is internal persistence,
  // not outbound traffic intended to prevent the hosting service from sleeping.
  timer=setInterval(()=>{if(ready)store.commit().catch(()=>void shutdown(75,'state snapshot failed'));},2000);
} catch(error) {
  // Never include connection strings or raw database errors in public logs.
  console.error('TAVRYL_HOST_START_FAILED',error.code || 'configuration_or_storage');
  await shutdown(1,'startup failed');
}
