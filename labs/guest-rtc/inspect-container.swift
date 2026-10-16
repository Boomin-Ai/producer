// Read compressed sample timing without decoding or modifying the recording.
import AVFoundation
import Foundation
func fail(_ text: String) -> Never { fputs(text+"\n",stderr); exit(1) }
let args = CommandLine.arguments
if args.count != 3 { fail("Usage: inspect-container <mp4> <evidence-json>") }
let asset = AVURLAsset(url: URL(fileURLWithPath:args[1]))
var tracks: [[String:Any]] = []
for type in [AVMediaType.video, AVMediaType.audio] {
    guard let track = asset.tracks(withMediaType:type).first else { fail("Missing track") }
    let reader = try AVAssetReader(asset:asset)
    let output = AVAssetReaderTrackOutput(track:track,outputSettings:nil)
    reader.add(output)
    guard reader.startReading() else { fail("Reader start failed") }
    var times: [[String:Any]] = []
    var untimed = 0
    while let sample = output.copyNextSampleBuffer() {
        let count = CMSampleBufferGetNumSamples(sample)
        if count == 0 { untimed += 1; continue }
        for index in 0..<count {
            var timing = CMSampleTimingInfo(duration:.invalid,presentationTimeStamp:.invalid,decodeTimeStamp:.invalid)
            guard CMSampleBufferGetSampleTimingInfo(sample,at:index,timingInfoOut:&timing) == noErr else { fail("Compressed sample timing failed") }
            guard timing.presentationTimeStamp.isValid else { fail("Untimed compressed media sample") }
            var row: [String:Any] = ["pts_ms":timing.presentationTimeStamp.seconds*1000]
            if timing.duration.isValid { row["duration_ms"] = timing.duration.seconds*1000 }
            if timing.decodeTimeStamp.isValid { row["dts_ms"] = timing.decodeTimeStamp.seconds*1000 }
            times.append(row)
        }
    }
    guard reader.status == .completed else { fail("Reader failed") }
    tracks.append(["kind":type == .video ? "video":"audio","sample_timings":times,"untimed_empty_buffers":untimed])
}
let report: [String:Any] = ["schema_version":1,"recording":URL(fileURLWithPath:args[1]).lastPathComponent,
    "reader":"AVFoundation compressed samples; no decoding","tracks":tracks]
try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:args[2]))
