import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StateStore} from '../state.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tavryl-state-test-'));
  // Never connect: emulate the optimistic revision contract with an isolated DB.
  const store=new StateStore('postgres://test:test@localhost/test',directory);
  const database={revision:0,files:{},writes:0};
  store.db={query:async (_sql,[encoded,revision])=>{
    if(revision!==database.revision)return {rowCount:0,rows:[]};
    database.files=JSON.parse(encoded); database.revision++; database.writes++;
    return {rowCount:1,rows:[{revision:database.revision}]};
  }};
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const write=(name,value)=>fs.writeFile(path.join(directory,name),value);
  await write('comptes.cfg','[comptes]\naccount="alpha"');
  await write('social.cfg','[social]\ncontacts={}');
  return {store,database,directory,write};
}

test('unchanged background checkpoints skip full reads; explicit commits do not',async t=>{
  const {store,database}=await fixture(t);
  await store.commit();const full=store.lastFullRead;
  await store.commit({background:true});await store.commit({background:true});
  assert.equal(store.lastFullRead,full);assert.equal(database.writes,1);
  await store.commit();assert.ok(store.lastFullRead>full);assert.equal(database.writes,1);
});
test('same-length atomic replacement is persisted at next background checkpoint',async t=>{
  const {store,database,directory,write}=await fixture(t);await store.commit();
  await write('comptes.cfg.tmp','[comptes]\naccount="bravo"');
  await fs.rename(path.join(directory,'comptes.cfg.tmp'),path.join(directory,'comptes.cfg'));
  await store.commit({background:true});
  assert.equal(database.writes,2);assert.match(database.files['comptes.cfg'],/bravo/);
});
test('same-length in-place rewrite is detected',async t=>{
  const {store,database,write}=await fixture(t);await store.commit();
  await write('comptes.cfg','[comptes]\naccount="bravo"');
  await store.commit({background:true});assert.match(database.files['comptes.cfg'],/bravo/);
});
test('full revalidation is forced after cache lifetime',async t=>{
  const {store}=await fixture(t);await store.commit();store.lastFullRead=-30001;
  await store.commit({background:true});assert.ok(store.lastFullRead>=0);
});
test('missing saved file cannot silently erase durable accounts',async t=>{
  const {store,database,directory}=await fixture(t);await store.commit();
  await fs.unlink(path.join(directory,'comptes.cfg'));
  await assert.rejects(store.commit({background:true}),/disappeared/);
  assert.equal(database.writes,1);assert.ok(database.files['comptes.cfg']);
});
test('invalid replacement does not reach database',async t=>{
  const {store,database,write}=await fixture(t);await store.commit();
  await write('social.cfg','invalid');
  await assert.rejects(store.commit({background:true}),/Invalid config/);
  assert.equal(database.writes,1);
});
test('stale host still cannot overwrite newer revision; error remains fatal',async t=>{
  const {store,database,write}=await fixture(t);await store.commit();database.revision++;
  await write('social.cfg','[social]\ncontacts={"new":{}}');
  await assert.rejects(store.commit(),/newer state/);
  await assert.rejects(store.commit({background:true}),/newer state/);
  assert.equal(database.writes,1);
});
test('a new file after an empty checkpoint is detected',async t=>{
  const {store,database,directory,write}=await fixture(t);
  await fs.unlink(path.join(directory,'comptes.cfg'));await fs.unlink(path.join(directory,'social.cfg'));
  await store.commit();await write('comptes.cfg','[comptes]\nnew={}');
  await store.commit({background:true});assert.equal(database.writes,1);
  assert.match(database.files['comptes.cfg'],/new/);
});
test('queued concurrent explicit commits preserve both state files',async t=>{
  const {store,database,write}=await fixture(t);await store.commit();
  await write('comptes.cfg','[comptes]\nnew={}');await write('social.cfg','[social]\ncontacts={"new":{}}');
  await Promise.all([store.commit(),store.commit({background:true}),store.commit()]);
  assert.equal(database.writes,2);assert.match(database.files['comptes.cfg'],/new/);
  assert.match(database.files['social.cfg'],/new/);
});
test('restoration recreates identical primary and backup files before checkpointing',async t=>{
  const {store,database,directory}=await fixture(t);await store.commit();
  const restoredDir=path.join(directory,'restored');
  const restored=new StateStore('postgres://test:test@localhost/test',restoredDir);
  restored.db={connect:async()=>{},query:async sql=>{
    if(sql.startsWith('SELECT'))return {rows:[{revision:database.revision,files:structuredClone(database.files)}]};
    if(sql.startsWith('UPDATE'))throw Error('unchanged restoration should not write');
    return {};
  }};
  assert.equal(await restored.open(),2);
  for(const [name,content] of Object.entries(database.files)) {
    assert.equal(await fs.readFile(path.join(restoredDir,name),'utf8'),content);
    assert.equal(await fs.readFile(path.join(restoredDir,name+'.bak'),'utf8'),content);
  }
  await restored.commit({background:true});
  assert.equal(restored.revision,database.revision);
});
test('temporary rename gap retries and preserves the new file',async t=>{
  const {store,database,directory,write}=await fixture(t);await store.commit();
  await fs.unlink(path.join(directory,'comptes.cfg'));
  const replacement=new Promise(resolve=>setTimeout(()=>resolve(write('comptes.cfg','[comptes]\nrestored={}')),10));
  await store.commit();await replacement;
  assert.match(database.files['comptes.cfg'],/restored/);
});
test('database failure cannot be hidden by a later cache hit',async t=>{
  const {store,write}=await fixture(t);await store.commit();
  await write('comptes.cfg','[comptes]\nnew={}');
  store.db.query=async()=>{throw Error('database unavailable');};
  await assert.rejects(store.commit(),/database unavailable/);
  await assert.rejects(store.commit({background:true}),/database unavailable/);
  assert.equal(store.revision,1);
});
