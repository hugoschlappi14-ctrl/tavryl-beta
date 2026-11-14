// Bounded, opt-in test diagnostics. Never inspect headers, packets or identities.
let sequence=0;
export function traceFlow(edge,game,log=console.log,{interval=1000,lifetime=120000}={}) {
  const id=++sequence,start=performance.now();let gameBytes=0,clientBytes=0,lastGame=start,lastClient=start,closed=false;
  const fromGame=chunk=>{gameBytes+=chunk.length;lastGame=performance.now();};
  const fromClient=chunk=>{clientBytes+=chunk.length;lastClient=performance.now();};
  game.on('data',fromGame);edge.on('data',fromClient);
  const sample=()=>{
    const now=performance.now();
    log('TAVRYL_FLOW '+JSON.stringify({id,at:Date.now(),ageMs:Math.round(now-start),gameBytes,clientBytes,
      edgeQueuedBytes:edge.writableLength,gameQueuedBytes:game.writableLength,
      gamePaused:game.isPaused(),gameIdleMs:Math.round(now-lastGame),clientIdleMs:Math.round(now-lastClient)}));
    gameBytes=0;clientBytes=0;
  };
  const timer=setInterval(sample,interval);timer.unref();
  const limit=setTimeout(stop,lifetime);limit.unref();
  function stop(){if(closed)return;closed=true;sample();clearInterval(timer);clearTimeout(limit);
    game.off('data',fromGame);edge.off('data',fromClient);edge.off('close',stop);game.off('close',stop);}
  edge.once('close',stop);game.once('close',stop);
  return stop;
}
