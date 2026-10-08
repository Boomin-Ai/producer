import SwiftUI
import LiveKit

struct EventsView: View {
    @EnvironmentObject var session: Session
    @State var sessions: [APIValue] = []
    @State var nextOffset: Int?
    @State var loadingMore = false
    @State var rooms: [APIValue] = []
    @State var loading = true
    @State var error = ""
    var body: some View { Group {
        if loading && sessions.isEmpty { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        else if !error.isEmpty && sessions.isEmpty { LoadError(message: error) { Task { await load() } } }
        else { ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(sessions, id: \.id) { event in
                    NavigationLink { EventDetail(event: event) } label: { HQNextEventCard(event: event) }.buttonStyle(.plain)
                }
                if nextOffset != nil { ProgressView().frame(maxWidth: .infinity).onAppear { Task { await loadMore() } } }
                if sessions.isEmpty { Text("New events will appear here.").font(.subheadline).foregroundStyle(.secondary) }
                if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
            }.padding(16)
        }.refreshable { await load() } }
    }.background(AppNightBackground()).navigationTitle("Events").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .topBarTrailing) { AccountButton() } }.task(id: session.signedIn) { await load() } }
    func load() async { loading = true; defer { loading = false }; do { let page = try await API.shared.call("office-hours?scope=all"); sessions = page["sessions"].list; if case .number(let offset) = page["next_offset"] { nextOffset = Int(offset) } else { nextOffset = nil }; error = ""; rooms = []; if session.signedIn { rooms = try await API.shared.call("live")["rooms"].list } } catch { self.error = error.localizedDescription } }
    func loadMore() async {
        guard let offset = nextOffset, !loadingMore else { return }
        loadingMore = true; defer { loadingMore = false }
        do {
            let page = try await API.shared.call("office-hours?scope=all&offset=\(offset)")
            let existing = Set(sessions.map(\.id))
            sessions += page["sessions"].list.filter { !existing.contains($0.id) }
            if case .number(let offset) = page["next_offset"] { nextOffset = Int(offset) } else { nextOffset = nil }
        } catch { self.error = error.localizedDescription }
    }
}
struct EventDetail: View {
    @EnvironmentObject var session: Session
    let event: APIValue
    @State var status = ""
    @State var attendance: Int?
    @State private var reserved = false
    @State private var reserving = false
    @State private var showInsiderNotice = false
    @State var error = ""
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 20) {
        GeometryReader { geo in
            EventArtwork(event: event).frame(width: geo.size.width, height: 190).clipped()
                .overlay { LinearGradient(colors: [.clear, .black.opacity(0.4)], startPoint: .top, endPoint: .bottom) }
        }.frame(height: 190).clipShape(RoundedRectangle(cornerRadius: 22))
        Text(event["title"].text).font(.system(size: 26, weight: .semibold)).tracking(-0.5)
        Label(event["starts_at"].text.eventDate, systemImage: "calendar").foregroundStyle(.cyan)
        MarkdownText(text: event["description"].text)
        Label("Live online · Atlantium", systemImage: "video").font(.caption).foregroundStyle(.secondary)
        if session.signedIn {
            if !reserved {
                Button(reserving ? "Reserving…" : "Reserve my place") { Task { await reserve() } }.buttonStyle(.borderedProminent).disabled(reserving)
            } else { Label("Your place is reserved", systemImage: "checkmark.circle.fill").font(.subheadline).foregroundStyle(.mint) }

            NavigationLink { LiveRoomView(roomID: event["room_id"].text, eventID: event.id, title: event["title"].text) } label: { Label("Enter session", systemImage: "video") }.buttonStyle(.bordered).disabled(!reserved)
        } else { Button("Sign in to join") { session.showAuth = true }.buttonStyle(.borderedProminent) }
        if let attendance { Label("\(attendance) registered", systemImage: "person.2").font(.caption).foregroundStyle(.secondary) }
        if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary) }
        if !error.isEmpty { Text(error).font(.subheadline).foregroundStyle(.red) }
        if showInsiderNotice {
            VStack(alignment: .leading, spacing: 10) {
                HStack { Image(systemName: "sparkles").foregroundStyle(.cyan); Text("Keep building with Insiders").font(.subheadline.weight(.semibold)); Spacer(); Button { showInsiderNotice = false } label: { Image(systemName: "xmark").font(.caption) }.tint(.secondary).accessibilityLabel("Dismiss membership notice") }
                Text("Free members get one Office Hours session every two weeks. Insiders get unlimited access to live technical help and project reviews.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                JoinInsidersButton(title: "Unlimited Office Hours with Insiders")
            }.padding(14).background(.cyan.opacity(0.055), in: RoundedRectangle(cornerRadius: 18)).overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(.cyan.opacity(0.16), lineWidth: 1) }
        }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading) }.background(AppNightBackground()).navigationBarTitleDisplayMode(.inline).task {
        if session.signedIn, let live = try? await API.shared.call("live"), live["registrations"][event.id]["status"].text == "registered" { reserved = true; await loadAttendance() }
    } }
    func reserve() async {
        reserving = true; defer { reserving = false }
        do {
            let result = try await API.shared.call("live/sessions/" + event.id + "/register", method: "POST", body: ["status": "registered"])
            reserved = result["registration"]["status"].text == "registered"
            error = ""; showInsiderNotice = false
            if !reserved { status = "You’re on the waitlist." }
            await loadAttendance()
        } catch {
            if let apiError = error as? APIError, apiError.code == "insider_required" {
                self.error = ""; showInsiderNotice = true
            } else { self.error = error.localizedDescription }
        }
    }
    func loadAttendance() async {
        if let details = try? await API.shared.call("office-hours/" + event["slug"].text), case .number(let count) = details["session"]["registration_count"] { attendance = Int(count) }
    }
}
extension String {
    var eventDate: String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; if let date = f.date(from: self) ?? ISO8601DateFormatter().date(from: self) { return date.formatted(date: .abbreviated, time: .shortened) }; return self }
}
struct ParticipantVideo: UIViewRepresentable {
    let track: VideoTrack
    var fit: Bool = false
    func makeUIView(context: Context) -> VideoView { let view = VideoView(); view.layoutMode = fit ? .fit : .fill; view.track = track; return view }
    func updateUIView(_ view: VideoView, context: Context) { view.layoutMode = fit ? .fit : .fill; view.track = track }
}
struct LiveRoomView: View {
    let roomID: String
    var eventID: String? = nil
    let title: String
    @EnvironmentObject var session: Session
    @Environment(\.scenePhase) var scenePhase
    @StateObject var room = Room()
    @StateObject private var chatReceiver = LobbyChatReceiver()
    @State var connected = false
    @State var error = ""
    @State var mic = false
    @State var camera = false
    @State var canPublish = false
    @State var canSpeak = false
    @State var busy = false
    @State var chat: [APIValue] = []
    @State private var chatRevision = 0
    @State var text = ""
    @Environment(\.dismiss) var dismiss
    var participants: [Participant] { [room.localParticipant] + Array(room.remoteParticipants.values) }
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 16) {
        if !connected && error.isEmpty { ProgressView("Joining room…") }
        if !connected && !error.isEmpty { Button("Retry joining") { Task { error = ""; await connect() } }.buttonStyle(.bordered) }
        ForEach(Array(room.remoteParticipants.values), id: \.identity) { participant in
            LiveScreenShare(participant: participant)
        }
        let speakers = participants.filter { $0.identity == room.localParticipant.identity ? (canSpeak || canPublish) : $0.permissions.canPublish }
        let listeners = participants.filter { $0.identity == room.localParticipant.identity ? !(canSpeak || canPublish) : !$0.permissions.canPublish }
        if !speakers.isEmpty {
            LazyVGrid(columns: speakers.count == 1 ? [GridItem(.flexible())] : [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(speakers, id: \.identity) { participant in
                    LobbyParticipantCard(participant: participant, isLocal: participant.identity == room.localParticipant.identity, avatarURL: session.avatarURL, localName: session.user["name"].text, localCameraOn: camera)
                }
            }
        } else if connected {
            Label("The stage is open", systemImage: "waveform").font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 90)
        }
        if !listeners.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("LISTENING · \(listeners.count)").font(.system(size: 10, weight: .semibold)).tracking(1.5).foregroundStyle(.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(listeners, id: \.identity) { participant in
                            LobbyListener(participant: participant, isLocal: participant.identity == room.localParticipant.identity, avatarURL: session.avatarURL)
                        }
                    }
                }
            }.padding(.vertical, 12)
        }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        VStack(alignment: .leading, spacing: 12) {
            HStack { Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(.cyan); Text("Room chat").font(.subheadline.weight(.semibold)); Spacer() }.padding(.bottom, 4)
            if chat.isEmpty { Text("Say hello to the room.").font(.caption).foregroundStyle(.secondary) }
            ForEach(chat, id: \.id) { message in
                HStack(alignment: .top, spacing: 10) {
                    Text(String(message.text("sender_display_name", "sender_username").prefix(1)).uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.cyan).frame(width: 28, height: 28).background(.cyan.opacity(0.08), in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text(message.text("sender_display_name", "sender_username")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(message.text("content", "body")).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Color(red: 0.025, green: 0.04, blue: 0.055), in: RoundedRectangle(cornerRadius: 18)).overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(.white.opacity(0.07), lineWidth: 1) }
    }.padding(.horizontal, 16).padding(.vertical, 12) }.navigationTitle(title.isEmpty ? "Lobby" : title).navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom) {
        HStack(spacing: 12) { TextField("Message the room", text: $text, axis: .vertical).lineLimit(1...5); Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.tint(.cyan).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !connected) }.modifier(MessageComposerSurface()).padding(.horizontal, 12).padding(.vertical, 8).background(Color.black)
    }
    .toolbar {
        ToolbarItem(placement: .principal) {
            Menu {
                Section("Camera and microphone") {
                    Button { Task { await toggle(camera: false) } } label: { Label(canSpeak ? (mic ? "Mute microphone" : "Turn microphone on") : "Microphone · Insiders only", systemImage: canSpeak ? (mic ? "mic.fill" : "mic.slash") : "lock.fill") }.disabled(!canSpeak || busy || !connected)
                    Button { Task { await toggle(camera: true) } } label: { Label(canPublish ? (camera ? "Turn camera off" : "Turn camera on") : "Camera · Insiders only", systemImage: canPublish ? (camera ? "video.fill" : "video.slash") : "lock.fill") }.disabled(!canPublish || busy || !connected)
                }
                if connected && (!canSpeak || !canPublish) {
                    Section("You can watch and listen") {
                        NavigationLink { ReneView().toolbar(.hidden, for: .tabBar) } label: { Label("Join Insiders to participate", systemImage: "person.2.badge.plus") }
                    }
                }
                Section {
                    Button(role: .destructive) { Task { await room.disconnect(); connected = false; dismiss() } } label: { Label("Leave lobby", systemImage: "phone.down.fill") }
                }
            } label: { HStack(spacing: 8) { Text(title.isEmpty ? "Lobby" : title).font(.headline).lineLimit(1); Image(systemName: mic ? "mic.fill" : "mic.slash").foregroundStyle(mic ? Color.cyan : Color.secondary); Image(systemName: camera ? "video.fill" : "video.slash").foregroundStyle(camera ? Color.cyan : Color.secondary); Image(systemName: "chevron.down").font(.caption.weight(.semibold)) }.padding(.horizontal, 12).padding(.vertical, 8) }
            .menuStyle(.button).buttonStyle(.bordered)
            .accessibilityLabel("Lobby camera and microphone controls")
        }
    }
    .task { await connect(); while connected && !Task.isCancelled { await loadChat(); try? await Task.sleep(for: .seconds(30)) } }
    .onReceive(chatReceiver.$event) { event in
        guard event["room_id"].text == roomID else { return }
        if event["type"].text == "delete" { chatRevision += 1; chatReceiver.deletedIDs.insert(event["message_id"].text); chat.removeAll { $0.id == event["message_id"].text } }
        else if !event["message"].id.isEmpty { mergeChat([event["message"]]) }
    }
    .onReceive(chatReceiver.$reconnect) { count in if count > 0 { Task { await loadChat() } } }
    .onChange(of: scenePhase) { _, phase in if phase != .active { Task { if mic { _ = try? await room.localParticipant.setMicrophone(enabled: false); mic = false }; if camera { _ = try? await room.localParticipant.setCamera(enabled: false); camera = false } } } }
    .onDisappear { Task { await room.disconnect() } } }
    func connect() async { do {
        let route = eventID.map { "live/sessions/" + $0 + "/livekit-token" } ?? "live/rooms/" + roomID + "/livekit-token"
        let token = try await API.shared.call(route, method: "POST")
        guard !token["token"].text.isEmpty, !token["url"].text.isEmpty else { throw APIError(message: "This room isn’t available yet.") }
        canPublish = token["permissions"]["can_publish"].flag
        canSpeak = eventID == nil ? token["permissions"]["can_publish_audio"].flag : canPublish
        room.add(delegate: chatReceiver)
        try await room.connect(url: token["url"].text, token: token["token"].text); connected = true
    } catch { self.error = error.localizedDescription } }
    func toggle(camera useCamera: Bool) async { guard connected && (useCamera ? canPublish : canSpeak) else { return }; busy = true; defer { busy = false }; do { if useCamera { try await room.localParticipant.setCamera(enabled: !camera); camera.toggle() } else { try await room.localParticipant.setMicrophone(enabled: !mic); mic.toggle() } } catch { self.error = error.localizedDescription } }
    func loadChat() async { guard !roomID.isEmpty else { return }; let revision = chatRevision; if let value = try? await API.shared.call("live/rooms/" + roomID + "/messages?limit=50") { if revision == chatRevision { chat = value["messages"].list.filter { !chatReceiver.deletedIDs.contains($0.id) } } else { mergeChat(value["messages"].list) } } }
    func mergeChat(_ incoming: [APIValue]) {
        chatRevision += 1
        var byID = Dictionary(chat.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for message in incoming where !chatReceiver.deletedIDs.contains(message.id) { byID[message.id] = message }
        chat = byID.values.sorted { $0["created_at"].text < $1["created_at"].text }
    }
    func send() async { let content = text.trimmingCharacters(in: .whitespacesAndNewlines); guard !content.isEmpty && !busy else { return }; busy = true; defer { busy = false }; do { let value = try await API.shared.call("live/rooms/" + roomID + "/messages", method: "POST", body: ["content": content]); if text.trimmingCharacters(in: .whitespacesAndNewlines) == content { text = "" }; mergeChat([value["message"]]) } catch { self.error = error.localizedDescription } }
}

