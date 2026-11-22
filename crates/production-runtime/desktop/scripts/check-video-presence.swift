// Fixture-specific visibility check for the public forest video. Samples only
// exposed background pixels, outside both authored foregrounds. This does not
// establish subjective quality, lip sync, or general dark-scene detection.
import Foundation
import AVFoundation
import CoreVideo
let folder=URL(fileURLWithPath:CommandLine.arguments[1])
var rows=[[String:Any]]()
for url in try FileManager.default.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil).filter({($0.lastPathComponent.hasPrefix("track-00-") || $0.lastPathComponent.hasPrefix("track-01-")) && $0.pathExtension=="mp4"}).sorted(by:{$0.path<$1.path}) {
 let asset=AVURLAsset(url:url);guard let track=asset.tracks(withMediaType:.video).first else {continue}
 let reader=try AVAssetReader(asset:asset)
 let output=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]);output.alwaysCopiesSampleData=false;reader.add(output);reader.startReading()
 var frames=0,blank=0,maxRun=0,run=0,stillRun=0,maxStillRun=0;var previous:[UInt8]?
 while let sample=output.copyNextSampleBuffer(),let b=CMSampleBufferGetImageBuffer(sample) {
  CVPixelBufferLockBaseAddress(b,.readOnly);let w=CVPixelBufferGetWidth(b),h=CVPixelBufferGetHeight(b),stride=CVPixelBufferGetBytesPerRowOfPlane(b,0),p=CVPixelBufferGetBaseAddressOfPlane(b,0)!.assumingMemoryBound(to:UInt8.self)
  var sum=0.0,sq=0.0,n=0.0;var points=[UInt8]()
  for iy in 1...14 {for ix in 0..<5 {let x=Int(Double(w)*(w>h ? (0.88+Double(ix)*0.02):(0.01+Double(ix)*0.005))),y=h*iy/16;let pixel=p[y*stride+x];points.append(pixel);let v=Double(pixel);sum+=v;sq+=v*v;n+=1}}
  CVPixelBufferUnlockBaseAddress(b,.readOnly);let mean=sum/n,variance=sq/n-mean*mean;let missing=mean<40 && variance<4
  if previous == points {stillRun+=1;maxStillRun=max(maxStillRun,stillRun)} else {stillRun=0};previous=points
  frames+=1;if missing {blank+=1;run+=1;maxRun=max(run,maxRun)} else {run=0}
 }
 guard reader.status == .completed else {fatalError("Decode failed")}
 rows.append(["chunk":url.lastPathComponent,"frames":frames,"blankFrames":blank,"maxBlankRun":maxRun,"maxIdenticalSampleRun":maxStillRun])
}
let data=try JSONSerialization.data(withJSONObject:rows,options:[.prettyPrinted,.sortedKeys]);FileHandle.standardOutput.write(data)
