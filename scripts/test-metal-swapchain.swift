// Compiled with the actual pinned backend; Thread Sanitizer must reject the
// unpatched reference access and accept the synchronized implementation.
import Foundation
import Metal

private final class SharedSwapchain: @unchecked Sendable {
    let chain: OBSSwapChain
    let texture: MetalTexture
    init(_ device: MetalDevice) {
        chain = OBSSwapChain(device: device, size: MTLSize(width:32,height:32,depth:1),colorSpace:GS_BGRA)!
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat:.bgra8Unorm,width:32,height:32,mipmapped:false)
        descriptor.usage = [.renderTarget,.shaderRead]
        texture = MetalTexture(device:device,descriptor:descriptor)!
    }
}
@main struct SwapchainLifetimeTest {
    static func main() throws {
        let device = try MetalDevice(device:MTLCreateSystemDefaultDevice()!)
        let shared = SharedSwapchain(device), started = DispatchSemaphore(value:0), finished = DispatchGroup()
        finished.enter()
        DispatchQueue.global().async {
            started.signal()
            for _ in 0..<100_000 {
                if let target = shared.chain.renderTarget { _ = target.texture.width }
                _ = shared.chain.discard
            }
            finished.leave()
        }
        started.wait()
        for index in 0..<100_000 {
            shared.chain.renderTarget = index % 2 == 0 ? shared.texture : nil
            shared.chain.discard = index % 2 == 0
        }
        finished.wait()
        shared.chain.renderTarget = nil
        print("PASS: 100000 concurrent swapchain target publications and retained reads")
    }
}
