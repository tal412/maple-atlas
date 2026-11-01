/* The Look detector: a small YOLO model, trained on synthetic game screens made from the
 * game's own sprites and map renders (the training scripts live outside this repository),
 * that finds monsters, NPCs, dropped items and players on a screenshot. It runs in the
 * browser with ONNX Runtime Web (vendor/ort/ on this site), loaded only when Look is first used;
 * the model and the runtime's WebAssembly come as bytes from Look's own cache (src/look-ui.js).
 *
 * detect(image) -> [{cls: 'monster'|'npc'|'item'|'player', score, box: {x, y, w, h}}] in the
 * image's pixels.
 */
(function(scope){
  const CLASSES=['monster','npc','item','player'];
  const ORT='./vendor/ort/';
  // model, runtime: () => Promise<ArrayBuffer> (the detector, the runtime's .wasm).
  function create({model,runtime,inputW=832,inputH=480,minScore=.35,iou=.5}={}){
    let session=null,loading=null;
    function loadScript(src){return new Promise((res,rej)=>{if(scope.ort)return res();const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=()=>rej(Error('The detector could not load.'));document.head.appendChild(s);});}
    function ready(){
      loading??=(async()=>{
        await loadScript(new URL(ORT+'ort.min.js',location.href).href);
        const [bytes,wasm]=await Promise.all([model(),runtime()]);
        scope.ort.env.wasm.wasmPaths=new URL(ORT,location.href).href;scope.ort.env.wasm.numThreads=1;scope.ort.env.wasm.wasmBinary=wasm;
        session=await scope.ort.InferenceSession.create(new Uint8Array(bytes),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
        return session;
      })().catch(e=>{loading=null;throw e;});
      return loading;
    }
    // Letterbox into the model's input (keeping the aspect), as the model was trained.
    function input(image){
      const k=Math.min(inputW/image.width,inputH/image.height),w=Math.round(image.width*k),h=Math.round(image.height*k),dx=(inputW-w)>>1,dy=(inputH-h)>>1;
      const src=document.createElement('canvas');src.width=image.width;src.height=image.height;src.getContext('2d').putImageData(image,0,0);
      const c=document.createElement('canvas');c.width=inputW;c.height=inputH;const x=c.getContext('2d');x.fillStyle='rgb(114,114,114)';x.fillRect(0,0,inputW,inputH);x.drawImage(src,dx,dy,w,h);
      const d=x.getImageData(0,0,inputW,inputH).data,n=inputW*inputH,t=new Float32Array(3*n);
      for(let i=0;i<n;i++){t[i]=d[i*4]/255;t[n+i]=d[i*4+1]/255;t[2*n+i]=d[i*4+2]/255;}
      return {tensor:new scope.ort.Tensor('float32',t,[1,3,inputH,inputW]),k,dx,dy};
    }
    const iouOf=(a,b)=>{const x=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),y=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));return x*y/(a.w*a.h+b.w*b.h-x*y);};
    async function detect(image){
      await ready();
      const {tensor,k,dx,dy}=input(image),out=await session.run({[session.inputNames[0]]:tensor}),o=out[session.outputNames[0]];
      // YOLO output: [1, 4 + classes, anchors] (centre x, y, width, height, then class scores).
      const [,rows,count]=o.dims,v=o.data,found=[];
      for(let i=0;i<count;i++){
        let best=0,cls=0;for(let c=4;c<rows;c++){const s=v[c*count+i];if(s>best){best=s;cls=c-4;}}
        if(best<minScore)continue;
        const cx=v[i],cy=v[count+i],w=v[2*count+i],h=v[3*count+i];
        found.push({cls:CLASSES[cls]||'monster',score:best,box:{x:(cx-w/2-dx)/k,y:(cy-h/2-dy)/k,w:w/k,h:h/k}});
      }
      found.sort((a,b)=>b.score-a.score);const keep=[];
      for(const f of found)if(!keep.some(o=>o.cls===f.cls&&iouOf(o.box,f.box)>iou))keep.push(f);
      return keep.slice(0,80);
    }
    return {ready,detect};
  }
  const api={create,CLASSES};
  scope.MapleLookDetector=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
