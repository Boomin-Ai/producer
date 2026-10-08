import SwiftUI
import AVFoundation
import LiveKitWebRTC

@MainActor final class PeerCallController: NSObject, ObservableObject {
    @Published var status = "Connecting…"
    @Published var error = ""
    @Published var microphone = true
    @Published var camera = false
    @Published var localVideo: LKRTCVideoTrack?
    @Published var remoteVideos: [String: LKRTCVideoTrack] = [:]
    @Published var connectedPeers: Set<String> = []
    @Published var ended = false
    @Published var ready = false
    // Use LiveKit's managed audio engine so AVAudioSession, capture, and remote
    // playout are started together. The platform-default ADM can negotiate video
    // successfully while leaving both sides of a call silent on iOS.
    private let factory = LKRTCPeerConnectionFactory(audioDeviceModuleType: .audioEngine, bypassVoiceProcessing: false, encoderFactory: LKRTCDefaultVideoEncoderFactory(), decoderFactory: LKRTCDefaultVideoDecoderFactory(), audioProcessingModule: nil)
    private var audio: LKRTCAudioTrack?
    private var capturer: LKRTCCameraVideoCapturer?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var peers: [String: LKRTCPeerConnection] = [:]
    private var pendingICE: [String: [LKRTCIceCandidate]] = [:]
    private var iceServers: [LKRTCIceServer] = []
    private var started = false
    private var generation = UUID()

