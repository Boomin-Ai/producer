// Isolated capability experiment. Uses WebRTC's header-extension API, never
// SDP string edits. The real SDK integration remains a separate reviewed change.
const uri='http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';
export function installCaptureExtensionProbe() {
  const state={attempts:0,enabled:0,unsupported:0,errors:[],negotiated:[]};
  for(const method of ['createOffer','createAnswer']) {
    const original=RTCPeerConnection.prototype[method];
    RTCPeerConnection.prototype[method]=function(...args) {
      for(const transceiver of this.getTransceivers()) {
        if(transceiver.stopped) continue;
        ++state.attempts;
        if(!transceiver.getHeaderExtensionsToNegotiate || !transceiver.setHeaderExtensionsToNegotiate) {++state.unsupported;continue;}
        const extensions=transceiver.getHeaderExtensionsToNegotiate();
        const capture=extensions.find(extension=>extension.uri===uri);
        if(!capture) {++state.unsupported;continue;}
        try {
          capture.direction='sendrecv';
          transceiver.setHeaderExtensionsToNegotiate(extensions);
          ++state.enabled;
        } catch(error) {if(state.errors.length<16) state.errors.push(String(error));}
      }
      return original.apply(this,args);
    };
  }
  const remote=RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription=async function(...args) {
    const result=await remote.apply(this,args);
    for(const transceiver of this.getTransceivers()) {
      if(!transceiver.getNegotiatedHeaderExtensions) continue;
      for(const extension of transceiver.getNegotiatedHeaderExtensions()) {
        if(extension.uri!==uri) continue;
        const item={kind:transceiver.receiver.track.kind,direction:extension.direction};
        if(state.negotiated.length<16 && !state.negotiated.some(old=>old.kind===item.kind && old.direction===item.direction)) state.negotiated.push(item);
      }
    }
    return result;
  };
  return state;
}
