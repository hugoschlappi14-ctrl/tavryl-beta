const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const root = process.cwd();
const run = path.join(__dirname, 'coop-' + Date.now());
const appPath = 'Godot/app_userdata/ProjectAether';
const roles = ['Client0', 'Client3'];
const children = [];
const checks = [];
const engine = process.env.TAVRYL_TEST_ENGINE;
const clientVersion = process.env.TAVRYL_TEST_CLIENT_VERSION || '0.18.15';
const pack = process.env.TAVRYL_TEST_PACK;
if (!engine || !pack) throw Error('Explicit test engine and public game pack required');
const fresh = true;
const stressRestart = process.argv.includes('--prepare-restart');
const restartInParty = process.argv.includes('--restart-in-party');
const trace = process.argv.includes('--trace');
const exerciseFriendship = process.argv.includes('--exercise-friendship');
const steadyWalk = process.argv.includes('--steady-walk');
const enduranceMinutes = Math.max(0, Math.min(30, Number(process.env.TAVRYL_ENDURANCE_MINUTES) || 0));
const report = { version:clientVersion, start:new Date().toISOString(), freshTestIdentities:fresh, checks };
let sequence = 0;
let temporaryFriendship = false;
const lastValidState = new Map();

function read(role) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(run, role + '-state.json'), 'utf8'));
    lastValidState.set(role, {state, at:Date.now()});
    return state;
  } catch {
    // The probe can be midway through writing its file. Bridge only that brief
    // read race; an absent/stopped client must still become unavailable.
    const previous = lastValidState.get(role);
    return previous && Date.now()-previous.at < 250 ? previous.state : null;
  }
}

async function wait(label, predicate, milliseconds = 5000) {
  const until = Date.now() + milliseconds;
  do {
    const result = predicate();
    if (result) return result;
    if (children.some(child => child.exitCode !== null)) throw Error(label + ' (client stopped)');
    await sleep(90);
  } while (Date.now() < until);
  throw Error(label);
}

function write(role, action, value = {}) {
  const id = ++sequence;
  const file = path.join(run, role + '-command.json');
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ id, action, ...value }));
  // Windows can briefly hold the destination while the Godot probe reads it.
  // Retry only that test-command file race; never remove a command in flight.
  for (let attempt=0;;attempt++) {
    try { fs.renameSync(temporary,file); break; }
    catch(error) {
      if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt>=20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
  }
  return id;
}

async function command(role, action, value) {
  if (trace) {
    (report.actions ??= []).push({ role, action, kind: value?.kind, time:new Date().toISOString(),
      client0World: first()?.world_times.length, client3World: second()?.world_times.length });
  }
  const id = write(role, action, value);
  await wait(action, () => read(role)?.id === id);
}

function start(role, restart = false) {
  const profile = path.join(run, '.test_' + role);
  const target = path.join(profile, appPath);
  fs.mkdirSync(target, { recursive: true });
  const priorRun = process.env.TAVRYL_PRIOR_TEST_RUN ||
    run;
  const prior = path.join(priorRun, '.test_' + role, appPath);
  if (!fresh && !restart) fs.copyFileSync(path.join(prior, 'identite_reseau.cfg'), path.join(target, 'identite_reseau.cfg'));
  const log = fs.openSync(path.join(run, role + (restart ? '-restart' : '') + '.log'), 'w');
  const child = spawn(engine, ['--headless', '--max-fps', '60', '--main-pack', pack, '--script',
    path.join(__dirname, 'coop-probe.gd'), '--', role, run], {
    env: {
      ...process.env, APPDATA: profile, LOCALAPPDATA: profile, TAVRYL_TEST_AUTO: '1',
      TAVRYL_TEST_HOST: process.env.TAVRYL_COOP_HOST || 'tavryl-beta.onrender.com', TAVRYL_TEST_PORT: process.env.TAVRYL_COOP_PORT || '443', TAVRYL_TEST_KEY: '',
    }, windowsHide: true, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  children.push(child);
  return child;
}

function stats(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  const percentile = p => ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)] ?? null;
  return { samples: ordered.length, p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) };
}

