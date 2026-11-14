import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {traceFlow} from '../trace-flow.mjs';
const socket=()=>Object.assign(new EventEmitter(),{writableLength:0,isPaused:()=>false});
test('flow counters do not change payload and close removes listeners',()=>{
 const edge=socket(),game=socket(),logs=[],payload=Buffer.from('unchanged');
 let received;game.on('data',b=>{received=b;});
 const stop=traceFlow(edge,game,s=>logs.push(JSON.parse(s.slice(12))));
 game.emit('data',payload);edge.emit('data',Buffer.alloc(3));edge.emit('close');stop();
 assert.equal(received,payload);assert.equal(logs.length,1);
 assert.equal(logs[0].gameBytes,9);assert.equal(logs[0].clientBytes,3);
 assert.equal(edge.listenerCount('data'),0);assert.equal(game.listenerCount('data'),1);
 assert.equal(game.listenerCount('close'),0);
});
test('flow tracing expires automatically',async()=>{
 const edge=socket(),game=socket(),logs=[];
 traceFlow(edge,game,s=>logs.push(s),{interval:10,lifetime:25});
 await new Promise(r=>setTimeout(r,60));
 assert.ok(logs.length>=1);assert.equal(edge.listenerCount('data'),0);
 assert.equal(game.listenerCount('data'),0);
 const count=logs.length;await new Promise(r=>setTimeout(r,30));assert.equal(logs.length,count);
});
