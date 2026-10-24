(function(scope){
  const source='https://maplestory-classic.com/market.json',page='https://maplestory-classic.com/market';
  const nameKey=name=>String(name).normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  const amount=value=>value===null||(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e15);
  function valid(data,now=Date.now()){
    if(data?.schema!==1||data.source!==source||data.page!==page||!Array.isArray(data.items)||data.count!==data.items.length||data.count<1||data.count>50000)return false;
    if(!Number.isFinite(Date.parse(data.updatedAt))||Date.parse(data.updatedAt)>now+900000||!Number.isFinite(Date.parse(data.retrievedAt))||!/^[a-f0-9]{64}$/.test(data.digest)||!Number.isInteger(data.lowDataBelow)||data.lowDataBelow<1)return false;
    const seen=new Set();
    return data.items.every(i=>{
      if(typeof i.name!=='string'||!i.name.trim()||i.name.length>200||typeof i.slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(i.slug)||seen.has(nameKey(i.name)))return false;
      seen.add(nameKey(i.name));
      return [i.median,i.askingMedian,i.typicalLow,i.typicalHigh].every(amount)&&Number.isInteger(i.sales)&&i.sales>=0&&['item','set'].includes(i.unit)&&!(i.typicalLow!==null&&i.typicalHigh!==null&&i.typicalLow>i.typicalHigh);
    });
  }
  function cache(channel,value){
    return new Promise(resolve=>{
      let db,done=false;const finish=result=>{if(done)return;done=true;clearTimeout(timer);db?.close();resolve(result);};
      const timer=setTimeout(()=>finish(null),600);
      try{
        const req=indexedDB.open(channel==='dev'?'maple-atlas-dev-market':'maple-atlas-market',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('snapshot');req.onerror=req.onblocked=()=>finish(null);
        req.onsuccess=()=>{db=req.result;if(done){db.close();return;}db.onversionchange=()=>db.close();
          const tx=db.transaction('snapshot',value?'readwrite':'readonly'),store=tx.objectStore('snapshot');
          const op=value?store.put(value,'current'):store.get('current');
          tx.oncomplete=()=>finish(op.result);tx.onerror=tx.onabort=()=>finish(null);
        };
      }catch(_){finish(null);}
    });
  }
  function create({url='./data/market.json',channel='main',request=(...args)=>fetch(...args),read=()=>cache(channel),write=value=>cache(channel,value),now=Date.now,timeout=12000}={}){
    if(url!=='./data/market.json')throw Error('Invalid market URL');
    let state={data:null,loading:false,error:null,checkedAt:null},pending=null,hydrating=null,byName=new Map();
    const listeners=new Set(),emit=()=>listeners.forEach(fn=>fn({...state}));
    function adopt(data){
      if(!valid(data,now()))return false;
      const old=state.data;
      if(old&&(Date.parse(data.updatedAt)<Date.parse(old.updatedAt)||(Date.parse(data.updatedAt)===Date.parse(old.updatedAt)&&Date.parse(data.retrievedAt)<Date.parse(old.retrievedAt))))return false;
      if(!old||old.digest!==data.digest||old.updatedAt!==data.updatedAt||old.retrievedAt!==data.retrievedAt){
        state.data=data;byName=new Map(data.items.map(i=>[nameKey(i.name),i]));emit();
      }
      return true;
    }
    function hydrate(){
      if(!hydrating)hydrating=Promise.resolve().then(read).then(saved=>adopt(saved)).catch(()=>false);
      return hydrating;
    }
    function refresh(){
      if(pending)return pending;
      void hydrate();state.loading=true;state.error=null;emit();
      pending=Promise.resolve().then(async()=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
        try{
          const response=await request(url,{cache:'no-store',credentials:'omit',signal:controller.signal});
          if(!response.ok)throw Error('Market download failed');
          const data=await response.json();if(!valid(data,now()))throw Error('Invalid market snapshot');
          if(!adopt(data))state.error='older';
          else{state.checkedAt=now();void Promise.resolve().then(()=>write(data)).catch(()=>{});}
        }catch(_){state.error='unavailable';}
        finally{clearTimeout(timer);state.loading=false;pending=null;emit();}
        return {...state};
      });return pending;
    }
    function match(entity,identities){
      const record=byName.get(nameKey(entity.name));
      if(!record)return null;
      // No alias, fuzzy or first-ID guessing for monetary values.
      const ids=new Set(identities.get(nameKey(entity.name))||[]);ids.add(entity.id);
      return {record,ambiguous:ids.size>1,identityCount:ids.size};
    }
    return {refresh,hydrate,match,getState:()=>({...state}),subscribe(fn){listeners.add(fn);fn({...state});return()=>listeners.delete(fn);}};
  }
  function identities(entities){
    const result=new Map();for(const e of entities)if(e.type==='item'){const key=nameKey(e.name);if(!result.has(key))result.set(key,new Set());result.get(key).add(e.id);}return result;
  }
  function watch({store,doc=document,win=window,interval=60000,every=setInterval,cancel=clearInterval}){
    let active=false,timer=null,suspended=false;
    function sync(){if(timer!==null){cancel(timer);timer=null;}if(active&&!doc.hidden&&!suspended)timer=every(()=>void store.refresh(),interval);}
    function resume(){if(doc.hidden)return;suspended=false;void store.refresh();sync();}
    function visibility(){if(doc.hidden)sync();else resume();}
    function show(event){if(event.persisted)resume();}
    function hide(){suspended=true;sync();}
    doc.addEventListener('visibilitychange',visibility);win.addEventListener('pageshow',show);win.addEventListener('pagehide',hide);win.addEventListener('online',resume);
    void store.refresh();
    return {view(value){active=Boolean(value);if(active&&!doc.hidden&&!suspended)void store.refresh();sync();},destroy(){hide();doc.removeEventListener('visibilitychange',visibility);win.removeEventListener('pageshow',show);win.removeEventListener('pagehide',hide);win.removeEventListener('online',resume);}};
  }
  const api={create,watch,identities,nameKey,valid,source,page};scope.MapleMarketData=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