const both = predicate => roles.every(role => { const state = read(role); return state && predicate(state); });
const first = () => read(roles[0]);
const second = () => read(roles[1]);
const codes = () => [first()?.social.code, second()?.social.code];
const relation = (state, field, code) => state.social[field].some(row => row.code === code);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const initial = [];

async function measureWalk(label) {
  const remoteBefore = await wait(label + ' avatar received initial position', () => {
    const mover = first(), witness = second();
    return mover && witness?.other.find(actor => actor.peer === mover.peer && actor.seq >= 0);
  });
  const mover = first();
  const startPosition = mover.position;
  await command(roles[1], 'track');
  const began = performance.now();
  const goal = [startPosition[0] + 95, startPosition[1]];
  await command(roles[0], 'walk', {xy:goal});
  const reached = await wait(label + ' remote avatar follows walking', () => {
    const a = first(), b = second();
    const remote = b?.other.find(actor => actor.peer === mover.peer);
    return a && remote && remote.seq > remoteBefore.seq &&
      distance(a.position,startPosition) > 55 && distance(remote.xy,a.position) < 35 && remote;
  }, 8500);
  const reachedMs = Math.round(performance.now() - began);
  const back = performance.now();
  await command(roles[0], 'walk', {xy:startPosition});
  await wait(label + ' remote avatar follows return leg', () => {
    const a = first(), b = second();
    const remote = b?.other.find(actor => actor.peer === mover.peer);
    return a && remote && remote.seq > reached.seq &&
      distance(a.position,startPosition) < 25 && distance(remote.xy,startPosition) < 35;
  }, 8500);
  const backMs = Math.round(performance.now() - back);
  await command(roles[1], 'stop_track');
  const tracked = second().remote_motion[String(mover.peer)];
  if (!tracked || tracked.packets.length < 4) throw Error(label + ' too few remote movement updates');
  const { packets, positions } = tracked;
  const intervals = packets.slice(1).map((row,i) => row[0] - packets[i][0]);
  const movementDistances = positions.slice(1).map((row,i) => distance(row.slice(1),positions[i].slice(1)));
  return { walkOutMs: reachedMs, walkBackMs: backMs, packetMs:stats(intervals),
    observerFrameMs:stats(second().track_frames), maxStepPx:Math.round(Math.max(...movementDistances)),
    firstSeq: packets[0][1], lastSeq: packets.at(-1)[1] };
}