struct HQView: View {
    @EnvironmentObject var session: Session
    @State private var showingAccount = false
    @AppStorage("atlantium.welcome.completed") private var welcomed = false
    @State private var live: APIValue = .null
    @State private var events: [APIValue] = []
    @State private var pendingConnections = 0
    @State private var loading = true
    @State private var error = ""
    var rooms: [APIValue] { live["rooms"].list.filter { $0["type"].text != "office_hours" } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .center) {
                    Text(session.signedIn ? "Welcome back" : "Welcome to Atlantium").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                    Spacer()
                    if session.signedIn && !session.needsOnboarding && pendingConnections == 0 && session.user["is_approved"].flag { Label("All caught up", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary) }
                }
                if session.signedIn && (session.needsOnboarding || pendingConnections > 0 || (!session.user["is_approved"].flag && !session.user["is_admin"].flag)) {
                    VStack(alignment: .leading, spacing: 14) {
                        if session.needsOnboarding {
                            NavigationLink { MemberOnboardingView() } label: {
                                HQAlertRow(title: "Finish onboarding", detail: "Introduce yourself to the network.", icon: "person.crop.circle.badge.checkmark")
                            }
                        }
                        if !session.user["is_approved"].flag && !session.user["is_admin"].flag {
                            HQAlertRow(title: "Profile review", detail: "Your membership approval is pending.", icon: "clock")
                        }
                        if pendingConnections > 0 {
                            NavigationLink { MemberNetworkView() } label: { HQAlertRow(title: "\(pendingConnections) connection request\(pendingConnections == 1 ? "" : "s")", detail: "See who wants to connect.", icon: "person.2") }
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("THE LOBBY").font(.caption2.weight(.semibold)).tracking(2).foregroundStyle(.white.opacity(0.7))
                        Spacer()
                        Image(systemName: "waveform").font(.title3).foregroundStyle(.cyan)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        (Text("Talk tech.\n").foregroundColor(.white) + Text("Explore the frontier.").foregroundColor(.cyan)).font(.system(size: 25, weight: .semibold)).tracking(-0.8).fixedSize(horizontal: false, vertical: true)
                        Text("Meet the people building what’s next.").font(.caption).foregroundStyle(.white.opacity(0.65)).fixedSize(horizontal: false, vertical: true)
                    }
                    if !session.signedIn {
                        Button { session.showAuth = true } label: { HStack { Text("Sign in to join"); Spacer(); Image(systemName: "arrow.up.right") }.font(.subheadline.weight(.semibold)).padding(16).foregroundStyle(.black).background(.white, in: Capsule()) }.buttonStyle(.plain)
                    } else {
                        ForEach(rooms, id: \.id) { room in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack(spacing: 6) { Circle().fill(.cyan).frame(width: 6, height: 6); Text(occupancy(room)).font(.caption.weight(.medium)) }
                                }
                                Spacer(minLength: 4)
                                NavigationLink { LiveRoomView(roomID: room.id, title: "Lobby") } label: { HStack(spacing: 9) { Text("Enter lobby"); Image(systemName: "arrow.up.right") }.font(.subheadline.weight(.semibold)).padding(.horizontal, 16).padding(.vertical, 10).foregroundStyle(.black).background(.white, in: Capsule()) }.buttonStyle(.plain)
                            }
                        }
                        if !loading && rooms.isEmpty && error.isEmpty { Text("The lobby is not available right now.").font(.caption).foregroundStyle(.secondary) }
                    }
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    GeometryReader { geo in
                        Image("HQLobby").resizable().scaledToFill().frame(width: geo.size.width, height: geo.size.height).clipped()
                            .overlay { LinearGradient(colors: [.black.opacity(0.75), .black.opacity(0.25)], startPoint: .leading, endPoint: .trailing) }
                            .overlay { LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom) }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 22))
                .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(.white.opacity(0.06), lineWidth: 1) }
                VStack(alignment: .leading, spacing: 16) {
                    HStack { Text("Upcoming events").font(.headline); Spacer(); NavigationLink("All events") { EventsView() }.font(.caption) }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 14) {
                            ForEach(Array(events.prefix(4)), id: \.id) { event in
                                NavigationLink { EventDetail(event: event) } label: { HQEventCard(event: event, registered: live["registrations"][event.id]["status"].text == "registered") }.buttonStyle(.plain)
                            }
                        }.padding(.vertical, 2)
                    }
                    if !loading && events.isEmpty { Text("New events will appear here.").font(.subheadline).foregroundStyle(.secondary) }
                }
                if session.signedIn && !rooms.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Active conversations").font(.headline)
                        VStack(spacing: 0) {
                            ForEach(rooms, id: \.id) { room in
                                NavigationLink { LiveRoomView(roomID: room.id, title: "Lobby") } label: {
                                    HStack(spacing: 12) {
                                        Image("HQLobby").resizable().scaledToFill().frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 12))
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack(spacing: 6) { Circle().fill(.mint).frame(width: 6, height: 6); Text("The lobby").font(.subheadline.weight(.semibold)).foregroundStyle(.white) }
                                            Text("Tech talk · " + occupancy(room)).font(.caption2).foregroundStyle(.secondary)
                                        }
                                        Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                    }.padding(14)
                                }.buttonStyle(.plain)
                            }
                        }.background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 20)).overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.08), lineWidth: 1) }
                    }
                }
                if loading { ProgressView() }
                if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
            }.padding(20).frame(maxWidth: 680, alignment: .leading).frame(maxWidth: .infinity)
        }.background {
            ZStack {
                Color(red: 0.018, green: 0.023, blue: 0.032)
                RadialGradient(colors: [Color(red: 0.025, green: 0.075, blue: 0.13).opacity(0.55), .clear], center: .topTrailing, startRadius: 0, endRadius: 620)
                LinearGradient(colors: [.clear, Color.blue.opacity(0.018)], startPoint: .top, endPoint: .bottom)
            }.ignoresSafeArea()
        }.navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .principal) { Menu {
            Button { if session.signedIn { showingAccount = true } else { welcomed = false } } label: { Label(session.signedIn ? "Profile and settings" : "Sign in", systemImage: "person.crop.circle") }
            NavigationLink { NotificationPreferencesView() } label: { Label("Notifications", systemImage: "bell") }
        } label: { HStack(spacing: 8) { HQMemberAvatar(url: session.avatarURL, name: memberName).frame(width: 30, height: 30).scaleEffect(0.65).background(.white.opacity(0.045), in: Circle()).overlay { Circle().strokeBorder(.white.opacity(0.09), lineWidth: 0.5) }; Text(session.signedIn ? memberName : "Atlantium").font(.subheadline.weight(.medium)).lineLimit(1).foregroundStyle(.white.opacity(0.9)); Image(systemName: "chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.55)) }.padding(.leading, 7).padding(.trailing, 12).padding(.vertical, 6).modifier(HQProfileGlass()) } .menuStyle(.button).buttonStyle(.plain).accessibilityLabel("Profile and settings menu") } }
        .sheet(isPresented: $showingAccount) { AccountView() }
        .refreshable { await session.loadProfile(); await load() }
        .task(id: session.signedIn) {
            await load()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(20)) } catch { break }
                if session.signedIn, let updated = try? await API.shared.call("live") { live = updated }
            }
        }
    }
    var memberName: String {
        let name = session.profile.text("display_name", "first_name")
        return name.isEmpty ? (session.user.text("name").isEmpty ? "Welcome back" : session.user.text("name")) : name
    }
    func occupancy(_ room: APIValue) -> String {
        if case .number(let count) = live["participant_counts"][room.id] { return "\(Int(count)) \(count == 1 ? "person" : "people") inside" }
        return "Checking who’s inside…"
    }
    func load() async {
        loading = true; error = ""; defer { loading = false }
        do {
            events = try await API.shared.call("office-hours")["sessions"].list
            if session.signedIn {
                live = try await API.shared.call("live")
                if session.insider {
                    let connections = try await API.shared.call("me/connections")["connections"].list
                    pendingConnections = connections.filter { $0["direction"].text == "incoming" && $0["status"].text == "pending" }.count
                } else { pendingConnections = 0 }
            } else { live = .null; pendingConnections = 0 }
        } catch { self.error = error.localizedDescription }
    }
}
struct HQAlertRow: View {
    let title: String
    let detail: String
    let icon: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(.cyan).frame(width: 24)
            VStack(alignment: .leading, spacing: 5) { Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary); Text(detail).font(.caption).foregroundStyle(.secondary) }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

