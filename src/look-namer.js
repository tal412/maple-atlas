/* Look's namer: a small classifier that says which monster or pet a detector box holds, or
 * 'other' (a player, an NPC, the cursor, scenery). It was trained (outside this repository) on
 * crops cut the way this file cuts them: the box padded by 8%, grey (114) outside the picture,
 * letterboxed to SIZE x SIZE on grey. It names what template matching cannot: monsters partly
 * hidden behind ropes or grass, cut by the screen's edge, heaped together, or see-through.
 * It runs with the same ONNX Runtime as the detector (src/look-detector.js loads it).
 *
 * create({model, runtime, classes}) -> {ready, name(image, box) -> [{cls, p}] (best first, 3)}
 * classes: the model's class names ('m<id>' a monster, 'p<id>' a pet, 'other').
 */
(function(scope){
  const SIZE=96,GREY=114;
  function create({model,runtime,classes=[]}={}){
    let session=null,loading=null;
    function ready(){
      loading??=(async()=>{
        if(!scope.ort)throw Error('The namer needs the detector\'s runtime.');
        const [bytes,wasm]=await Promise.all([model(),runtime()]);
        if(!scope.ort.env.wasm.wasmBinary)scope.ort.env.wasm.wasmBinary=wasm;
        session=await scope.ort.InferenceSession.create(new Uint8Array(bytes),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
        return session;
      })().catch(e=>{loading=null;throw e;});
      return loading;
    }
    // The box padded by 8% (grey beyond the picture), letterboxed to SIZE x SIZE on grey.
    function input(image,box,source){
      const px=box.w*.08,py=box.h*.08,x0=Math.round(box.x-px),y0=Math.round(box.y-py),w=Math.max(1,Math.round(box.x+box.w+px)-x0),h=Math.max(1,Math.round(box.y+box.h+py)-y0);
      const k=SIZE/Math.max(w,h),dw=Math.max(1,Math.round(w*k)),dh=Math.max(1,Math.round(h*k)),c=document.createElement('canvas');c.width=SIZE;c.height=SIZE;
      const x=c.getContext('2d',{willReadFrequently:true});x.fillStyle=`rgb(${GREY},${GREY},${GREY})`;x.fillRect(0,0,SIZE,SIZE);
      const ox=(SIZE-dw)>>1,oy=(SIZE-dh)>>1;x.save();x.beginPath();x.rect(ox,oy,dw,dh);x.clip();x.imageSmoothingQuality='medium';
      x.drawImage(source,x0,y0,w,h,ox,oy,dw,dh);x.restore();
      // Parts of the box beyond the picture stay grey (drawImage leaves them unpainted).
      const d=x.getImageData(0,0,SIZE,SIZE).data,n=SIZE*SIZE,t=new Float32Array(3*n);
      for(let i=0;i<n;i++){t[i]=d[i*4]/255;t[n+i]=d[i*4+1]/255;t[2*n+i]=d[i*4+2]/255;}
      return new scope.ort.Tensor('float32',t,[1,3,SIZE,SIZE]);
    }
    // A canvas of the screenshot, made once per picture.
    let lastImage=null,lastCanvas=null;
    function sourceOf(image){
      if(image!==lastImage){const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').putImageData(image,0,0);lastImage=image;lastCanvas=c;}
      return lastCanvas;
    }
    async function name(image,box){
      await ready();
      const out=await session.run({[session.inputNames[0]]:input(image,box,sourceOf(image))}),p=out[session.outputNames[0]].data;
      return [...p].map((v,i)=>({cls:classes[i]||String(i),p:v})).sort((a,b)=>b.p-a.p).slice(0,3);
    }
    return {ready,name};
  }
  const api={create,SIZE};
  scope.MapleLookNamer=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
