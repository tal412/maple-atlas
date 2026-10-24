(function(scope) {
  function pinch(camera, first, second) {
    const center={x:(first.x+second.x)/2,y:(first.y+second.y)/2};
    return {distance:Math.hypot(first.x-second.x,first.y-second.y),zoom:camera.zoom,world:{x:(center.x-camera.ox)/camera.scale,y:(center.y-camera.oy)/camera.scale}};
  }
  function updatePinch(start, first, second) {
    return {zoom:Math.max(.5,Math.min(5,start.zoom*Math.hypot(first.x-second.x,first.y-second.y)/Math.max(1,start.distance))),world:start.world,screen:{x:(first.x+second.x)/2,y:(first.y+second.y)/2}};
  }
  function create({element,getCamera,onPan,onZoom,onStart,onEnd}) {
    const pointers=new Map();let start=null,dragged=false,suppressClick=false;
    const point=e=>{const r=element.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
    function rebase(){const p=[...pointers.values()],c=getCamera();start=p.length>1?pinch(c,p[0],p[1]):p.length?{...p[0],dx:c.dx,dy:c.dy}:null;}
    element.onpointerdown=e=>{
      if(!pointers.size){dragged=false;suppressClick=false;}
      const marker=e.target.closest('.mc-place');
      if((e.target.closest('button,a,input,select,textarea')&&!marker)||e.button>0||pointers.size===2)return;
      pointers.set(e.pointerId,point(e));
      // Keep a short tap targeted at its marker; captured moves still bubble to the map.
      (marker||element).setPointerCapture(e.pointerId);
      if(pointers.size===2){dragged=true;suppressClick=true;}
      onStart();rebase();
    };
    element.onpointermove=e=>{
      if(!pointers.has(e.pointerId))return;
      pointers.set(e.pointerId,point(e));const p=[...pointers.values()];
      if(p.length>1){onZoom(updatePinch(start,p[0],p[1]));}
      else{
        if(!dragged&&Math.hypot(p[0].x-start.x,p[0].y-start.y)<6)return;
        dragged=true;suppressClick=true;
        onPan(start.dx+p[0].x-start.x,start.dy+p[0].y-start.y);
      }
    };
    const end=e=>{if(!pointers.delete(e.pointerId))return;rebase();if(!pointers.size)onEnd();};
    element.onpointerup=end;element.onpointercancel=end;element.onlostpointercapture=end;
    // Stop the click produced after a drag before it reaches a marker's click handler.
    // Keyboard activation has detail=0 and remains available.
    const guard=e=>{if(suppressClick&&e.detail!==0){e.preventDefault();e.stopImmediatePropagation();}};
    element.addEventListener('click',guard,true);
    element.addEventListener('dblclick',guard,true);
    return {get moving(){return pointers.size>0;}};
  }
  const api={pinch,updatePinch,create};scope.MapleGestures=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
