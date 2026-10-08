import Foundation
import AVFoundation
import AppKit
let root=CommandLine.arguments[1]
var evidence:[[String:Any]]=[]
for name in ["landscape","portrait"] {
 let asset=AVURLAsset(url:URL(fileURLWithPath:root+"/"+name+".mp4"))
 guard let video=asset.tracks(withMediaType:.video).first,let audio=asset.tracks(withMediaType:.audio).first else { fatalError("Missing video or audio: \(name)") }
 let size=video.naturalSize
 let expected=name=="landscape" ? CGSize(width:1280,height:720) : CGSize(width:720,height:1280)
 guard size==expected else {fatalError("Incorrect canvas: \(size)")}
 let generator=AVAssetImageGenerator(asset:asset);generator.appliesPreferredTrackTransform=true
 let image=try generator.copyCGImage(at:CMTime(seconds:3,preferredTimescale:600),actualTime:nil)
 let rep=NSBitmapImageRep(cgImage:image)
 try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:root+"/"+name+".png"))
 let reader=try AVAssetReader(asset:asset)
 let output=AVAssetReaderTrackOutput(track:audio,outputSettings:[AVFormatIDKey:kAudioFormatLinearPCM,AVLinearPCMIsFloatKey:true,AVLinearPCMBitDepthKey:32,AVLinearPCMIsNonInterleaved:false])
 reader.add(output);reader.startReading();var count=0;var square=0.0;var peak=0.0
 while let sample=output.copyNextSampleBuffer(){guard let block=CMSampleBufferGetDataBuffer(sample) else{continue};let n=CMBlockBufferGetDataLength(block);var data=[UInt8](repeating:0,count:n);CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:n,destination:&data);data.withUnsafeBytes{raw in for value in raw.bindMemory(to:Float.self){let v=Double(value);square+=v*v;peak=max(peak,abs(v));count+=1;}}}
 let rms=sqrt(square/Double(max(count,1)))
 guard rms>0.04 && rms<0.12 else{fatalError("Lost or doubled audio: \(name), RMS \(rms)")}
 evidence.append(["output":name,"width":Int(size.width),"height":Int(size.height),"duration":asset.duration.seconds,"audioRMS":rms,"audioPeak":peak,"audioSamples":count])
}
let a=evidence[0]["audioRMS"] as! Double,b=evidence[1]["audioRMS"] as! Double
guard abs(a-b)<0.005 else{fatalError("Audio differs across outputs")}
let data=try JSONSerialization.data(withJSONObject:evidence,options:[.prettyPrinted,.sortedKeys]);try data.write(to:URL(fileURLWithPath:root+"/recording-evidence.json"));print(String(data:data,encoding:.utf8)!)
