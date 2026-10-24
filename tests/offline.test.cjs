const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(channel='main'){
 const handlers={},entries=new Map(),deleted=[],calls=[],prefix=channel==='main'?'/maple-atlas/':'/maple-atlas/dev/';let fail=false,quota=false;
 const cache={match:async key=>entries.get(key)?.clone(),put:async(key,value)=>{if(quota)throw Error('quota');entries.set(key,value.clone());}};
 const name='maple-atlas-offline-'+channel+'-new';
 const source=fs.readFileSync('src/service-worker.js','utf8').replace('__CACHE_NAME__',JSON.stringify(name)).replace('__OFFLINE_FILES__',JSON.stringify(['index.html','vendor/companion/qr.js'])).replace('__CHANNEL__',JSON.stringify(channel));
 vm.runInNewContext(source,{URL,Response,self:{location:{href:'https://example.test'+prefix+'sw.js'},addEventListener:(type,fn)=>handlers[type]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>cache,keys:async()=>['maple-atlas-offline-main-old','maple-atlas-offline-dev-old',name],delete:async key=>deleted.push(key)},fetch:async req=>{calls.push(req.url||req);if(fail)throw Error('offline');return new Response('fresh');}});
 const request=(path,mode='cors')=>{let result=null;handlers.fetch({request:{url:'https://example.test'+prefix+path,method:'GET',mode},respondWith:r=>{result=r;}});return result;};
 return {handlers,entries,deleted,calls,request,prefix,setFail:v=>{fail=v;},setQuota:v=>{quota=v;}};
}
(async()=>{
 const f=fixture();let task;f.handlers.activate({waitUntil:p=>task=p});await task;assert.deepEqual(f.deleted,['maple-atlas-offline-main-old']);
 assert.equal(f.request('dev/index.html'),null);assert.equal(f.request('data/market.json'),null,'Market failure must remain visible to the market store');assert.equal(f.request('version.json'),null);
 assert.equal(await (await f.request('vendor/companion/qr.js')).text(),'fresh');const n=f.calls.length;
 f.setFail(true);assert.equal(await (await f.request('vendor/companion/qr.js')).text(),'fresh');assert.equal(f.calls.length,n,'Saved static files do not require internet');
 await assert.rejects(f.request('assets/missing.png'));
 f.setFail(false);await f.request('?release=one','navigate');assert(f.entries.has('https://example.test/maple-atlas/index.html'));
 f.setFail(true);assert.equal(await (await f.request('','navigate')).text(),'fresh','Navigation falls back offline');
 f.setFail(false);f.setQuota(true);assert.equal(await (await f.request('assets/new.png')).text(),'fresh','A full cache must not break online content');
 f.setQuota(false);const messages=[];f.handlers.message({data:{type:'save-companion-offline'},ports:[{postMessage:m=>messages.push(m)}],waitUntil:p=>task=p});await task;assert.equal(messages.at(-1).done,true);
 const d=fixture('dev');d.handlers.activate({waitUntil:p=>task=p});await task;assert.deepEqual(d.deleted,['maple-atlas-offline-dev-old']);
 console.log('PASS: offline navigation/assets, cache quota failures, resumable offline save, market freshness and main/dev isolation');
})().catch(e=>{console.error(e);process.exitCode=1;});
