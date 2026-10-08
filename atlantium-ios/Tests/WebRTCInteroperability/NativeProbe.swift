import Foundation
import LiveKitWebRTC
@MainActor final class Probe: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {
    let factory = LKRTCPeerConnectionFactory(encoderFactory: LKRTCDefaultVideoEncoderFactory(), decoderFactory: LKRTCDefaultVideoDecoderFactory())
    var peer: LKRTCPeerConnection!
    var channel: LKRTCDataChannel!
    var gathered = false
    var echoed = false
    var tracks = Set<String>()
    func run() async throws {
        let config = LKRTCConfiguration(); config.sdpSemantics = .unifiedPlan
        if let json = ProcessInfo.processInfo.environment["ICE_JSON"] {
            let servers = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]]
            config.iceTransportPolicy = .relay
            config.iceServers = servers.map { LKRTCIceServer(urlStrings: $0["urls"] as! [String], username: $0["username"] as? String, credential: $0["credential"] as? String) }
        }
        peer = factory.peerConnection(with: config, constraints: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
        let receiver = LKRTCRtpTransceiverInit(); receiver.direction = .recvOnly
        _ = peer.addTransceiver(of: .audio, init: receiver)
        _ = peer.addTransceiver(of: .video, init: receiver)
        channel = peer.dataChannel(forLabel: "interop", configuration: LKRTCDataChannelConfiguration()); channel.delegate = self
        let offer: LKRTCSessionDescription = try await withCheckedThrowingContinuation { continuation in peer.offer(for: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { value, error in if let value { continuation.resume(returning: value) } else { continuation.resume(throwing: error ?? NSError(domain: "offer", code: 1)) } } }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in peer.setLocalDescription(offer) { error in if let error { c.resume(throwing: error) } else { c.resume() } } }
        for _ in 0..<300 { if gathered { break }; try await Task.sleep(for: .milliseconds(100)) }
        guard gathered else { throw NSError(domain: "gather timeout", code: 1) }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8894/offer")!); request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["type": "offer", "sdp": peer.localDescription!.sdp])
        let (data, _) = try await URLSession.shared.data(for: request)
        let answer = try JSONSerialization.jsonObject(with: data) as! [String: String]
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in peer.setRemoteDescription(LKRTCSessionDescription(type: .answer, sdp: answer["sdp"]!)) { error in if let error { c.resume(throwing: error) } else { c.resume() } } }
        for _ in 0..<200 { if echoed && tracks == ["audio", "video"] { break }; try await Task.sleep(for: .milliseconds(100)) }
        guard echoed, tracks == ["audio", "video"] else { throw NSError(domain: "native/browser media negotiation or transport failed", code: 1) }
        try await Task.sleep(for: .seconds(2))
        let report: LKRTCStatisticsReport = await withCheckedContinuation { continuation in peer.statistics { continuation.resume(returning: $0) } }
        let media = Set(report.statistics.values.filter { $0.type == "inbound-rtp" && (($0.values["bytesReceived"] as? NSNumber)?.intValue ?? 0) > 0 }.compactMap { $0.values["kind"] as? String })
        guard media == ["audio", "video"] else { throw NSError(domain: "Actual RTP media missing: \(media)", code: 1) }
        peer.close(); print("PASS native WebRTC ↔ Chrome SDP/ICE/DTLS, received audio/video RTP bytes, bidirectional data transport")
    }
    nonisolated func dataChannelDidChangeState(_ channel: LKRTCDataChannel) { if channel.readyState == .open { _ = channel.sendData(LKRTCDataBuffer(data: Data("native-ping".utf8), isBinary: false)) } }
    nonisolated func dataChannel(_ channel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) { Task { @MainActor in self.echoed = String(decoding: buffer.data, as: UTF8.self) == "browser-pong" } }
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCIceGatheringState) { Task { @MainActor in self.gathered = state == .complete } }
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didAdd receiver: LKRTCRtpReceiver, streams: [LKRTCMediaStream]) { if let kind = receiver.track?.kind { Task { @MainActor in self.tracks.insert(kind) } } }
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCSignalingState) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCPeerConnectionState) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCIceConnectionState) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peer: LKRTCPeerConnection) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didOpen channel: LKRTCDataChannel) {}
}
@main struct Main { static func main() async throws { try await Probe().run() } }