struct HQEventCard: View {
    let event: APIValue
    let registered: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                EventArtwork(event: event)
                    .frame(width: 178, height: 100).clipped()
                    .overlay { LinearGradient(colors: [.clear, Color(red: 0.035, green: 0.06, blue: 0.085)], startPoint: .top, endPoint: .bottom) }
                VStack(spacing: 2) { Text(month).font(.system(size: 8, weight: .medium)); Text(day).font(.system(size: 22, weight: .semibold)) }
                    .foregroundStyle(.black).padding(8).background(.white.opacity(0.95), in: RoundedRectangle(cornerRadius: 10)).padding(10)
            }
            VStack(alignment: .leading, spacing: 7) {
                Text(event["title"].text).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
                Text(event["description"].text).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Text(event["starts_at"].text.eventDate).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Label("Online", systemImage: "video").font(.caption2).foregroundStyle(.secondary)
                if registered { Text("You’re registered").font(.caption2.weight(.medium)).foregroundStyle(.cyan) }
                Text(registered ? "View registration" : "View event").font(.caption.weight(.medium)).frame(maxWidth: .infinity).padding(.vertical, 8).overlay { Capsule().strokeBorder(.white.opacity(0.25), lineWidth: 1) }
            }.padding(.horizontal, 12).padding(.bottom, 12)
        }.frame(width: 178).background(Color(red: 0.035, green: 0.06, blue: 0.085))
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.12), lineWidth: 1) }
    }
    var date: Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: event["starts_at"].text) ?? ISO8601DateFormatter().date(from: event["starts_at"].text)
    }
    var month: String { date?.formatted(.dateTime.month(.abbreviated)).uppercased() ?? "EVENT" }
    var day: String { date?.formatted(.dateTime.day()) ?? "—" }
}
struct HQShortcut: View {
    let title: String
    let detail: String
    let icon: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Image(systemName: icon).font(.title3).foregroundStyle(.cyan); Spacer(); Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(.secondary) }
            VStack(alignment: .leading, spacing: 5) { Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary); Text(detail).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 140).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 24))
    }
}
struct HQMemberAvatar: View {
    let url: String
    let name: String
    var body: some View {
        AsyncImage(url: NativeRoutes.external(url)) { image in image.resizable().scaledToFill() } placeholder: {
            ZStack { Circle().fill(.cyan.opacity(0.15)); Text(String(name.prefix(1)).uppercased()).font(.headline).foregroundStyle(.cyan) }
        }.frame(width: 46, height: 46).clipShape(Circle())
    }
}

