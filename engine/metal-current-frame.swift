// Compiled with the pinned libobs-metal sources. The C entry point is optional:
// Producer keeps its previous-frame path when an older engine lacks it.
import Metal

private final class ProducerCopyCompletion: @unchecked Sendable {
    let callback: @convention(c) (UnsafeMutableRawPointer?, Int32) -> Void
    let context: UnsafeMutableRawPointer?
    // Keep both textures alive until the GPU copy finishes, including teardown.
    let source: MTLTexture
    let destination: MTLTexture

    init(callback: @escaping @convention(c) (UnsafeMutableRawPointer?, Int32) -> Void,
         context: UnsafeMutableRawPointer?, source: MTLTexture, destination: MTLTexture) {
        self.callback = callback
        self.context = context
        self.source = source
        self.destination = destination
    }

    func complete(_ command: MTLCommandBuffer) {
        withExtendedLifetime((source, destination)) {
            callback(context, command.status == .completed ? 1 : 0)
        }
    }
}

// Graphics thread only. The source is a gs_texture_t / MetalTexture wrapper;
// destination is an unretained id<MTLTexture> owned by the caller's pixel buffer.
// true promises exactly one asynchronous callback; false promises no callback.
@_cdecl("producer_metal_copy_texture_async_v1")
public func producer_metal_copy_texture_async_v1(
    source: UnsafeRawPointer,
    destination: UnsafeRawPointer,
    context: UnsafeMutableRawPointer?,
    callback: @escaping @convention(c) (UnsafeMutableRawPointer?, Int32) -> Void
) -> Bool {
    let source: MetalTexture = unretained(source)
    let destination: MTLTexture = Unmanaged<AnyObject>.fromOpaque(destination).takeUnretainedValue() as! MTLTexture
    guard let device = source.device,
          source.texture.width == destination.width,
          source.texture.height == destination.height,
          source.texture.pixelFormat == destination.pixelFormat,
          device.device.registryID == destination.device.registryID,
          let copy = device.commandQueue.makeCommandBuffer(),
          let encoder = copy.makeBlitCommandEncoder() else {
        return false
    }

    // Commit the current draw before placing the copy on the SAME queue.
    // Queue ordering provides the dependency; no waitUntilCompleted here.
    device.finishPendingCommands()
    encoder.copy(from: source.texture, to: destination)
    encoder.endEncoding()
    let completion = ProducerCopyCompletion(callback: callback, context: context,
                                           source: source.texture, destination: destination)
    copy.addCompletedHandler { command in completion.complete(command) }
    copy.commit()
    return true
}
