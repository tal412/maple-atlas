(function(scope){
  // Only a versioned static asset on this GitHub Pages origin is requested.
  // Cache failures never block search; cached editions never masquerade as new data.
  function cache(name,operation){
    return new Promise(resolve=>{
      let db,finished=false;
      const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);db?.close();resolve(value);};
      const timer=setTimeout(()=>finish(null),600);
      try{
        const open=indexedDB.open(name,1);
        open.onupgradeneeded=()=>open.result.createObjectStore('catalog');
        open.onblocked=open.onerror=()=>finish(null);
        open.onsuccess=()=>{
          db=open.result;if(finished){db.close();return;}
          db.onversionchange=()=>db.close();
          const tx=db.transaction('catalog',operation.value?'readwrite':'readonly'),store=tx.objectStore('catalog');
          const request=operation.value?store.put(operation.value,'current'):store.get('current');
          tx.oncomplete=()=>finish(request.result);tx.onabort=tx.onerror=()=>finish(null);
        };
      }catch(_){finish(null);}
    });
  }
  function create({url,channel='main',readCache=()=>cache(channel==='dev'?'maple-atlas-dev-search':'maple-atlas-search',{}),writeCache=value=>cache(channel==='dev'?'maple-atlas-dev-search':'maple-atlas-search',{value}),request=(...args)=>fetch(...args)}){
    if(!/^\.\/data\/search-[a-f0-9]{16}\.json$/.test(url))throw new Error('Invalid catalog path');
    let pending=null;
    const valid=data=>data?.schema===1&&Array.isArray(data.entities)&&data.entities.length>0;
    function load(){
      if(pending)return pending;
      pending=(async()=>{
        const saved=await readCache().catch(()=>null);
        if(saved?.url===url&&valid(saved.data))return saved.data;
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
        try{
          const response=await request(url,{signal:controller.signal,credentials:'omit'});
          if(!response.ok)throw new Error('Search download failed');
          const data=await response.json();if(!valid(data))throw new Error('Invalid search catalog');
          void writeCache({url,data}).catch(()=>{});return data;
        }finally{clearTimeout(timer);}
      })().catch(error=>{pending=null;throw error;});
      return pending;
    }
    return {load};
  }
  const api={create};scope.MapleSearchData=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