struct LobbyMenuButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        if #available(iOS 26.0, *) {
            configuration.label.glassEffect(.regular.interactive(), in: Capsule()).opacity(configuration.isPressed ? 0.7 : 1)
        } else {
            configuration.label.background(.thinMaterial, in: Capsule()).opacity(configuration.isPressed ? 0.7 : 1)
        }
    }
}

private struct LiveScreenShare: View {
    @ObservedObject var participant: RemoteParticipant
    @State private var expanded = false
    var body: some View {
        if let publication = participant.videoTracks.first(where: { $0.source == .screenShareVideo }), !publication.isMuted, let track = publication.track as? VideoTrack {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label((participant.name ?? "Member") + " is sharing", systemImage: "rectangle.on.rectangle").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Button { expanded = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").padding(8) }.accessibilityLabel("Expand shared screen")
                }
                ParticipantVideo(track: track, fit: true).aspectRatio(16 / 9, contentMode: .fit).background(.black).clipShape(RoundedRectangle(cornerRadius: 14)).onTapGesture { expanded = true }
            }
            .fullScreenCover(isPresented: $expanded) { SharedScreenViewer(participant: participant) }
        }
    }
}

private struct SharedScreenViewer: View {
    @ObservedObject var participant: RemoteParticipant
    @Environment(\.dismiss) private var dismiss
    @State private var rotated = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(participant.name ?? "Shared screen").font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer()
                Button { rotated.toggle() } label: { Image(systemName: "rotate.right").frame(width: 44, height: 44) }.accessibilityLabel("Rotate shared screen")
                Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("Close full-screen share")
            }.padding(.horizontal, 12).foregroundStyle(.white)
            GeometryReader { geometry in
                ZStack {
                    Color.black
                    if let publication = participant.videoTracks.first(where: { $0.source == .screenShareVideo }), !publication.isMuted, let track = publication.track as? VideoTrack {
                        ZoomableSharedVideo(track: track)
                            .frame(width: rotated ? geometry.size.height : geometry.size.width, height: rotated ? geometry.size.width : geometry.size.height)
                            .rotationEffect(.degrees(rotated ? 90 : 0))
                    } else { Text("Screen sharing ended").foregroundStyle(.secondary) }
                }.frame(width: geometry.size.width, height: geometry.size.height).clipped()
            }
            Text("Pinch to zoom · Drag to move · Double-tap to reset").font(.caption2).foregroundStyle(.secondary).padding(12)
        }.background(.black).preferredColorScheme(.dark).statusBarHidden().persistentSystemOverlays(.hidden)
    }
}

