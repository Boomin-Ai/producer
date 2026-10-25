// Synthetic numbered flashes and matching tones; never opens capture devices.
import Foundation
import AVFoundation
import CoreVideo
import AudioToolbox

func require(_ condition: Bool, _ message: String) {
    if !condition { fputs(message + "\n", stderr); exit(1) }
}
require(CommandLine.arguments.count == 2, "Usage: generate-program-av.swift <private-output.mov>")
let output = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.removeItem(at: output)
let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_000_000, AVVideoMaxKeyFrameIntervalKey: 30]
])
let pixels = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180
])
var asbd = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
    mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2,
    mBitsPerChannel: 16, mReserved: 0)
var audioFormat: CMAudioFormatDescription?
require(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd,
    layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
    formatDescriptionOut: &audioFormat) == noErr, "Audio format creation failed")
let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: audioFormat)
require(writer.canAdd(video) && writer.canAdd(audio), "Synthetic encoder inputs unavailable")
writer.add(video); writer.add(audio)
require(writer.startWriting(), "Synthetic writer failed")
writer.startSession(atSourceTime: .zero)
let writing = DispatchGroup()
writing.enter(); writing.enter()
var audioTick = 0
var audioFinished = false
var videoFrame = 0
var videoFinished = false
audio.requestMediaDataWhenReady(on: DispatchQueue(label: "synthetic-av-audio")) {
    while audio.isReadyForMoreMediaData && audioTick < 12800 {
    let tick = audioTick
    var pcm = [Int16](repeating: 0, count: 960)
    for index in 0..<480 {
        let sample = tick * 480 + index
        let phase = sample % 96000
        if phase >= 24000 && phase < 28800 {
            let label = (sample / 96000) % 16
            let frequency = 997.0 + 128.0 * Double(label)
            let value = Int16(sin(2 * Double.pi * frequency * Double(sample) / 48000) * 12000)
            pcm[index * 2] = value; pcm[index * 2 + 1] = value
        }
    }
    var block: CMBlockBuffer?
    require(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
        blockLength: pcm.count * 2, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: pcm.count * 2, flags: 0, blockBufferOut: &block) == noErr,
        "Synthetic PCM allocation failed")
    require(pcm.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: $0.count) } == noErr,
        "Synthetic PCM copy failed")
    var sampleBuffer: CMSampleBuffer?
    require(CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault,
        dataBuffer: block!, formatDescription: audioFormat!, sampleCount: 480,
        presentationTimeStamp: CMTime(value: Int64(tick * 480), timescale: 48000),
        packetDescriptions: nil, sampleBufferOut: &sampleBuffer) == noErr,
        "Synthetic audio sample creation failed")
    require(audio.append(sampleBuffer!), "Synthetic audio encoding failed")
    audioTick += 1
    }
    if audioTick == 12800 && !audioFinished {
        audioFinished = true; audio.markAsFinished(); writing.leave()
    }
}
video.requestMediaDataWhenReady(on: DispatchQueue(label: "synthetic-av-video")) {
    while video.isReadyForMoreMediaData && videoFrame < 3840 {
        var image: CVPixelBuffer?
        require(CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pixels.pixelBufferPool!, &image) == kCVReturnSuccess, "Synthetic image allocation failed")
        CVPixelBufferLockBaseAddress(image!, [])
        let bytes = CVPixelBufferGetBaseAddress(image!)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(image!)
        let label = videoFrame / 60
        let phase = videoFrame % 60
        let active = phase >= 15 && phase < 18
        for y in 0..<180 { for x in 0..<320 {
            let white = active && (y >= 16 || (label & (1 << (x / 40))) != 0)
            let value: UInt8 = white ? 255 : 0
            let at = y * stride + x * 4
            bytes[at] = value; bytes[at + 1] = value; bytes[at + 2] = value; bytes[at + 3] = 255
        } }
        CVPixelBufferUnlockBaseAddress(image!, [])
        require(pixels.append(image!, withPresentationTime: CMTime(value: Int64(videoFrame), timescale: 30)), "Synthetic video encoding failed")
        videoFrame += 1
    }
    if videoFrame == 3840 && !videoFinished {
        videoFinished = true; video.markAsFinished(); writing.leave()
    }
}
writing.wait()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
require(writer.status == .completed, "Synthetic movie finalization failed")
print("Generated 128-second numbered flash/tone fixture; camera and microphone unused")