    func start(threadID: String, video: Bool, announce: Bool) async {
        guard !started else { return }; started = true
        let attempt = generation
        do {
            let allowed = await AVCaptureDevice.requestAccess(for: .audio)
            guard generation == attempt else { return }
            guard allowed else { throw APIError(message: "Allow microphone access in Settings to make a call.") }
            if video {
                let cameraAllowed = await AVCaptureDevice.requestAccess(for: .video)
                guard generation == attempt else { return }
                guard cameraAllowed else { throw APIError(message: "Allow camera access in Settings to make a video call.") }
            }
            let ticket = try await API.shared.call("threads/" + threadID + "/media-ticket", method: "POST")
            guard generation == attempt else { return }
            guard var components = URLComponents(string: ticket["websocket_url"].text),
                  components.scheme == "wss", components.host == NativeRoutes.base.host,
                  !ticket["ticket"].text.isEmpty else { throw APIError(message: "The call connection is unavailable.") }
            components.queryItems = [URLQueryItem(name: "ticket", value: ticket["ticket"].text)]
            guard let url = components.url else { throw APIError(message: "The call connection is unavailable.") }
            iceServers = ticket["ice_servers"].list.map { server in
                let urls = server["urls"].list.map(\.text)
                return LKRTCIceServer(urlStrings: urls.isEmpty ? [server["urls"].text] : urls, username: server["username"].text, credential: server["credential"].text)
            }
            try configureAudio()
            audio = factory.audioTrack(withTrackId: "audio-" + UUID().uuidString)
            let source = factory.videoSource()
            localVideo = factory.videoTrack(with: source, trackId: "video-" + UUID().uuidString)
            capturer = LKRTCCameraVideoCapturer(delegate: source)
            localVideo?.isEnabled = false
            if video { try await setCamera(true) }
            guard generation == attempt else { return }
            var request = URLRequest(url: url)
            request.setValue("https://atlantium.ai", forHTTPHeaderField: "Origin")
            socket = API.shared.session.webSocketTask(with: request)
            socket?.resume()
            receiveTask = Task { [weak self] in await self?.receive() }
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(90))
                guard !Task.isCancelled, let self, self.connectedPeers.isEmpty else { return }
                self.fail("No one joined the call. You can try again from the conversation.")
            }
            if announce {
                _ = try await API.shared.call("threads/" + threadID + "/messages", method: "POST", body: ["body": CallInvitation.message])
            }
        } catch { if generation == attempt { fail(error.localizedDescription) } }
    }
    private func configureAudio() throws {
        let rtcAudio = LKRTCAudioSession.sharedInstance()
        rtcAudio.lockForConfiguration()
        defer { rtcAudio.unlockForConfiguration() }
        try rtcAudio.setCategory(AVAudioSession.Category.playAndRecord, with: [.defaultToSpeaker, .allowBluetooth])
        try rtcAudio.setMode(AVAudioSession.Mode.voiceChat)
        if !rtcAudio.isActive { try rtcAudio.setActive(true) }
        rtcAudio.useManualAudio = false
        rtcAudio.isAudioEnabled = true
    }
    private func receive() async {
        do {
            while !Task.isCancelled, let socket {
                let incoming = try await socket.receive()
                let data: Data
                switch incoming { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
                let signal = try JSONDecoder().decode(APIValue.self, from: data)
                try await handle(signal)
            }
        } catch { if !Task.isCancelled && !ended { fail("The call connection was lost. Please try again.") } }
    }
    private func handle(_ signal: APIValue) async throws {
        let type = signal["type"].text
        if type == "ready" {
            ready = true
            status = "Waiting for the other member…"
            for member in signal["peers"].list {
                let id = member["profile_id"].text
                guard UUID(uuidString: id) != nil else { continue }
                let peer = try ensurePeer(id)
                let description = try await createDescription(peer, offer: true)
                try await setDescription(peer, description, remote: false)
                try await send(["type": "offer", "target": id, "data": ["type": "offer", "sdp": description.sdp]])
            }
            return
        }
        if type == "peer-left" { let hadConnection = !connectedPeers.isEmpty; remove(signal["profile_id"].text); if peers.isEmpty && hadConnection { stop(); status = "The other member left" }; return }
        let id = signal["from"].text
        guard UUID(uuidString: id) != nil else { return }
        let peer = try ensurePeer(id)
        if type == "offer" || type == "answer" {
            let description = LKRTCSessionDescription(type: type == "offer" ? .offer : .answer, sdp: signal["data"]["sdp"].text)
            try await setDescription(peer, description, remote: true)
            for candidate in pendingICE.removeValue(forKey: id) ?? [] { try await add(candidate, to: peer) }
            if type == "offer" {
                let answer = try await createDescription(peer, offer: false)
                try await setDescription(peer, answer, remote: false)
                try await send(["type": "answer", "target": id, "data": ["type": "answer", "sdp": answer.sdp]])
            }
        } else if type == "ice", !signal["data"]["candidate"].text.isEmpty {
            let value = signal["data"]
            let index: Int32
            if case .number(let number) = value["sdpMLineIndex"], number >= 0, number <= Double(Int32.max) { index = Int32(number) } else { index = 0 }
            let candidate = LKRTCIceCandidate(sdp: value["candidate"].text, sdpMLineIndex: index, sdpMid: value["sdpMid"].text.isEmpty ? nil : value["sdpMid"].text)
            if peer.remoteDescription == nil { pendingICE[id, default: []].append(candidate) }
            else { try await add(candidate, to: peer) }
        }
    }
    private func ensurePeer(_ id: String) throws -> LKRTCPeerConnection {
        if let peer = peers[id] { return peer }
        guard peers.count < 3 else { throw APIError(message: "This call is full.") }
        let config = LKRTCConfiguration(); config.iceServers = iceServers; config.sdpSemantics = .unifiedPlan
        guard let peer = factory.peerConnection(with: config, constraints: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self) else { throw APIError(message: "Could not prepare the call.") }
        if let audio { peer.add(audio, streamIds: ["atlantium"]) }
        if let localVideo { peer.add(localVideo, streamIds: ["atlantium"]) }
        peers[id] = peer
        return peer
    }
    private func createDescription(_ peer: LKRTCPeerConnection, offer: Bool) async throws -> LKRTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            let complete: @Sendable (LKRTCSessionDescription?, Error?) -> Void = { value, error in
                if let error { continuation.resume(throwing: error) }
                else if let value { continuation.resume(returning: value) }
                else { continuation.resume(throwing: APIError(message: "Could not negotiate the call.")) }
            }
            let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            if offer { peer.offer(for: constraints, completionHandler: complete) } else { peer.answer(for: constraints, completionHandler: complete) }
        }
    }
    private func setDescription(_ peer: LKRTCPeerConnection, _ description: LKRTCSessionDescription, remote: Bool) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let complete: @Sendable (Error?) -> Void = { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
            if remote { peer.setRemoteDescription(description, completionHandler: complete) } else { peer.setLocalDescription(description, completionHandler: complete) }
        }
    }
    private func add(_ candidate: LKRTCIceCandidate, to peer: LKRTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.add(candidate) { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
        }
    }
    private func send(_ value: [String: Any]) async throws {
        guard let socket else { return }
        let data = try JSONSerialization.data(withJSONObject: value)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
    func setCamera(_ enabled: Bool) async throws {
        if enabled {
            guard await AVCaptureDevice.requestAccess(for: .video) else { throw APIError(message: "Allow camera access in Settings.") }
            guard !ended, let capturer, let device = LKRTCCameraVideoCapturer.captureDevices().first(where: { $0.position == .front }) ?? LKRTCCameraVideoCapturer.captureDevices().first,
                  let format = LKRTCCameraVideoCapturer.supportedFormats(for: device).filter({ CMVideoFormatDescriptionGetDimensions($0.formatDescription).width <= 1280 }).max(by: { CMVideoFormatDescriptionGetDimensions($0.formatDescription).width < CMVideoFormatDescriptionGetDimensions($1.formatDescription).width }) else { throw APIError(message: "Camera unavailable.") }
            try await capturer.startCapture(with: device, format: format, fps: min(30, Int(format.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30)))
        } else { await capturer?.stopCapture() }
        guard !ended else { return }
        localVideo?.isEnabled = enabled; camera = enabled
    }
    func toggleMicrophone() { microphone.toggle(); audio?.isEnabled = microphone }
    private func remove(_ id: String) { peers.removeValue(forKey: id)?.close(); pendingICE.removeValue(forKey: id); remoteVideos.removeValue(forKey: id); connectedPeers.remove(id) }
    private func fail(_ message: String) { error = message; stop() }
    func stop() {
        guard !ended else { return }; ended = true; ready = false; status = "Call ended"; generation = UUID()
        receiveTask?.cancel(); timeoutTask?.cancel(); socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        peers.values.forEach { $0.close() }; peers.removeAll(); pendingICE.removeAll(); remoteVideos.removeAll(); connectedPeers.removeAll()
        audio?.isEnabled = false; localVideo?.isEnabled = false
        let capture = capturer; Task { await capture?.stopCapture() }
        audio = nil; localVideo = nil; capturer = nil
        let rtcAudio = LKRTCAudioSession.sharedInstance()
        rtcAudio.lockForConfiguration()
        try? rtcAudio.setActive(false)
        rtcAudio.unlockForConfiguration()
    }
}
extension PeerCallController: LKRTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        Task { @MainActor [weak self] in
            guard let self, let id = self.peers.first(where: { $0.value === peer })?.key else { return }
            do { try await self.send(["type": "ice", "target": id, "data": ["candidate": candidate.sdp, "sdpMLineIndex": candidate.sdpMLineIndex, "sdpMid": candidate.sdpMid as Any? ?? NSNull()]]) }
            catch { if !self.ended { self.fail("Could not connect the call.") } }
        }
    }
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCPeerConnectionState) {
        Task { @MainActor [weak self] in
            guard let self, let id = self.peers.first(where: { $0.value === peer })?.key else { return }
            if state == .connected {
                do { try self.configureAudio() }
                catch { self.error = "Audio could not start. Hang up and try again." }
                self.connectedPeers.insert(id); self.status = "Connected"; self.timeoutTask?.cancel()
            }
            else if state == .failed { self.remove(id); self.status = "Connection failed"; self.error = "Could not connect. Hang up and try again." }
            else if state == .disconnected { self.status = "Reconnecting…" }
        }
    }
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didAdd receiver: LKRTCRtpReceiver, streams: [LKRTCMediaStream]) {
        Task { @MainActor [weak self] in
            guard let self, let id = self.peers.first(where: { $0.value === peer })?.key else { return }
            if let audio = receiver.track as? LKRTCAudioTrack {
                audio.isEnabled = true
            } else if let video = receiver.track as? LKRTCVideoTrack {
                self.remoteVideos[id] = video
            }
        }
    }
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didRemove receiver: LKRTCRtpReceiver) { Task { @MainActor [weak self] in guard let self, let id = self.peers.first(where: { $0.value === peer })?.key else { return }; self.remoteVideos.removeValue(forKey: id) } }
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCSignalingState) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peer: LKRTCPeerConnection) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCIceConnectionState) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didChange state: LKRTCIceGatheringState) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    nonisolated func peerConnection(_ peer: LKRTCPeerConnection, didOpen channel: LKRTCDataChannel) {}
}
struct PeerVideo: UIViewRepresentable {
    let track: LKRTCVideoTrack
    var onFrames: () -> Void = {}
    func makeUIView(context: Context) -> LKRTCMTLVideoView { let view = LKRTCMTLVideoView(); view.videoContentMode = .scaleAspectFill; view.delegate = context.coordinator; track.add(view); return view }
    func updateUIView(_ view: LKRTCMTLVideoView, context: Context) { if context.coordinator.track !== track { context.coordinator.track?.remove(view); track.add(view); context.coordinator.track = track } }
    func makeCoordinator() -> Coordinator { Coordinator(track: track, onFrames: onFrames) }
    static func dismantleUIView(_ view: LKRTCMTLVideoView, coordinator: Coordinator) { coordinator.track?.remove(view) }
    final class Coordinator: NSObject, LKRTCVideoViewDelegate {
        var track: LKRTCVideoTrack?
        let onFrames: () -> Void
        init(track: LKRTCVideoTrack, onFrames: @escaping () -> Void) { self.track = track; self.onFrames = onFrames }
        func videoView(_ videoView: LKRTCVideoRenderer, didChangeVideoSize size: CGSize) { if size.width > 0 && size.height > 0 { DispatchQueue.main.async { self.onFrames() } } }
    }
}
struct PeerVideoTile: View {
    let track: LKRTCVideoTrack
    @State private var hasFrames = false
    var body: some View {
        ZStack {
            Image(systemName: "person.crop.circle.fill").font(.system(size: 100)).foregroundStyle(.cyan)
            PeerVideo(track: track, onFrames: { hasFrames = true }).opacity(hasFrames ? 1 : 0)
        }.clipShape(RoundedRectangle(cornerRadius: 24))
    }
}
struct PeerCallView: View {
    let threadID: String
    let name: String
    let video: Bool
    let announce: Bool
    @StateObject private var call = PeerCallController()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var cameraBusy = false
    var body: some View {
        VStack(spacing: 24) {
            Text(name.isEmpty ? "Member call" : name).font(.title2.bold()).padding(.top, 24)
            Text(call.status).foregroundStyle(.secondary)
            if !call.remoteVideos.isEmpty { ForEach(Array(call.remoteVideos.keys).sorted(), id: \.self) { id in if let track = call.remoteVideos[id] { PeerVideoTile(track: track) } } }
            else { Spacer(); Image(systemName: "person.crop.circle.fill").font(.system(size: 100)).foregroundStyle(.cyan); Spacer() }
            if call.camera, let track = call.localVideo { PeerVideo(track: track).frame(width: 120, height: 160).clipShape(RoundedRectangle(cornerRadius: 20)).frame(maxWidth: .infinity, alignment: .trailing) }
            if !call.error.isEmpty { Text(call.error).font(.subheadline).foregroundStyle(.red) }
            HStack(spacing: 28) {
                Button { call.toggleMicrophone() } label: { Label(call.microphone ? "Mute" : "Unmute", systemImage: call.microphone ? "mic.fill" : "mic.slash.fill") }.disabled(call.ended || !call.ready)
                Button { Task { cameraBusy = true; defer { cameraBusy = false }; do { try await call.setCamera(!call.camera) } catch { call.error = error.localizedDescription } } } label: { Label("Camera", systemImage: call.camera ? "video.fill" : "video.slash.fill") }.disabled(call.ended || !call.ready || cameraBusy)
                Button(role: .destructive) { call.stop(); dismiss() } label: { Label("Hang up", systemImage: "phone.down.fill") }
            }.labelStyle(.iconOnly).font(.title2).buttonStyle(.bordered).controlSize(.large).padding(.bottom, 24)
        }.padding(.horizontal, 24).background(Color.black).preferredColorScheme(.dark)
        .task { await call.start(threadID: threadID, video: video, announce: announce) }
        .onDisappear { call.stop() }
        .onChange(of: phase) { _, phase in if phase == .background { call.stop(); dismiss() } }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in call.stop(); dismiss() }
    }
}
