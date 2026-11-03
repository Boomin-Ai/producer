// Inspect a desktop acceptance recording using the system decoder, not its preview.
// Usage: swift inspect-authoring-recording.swift FILE WIDTH HEIGHT FRAME.png
import Foundation
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 5, let width = Int(args[2]), let height = Int(args[3]) else {
    fatalError("Expected FILE WIDTH HEIGHT FRAME.png")
}
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let video = asset.tracks(withMediaType: .video).first,
      let audio = asset.tracks(withMediaType: .audio).first else {
    fatalError("Recording must contain video and audio tracks")
}
let duration = CMTimeGetSeconds(asset.duration)
var failures: [String] = []
if Int(video.naturalSize.width) != width || Int(video.naturalSize.height) != height { failures.append("Unexpected encoded dimensions") }
if duration < 9 || duration > 16 || abs(video.nominalFrameRate - 30) >= 1 { failures.append("Unexpected encoded duration/cadence") }
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
let frame = try generator.copyCGImage(at: CMTime(seconds: min(5, duration / 2), preferredTimescale: 600), actualTime: nil)
if frame.width != width || frame.height != height { failures.append("Decoded frame does not match canvas") }
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[4]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, frame, nil)
precondition(CGImageDestinationFinalize(destination), "Could not save decoded frame")

let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: audio, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMIsFloatKey: true,
    AVLinearPCMBitDepthKey: 32, AVLinearPCMIsNonInterleaved: false
])
reader.add(output)
precondition(reader.startReading(), "Audio decoder failed to start")
var samples = 0
var energy = 0.0
var peak = 0.0
while let sample = output.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { fatalError("Missing decoded audio data") }
    let size = CMBlockBufferGetDataLength(block)
    var data = Data(count: size)
    let copied = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: $0.baseAddress!) }
    precondition(copied == noErr, "Audio copy failed")
    data.withUnsafeBytes { bytes in
        for offset in stride(from: 0, to: size - 3, by: 4) {
            let value = Double(bytes.loadUnaligned(fromByteOffset: offset, as: Float.self))
            precondition(value.isFinite, "Invalid encoded audio sample")
            samples += 1; energy += value * value; peak = max(peak, abs(value))
        }
    }
}
precondition(reader.status == .completed && samples > 0, "Audio did not decode completely")
if peak <= 0.00001 { failures.append("Audio track is silent; microphone acceptance is incomplete") }
let report: [String: Any] = ["width": video.naturalSize.width, "height": video.naturalSize.height, "fps": video.nominalFrameRate,
    "duration": duration, "decodedAudioSamples": samples, "audioRms": sqrt(energy / Double(samples)),
    "audioPeak": peak, "microphoneSignalEncoded": peak > 0.00001, "decodedFrame": args[4], "failures": failures]
let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write(Data("\n".utf8))
if !failures.isEmpty {
    FileHandle.standardError.write(Data((failures.joined(separator: "; ") + "\n").utf8))
    exit(2)
}
