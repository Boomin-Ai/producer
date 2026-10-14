// Decode generated IDs from the actual native OBS MP4, never browser callbacks.
import Foundation
import AVFoundation
import CoreVideo

func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
func reader(_ asset: AVAsset, _ track: AVAssetTrack, _ settings: [String: Any]) throws -> (AVAssetReader, AVAssetReaderTrackOutput) {
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { fail("Cannot add decoder output") }
    reader.add(output)
    guard reader.startReading() else { fail("Decoder failed") }
    return (reader, output)
}
struct Marker { let id: Int; let pts: Double; let confidence: Double }
func percentile(_ values: [Double], _ q: Double) -> Double? {
    let sorted = values.sorted()
    return sorted.isEmpty ? nil : sorted[Int(ceil(Double(sorted.count) * q)) - 1]
}
func toneId(_ pcm: [Int16]) -> (Int, Double) {
    var energies: [Double] = []
    for id in 0..<16 {
        let coefficient = 2 * cos(2 * Double.pi * (997 + 128 * Double(id)) / 48000)
        var previous = 0.0, before = 0.0
        for sample in pcm { let current = Double(sample) + coefficient * previous - before; before = previous; previous = current }
        energies.append(max(0, previous * previous + before * before - coefficient * previous * before))
    }
    let ordered = energies.indices.sorted { energies[$0] > energies[$1] }
    return (ordered[0], energies[ordered[0]] / max(energies[ordered[1]], 1))
}
let args = CommandLine.arguments
guard args.count == 3 else { fail("Usage: swift analyze-numbered-recording.swift <mp4> <evidence-json>") }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let videoTrack = asset.tracks(withMediaType: .video).first, let audioTrack = asset.tracks(withMediaType: .audio).first else { fail("Recording needs video/audio") }
var video: [Marker] = [], audio: [Marker] = [], videoFrames = 0, audioSamples = 0
var videoActive = false
let (videoReader, videoOutput) = try reader(asset, videoTrack, [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
while let sample = videoOutput.copyNextSampleBuffer() {
    guard let image = CMSampleBufferGetImageBuffer(sample) else { fail("Missing pixels") }
    CVPixelBufferLockBaseAddress(image, .readOnly)
    let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
    guard width >= 320, height >= 180, width * 9 == height * 16,
          let bytes = CVPixelBufferGetBaseAddress(image)?.assumingMemoryBound(to: UInt8.self) else { fail("Expected generated 16:9 recording") }
    let stride = CVPixelBufferGetBytesPerRow(image)
    let active = bytes[(height / 2) * stride + (width / 2) * 4] > 180
    if active && !videoActive {
        var id = 0
        for bit in 0..<8 { if bytes[(height * 8 / 180) * stride + ((bit * 40 + 20) * width / 320) * 4] > 180 { id |= 1 << bit } }
        video.append(Marker(id: id, pts: CMSampleBufferGetPresentationTimeStamp(sample).seconds * 1000, confidence: 1))
    }
    videoActive = active; videoFrames += 1
    CVPixelBufferUnlockBaseAddress(image, .readOnly)
}
guard videoReader.status == .completed else { fail("Video decode failed") }
let (audioReader, audioOutput) = try reader(asset, audioTrack, [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
var window: [Int16] = [], pulse: [Int16] = [], windowPTS = 0.0, pulsePTS = 0.0, priorEnd: Double?
var pulseActive = false, audioDiscontinuities = 0, uncertainTones = 0
func finishPulse() {
    if !pulse.isEmpty {
        let (id, confidence) = toneId(pulse)
        if confidence >= 2 { audio.append(Marker(id: id, pts: pulsePTS, confidence: confidence)) } else { uncertainTones += 1 }
    }
    pulse.removeAll(keepingCapacity: true); pulseActive = false
}
while let sample = audioOutput.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { fail("Missing PCM") }
    let length = CMBlockBufferGetDataLength(block)
    guard length % 2 == 0 else { fail("Unaligned PCM") }
    var pcm = [Int16](repeating: 0, count: length / 2)
    let copied = pcm.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
    guard copied == kCMBlockBufferNoErr else { fail("PCM copy failed") }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds * 1000
    if let end = priorEnd, abs(pts - end) > 2 { audioDiscontinuities += 1; finishPulse(); window.removeAll(keepingCapacity: true) }
    for (index, value) in pcm.enumerated() {
        if window.isEmpty { windowPTS = pts + Double(index) / 48 }
        window.append(value)
        if window.count == 480 {
            let rms = sqrt(window.reduce(0.0) { $0 + Double($1) * Double($1) } / 480)
            if rms > 2000 {
                if !pulseActive { pulsePTS = windowPTS; pulseActive = true }
                guard pulse.count + window.count <= 48000 else { fail("Generated tone exceeded one-second bound") }
                pulse.append(contentsOf: window)
            } else if pulseActive { finishPulse() }
            window.removeAll(keepingCapacity: true)
        }
    }
    audioSamples += pcm.count; priorEnd = pts + Double(pcm.count) / 48
}
finishPulse()
guard audioReader.status == .completed else { fail("Audio decode failed") }
// Collapse same-ID codec threshold recrossings within the declared pulse envelope.
func collapse(_ markers: [Marker]) -> [Marker] {
    var result: [Marker] = []
    for marker in markers { if let previous = result.last, marker.id == previous.id, marker.pts - previous.pts < 150 { continue }; result.append(marker) }
    return result
}
let rawAudio = audio.count, rawVideo = video.count
audio = collapse(audio); video = collapse(video)
var used = Set<Int>(), pairs: [[String: Any]] = []
for sound in audio {
    let candidates = video.indices.filter { !used.contains($0) && video[$0].id % 16 == sound.id && abs(video[$0].pts - sound.pts) < 1000 }
    if let index = candidates.min(by: { abs(video[$0].pts - sound.pts) < abs(video[$1].pts - sound.pts) }) {
        used.insert(index); pairs.append(["id": video[index].id, "audio_pts_ms": sound.pts, "video_pts_ms": video[index].pts, "video_minus_audio_ms": video[index].pts - sound.pts])
    }
}
let offsets = pairs.map { $0["video_minus_audio_ms"] as! Double }
var regressions = 0, repetitions = 0
for index in 1..<max(video.count, 1) {
    let step = (video[index].id - video[index - 1].id + 256) % 256
    if step == 0 { repetitions += 1 } else if step >= 128 { regressions += 1 }
}
let labels = Set(video.map { $0.id })
let expectedSpan = (video.first != nil && video.last!.id >= video.first!.id) ? Array(video.first!.id...video.last!.id) : []
let report: [String: Any] = ["decoder": "macOS AVFoundation", "recording": URL(fileURLWithPath: args[1]).lastPathComponent, "duration_seconds": asset.duration.seconds,
    "video_frames": videoFrames, "audio_samples": audioSamples, "video_markers": video.map { ["id": $0.id, "pts_ms": $0.pts] as [String: Any] }, "audio_markers": audio.map { ["id_mod16": $0.id, "pts_ms": $0.pts, "tone_confidence_ratio": $0.confidence] as [String: Any] },
    "raw_audio_crossings": rawAudio, "raw_video_crossings": rawVideo, "uncertain_tones": uncertainTones, "audio_pts_discontinuities": audioDiscontinuities,
    "pairs": pairs, "unmatched_audio": audio.count - pairs.count, "unmatched_video": video.count - used.count, "missing_video_labels_within_observed_span": expectedSpan.filter { !labels.contains($0) },
    "repeated_video_labels": repetitions, "regressed_video_labels": regressions, "absolute_p95_ms": percentile(offsets.map(abs), 0.95) as Any? ?? NSNull(),
    "local_numbered_marker_gate_passed": pairs.count >= 5 && audio.count == pairs.count && video.count == pairs.count && regressions == 0 && repetitions == 0 && uncertainTones == 0 && (percentile(offsets.map(abs), 0.95) ?? .infinity) <= 80,
    "source_paint_uncertainty_ms": 1000.0 / 30, "audio_detector_window_ms": 10, "startup_and_tail_loss_qualified": false, "lip_sync_qualified": false, "g1_complete": false]
try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: args[2]))
print("Native numbered recording: \(pairs.count) pairs, p95 \(percentile(offsets.map(abs), 0.95) ?? -1) ms, \(regressions) old labels")
