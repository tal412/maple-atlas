const assert=require('node:assert/strict'),{detect}=require('../src/companion-device.js');
for(const sample of [
 {userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',platform:'MacIntel',maxTouchPoints:0},
 {userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',platform:'Win32',maxTouchPoints:10},
 {userAgent:'Mozilla/5.0 (X11; Linux x86_64)',platform:'Linux x86_64'},
 {userAgentData:{mobile:false,platform:'macOS'}}
]){assert.equal(detect({...sample,canShareScreen:true}).role,'pc');assert(detect({...sample,canShareScreen:true}).canShareScreen);}
for(const sample of [
 {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',platform:'iPhone'},
 {userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit Mobile',platform:'Linux armv8l'},
 {userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',platform:'MacIntel',maxTouchPoints:5},
 {userAgentData:{mobile:true,platform:'Android'}},
 {userAgentData:{mobile:false,platform:'Android'},maxTouchPoints:5}
]){assert.equal(detect({...sample,canShareScreen:true}).role,'phone');assert(!detect({...sample,canShareScreen:true}).canShareScreen);}
assert.equal(detect({platform:'MacIntel',canShareScreen:false}).role,'pc','An unsupported desktop browser is not a phone');
assert(!detect({platform:'MacIntel',canShareScreen:false}).canShareScreen);
console.log('PASS: computer/phone roles for macOS, Windows touchscreens, Linux, Android, iPhone and iPad desktop mode; capability checks independent of viewport');