private struct ZoomableSharedVideo: UIViewRepresentable {
    let track: VideoTrack
    func makeUIView(context: Context) -> SharedVideoScrollView {
        let view = SharedVideoScrollView()
        view.delegate = context.coordinator
        view.video.track = track
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2
        view.addGestureRecognizer(tap)
        return view
    }
    func updateUIView(_ view: SharedVideoScrollView, context: Context) {
        if view.video.track !== track { view.setZoomScale(1, animated: false); view.video.track = track }
    }
    static func dismantleUIView(_ view: SharedVideoScrollView, coordinator: Coordinator) { view.video.track = nil }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? SharedVideoScrollView)?.video }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? SharedVideoScrollView else { return }
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: true) }
            else {
                let point = gesture.location(in: scroll.video)
                let size = CGSize(width: scroll.bounds.width / 2, height: scroll.bounds.height / 2)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

private final class SharedVideoScrollView: UIScrollView {
    let video = VideoView()
    private var viewport = CGSize.zero
    override init(frame: CGRect) {
        super.init(frame: frame)
        minimumZoomScale = 1; maximumZoomScale = 6; bouncesZoom = true
        showsHorizontalScrollIndicator = false; showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        video.layoutMode = .fit; video.isUserInteractionEnabled = false
        addSubview(video)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard viewport != bounds.size else { return }
        viewport = bounds.size
        setZoomScale(1, animated: false)
        video.frame = CGRect(origin: .zero, size: viewport)
        contentSize = viewport
    }
}

struct LobbyParticipantCard: View {
    @ObservedObject var participant: Participant
    let isLocal: Bool
    let avatarURL: String
    let localName: String
    let localCameraOn: Bool
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if (!isLocal || localCameraOn), let publication = participant.videoTracks.first(where: { $0.source == .camera }), !publication.isMuted, let track = publication.track as? VideoTrack {
                ParticipantVideo(track: track)
            } else {
                Color(red: 0.035, green: 0.06, blue: 0.08)
                HQMemberAvatar(url: isLocal ? avatarURL : "", name: participant.name ?? localName).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .center, endPoint: .bottom)
            HStack(spacing: 6) {
                Image(systemName: participant.isSpeaking ? "waveform" : "mic").foregroundStyle(participant.isSpeaking ? .cyan : .white.opacity(0.6))
                Text(participant.name?.isEmpty == false ? participant.name! : isLocal ? "You" : "Member").lineLimit(1)
            }.font(.caption.weight(.medium)).padding(10)
        }
        .frame(height: 190).clipped().clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(participant.isSpeaking ? Color.cyan : Color.white.opacity(0.08), lineWidth: participant.isSpeaking ? 2 : 1) }
        .animation(.easeInOut(duration: 0.18), value: participant.isSpeaking)
    }
}

