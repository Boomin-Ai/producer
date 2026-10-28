// Decode every encoded frame. Count persistent white header pixels so a one-
// frame graphics dropout is observable independently of changing forecast text.
import Foundation
import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
let input=URL(fileURLWithPath:CommandLine.arguments[1]),out=URL(fileURLWithPath:CommandLine.arguments[2])
try FileManager.default.createDirectory(at:out,withIntermediateDirectories:true)
let asset=AVURLAsset(url:input)
guard let track=asset.tracks(withMediaType:.video).first else {fatalError("No video track")}
let reader=try AVAssetReader(asset:asset),output=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]);output.alwaysCopiesSampleData=false;reader.add(output);reader.startReading()
let context=CIContext(options:[.cacheIntermediates:false])
func save(_ buffer:CVPixelBuffer,_ name:String){let image=CIImage(cvPixelBuffer:buffer);guard let cg=context.createCGImage(image,from:image.extent),let dest=CGImageDestinationCreateWithURL(out.appendingPathComponent(name+".png") as CFURL,UTType.png.identifier as CFString,1,nil) else{return};CGImageDestinationAddImage(dest,cg,nil);CGImageDestinationFinalize(dest)}
var rows:[[String:Any]]=[],previous:CVPixelBuffer?,saveNext=false,saved=0
while let sample=output.copyNextSampleBuffer(){autoreleasepool{
 guard let buffer=CMSampleBufferGetImageBuffer(sample) else{return}
 CVPixelBufferLockBaseAddress(buffer,.readOnly);let w=CVPixelBufferGetWidth(buffer),h=CVPixelBufferGetHeight(buffer),stride=CVPixelBufferGetBytesPerRow(buffer),data=CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to:UInt8.self)
 var white=0
 for y in Swift.stride(from:Int(Double(h)*0.035),to:Int(Double(h)*0.095),by:2){for x in Swift.stride(from:Int(Double(w)*0.025),to:Int(Double(w)*0.32),by:2){let p=data+y*stride+x*4;if p[0]>180&&p[1]>180&&p[2]>180{white+=1}}}
 CVPixelBufferUnlockBaseAddress(buffer,.readOnly)
 let index=rows.count,time=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));rows.append(["frame":index,"seconds":time,"headerWhiteSamples":white])
 if saveNext {save(buffer,"after-\(index)");saveNext=false}
 if white<12&&saved<12 {if let before=previous{save(before,"before-\(index-1)")};save(buffer,"missing-\(index)");saveNext=true;saved+=1}
 previous=buffer
}}
let counts=rows.compactMap{$0["headerWhiteSamples"] as? Int};let missing=rows.filter{($0["headerWhiteSamples"] as? Int ?? 0)<12}
let report:[String:Any]=["frames":rows.count,"duration":CMTimeGetSeconds(asset.duration),"width":track.naturalSize.width,"height":track.naturalSize.height,"minimumHeaderSamples":counts.min() ?? 0,"maximumHeaderSamples":counts.max() ?? 0,"missingHeaderFrames":missing,"rows":rows,"readerStatus":reader.status.rawValue]
try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:out.appendingPathComponent("frames.json"))
print("Decoded \(rows.count) frames; \(missing.count) missing-header frames; sample range \(counts.min() ?? 0)...\(counts.max() ?? 0)")
