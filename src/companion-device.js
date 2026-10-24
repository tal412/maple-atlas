/* Device role uses browser platform signals, never viewport width. */
(function(scope){
  function detect({userAgent='',platform='',maxTouchPoints=0,userAgentData,canShareScreen=false}={}){
    const os=userAgentData?.platform||platform;
    const handheld=userAgentData?.mobile===true||/Android|iPhone|iPad|iPod|Windows Phone/i.test(userAgent)||/Android|iOS/i.test(os)||(/Mac/i.test(os)&&maxTouchPoints>1);
    return {role:handheld?'phone':'pc',label:handheld?'Phone or tablet':'Computer',canShareScreen:!handheld&&canShareScreen};
  }
  scope.MapleCompanionDevice={detect};if(typeof module!=='undefined')module.exports=scope.MapleCompanionDevice;
})(globalThis);
