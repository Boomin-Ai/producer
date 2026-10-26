import Foundation
import AVFoundation
import CoreGraphics
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
guard let track = asset.tracks(withMediaType: .video).first else { fatalError("No encoded video") }
let size = track.naturalSize
let duration = CMTimeGetSeconds(asset.duration)
precondition(Int(size.width) == 1920 && Int(size.height) == 1080, "Expected 1080p native recording")
precondition(duration >= 9 && duration <= 12 && abs(track.nominalFrameRate - 30) < 1, "Unexpected recording cadence or duration")
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
func pixels(_ second: Double) throws -> [UInt8] {
 let image = try generator.copyCGImage(at: CMTime(seconds: second, preferredTimescale: 600), actualTime: nil)
 var bytes = [UInt8](repeating: 0, count: 1920*1080*4)
 bytes.withUnsafeMutableBytes { ptr in
  let context = CGContext(data: ptr.baseAddress, width: 1920, height: 1080, bitsPerComponent: 8, bytesPerRow: 1920*4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.draw(image, in: CGRect(x:0,y:0,width:1920,height:1080))
 }
 return bytes
}
let a = try pixels(1), b = try pixels(8)
var changed = 0
// Top and bottom bands never overlap either native camera slot. No camera pixels or
// frames are emitted; this checks that stage animation reached encoded output.
for y in stride(from: 0, to: 1080, by: 4) {
 for x in stride(from: 0, to: 1920, by: 4) where y < 300 || y > 780 {
  let offset = (y*1920+x)*4
  if (0..<3).contains(where: { abs(Int(a[offset+$0])-Int(b[offset+$0])) > 10 }) { changed += 1 }
 }
}

let report: [String:Any] = ["width":1920,"height":1080,"fps":track.nominalFrameRate,"duration":duration,"changedStageSamples":changed,"encodedStageMotion":changed > 100]
let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted,.sortedKeys])
print(String(data:data,encoding:.utf8)!)

precondition(changed > 100, "Encoded stage appears frozen")
