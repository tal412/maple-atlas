(function(scope){
 function create({onProgress=()=>{}}={}){
  let worker=null,loading=null,catalog=null,next=0;const pending=new Map();
  function stop(){worker?.terminate();worker=null;loading=null;catalog=null;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Visual reading stopped.'));}pending.clear();}
  function request(type,extra={},transfer=[],timeout=20000){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('Visual reading took too long. Stop and restart the reader.'));},timeout);pending.set(id,{resolve,reject,timer});worker.postMessage({type,id,...extra},transfer);});}
  async function ready(){
   if(!loading){worker=new Worker('./vision-worker.js');worker.onmessage=({data})=>{
    if(data.type==='loading'){onProgress(data.message);return;}
    const p=pending.get(data.id);if(!p)return;pending.delete(data.id);clearTimeout(p.timer);if(data.type==='error')p.reject(Error(data.message));else p.resolve(data);
   };worker.onerror=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('The local matcher could not start. Reload and retry.'));}pending.clear();};
   loading=request('init',{},[],90000).then(value=>{catalog=value;return value;}).catch(e=>{stop();throw e;});}
   return loading;
  }
  async function match(image){await ready();return (await request('match',{image:{width:image.width,height:image.height,data:image.data}},[image.data.buffer])).result;}
  return {ready,match,stop,get catalog(){return catalog;}};
 }
 scope.MapleVisualClient={create};
})(globalThis);