private struct LobbyListener: View {
    @ObservedObject var participant: Participant
    let isLocal: Bool
    let avatarURL: String
    var body: some View {
        HStack(spacing: 6) {
            AsyncImage(url: NativeRoutes.external(isLocal ? avatarURL : "")) { image in image.resizable().scaledToFill() } placeholder: {
                Text(String((participant.name ?? "Member").prefix(1)).uppercased()).font(.caption.weight(.medium)).frame(maxWidth: .infinity, maxHeight: .infinity).background(.white.opacity(0.06))
            }.frame(width: 26, height: 26).clipShape(Circle())
            Text(isLocal ? "You" : participant.name ?? "Member").font(.caption).lineLimit(1).foregroundStyle(.secondary)
        }
    }

}

struct HQNextEventCard: View {
    let event: APIValue
    var body: some View {
        HStack(spacing: 16) {
            EventArtwork(event: event).frame(width: 82, height: 82).clipShape(RoundedRectangle(cornerRadius: 16))
            VStack(alignment: .leading, spacing: 6) {
                Text(event["is_live"].flag ? "LIVE NOW" : "UP NEXT").font(.system(size: 9, weight: .semibold)).tracking(1.5).foregroundStyle(.cyan)
                Text(event["title"].text).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(event["starts_at"].text.eventDate).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(.secondary)
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 18)).overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(.white.opacity(0.07), lineWidth: 1) }
    }
}

