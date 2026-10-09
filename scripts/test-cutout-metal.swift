// Compile with the pinned libobs-metal sources and engine/metal-current-frame.swift.
// Verifies real GPU draw/copy ordering, an asynchronous handoff and rejection.
import Foundation
import Metal

private final class CopyResult: @unchecked Sendable {
    let ready = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var callbacks = 0
    var success: Int32 = 0

    func receive(_ success: Int32) {
        lock.lock()
        callbacks += 1
        self.success = success
        lock.unlock()
        ready.signal()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return callbacks
    }
}

private func copied(_ context: UnsafeMutableRawPointer?, _ success: Int32) {
    Unmanaged<CopyResult>.fromOpaque(context!).takeUnretainedValue().receive(success)
}

private func clear(_ device: MetalDevice, _ source: MetalTexture, _ red: Double,
                   gate: MTLSharedEvent? = nil) {
    let command = device.commandQueue.makeCommandBuffer()!
    if let gate { command.encodeWaitForEvent(gate, value: 1) }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = source.texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColorMake(red, 0, 0, 1)
    command.makeRenderCommandEncoder(descriptor: pass)!.endEncoding()
    device.renderState.commandBuffer = command
    source.hasPendingWrites = true
    device.renderState.inFlightRenderTargets.insert(source)
}

@main
struct CutoutMetalTest {
    static func main() throws {
        let gpu = MTLCreateSystemDefaultDevice()!
        let device = try MetalDevice(device: gpu)
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: 32, height: 32, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .shared
        let source = MetalTexture(device: device, descriptor: descriptor)!
        let destination = gpu.makeTexture(descriptor: descriptor)!

        for index in 0..<60 {
            let result = CopyResult()
            let gate = index == 0 ? gpu.makeSharedEvent()! : nil
            clear(device, source, index % 2 == 0 ? 1 : 0, gate: gate)
            // Rescue a broken synchronous implementation so the test can fail
            // explicitly rather than hanging on the deliberately gated draw.
            if let gate {
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) { gate.signaledValue = 1 }
            }
            let started = DispatchTime.now().uptimeNanoseconds
            let accepted = producer_metal_copy_texture_async_v1(
                source: UnsafeRawPointer(Unmanaged.passUnretained(source).toOpaque()),
                destination: UnsafeRawPointer(Unmanaged.passUnretained(destination as AnyObject).toOpaque()),
                context: Unmanaged.passUnretained(result).toOpaque(), callback: copied)
            precondition(accepted)
            if let gate {
                precondition(DispatchTime.now().uptimeNanoseconds - started < 500_000_000,
                             "handoff waited for GPU work")
                precondition(result.count == 0, "copy completed before its draw dependency")
                // Rewrite the ring texture immediately AFTER enqueuing the copy.
                clear(device, source, 0.5)
                device.finishPendingCommands()
                gate.signaledValue = 1
            }
            precondition(result.ready.wait(timeout: .now() + 5) == .success)
            precondition(result.count == 1 && result.success == 1)
            var pixels = [UInt8](repeating: 0, count: 32 * 32 * 4)
            pixels.withUnsafeMutableBytes {
                destination.getBytes($0.baseAddress!, bytesPerRow: 32 * 4,
                                     from: MTLRegionMake2D(0, 0, 32, 32), mipmapLevel: 0)
            }
            let expected: UInt8 = index % 2 == 0 ? 255 : 0
            precondition(stride(from: 0, to: pixels.count, by: 4).allSatisfy {
                pixels[$0] == 0 && pixels[$0 + 1] == 0 && pixels[$0 + 2] == expected && pixels[$0 + 3] == 255
            }, "copy saw stale or overwritten pixels at iteration \(index)")
        }

        let rejected = CopyResult()
        let wrong = gpu.makeTexture(descriptor: MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: 16, height: 16, mipmapped: false))!
        precondition(!producer_metal_copy_texture_async_v1(
            source: UnsafeRawPointer(Unmanaged.passUnretained(source).toOpaque()),
            destination: UnsafeRawPointer(Unmanaged.passUnretained(wrong as AnyObject).toOpaque()),
            context: Unmanaged.passUnretained(rejected).toOpaque(), callback: copied))
        precondition(rejected.count == 0)
        print("PASS: 60 GPU draw/copy frames; no render-thread wait; copy precedes ring overwrite; mismatch rejects without callback")
    }
}
