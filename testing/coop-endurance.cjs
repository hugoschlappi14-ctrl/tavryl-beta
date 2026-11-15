const fs=require('node:fs');
const path=require('node:path');

// Drives the public client through its ordinary controls. Never changes health,
// damage, cooldowns, speed, target rules, collision or server simulation.
module.exports=async function endurance(ctx) {
  const {minutes,roles,read,command,wait,sleep,stats,distance,measureWalk,
    children,start,run,checks,first,second,both,getLeader,setLeader}=ctx;
  const began=Date.now(), until=began+minutes*60000;
  const samples=roles.map(()=>[]), worst=[], segments=[];
  const result={requestedMinutes:minutes,start:new Date(began).toISOString(),walks:0,
    portalTransitions:0,reconnections:0,deathInterruptions:0,segments};
  let segmentStart=Date.now(), round=0;
  async function collect(label) {
    const snapshots=[];
    for(const role of roles)snapshots.push(await wait('fresh telemetry for '+role,()=>read(role),3000));
    const rows=roles.map((role,i)=>{
      const s=snapshots[i];
      const times=s.world_times||[], gaps=times.slice(1).map((t,j)=>t-times[j]);
      samples[i].push(...gaps);
      worst.push(...(s.world_stalls||[]).map(x=>({...x,client:i})));
      return {zone:s.zone,mode:s.mode,world:stats(gaps)};
    });
    segments.push({label,seconds:Math.round((Date.now()-segmentStart)/1000),clients:rows});
    for(const role of roles)await command(role,'reset_metrics');
    segmentStart=Date.now();
  }
  async function alive() {
    if(!both(s=>s.hp>0&&!s.down&&!s.respawning)) {
      for(const role of roles)await command(role,'halt');
    }
    await wait('ordinary recovery before endurance movement',()=>both(s=>s.mode===3&&s.hp>0&&!s.down&&!s.respawning),45000);
  }
  async function portal(destination) {
    await alive();
    const point=first().zone==='lisiere'?[-2050,4025]:[1300,1040];
    for(const role of roles)await command(role,'walk',{xy:point});
    await wait('both walked to portal',()=>both(s=>distance(s.position,point)<60),18000);
    // Disconnecting promotes the remaining member: respect the current leader.
    const leaderRole=roles.find(role=>read(role)?.peer===first().social.group[0]?.peer);
    if(!leaderRole)throw Error('no current party leader');
    await command(leaderRole,'travel',{zone:destination});
    await wait('party crossed portal to '+destination,()=>both(s=>s.zone===destination&&s.known_zone===destination),10000);
    result.portalTransitions++;
  }
  async function restart() {
    await collect('before client restart');
    const oldPeer=first().peer, witnessPeer=second().peer, code=first().social.code;
    const proc=getLeader(); const stopped=new Promise(resolve=>proc.once('exit',resolve));
    proc.kill(); await Promise.race([stopped,sleep(5000)]);
    if(proc.exitCode===null&&proc.signalCode===null)throw Error('endurance client did not stop');
    children.splice(children.indexOf(proc),1);
    await wait('witness stayed connected',()=>second()?.mode===3&&second().peer===witnessPeer&&!second().other.some(a=>a.peer===oldPeer),10000);
    for(const suffix of ['-state.json','-command.json'])fs.rmSync(path.join(run,roles[0]+suffix),{force:true});
    setLeader(start(roles[0],true));
    await wait('endurance reconnect restored party and world',()=>{
      const a=first(),b=second();return a?.mode===3&&a.peer!==oldPeer&&a.social.code===code&&a.world_ms>=0&&
        b?.peer===witnessPeer&&a.zone===b.zone&&a.social.group.length===2&&b.social.group.length===2&&b.other.some(x=>x.peer===a.peer);
    },30000);
    result.reconnections++;
    for(const role of roles)await command(role,'defend');
    await alive(); await measureWalk('endurance after reconnect'); result.walks++;
  }
  try {
    for(const role of roles)await command(role,'defend');
    for(const role of roles)await command(role,'reset_metrics');
    while(Date.now()<until) {
      round++; const roundEnd=Math.min(until,Date.now()+60000);
      if(round%5===0 || minutes===1&&round===1){await portal('village');await portal('lisiere');await restart();}
      while(Date.now()<roundEnd) {
        await alive();
        try{await measureWalk('endurance walk '+(result.walks+1));result.walks++;}
        catch(error){
          if(both(s=>s.hp>0&&!s.down&&!s.respawning))throw error;
          result.deathInterruptions++; await alive();
        }
        await sleep(1200);
      }
      await collect('minute block '+round);
      console.log('TAVRYL_ENDURANCE_PROGRESS '+JSON.stringify({elapsedSeconds:Math.round((Date.now()-began)/1000),walks:result.walks,
        portals:result.portalTransitions,reconnections:result.reconnections,
        clients:samples.map(stats)}));
    }
    checks.push('extended two-client session completed');
  } catch(error){result.failure=error.message;}
  finally {
    try{await collect('final');}catch(error){result.failure??=error.message;}
    result.elapsedSeconds=Math.round((Date.now()-began)/1000);
    result.completed=!result.failure&&Date.now()>=until;
    result.clients=samples.map(stats);
    result.worstStalls=worst.sort((a,b)=>b.gap-a.gap).slice(0,20);
    result.over250ms=samples.map(s=>s.filter(x=>x>250).length);
    result.over500ms=samples.map(s=>s.filter(x=>x>500).length);
    result.over1000ms=samples.map(s=>s.filter(x=>x>1000).length);
  }
  return result;
};
