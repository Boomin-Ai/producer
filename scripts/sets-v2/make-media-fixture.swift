import Foundation
import AVFoundation
import CoreVideo
import AppKit

// Synthetic media only: no device permissions, network or user photos.
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 320, pixelsHigh: 180,
                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                            isPlanar: false, colorSpaceName: .deviceRGB,
                            bytesPerRow: 320 * 4, bitsPerPixel: 32)!
let bytes = image.bitmapData!
for y in 0..<180 { for x in 0..<320 {
    let i = y * image.bytesPerRow + x * 4
    bytes[i] = x < 160 ? 255 : 0
    bytes[i+1] = x < 160 ? 0 : 255
    bytes[i+2] = 255
    bytes[i+3] = 255
}}
try image.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("topic.png"))
let url = directory.appendingPathComponent("clip.mp4")
if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 700_000]
])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:]
])
writer.add(input)
guard writer.startWriting() else { fatalError(String(describing: writer.error)) }
writer.startSession(atSourceTime: .zero)
for frame in 0..<60 {
    let deadline = Date().addingTimeInterval(10)
    while !input.isReadyForMoreMediaData {
        guard Date() < deadline, writer.status == .writing else { fatalError("Writer stalled: \(String(describing: writer.error))") }
        Thread.sleep(forTimeInterval: 0.002)
    }
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer) == kCVReturnSuccess, let buffer else { fatalError("Pixel buffer") }
    CVPixelBufferLockBaseAddress(buffer, [])
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    for y in 0..<180 { for x in 0..<320 {
        let i = y * stride + x * 4
        let bright = abs(x - frame * 5 % 320) < 22
        base[i] = bright ? 255 : 20
        base[i+1] = bright ? 255 : 210
        base[i+2] = bright ? 255 : 30
        base[i+3] = 255
    }}
    CVPixelBufferUnlockBaseAddress(buffer, [])
    guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else { fatalError("Append failed") }
}
input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
guard finished.wait(timeout: .now() + 20) == .success, writer.status == .completed else { fatalError("Finalize failed: \(String(describing: writer.error))") }
print("Synthetic PNG and H.264 fixtures generated")