private struct HQProfileGlass: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content.background(.ultraThinMaterial, in: Capsule()).overlay { Capsule().strokeBorder(.white.opacity(0.08), lineWidth: 0.5) }
        }
    }
}

// Stable randomized artwork: an event keeps the same image across cards and detail.
private struct EventArtwork: View {
    let event: APIValue
    var asset: String {
        guard event["title"].text.localizedCaseInsensitiveContains("office hours") || event["slug"].text.hasPrefix("office-hours-") else { return "HQEvent" }
        let seed = event.id.isEmpty ? event["slug"].text : event.id
        let hash = seed.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
        return "OfficeHours\(hash % 7 + 1)"
    }
    var body: some View {
        GeometryReader { geo in
            AsyncImage(url: NativeRoutes.external(event["image_url"].text)) { image in image.resizable().scaledToFill() } placeholder: { Image(asset).resizable().scaledToFill() }
                .frame(width: geo.size.width, height: geo.size.height).clipped()
        }
    }
}

final class LobbyChatReceiver: NSObject, ObservableObject, RoomDelegate {
    @Published var event: APIValue = .null
    @Published var reconnect = 0
    var deletedIDs: Set<String> = []
    func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType: EncryptionType) {
        guard participant == nil, topic == "atlantium.chat.v1", let value = try? JSONDecoder().decode(APIValue.self, from: data) else { return }
        Task { @MainActor in self.event = value }
    }
    func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        if connectionState == .connected { Task { @MainActor in self.reconnect += 1 } }
    }
}
