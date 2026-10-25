// Supplemental generated-tone diagnostics. Does not change recording acceptance.
import Foundation
import AVFoundation
func fail(_ s: String) -> Never { fputs(s + "\n", stderr); exit(1) }
let args = CommandLine.arguments
guard args.count == 4 else { fail("Usage: analyze-partial-tone.swift recording numbered.json output.json") }
let numbered = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [String: Any]
let pairs = numbered["pairs"] as! [[String: Any]]
let paired = Set(pairs.compactMap { $0["id"] as? Int })
let markers = numbered["video_markers"] as! [[String: Any]]
let lost = markers.filter { !paired.contains($0["id"] as! Int) }
let ids = Set(lost.flatMap { [$0["id"] as! Int, ($0["id"] as! Int)-1] })
let selected = markers.filter { ids.contains($0["id"] as! Int) }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let track = asset.tracks(withMediaType: .audio).first else { fail("No audio track") }
var rows = [[String: Any]]()
for marker in selected {
    let id = marker["id"] as! Int, center = marker["pts_ms"] as! Double
    let start = max(0, center/1000 - 0.15)
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 48000), duration: CMTime(seconds: 0.3, preferredTimescale: 48000))
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey:kAudioFormatLinearPCM, AVSampleRateKey:48000, AVNumberOfChannelsKey:1, AVLinearPCMBitDepthKey:16, AVLinearPCMIsFloatKey:false, AVLinearPCMIsBigEndianKey:false, AVLinearPCMIsNonInterleaved:false])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { fail("Cannot add decoder") }
    reader.add(output)
    guard reader.startReading() else { fail("Cannot start decode") }
    var pcm = [Int16](), firstPTS: Double?
    while let sample = output.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { fail("Missing PCM") }
        let count = CMBlockBufferGetDataLength(block)
        guard count % 2 == 0, pcm.count + count/2 <= 48000 else { fail("Invalid or unbounded PCM window") }
        if firstPTS == nil { firstPTS = CMSampleBufferGetPresentationTimeStamp(sample).seconds * 1000 }
        var values = [Int16](repeating:0, count:count/2)
        let status = values.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset:0, dataLength:count, destination:$0.baseAddress!) }
        guard status == kCMBlockBufferNoErr else { fail("PCM copy failed") }
        pcm.append(contentsOf: values)
    }
    guard reader.status == .completed, pcm.count >= 480 else { fail("Decode failed or insufficient PCM") }
    var peak = 0.0, peakOffset = 0
    // Shift ten-millisecond RMS windows by one millisecond, diagnostic only.
    for offset in stride(from:0, through:pcm.count-480, by:48) {
        let rms = sqrt(pcm[offset..<offset+480].reduce(0.0) { $0 + Double($1)*Double($1) }/480)
        if rms > peak { peak = rms; peakOffset = offset }
    }
    var energies = [Double]()
    for tone in 0..<16 {
        let coefficient = 2*cos(2*Double.pi*Double(997+128*tone)/48000)
        var previous = 0.0, before = 0.0
        for value in pcm[peakOffset..<peakOffset+480] {
            let next = Double(value) + coefficient*previous - before
            before = previous; previous = next
        }
        energies.append(max(0, previous*previous + before*before - coefficient*previous*before))
    }
    let ranking = energies.enumerated().sorted { $0.element > $1.element }
    rows.append(["label":id,"paired_by_original_detector":paired.contains(id),"video_pts_ms":center,"search_radius_ms":150,"peak_10ms_rms":peak,"peak_window_pts_ms":(firstPTS ?? 0)+Double(peakOffset)/48,"peak_tone_id_mod16":ranking[0].offset,"expected_tone_id_mod16":id%16,"tone_confidence_ratio":ranking[0].element/max(1,ranking[1].element)])
}
let report: [String: Any] = ["decoder":"AVFoundation","supplemental_diagnostics_only":true,"acceptance_threshold_changed":false,"recording_acceptance_overridden":false,"windows":rows,"scope":"Unpaired video markers and preceding matched controls. Rolling RMS diagnostics do not redefine the original numbered-recording gate."]
try JSONSerialization.data(withJSONObject: report, options:[.prettyPrinted,.sortedKeys]).write(to: URL(fileURLWithPath:args[3]))
print("Supplemental tone windows:",rows.count)
