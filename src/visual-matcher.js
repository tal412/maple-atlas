/* Local binary landmark search + geometric verification. No OCR or remote inference. */
(function(scope){
  const pairs=[[0,7],[4,11],[8,15],[12,19],[16,23],[20,27],[24,31],[3,29]];
  function create(cv,catalog,buffer){
    if(catalog.schema!==1||catalog.algorithm!=='ORB-1200-1.2-8-edge12-fast10'||buffer.byteLength!==catalog.bytes)throw Error('Unsupported visual map index.');
    const orb=new cv.ORB();orb.setMaxFeatures(1200);orb.setScaleFactor(1.2);orb.setNLevels(8);orb.setEdgeThreshold(12);orb.setFastThreshold(10);
    const matcher=new cv.BFMatcher(cv.NORM_HAMMING,false),empty=new cv.Mat();
    const records=catalog.records.map((r,i)=>{
      if(!Number.isSafeInteger(r.count)||r.count<12||r.count>1200||r.offset<0||r.offset+r.count*40>buffer.byteLength||r.offset%4)throw Error('Invalid visual reference.');
      const points=new Float32Array(buffer,r.offset,r.count*2),bytes=new Uint8Array(buffer,r.offset+r.count*8,r.count*32);
      return {...r,i,points,bytes,mat:cv.matFromArray(r.count,32,cv.CV_8U,bytes)};
    });
    const total=records.reduce((n,r)=>n+r.count,0),head=new Int32Array(8*65536).fill(-1),frequency=new Uint32Array(8*65536),next=new Int32Array(total*8),owner=new Uint16Array(total);let base=0;
    for(const r of records){for(let row=0;row<r.count;row++){owner[base+row]=r.i;for(let table=0;table<8;table++){const [a,b]=pairs[table],key=table*65536+r.bytes[row*32+a]*256+r.bytes[row*32+b],node=(base+row)*8+table;next[node]=head[key];head[key]=node;frequency[key]++;}}base+=r.count;}
    function shortlist(bytes,count){
      const votes=new Float32Array(records.length);
      // Common brick/grass patterns carry little location evidence. Skip their
      // entire bucket instead of truncating it, which would bias by map order.
      for(let row=0;row<count;row++)for(let table=0;table<8;table++){const [a,b]=pairs[table],key=table*65536+bytes[row*32+a]*256+bytes[row*32+b],n=frequency[key];if(n>200)continue;let node=head[key];while(node!==-1){votes[owner[Math.floor(node/8)]]+=1/Math.sqrt(n);node=next[node];}}
      return records.map((r,i)=>[r,votes[i]]).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]).slice(0,28).map(([r])=>r);
    }
    function verify(q,kp,r,width,height){
      const matches=new cv.DMatchVectorVector(),seen=new Set(),good=[];let from,to,mask,h;
      try{
        matcher.knnMatch(q,r.mat,matches,2);
        for(let i=0;i<matches.size();i++){const v=matches.get(i);try{if(v.size()<2)continue;const a=v.get(0),b=v.get(1);if(a.distance<.75*b.distance&&a.distance<80&&!seen.has(a.trainIdx)){seen.add(a.trainIdx);good.push(a);}}finally{v.delete();}}
        if(good.length<12)return null;
        const qp=[],rp=[];
        for(const m of good){const p=kp.get(m.queryIdx).pt;qp.push(p.x,p.y);rp.push(r.points[m.trainIdx*2],r.points[m.trainIdx*2+1]);}
        from=cv.matFromArray(good.length,1,cv.CV_32FC2,qp);to=cv.matFromArray(good.length,1,cv.CV_32FC2,rp);mask=new cv.Mat();h=cv.findHomography(from,to,cv.RANSAC,4,mask,2000,.995);
        if(h.empty())return null;
        const inliers=[],query=[],landmarks=[],grid=new Set();let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        for(let i=0;i<good.length;i++)if(mask.data[i]){inliers.push([rp[i*2],rp[i*2+1]]);query.push([qp[i*2],qp[i*2+1]]);landmarks.push(r.i+':'+good[i].trainIdx);minX=Math.min(minX,qp[i*2]);maxX=Math.max(maxX,qp[i*2]);minY=Math.min(minY,qp[i*2+1]);maxY=Math.max(maxY,qp[i*2+1]);}
        const n=inliers.length,ratio=n/good.length,area=(maxX-minX)*(maxY-minY)/(width*height);
        if(n<12||ratio<.45||area<.004||maxX-minX<20||maxY-minY<15)return null;
        for(const [x,y] of query)grid.add(Math.min(2,Math.floor((x-minX)/(maxX-minX)*3))+3*Math.min(2,Math.floor((y-minY)/(maxY-minY)*3)));
        if(grid.size<4)return null;
        const matrix=Array.from(h.data64F);if(matrix.length!==9||!matrix.every(Number.isFinite))return null;
        const cx=(minX+maxX)/2,cy=(minY+maxY)/2,project=(x,y)=>{const z=matrix[6]*x+matrix[7]*y+matrix[8];return [(matrix[0]*x+matrix[1]*y+matrix[2])/z,(matrix[3]*x+matrix[4]*y+matrix[5])/z];};
        const center=project(cx,cy),right=project(cx+10,cy),down=project(cx,cy+10),sx=Math.hypot(right[0]-center[0],right[1]-center[1])/10,sy=Math.hypot(down[0]-center[0],down[1]-center[1])/10,det=(right[0]-center[0])*(down[1]-center[1])-(right[1]-center[1])*(down[0]-center[0]);
        if(det<=0||sx<.05||sx>20||sy<.05||sy>20||sx/sy<.45||sx/sy>2.2)return null;
        return {id:r.id,kind:r.kind,inliers:n,matches:good.length,ratio,score:n*(.5+.5*ratio),landmarks,points:query.slice(0,80).map(([x,y])=>[x/width,y/height]),referencePoints:inliers.slice(0,80).map(([x,y])=>[x/r.width,y/r.height]),matrix,width,height,referenceWidth:r.width,referenceHeight:r.height};
      }finally{matches.delete();from?.delete();to?.delete();mask?.delete();h?.delete();}
    }
    function matchOnce({width,height,data}){
      if(!Number.isInteger(width)||!Number.isInteger(height)||width<16||height<16||width*height>1600000||data.length!==width*height*4)throw Error('Invalid image dimensions.');
      const rgba=cv.matFromArray(height,width,cv.CV_8UC4,data),gray=new cv.Mat(),kp=new cv.KeyPointVector(),desc=new cv.Mat();
      try{
        cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);orb.detectAndCompute(gray,empty,kp,desc);
        if(desc.rows<12)return {candidates:[],features:desc.rows};
        const ranked=shortlist(desc.data,desc.rows).map(r=>verify(desc,kp,r,width,height)).filter(Boolean).sort((a,b)=>b.score-a.score),unique=new Map();
        for(const r of ranked)if(!unique.has(r.id))unique.set(r.id,r);
        const candidates=Array.from(unique.values()).slice(0,5),best=candidates[0],runner=candidates[1];
        const strong=!!best&&best.inliers>=18&&best.ratio>=.55&&(!runner||best.score>=runner.score*1.65&&best.score-runner.score>=8);
        return {candidates,strong,features:desc.rows};
      }finally{rgba.delete();gray.delete();kp.delete();desc.delete();}
    }
    function match(image){
      const first=matchOnce(image);if(first.strong||Math.min(image.width,image.height)<80)return first;
      const src=cv.matFromArray(image.height,image.width,cv.CV_8UC4,image.data),small=new cv.Mat();
      try{
        cv.resize(src,small,new cv.Size(Math.round(image.width/2),Math.round(image.height/2)),0,0,cv.INTER_AREA);
        const second=matchOnce({width:small.cols,height:small.rows,data:small.data}),byMap=new Map();
        // Preserve competing evidence from either scale; shrinking an ambiguous
        // image must not silently erase a plausible alternative location.
        for(const c of [...first.candidates,...second.candidates])if(!byMap.has(c.id)||byMap.get(c.id).score<c.score)byMap.set(c.id,c);
        const candidates=[...byMap.values()].sort((a,b)=>b.score-a.score).slice(0,5),best=candidates[0],runner=candidates[1];
        const strong=!!best&&best.inliers>=18&&best.ratio>=.55&&(!runner||best.score>=runner.score*1.65&&best.score-runner.score>=8);
        return {candidates,strong,features:first.features,scales:2};
      }finally{src.delete();small.delete();}
    }
    return {match,destroy(){for(const r of records)r.mat.delete();matcher.delete();orb.delete();empty.delete();}};
  }
  scope.MapleVisualMatcher={create};if(typeof module!=='undefined')module.exports=scope.MapleVisualMatcher;
})(globalThis);
