// Same decoded frames and 768-pixel analysis budget as the live cutout.
// Usage: swift scripts/benchmark-cutout.swift VIDEO OUTPUT_DIR [FRAME_COUNT]
import Foundation
import AVFoundation
import Vision
import CoreImage
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
guard CommandLine.arguments.count >= 3 else { fail("Usage: swift scripts/benchmark-cutout.swift VIDEO OUTPUT_DIR [FRAME_COUNT]") }
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let count = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3]) ?? 60 : 60
guard count > 0 && count <= 600 else { fail("FRAME_COUNT must be 1...600") }
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let asset = AVURLAsset(url: input)
guard let track = asset.tracks(withMediaType: .video).first else { fail("Input has no video track") }
let reader = try AVAssetReader(asset: asset)
let decoded = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(decoded)
guard reader.startReading() else { fail(reader.error?.localizedDescription ?? "Decode failed") }
let context = CIContext()
var frames: [CVPixelBuffer] = []
var original: CIImage?
while frames.count < count, let sample = decoded.copyNextSampleBuffer(), let pb = CMSampleBufferGetImageBuffer(sample) {
    let image = CIImage(cvPixelBuffer: pb).transformed(by: track.preferredTransform)
    let normalized = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
    let scale = min(1, 768 / max(normalized.extent.width, normalized.extent.height))
    let small = normalized.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let w = Int(small.extent.width), h = Int(small.extent.height)
    var buffer: CVPixelBuffer?
    guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer) == kCVReturnSuccess, let buffer else { fail("Buffer allocation failed") }
    context.render(small, to: buffer)
    frames.append(buffer)
    original = small
}
if reader.status == .failed { fail(reader.error?.localizedDescription ?? "Decode failed") }
guard !frames.isEmpty else { fail("No frames decoded") }
reader.cancelReading()
func png(_ image: CIImage, _ filename: String) throws {
    guard let cg = context.createCGImage(image, from: image.extent) else { fail("Image conversion failed") }
    let bitmap = NSBitmapImageRep(cgImage: cg)
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fail("PNG encoding failed") }
    try data.write(to: output.appendingPathComponent(filename))
}
var report: [[String: Any]] = []
var csv = "quality,frame,inference_ms,mask_width,mask_height\n"
let modes: [(String, VNGeneratePersonSegmentationRequest.QualityLevel)] = [("balanced", .balanced), ("accurate", .accurate)]
if #available(macOS 12, *) {
    for (name, quality) in modes {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = quality
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        if let revision = VNGeneratePersonSegmentationRequest.supportedRevisions.last { request.revision = revision }
        var durations: [Double] = []
        var finalMask: CIImage?
        for (index, frame) in frames.enumerated() {
            try autoreleasepool {
                let handler = VNImageRequestHandler(cvPixelBuffer: frame, options: [:])
                let start = ProcessInfo.processInfo.systemUptime
                try handler.perform([request])
                let ms = (ProcessInfo.processInfo.systemUptime - start) * 1000
                guard let mask = request.results?.first?.pixelBuffer else { fail("Vision returned no mask") }
                durations.append(ms)
                csv += "\(name),\(index),\(ms),\(CVPixelBufferGetWidth(mask)),\(CVPixelBufferGetHeight(mask))\n"
                let image = CIImage(cvPixelBuffer: mask)
                let scaled = image.transformed(by: CGAffineTransform(scaleX: CGFloat(CVPixelBufferGetWidth(frame)) / image.extent.width, y: CGFloat(CVPixelBufferGetHeight(frame)) / image.extent.height))
                if index == frames.count - 1 { finalMask = scaled }
                if index % 15 == 0 || index == frames.count - 1 {
                    let foreground = CIImage(cvPixelBuffer: frame)
                    let bg = CIImage(color: CIColor(red: 0.18, green: 0.12, blue: 0.28)).cropped(to: foreground.extent)
                    let composite = foreground.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: bg, kCIInputMaskImageKey: scaled])
                    try png(composite, "\(name)-\(index)-cutout.png")
                }
            }
        }
        // First inference includes cold start; report it separately.
        let steady = Array(durations.dropFirst()).sorted()
        func percentile(_ fraction: Double) -> Double { steady.isEmpty ? durations[0] : steady[min(steady.count - 1, Int(Double(steady.count - 1) * fraction))] }
        let mean = steady.isEmpty ? durations[0] : steady.reduce(0, +) / Double(steady.count)
        report.append(["quality": name, "frames": frames.count, "cold_ms": durations[0], "steady_mean_ms": mean, "p50_ms": percentile(0.5), "p95_ms": percentile(0.95), "inference_only_hz": 1000 / mean])
        if let finalMask { try png(finalMask, "\(name)-mask.png") }
        print("\(name): cold \(Int(durations[0])) ms, steady mean \(Int(mean)) ms, p95 \(Int(percentile(0.95))) ms")
    }
} else { fail("Apple Vision person segmentation requires macOS 12+") }
if let original { try png(original, "source.png") }
try Data(csv.utf8).write(to: output.appendingPathComponent("frames.csv"))
let summary: [String: Any] = ["analysis_max_edge": 768, "frames": frames.count, "results": report, "scope": "Inference only on predecoded frames. Excludes live capture, analysis ring delay, compositing, encoding, and multi-camera contention. Cutouts use raw alpha with no feather/erode."]
try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("summary.json"))
