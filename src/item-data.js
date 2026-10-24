(function(scope){
  const base='https://maplestory.io/api/MCW/1/item/';
  const keys=['price','notSale','only','tradeBlock','reqLevel','reqSTR','reqDEX','reqINT','reqLUK','reqJob','incPAD','incMAD','incPDD','incMDD','incSTR','incDEX','incINT','incLUK','incMHP','incMMP','incACC','incEVA','incSpeed','incJump','tuc','slotMax'];
  function normalize(raw,id){
    if(String(raw?.id)!==id||!raw.metaInfo||typeof raw.description?.name!=='string')throw Error('Invalid item record');
    const meta=raw.metaInfo,stats={};
    for(const key of keys)if(typeof meta[key]==='boolean'||(typeof meta[key]==='number'&&Number.isFinite(meta[key])))stats[key]=meta[key];
    const result={id,name:raw.description.name,cash:meta.cash===true,stats,source:base+id};
    if(typeof raw.description.description==='string')result.description=raw.description.description.replace(/\\n/g,'\n');
    if(typeof raw.typeInfo?.subCategory==='string')result.subcategory=raw.typeInfo.subCategory;
    if(typeof meta.reqLevel==='number')result.level=meta.reqLevel;
    if(typeof meta.price==='number'&&Number.isFinite(meta.price)&&meta.price>=0&&!result.cash)result.sell=meta.price;
    return result;
  }
  function cache(channel,id,value){
    return new Promise(resolve=>{
      let db,done=false;const finish=result=>{if(done)return;done=true;clearTimeout(timer);db?.close();resolve(result);};
      const timer=setTimeout(()=>finish(null),600);
      try{
        const req=indexedDB.open(channel==='dev'?'maple-atlas-dev-items':'maple-atlas-items',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('items');
        req.onerror=req.onblocked=()=>finish(null);
        req.onsuccess=()=>{db=req.result;if(done){db.close();return;}db.onversionchange=()=>db.close();
          const tx=db.transaction('items',value?'readwrite':'readonly'),store=tx.objectStore('items');
          const op=value?store.put(value,'MCW/1/'+id):store.get('MCW/1/'+id);
          tx.oncomplete=()=>finish(op.result);tx.onerror=tx.onabort=()=>finish(null);
        };
      }catch(_){finish(null);}
    });
  }
  function create({channel='main',request=(...args)=>fetch(...args),read=id=>cache(channel,id),write=(id,value)=>cache(channel,id,value),now=Date.now,timeout=12000}={}){
    const pending=new Map(),memory=new Map();
    const valid=(saved,id)=>saved?.schema===1&&saved.data?.id===id&&saved.data.source===base+id&&Number.isFinite(saved.checked);
    async function load(id,{refresh=false}={}){
      id=String(id);if(!/^\d{1,8}$/.test(id))throw Error('Invalid item ID');
      if(pending.has(id))return pending.get(id);
      const task=(async()=>{
        const saved=memory.get(id)||await read(id).catch(()=>null);
        if(!refresh&&valid(saved,id)&&now()-saved.checked<86400000)return {...saved,cached:true};
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
        try{
          const response=await request(base+id,{credentials:'omit',signal:controller.signal});
          if(!response.ok)throw Error('Item request failed');
          const data=normalize(await response.json(),id),record={schema:1,checked:now(),data};
          memory.set(id,record);void write(id,record).catch(()=>{});return record;
        }catch(error){if(valid(saved,id))return {...saved,cached:true,stale:true};throw error;}
        finally{clearTimeout(timer);}
      })();pending.set(id,task);
      try{return await task;}finally{pending.delete(id);}
    }
    return {load};
  }
  const api={create,normalize,base};scope.MapleItemData=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
