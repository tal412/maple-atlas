#!/usr/bin/env python3
"""Build pinned ORB landmark vectors. Optional OpenCV build dependency; no runtime server.

First regeneration: --sources --download (requires the pinned research export).
Subsequent regeneration: --download, or no arguments when sources are present.
Normal site builds use the committed index and do not require OpenCV.
"""
import argparse,concurrent.futures,hashlib,json,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
COMMIT='a44f101bffa8272164ca47484ab18c078dcab0a0'
DOCS=ROOT/'docs'
def blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def sources():
 raw=ROOT/'research/osms';tree={v['path']:v for v in json.loads((raw/'repo-tree.json').read_text())['tree']}
 def read(name,path):
  data=(raw/(name+'.json')).read_bytes();assert blob(data)==tree[path]['sha'],path;return json.loads(data)
 maps=read('maps','data/current/maps.json');manifest=read('map_manifest','data/current/map_manifest.json')
 existing=json.loads((ROOT/'data/map-assets.json').read_text())['maps'];catalog=json.loads((ROOT/'data/search-catalog.json').read_text())
 def asset(path,local=None):
  obj=tree[path];return dict(path=local or 'assets/recognition/'+obj['sha'][:16]+Path(path).suffix,source='https://raw.githubusercontent.com/ohmi69/osms_datamine_dashboard/'+COMMIT+'/'+path,gitBlob=obj['sha'],bytes=obj['size'])
 records=[]
 for region in maps['regions']:
  for m in region['maps']:
   mid=str(m['id']);e=existing.get(mid,{});full='data/maps/'+manifest[mid.zfill(9)]+'.webp';preview='data/current/'+m['minimap'] if m.get('minimap') else None
   records.append(dict(id=mid,name=m['name'],street=m.get('street_name',''),region=region['region'],inAtlas=mid in existing,image=asset(full,e.get('image',{}).get('path')),preview=asset(preview,e.get('preview',{}).get('path')) if preview else None))
 known={m['id'] for m in records};missing=[dict(id=e['id'],name=e['name'],reason='No reference image in the pinned export') for e in catalog['entities'] if e['type']=='map' and e['id'] not in known]
 result=dict(schema=1,sourceCommit=COMMIT,maps=sorted(records,key=lambda m:int(m['id'])),unavailable=missing)
 (ROOT/'data/visual-sources.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result

def download(entry):
 target=DOCS/entry['path']
 if target.exists() and blob(target.read_bytes())==entry['gitBlob']:return
 error=None
 for attempt in range(3):
  try:
   with urllib.request.urlopen(entry['source'],timeout=40) as response:data=response.read()
   if len(data)!=entry['bytes'] or blob(data)!=entry['gitBlob']:raise ValueError('Source hash mismatch: '+entry['path'])
   target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);return
  except Exception as e:error=e
 raise error

def build(source):
 import cv2,numpy as np
 cv2.setNumThreads(2);cv2.setRNGSeed(19)
 orb=cv2.ORB_create(nfeatures=1200,scaleFactor=1.2,nlevels=8,edgeThreshold=12,fastThreshold=10)
 out=bytearray();records=[];coverage=[]
 for num,m in enumerate(source['maps'],1):
  kinds=[]
  for kind,entry,side in [('minimap',m['preview'] or m['image'],550),('scene',m['image'],1600)]:
   data=(DOCS/entry['path']).read_bytes();assert blob(data)==entry['gitBlob'],entry['path']
   raw=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_UNCHANGED)
   if raw is None:raise ValueError('Unreadable source: '+entry['path'])
   if raw.ndim==2:raw=cv2.cvtColor(raw,cv2.COLOR_GRAY2BGRA)
   if raw.shape[2]==4:
    alpha=raw[:,:,3:4].astype(np.float32)/255;raw=(raw[:,:,:3]*alpha+60*(1-alpha)).astype(np.uint8)
   h,w=raw.shape[:2];scale=side/max(h,w);im=cv2.resize(raw,(max(1,round(w*scale)),max(1,round(h*scale))),interpolation=cv2.INTER_LINEAR)
   keypoints,desc=orb.detectAndCompute(cv2.cvtColor(im,cv2.COLOR_BGR2GRAY),None)
   n=0 if desc is None else len(desc)
   if n<12:continue
   offset=len(out);points=np.array([k.pt for k in keypoints],dtype='<f4');out+=points.tobytes();out+=desc.tobytes()
   records.append(dict(id=m['id'],kind=kind,width=im.shape[1],height=im.shape[0],originalWidth=w,originalHeight=h,count=n,offset=offset,source=entry['gitBlob']))
   kinds.append(kind)
  coverage.append(dict(id=m['id'],name=m['name'],kinds=kinds))
  if num%40==0 or num==len(source['maps']):print(f'Indexed {num}/{len(source["maps"])} reference maps',flush=True)
 digest=hashlib.sha256(out).hexdigest();filename='visual-'+digest[:16]+'.bin'
 folder=DOCS/'data';folder.mkdir(exist_ok=True);(folder/filename).write_bytes(out)
 for old in folder.glob('visual-*.bin'):
  if old.name!=filename:old.unlink()
 catalog=dict(schema=1,algorithm='ORB-1200-1.2-8-edge12-fast10',opencv=cv2.__version__,sourceCommit=COMMIT,data='./data/'+filename,sha256=digest,bytes=len(out),records=records,maps=[{k:v for k,v in m.items() if k not in ['image','preview']}|dict(image='./'+m['image']['path'],preview='./'+(m['preview'] or m['image'])['path']) for m in source['maps']],unavailable=source['unavailable'],coverage=coverage)
 (folder/'visual-index.json').write_text(json.dumps(catalog,separators=(',',':'))+'\n')
 print(f'Visual index: {len(records)} views, {sum(r["count"] for r in records):,} landmarks, {len(out):,} bytes; {len(source["unavailable"])} names without references',flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--sources',action='store_true');parser.add_argument('--download',action='store_true');args=parser.parse_args()
 source=sources() if args.sources else json.loads((ROOT/'data/visual-sources.json').read_text())
 if args.download:
  entries={m[k]['path']:m[k] for m in source['maps'] for k in ['image','preview'] if m[k]}
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
   for i,_ in enumerate(pool.map(download,entries.values()),1):
    if i%60==0:print(f'Checked/downloaded {i}/{len(entries)} images',flush=True)
 build(source)
