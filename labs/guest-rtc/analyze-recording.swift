// Native AVFoundation decoder: inspect actual OBS MP4 presentation timestamps.
import Foundation
import AVFoundation
import CoreVideo

func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
func reader(_ asset: AVAsset, _ track: AVAssetTrack, _ settings: [String: Any]) throws -> (AVAssetReader, AVAssetReaderTrackOutput) {
    let r = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    out.alwaysCopiesSampleData = false
    guard r.canAdd(out) else { fail("Cannot add decoder output") }
    r.add(out); guard r.startReading() else { fail("Decoder failed: \(String(describing:r.error))") }
    return (r,out)
}
func percentile(_ values: [Double], _ q: Double) -> Double? {
    let sorted = values.sorted(); if sorted.isEmpty { return nil }
    return sorted[Int((Double(sorted.count - 1) * q).rounded())]
}
let args = CommandLine.arguments
if args.count != 3 { fail("Usage: swift analyze-recording.swift <mp4> <evidence-json>") }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let vt = asset.tracks(withMediaType: .video).first, let at = asset.tracks(withMediaType: .audio).first else { fail("Recording needs video and audio tracks") }
var videoEdges: [Double] = [], audioEdges: [Double] = [], videoFrames = 0, audioSamples = 0
var active = false
let (vr,vo) = try reader(asset,vt,[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
while let sample = vo.copyNextSampleBuffer() {
    guard let image = CMSampleBufferGetImageBuffer(sample) else { fail("Missing image buffer") }
    CVPixelBufferLockBaseAddress(image,.readOnly)
    let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image), stride = CVPixelBufferGetBytesPerRow(image)
    guard let bytes = CVPixelBufferGetBaseAddress(image)?.assumingMemoryBound(to:UInt8.self) else { fail("Missing pixels") }
    var sum = 0.0, count = 0
    for y in Swift.stride(from:0,to:height,by:4) { for x in Swift.stride(from:0,to:width,by:4) { sum += Double(bytes[y*stride+x*4]); count += 1 } }
    CVPixelBufferUnlockBaseAddress(image,.readOnly)
    let next = sum/Double(count) > 180
    if next && !active { videoEdges.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds*1000) }
    active = next; videoFrames += 1
}
guard vr.status == .completed else { fail("Video decode failed: \(String(describing:vr.error))") }
active = false
let (ar,ao) = try reader(asset,at,[AVFormatIDKey:kAudioFormatLinearPCM,AVSampleRateKey:48000,AVNumberOfChannelsKey:1,
    AVLinearPCMBitDepthKey:16,AVLinearPCMIsFloatKey:false,AVLinearPCMIsBigEndianKey:false,AVLinearPCMIsNonInterleaved:false])
while let sample = ao.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { fail("Missing PCM buffer") }
    let length = CMBlockBufferGetDataLength(block), frames = length/2
    var pcm = [Int16](repeating:0,count:frames)
    let copied = pcm.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:$0.baseAddress!) }
    guard copied == kCMBlockBufferNoErr else { fail("PCM copy failed") }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds*1000
    // RMS windows are bounded by decoded AAC chunks; edge resolution <= 10 ms.
    for index in Swift.stride(from:0,to:frames,by:480) {
        let end = min(index+480,frames)
        let sum = pcm[index..<end].reduce(0.0) { $0 + Double($1)*Double($1) }
        let next = sqrt(sum/Double(end-index)) > 2000
        if next && !active { audioEdges.append(pts+Double(index)/48) }
        active = next
    }
    audioSamples += frames
}
guard ar.status == .completed else { fail("Audio decode failed: \(String(describing:ar.error))") }
// Pair each marker at most once; account for every unmatched marker.
var used = Set<Int>(), pairs: [[String:Double]] = [], unmatchedAudio = 0
for a in audioEdges {
    let eligible = videoEdges.indices.filter { !used.contains($0) && abs(videoEdges[$0]-a) < 400 }
    if let index = eligible.min(by:{ abs(videoEdges[$0]-a) < abs(videoEdges[$1]-a) }) {
        used.insert(index); pairs.append(["audio_pts_ms":a,"video_pts_ms":videoEdges[index],"video_minus_audio_ms":videoEdges[index]-a])
    } else { unmatchedAudio += 1 }
}
let offsets = pairs.map { $0["video_minus_audio_ms"]! }
let duration = asset.duration.seconds
let early = pairs.filter { $0["audio_pts_ms"]! < duration*1000/3 }.map { $0["video_minus_audio_ms"]! }
let late = pairs.filter { $0["audio_pts_ms"]! > duration*2000/3 }.map { $0["video_minus_audio_ms"]! }
var report: [String:Any] = ["schema_version":1,"decoder":"macOS AVFoundation","recording":URL(fileURLWithPath:args[1]).lastPathComponent,
    "duration_seconds":duration,"video_frames_decoded":videoFrames,"audio_samples_decoded":audioSamples,
    "video_marker_pts_ms":videoEdges,"audio_marker_pts_ms":audioEdges,"pairs":pairs,
    "unmatched_audio_markers":unmatchedAudio,"unmatched_video_markers":videoEdges.count-used.count,
    "browser_source_paint_uncertainty_ms":1000.0/30,"audio_detector_window_max_ms":10,
    "observed_marker_test_pass":pairs.count >= 5 && unmatchedAudio == 0 && videoEdges.count == used.count && (percentile(offsets.map(abs),0.95) ?? Double.infinity) <= 80,
    "network_impairment_qualified":false,"lip_sync_qualified":false,"g1_complete":false]
report["recorded_av_abs_p95_ms"] = percentile(offsets.map(abs),0.95) ?? NSNull()
report["recorded_video_minus_audio_median_ms"] = percentile(offsets,0.5) ?? NSNull()
if let e = percentile(early,0.5), let l = percentile(late,0.5) { report["late_minus_early_median_offset_ms"] = l-e }
let data = try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys])
try data.write(to:URL(fileURLWithPath:args[2]))
print("Decoded \(videoFrames) video frames / \(audioSamples) audio samples; paired \(pairs.count) markers; p95 \(percentile(offsets.map(abs),0.95) ?? -1) ms")