(async () => {
  let beforeRestartWorldTimes;
  try {
    const startAfter = Date.parse(process.env.TAVRYL_COOP_START_AFTER || '');
    while (Date.now() < startAfter) await sleep(Math.min(30000, startAfter - Date.now()));
    report.start = new Date().toISOString();
    if (Number.isFinite(startAfter)) report.requestedStartAfter = new Date(startAfter).toISOString();
    let leaderProcess = start(roles[0]);
    start(roles[1]);
    await wait('both characters authenticated and received the world', () => {
      for (const [i, role] of roles.entries()) {
        const state = read(role);
        if (state) initial[i] = {
          health: state.health, authMs: state.auth_ms, worldMs: state.world_ms, soloMovementPx: Math.round(state.offline_motion),
          serverVersion: state.server_version,
        };
      }
      return both(state => state.auth_ms >= 0 && state.world_ms >= 0 && state.social.code);
    }, 115000);
    const expectedServer = process.env.TAVRYL_EXPECT_SERVER || '0.18.16';
    if (restartInParty && !initial.every(s => s.serverVersion === expectedServer)) {
      throw Error('expected public server version was not verified: ' + expectedServer);
    }
    checks.push('both characters authenticated and received the world');
    const [leader, guest] = codes();
    await wait('both players can see each other in the online roster', () =>
      relation(first(), 'roster', guest) && relation(second(), 'roster', leader), 10000);
    if (exerciseFriendship && relation(first(), 'friends', guest)) {
      await command(roles[0], 'social', {kind:'remove',target:guest});
      await wait('test friendship removed on both clients', () =>
        !relation(first(),'friends',guest) && !relation(second(),'friends',leader));
    }
    if (!relation(first(), 'friends', guest)) {
      temporaryFriendship = true;
      if (!relation(second(), 'requests', leader)) {
        await command(roles[0], 'social', {kind: 'add', target: guest});
      }
      await wait('guest received friend request', () => relation(second(), 'requests', leader));
      await command(roles[1], 'social', {kind: 'accept', target: leader});
      await wait('friendship confirmed', () =>
        relation(first(), 'friends', guest) && relation(second(), 'friends', leader));
      checks.push('friend request and acceptance confirmed on both test accounts');
    }
    await command(roles[0], 'social', {kind: 'invite', target: guest});
    await wait('guest received group invitation', () => relation(second(), 'invites', leader));
    await command(roles[1], 'social', {kind: 'join', target: leader});
    await wait('group of two', () => both(state => state.social.group.length === 2));
    checks.push('group of two');

    const echo = [];
    for (let i = 0; i < 12; i++) {
      const origin = roles[i % 2];
      const receiver = roles[1 - (i % 2)];
      const tic = performance.now();
      const payload = 'Tavryl test interne ' + i;
      // Identities are stable for this test. Avoid turning a transient state-file
      // read during its rewrite into an empty recipient after the 600 ms pause.
      await command(origin, 'social', {kind:'message', target:[leader,guest][1 - (i % 2)], text:payload});
      await wait('private message received by both clients', () => read(receiver)?.got === payload && read(origin)?.got === payload);
      echo.push(Math.round(performance.now() - tic));
      await sleep(600);
    }
    report.privateMessageObservedMs = stats(echo);
    checks.push('12 private messages received');

    if (!both(s => s.zone === 'lisiere')) {
      const portal = first()?.zone === 'lisiere' ? [-2050,4025] : [1300,1040];
      await command(roles[0], 'walk', {xy:portal});
      await wait('walk to the active zone portal', () => {
        const s = first();
        return s && distance(s.position,portal) < 60;
      }, 14000);
      await command(roles[0], 'travel');
      await wait('group arrived at Moonbramble Woods', () => both(s => s.zone === 'lisiere'), 8000);
      report.portal = await wait('both received the destination world', () => {
        const samples = roles.map(role => read(role)?.portal);
        return samples.every(s => s && s.enterMs >= 0 && s.firstWorldMs >= s.enterMs) && samples;
      });
      await wait('both received the six route monsters', () => both(s =>
        s.enemies.filter(enemy => enemy.id.startsWith('Route_lisiere_')).length === 6));
      checks.push('village portal moved the group and replicated all six route monsters');
      await sleep(2200);
      report.portal = roles.map((role,i) => read(role)?.portal ?? report.portal[i]);
    }
    checks.push('both players present in Moonbramble Woods');

    if (restartInParty) {
      report.beforeRestart = await measureWalk('initial');
      await command(roles[0], 'raise_counter', {counter:20000});
      const oldPeer = first().peer;
      const witnessPeer = second().peer;
      await wait('witness received elevated movement sequence', () =>
        second()?.other.some(actor => actor.peer === oldPeer && actor.seq >= 20000));
      beforeRestartWorldTimes = first().world_times;
      if (report.portal) report.portal = roles.map((role,i) => read(role)?.portal ?? report.portal[i]);
      if (trace) report.stallsBeforeRestart = first().world_stalls;
      if (trace) report.arrivalsBeforeRestart = first().world_arrivals;
      if (trace) report.lifeBeforeRestart = first().life_events;
      const stopped = new Promise(resolve => leaderProcess.once('exit', resolve));
      // Simulate closing the process without letting its solo scene reload interfere.
      leaderProcess.kill();
      await Promise.race([stopped, sleep(5000).then(() => {
        if (leaderProcess.exitCode === null && leaderProcess.signalCode === null) throw Error('first client did not stop');
      })]);
      children.splice(children.indexOf(leaderProcess),1);
      await wait('witness remained online during departure', () => {
        const witness = second();
        return witness?.mode === 3 && witness.peer === witnessPeer &&
          !witness.other.some(actor => actor.peer === oldPeer);
      });
      for (const suffix of ['-state.json','-command.json']) fs.rmSync(path.join(run,roles[0]+suffix),{force:true});
      leaderProcess = start(roles[0],true);
      await wait('same player reauthenticated while witness stayed connected', () => {
        const a = first(), b = second();
        return a?.mode === 3 && a.auth_ms >= 0 && a.world_ms >= 0 && a.peer !== oldPeer &&
          a.social.code === leader && b?.mode === 3 && b.peer === witnessPeer &&
          b.other.some(actor => actor.peer === a.peer && actor.seq >= 0 && actor.seq < 20000);
      }, 18000);
      report.reconnect = {authMs:first().auth_ms, worldMs:first().world_ms,
        sameWitnessPeer: second().peer === witnessPeer, newPeer: first().peer !== oldPeer,
        restoredZone: first().zone };
      await wait('party restored after client restart', () => both(state => state.social.group.length === 2));
      checks.push('party restored after client restart while the partner stayed connected');
      report.afterRestart = await measureWalk('after restart');
      checks.push('movement followed in both directions after full client restart');
      if (steadyWalk) {
        // Measure relative walks from the restored checkpoint. A forced regroup
        // can make idle level-1 probes die before latency sampling begins.
        const firstCount = first().world_times.length;
        const secondCount = second().world_times.length;
        report.steadyWalk = [];
        for (let round = 0; round < 3; round++) {
          report.steadyWalk.push(await measureWalk('steady movement ' + (round + 1)));
        }
        report.steadyWorldMs = roles.map((role, i) => {
          const times = read(role).world_times.slice(i === 0 ? firstCount : secondCount);
          return stats(times.slice(1).map((time,j) => time - times[j]));
        });
        checks.push('three successive walks synchronized after reconnect');
      }
    }

    const startPosition = first().position;
    const replicasBefore = second().other.map(x => x.seq);
    const move = [startPosition[0] + 90, startPosition[1]];
    await command(roles[0], 'walk', {xy: move});
    try { await wait('remote avatar follows movement', () => {
      const a = first(), b = second();
      return a && b && distance(a.position, startPosition) > 35 &&
        b.other.some(actor => actor.seq > (replicasBefore[0] ?? -1) && distance(actor.xy, a.position) < 27);
    }, 8500);
      checks.push('remote avatar followed movement');
    } catch (error) {
      report.movementFailure = error.message;
    }

    const state = await wait('enemies synchronized in Moonbramble Woods', () => {
      const s = first();
      return s?.enemies.some(e => distance(e.xy,s.position)<850) && s;
    });
    const candidates = state.enemies.filter(e => distance(e.xy, state.position) < 850);
    candidates.sort((a,b) => distance(a.xy,state.position) - distance(b.xy,state.position));
    const target = candidates[0];
    if (!target) throw Error('no replicated enemy near the test characters');
    report.enemy = target.name;
    const dest = [target.xy[0] + 45, target.xy[1]];
    await command(roles[0], 'walk', {xy: dest, chase:target.id});
    await command(roles[1], 'walk', {xy: [dest[0] + 45, dest[1]], chase:target.id});
    await wait('Warrior near synchronized enemy', () => {
      const s = first();
      const e = s?.enemies.find(e => e.id === target.id);
      return e && !s.safe && distance(e.xy, s.position) < 100;
    }, 18000);
    const baseline = await wait('same enemy on both clients', () => second()?.enemies.find(e => e.id === target.id)?.hp);
    const castSentAt = performance.now();
    await command(roles[0], 'cast', {target: target.id});
    await wait('Warrior spell activated and shared HP decreased', () => {
      const s = first(), other = second();
      if (!s?.spell_fired || !other || baseline == null) return false;
      const remoteHp = other.enemies.find(e => e.id === target.id)?.hp ?? 0;
      return s.spell_result >= 0 && remoteHp < baseline;
    }, 7500);
    checks.push('Warrior spell caused authoritative HP decrease on both clients');
    report.spellObservedMs = first().spell_result;
    report.spellOnBothClientsObservedMs = Math.round(performance.now() - castSentAt);
    if (process.argv.includes('--respawn-check')) {
      const before=roles.map(role=>({zone:read(role).zone,checkpoint:read(role).checkpoint}));
      for(const role of roles) {
        await command(role,'respawn_test');
        await sleep(1700);
        await wait('respawn completed',()=>{
          const state=read(role);
          return state && state.hp>0 && !state.down && !state.respawning;
        },6000);
      }
      report.respawn={before,after:roles.map(role=>({zone:read(role).zone,checkpoint:read(role).checkpoint,position:read(role).position}))};
      if(!both(s=>s.zone==='lisiere'))throw Error('respawn separated the party across zones');
      checks.push('death and respawn keep both players at the Lisiere checkpoint');
    }
    if (stressRestart) {
      await command(roles[0], 'raise_counter', {counter:20000});
      await wait('remote client observed elevated movement sequence', () =>
        second()?.other.some(actor => actor.seq >= 20000));
      checks.push('movement sequence above 20000 sent before process restart');
    }
    if (enduranceMinutes > 0) {
      report.endurance = await require('./coop-endurance.cjs')({minutes:enduranceMinutes,roles,read,command,wait,sleep,stats,distance,
        measureWalk,children,start,run,checks,first,second,both,
        getLeader:()=>leaderProcess,setLeader:value=>{leaderProcess=value;}});
      if (!report.endurance.completed) throw Error(report.endurance.failure || 'endurance duration not completed');
    }
  } catch (error) {
    report.failure = error.message;
  } finally {
    report.connection = initial;
    if (report.portal && !report.reconnect) {
      report.portal = roles.map((role,i) => read(role)?.portal ?? report.portal[i]);
    }
    if (trace) report.worldStalls = roles.map(role => read(role)?.world_stalls ?? []);
    if (trace) report.worldArrivals = roles.map(role => read(role)?.world_arrivals ?? []);
    if (trace) report.lifeEvents = roles.map(role => read(role)?.life_events ?? []);
    report.worldUpdateIntervalMs = roles.map(role => {
      const times = read(role)?.world_times ?? [];
      return stats(times.slice(1).map((value,i) => value - times[i]));
    });
    if (beforeRestartWorldTimes) report.worldUpdatesBeforeRestartMs =
      stats(beforeRestartWorldTimes.slice(1).map((value,i) => value - beforeRestartWorldTimes[i]));
    report.lastClientState = roles.map(role => {
      const s = read(role);
      return s ? {mode:s.mode, zone:s.zone, knownZone:s.known_zone, localSequence:s.sequence_local, safe:s.safe, spellFired:s.spell_fired,
        position:s.position, avatars:s.other, visibleEnemies:s.enemies.length, socialNotice:s.notice} : null;
    });
    await command(roles[0], 'social', {kind:'leave'}).catch(() => {});
    if (temporaryFriendship && codes().every(Boolean)) {
      await command(roles[0], 'social', {kind:'remove',target:codes()[1]}).catch(() => {});
      await sleep(400);
    }
    for (const role of roles) write(role, 'stop');
    await sleep(1400);
    for (const child of children) if (child.exitCode === null) child.kill();
    fs.writeFileSync(path.join(run,'summary.json'), JSON.stringify(report,null,2));
    console.log('TAVRYL_TEST_RESULT '+JSON.stringify({start:report.start,version:report.version,checks:report.checks,failure:report.failure||null,movementFailure:report.movementFailure||null,connection:report.connection,reconnect:report.reconnect,worldUpdateIntervalMs:report.worldUpdateIntervalMs,worldUpdatesBeforeRestartMs:report.worldUpdatesBeforeRestartMs,steadyWorldMs:report.steadyWorldMs,worldStalls:report.worldStalls,respawn:report.respawn,spellOnBothClientsObservedMs:report.spellOnBothClientsObservedMs,lastClientState:report.lastClientState,lifeEvents:report.lifeEvents,endurance:report.endurance}));
    process.exitCode = report.failure || report.movementFailure ? 1 : 0;
  }
})();
