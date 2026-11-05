import {createHash,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export async function body(req) {
  if(!String(req.headers['content-type']||'').startsWith('application/json')) throw Error('invalid_content_type');
  const chunks=[];let size=0;
  for await(const chunk of req) {size+=chunk.length;if(size>16384)throw Error('invalid_body');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('invalid_json');}
  if(!value||Array.isArray(value)||typeof value!=='object')throw Error('invalid_json');
  return value;
}
export function json(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}
export function adminHandler(getStore,key=process.env.TAVRYL_ADMIN_KEY||'') {
  const enabled=key.length>=32;
  const digest=s=>createHash('sha256').update(s).digest();
  const expected=digest(key);let failures=0,windowStart=Date.now();
  const staticFiles={'/admin':['admin.html','text/html'],'/admin/':['admin.html','text/html'],'/admin.js':['admin.js','text/javascript'],'/admin.css':['admin.css','text/css']};
  return async(req,res)=>{
    let url;try{url=new URL(req.url,'http://localhost');}catch{json(res,400,{error:'invalid_url'});return true;}
    if(!url.pathname.startsWith('/admin'))return false;
    res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    if(!enabled){json(res,404,{error:'not_found'});return true;}
    try {
      if(req.method==='GET' && staticFiles[url.pathname]) {
        const [file,type]=staticFiles[url.pathname];const content=await readFile(new URL(file,import.meta.url));
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);return true;
      }
      const authorization=req.headers.authorization||'';
      const supplied=authorization.startsWith('Bearer ')?authorization.slice(7):'';
      if(!timingSafeEqual(digest(supplied),expected)) {
        if(Date.now()-windowStart>60000){windowStart=Date.now();failures=0;}
        failures++;json(res,failures>30?429:401,{error:failures>30?'too_many_attempts':'unauthorized'});return true;
      }
      const store=getStore();if(!store){json(res,503,{error:'starting'});return true;}
      if(req.method==='GET'&&url.pathname==='/admin/api/overview')json(res,200,await store.overview());
      else if(req.method==='GET'&&url.pathname==='/admin/api/characters')json(res,200,await store.characters(url.searchParams.get('account')));
      else if(req.method==='POST'&&url.pathname==='/admin/api/moderate') {
        // Bearer credentials are never cookies. Also reject cross-origin browser writes.
        const origin=req.headers.origin;
        if(origin && new URL(origin).host!==req.headers.host){json(res,403,{error:'origin_rejected'});return true;}
        const v=await body(req);json(res,200,await store.moderate(v.accountId,v.action,v.reason,v.duration));
      } else json(res,404,{error:'not_found'});
    } catch(error) {
      const safe=/^(invalid_|unknown_player|duplicate_player)/.test(error.message);
      json(res,safe?400:503,{error:safe?error.message:'temporarily_unavailable'});
    }
    return true;
  };
}
