import SwiftUI
struct MemberNetworkView: View {
    @EnvironmentObject var session: Session
    @State var section = 0
    @State var query = ""
    @State var rows: [APIValue] = []
    @State var error = ""
    @State var loading = false
    @State var searchTask: Task<Void, Never>?
    var body: some View { Group {
        if !session.signedIn { SignInPrompt(title: "Meet your people", message: "Connect with builders, founders, and professionals on the frontier.") }
        else if !session.insider { InsiderNetworkWall() }
        else if session.needsOnboarding { OnboardingView() }
        else { VStack {
            Picker("Network", selection: $section) { Text("People").tag(0); Text("Connections").tag(2) }.pickerStyle(.segmented).padding(.horizontal)
            if loading && rows.isEmpty { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if !error.isEmpty { LoadError(message: error) { Task { await load() } } }
            else { List {
                ForEach(rows, id: \.id) { row in
                    if section == 1 { NavigationLink { ThreadView(thread: row) } label: { VStack(alignment: .leading, spacing: 6) { Text(row["other_name"].text).font(.headline); Text(row["last_message"]["body"].text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) } } }
                    else if section == 2 { VStack(alignment: .leading, spacing: 8) { NavigationLink { MemberView(profileID: row["other_profile_id"].text) } label: { Text(row["other_name"].text.isEmpty ? "View member" : row["other_name"].text) }; Text(row["status"].text.capitalized).foregroundStyle(.secondary); if row["direction"].text == "incoming" && row["status"].text == "pending" { HStack { Button("Accept") { Task { await decide(row, accept: true) } }.buttonStyle(.borderedProminent); Button("Decline") { Task { await decide(row, accept: false) } }.buttonStyle(.bordered) } } } }
                    else { NavigationLink { MemberView(profileID: row["profile_id"].text) } label: { HStack(spacing: 12) { Avatar(url: row["avatar_url"].text); VStack(alignment: .leading, spacing: 5) { Text(row["display_name"].text).font(.headline); Text(row["bio"].text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) } } } }
                }
                if rows.isEmpty { ContentUnavailableView(section == 1 ? "No messages yet" : "No members here yet", systemImage: section == 1 ? "bubble.left.and.bubble.right" : "person.2", description: Text(section == 1 ? "Meet someone in People and send an introduction." : "Try a search or check back soon.")) }
            }.listStyle(.plain).refreshable { await load() }.searchable(text: $query, prompt: "Search members") }
        } }
    }.navigationTitle("Network").toolbar { ToolbarItem(placement: .topBarTrailing) { AccountButton() } }
    .task(id: session.signedIn && !session.needsOnboarding) { if session.signedIn && !session.needsOnboarding { await load() } else { rows = []; error = "" } }.task(id: section) { if session.signedIn { await load() } }
    .onChange(of: query) { _, _ in searchTask?.cancel(); searchTask = Task { try? await Task.sleep(for: .milliseconds(350)); if !Task.isCancelled { await load() } } } }
    func load() async { guard session.signedIn && session.insider else { rows = []; return }; loading = true; defer { loading = false }; do {
        var components = URLComponents(); components.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: "50")]
        let result = try await API.shared.call(section == 0 ? "members/search?" + (components.percentEncodedQuery ?? "") : section == 1 ? "threads" : "me/connections")
        rows = result[section == 0 ? "members" : section == 1 ? "conversations" : "connections"].list; error = ""
    } catch { self.error = error.localizedDescription } }
    func decide(_ row: APIValue, accept: Bool) async { do { _ = try await API.shared.call("connections/requests/" + row.id + "/decide", method: "POST", body: ["accept": accept]); await load() } catch { self.error = error.localizedDescription } }
}
struct Avatar: View {
    let url: String
    var body: some View { AsyncImage(url: NativeRoutes.external(url)) { image in image.resizable().scaledToFill() } placeholder: { Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(.secondary) }.frame(width: 48, height: 48).clipShape(Circle()) }
}
struct MemberView: View {
    let profileID: String
    @State var member: APIValue = .null
    @State var error = ""
    @State var status = ""
    @State var message = ""
    @State var busy = false
    @State var block = false
    @State var thread: APIValue?
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 20) {
        Avatar(url: member["avatar_url"].text)
        Text(member["display_name"].text).font(.largeTitle.bold())
        MarkdownText(text: member["bio"].text)
        ForEach(Array(member["roles"].list.enumerated()), id: \.offset) { _, role in Text([role["role"].text.capitalized, role["title"].text, role["org"].text.isEmpty ? role["org"]["name"].text : role["org"].text].filter { !$0.isEmpty }.joined(separator: " · ")).foregroundStyle(.secondary) }
        TextField("Introduce yourself", text: $message, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(2...5)
        HStack { Button("Connect") { Task { await action(dm: false) } }.buttonStyle(.bordered); Button("Send introduction") { Task { await action(dm: true) } }.buttonStyle(.borderedProminent).disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }.disabled(busy)
        if !status.isEmpty { Text(status).foregroundStyle(.cyan) }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Divider()
        Link("Report this member", destination: reportURL)
        Button("Block member", role: .destructive) { block = true }
    }.padding(24).frame(maxWidth: .infinity, alignment: .leading) }.navigationTitle("Member").navigationBarTitleDisplayMode(.inline)
    .task { do { member = try await API.shared.call("members/" + profileID)["member"] } catch { self.error = error.localizedDescription } }
    .confirmationDialog("Block this member?", isPresented: $block, titleVisibility: .visible) { Button("Block", role: .destructive) { Task { do { _ = try await API.shared.call("blocks", method: "POST", body: ["profile_id": profileID]); status = "Member blocked." } catch { self.error = error.localizedDescription } } } }
    .navigationDestination(item: $thread) { ThreadView(thread: $0) } }
    var reportURL: URL { var c = URLComponents(string: "mailto:team@atlantium.ai")!; c.queryItems = [URLQueryItem(name: "subject", value: "Member safety report"), URLQueryItem(name: "body", value: "Member profile: \(profileID)\nPlease describe the issue:\n")]; return c.url! }
    func action(dm: Bool) async { busy = true; defer { busy = false }; do {
        let value = try await API.shared.call(dm ? "dm/requests" : "connections/requests", method: "POST", body: dm ? ["profile_id": profileID, "body": message, "purpose": "peer"] : ["profile_id": profileID, "message": message, "purpose": "peer"])
        if dm && !value["thread_id"].text.isEmpty { thread = .object(["id": value["thread_id"], "other_name": member["display_name"]]) }
        status = dm ? "Introduction sent." : "Connection request sent."; message = ""; error = ""
    } catch { self.error = error.localizedDescription } }
}
struct ThreadView: View {
    let thread: APIValue
    @State var rows: [APIValue] = []
    @State var text = ""
    @State var error = ""
    @State var sending = false
    @State private var callVideo = false
    @State private var announceCall = true
    @State private var showingCall = false
    @State private var now = Date()
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(rows, id: \.id) { row in
                        HStack(alignment: .bottom) {
                            if row["mine"].flag { Spacer(minLength: 40) }
                            VStack(alignment: .leading, spacing: 12) {
                                Text(row["body"].text)
                                if CallInvitation.isCurrent(body: row["body"].text, createdAt: row["created_at"].text, mine: row["mine"].flag, now: now) {
                                    Button { openCall(video: false, announce: false) } label: { Label("Answer call", systemImage: "phone.fill") }.buttonStyle(.borderedProminent)
                                }
                            }.padding(14).background(row["mine"].flag ? Color.cyan.opacity(0.18) : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
                            if !row["mine"].flag { Spacer(minLength: 40) }
                        }.id(row.id)
                    }
                }.padding()
            }.onChange(of: rows.count) { _, _ in if let id = rows.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } } }
        }
        .navigationTitle(thread["other_name"].text.isEmpty ? "Conversation" : thread["other_name"].text)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { openCall(video: false, announce: true) } label: { Image(systemName: "phone") }.accessibilityLabel("Call member")
                Button { openCall(video: true, announce: true) } label: { Image(systemName: "video") }.accessibilityLabel("Video call member")
            }
        }
        .fullScreenCover(isPresented: $showingCall) { PeerCallView(threadID: thread.id, name: thread["other_name"].text, video: callVideo, announce: announceCall) }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                if !error.isEmpty { Text(error).foregroundStyle(.red).font(.caption) }
                HStack {
                    TextField("Message", text: $text, axis: .vertical).lineLimit(1...5)
                    Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.modifier(MessageComposerSurface())
            }.padding(.horizontal, 12).padding(.vertical, 8).background(Color.black)
        }
        .task { while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(8)) } }
    }
    func openCall(video: Bool, announce: Bool) { callVideo = video; announceCall = announce; showingCall = true }
    func load() async { do { rows = try await API.shared.call("threads/" + thread.id + "/messages")["messages"].list; now = Date() } catch { self.error = error.localizedDescription } }
    func send() async { sending = true; defer { sending = false }; do { _ = try await API.shared.call("threads/" + thread.id + "/messages", method: "POST", body: ["body": text]); text = ""; error = ""; await load() } catch { self.error = error.localizedDescription } }
}

struct InsiderNetworkWall: View {
    @EnvironmentObject var session: Session
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NetworkPreviewCard()
                Text("A network to help you break into tech—from your next role to your next investor. Insiders connect at the frontier.").font(.subheadline).foregroundStyle(.white.opacity(0.65)).lineSpacing(3).padding(.horizontal, 6)
            }.padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity)
        }.background(AppNightBackground())
    }
}
struct NetworkPreviewCard: View {
    @EnvironmentObject var session: Session
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            GeometryReader { geo in
                Image("NetworkPreview").resizable().scaledToFill().frame(width: geo.size.width, height: geo.size.height).clipped()
            }
            LinearGradient(colors: [.clear, .black.opacity(0.25), .black.opacity(0.95)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 8) {
                Text("INSIDE THE NETWORK").font(.system(size: 9, weight: .semibold)).tracking(1.8).foregroundStyle(.cyan)
                Text("Built around\nyour people.").font(.system(size: 27, weight: .semibold)).tracking(-0.7).foregroundStyle(.white)
                Text("Ideas. Launches. Conversations.").font(.caption).foregroundStyle(.white.opacity(0.65))
                if session.signedIn { JoinInsidersButton().padding(.top, 8) }
                else { Button("Sign in to join") { session.showAuth = true }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black).padding(.top, 8) }
            }.padding(18)
        }.aspectRatio(0.68, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 24))
            .overlay { RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.12), lineWidth: 1) }
            .accessibilityElement(children: .combine)
    }

}
struct InboxView: View {
    @EnvironmentObject var session: Session
    @State private var threads: [APIValue] = []
    @State private var loading = false
    @State private var error = ""
    var body: some View {
        Group {
            if !session.signedIn { SignInPrompt(title: "Your Inbox", message: "Message Rene or Kleveland. Insiders can also message their connections.") }
            else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        NavigationLink { ReneView().toolbar(.hidden, for: .tabBar) } label: {
                            HStack(spacing: 12) {
                                Image("Rene").resizable().scaledToFill().frame(width: 46, height: 46).clipShape(Circle())
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack { Text("Rene").font(.subheadline.weight(.semibold)).foregroundStyle(.white); Text("YOUR GUIDE").font(.system(size: 8, weight: .medium)).tracking(1).foregroundStyle(.cyan) }
                                    Text("Talk through what’s next.").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(); Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(.cyan)
                            }.padding(14).background(.cyan.opacity(0.045), in: RoundedRectangle(cornerRadius: 18))
                                .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(.cyan.opacity(0.12), lineWidth: 1) }
                        }.buttonStyle(.plain).padding(.bottom, 20)
                        Text("Messages").font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.bottom, 6)
                        ForEach(threads.filter { $0["other_name"].text.lowercased() != "rene" }, id: \.id) { thread in
                            NavigationLink { ThreadView(thread: thread) } label: {
                                HStack(spacing: 12) {
                                    HQMemberAvatar(url: thread["other_avatar_url"].text, name: thread["other_name"].text)
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack { Text(thread["other_name"].text).font(.subheadline.weight(.medium)).foregroundStyle(.white); Spacer(); Text(thread["last_message"]["created_at"].text.inboxTime).font(.caption2).foregroundStyle(.secondary) }
                                        Text(thread["last_message"]["body"].text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }.padding(.vertical, 12).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            Divider().overlay(.white.opacity(0.03)).padding(.leading, 56)
                        }
                        if loading { ProgressView().padding(12) }
                        if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
                    }.padding(.horizontal, 18).padding(.top, 12)
                }.background(AppNightBackground()).refreshable { await load() }
            }
        }.navigationTitle("Inbox").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { AccountButton() } }
        .task(id: session.signedIn) {
            guard session.signedIn else { return }
            await load()
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(8)); guard !Task.isCancelled else { return }; await load() }
        }
    }
    func load() async {
        loading = threads.isEmpty; defer { loading = false }
        do { threads = try await API.shared.call("threads")["conversations"].list; error = "" } catch { self.error = error.localizedDescription }
    }
}

struct NetworkView: View {
 @EnvironmentObject var session: Session
 var body: some View {
  Group {
   if !session.signedIn { InsiderNetworkWall() }
   else if !session.insider { InsiderNetworkWall() }
   else { CommunityNetworkView() }
  }.navigationTitle("Network").navigationBarTitleDisplayMode(.inline)
 }
}
struct CommunityNetworkView: View {
 @State var posts: [APIValue] = []
 @State var cursor = ""
 @State var filter = "all"
 @State var error = ""
 @State var loading = false
 @State var compose = false
 var body: some View {
  ScrollView { LazyVStack(alignment: .leading, spacing: 18) {
   if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Try again") { Task { await load() } } }
   ForEach(posts, id: \.id) { post in CommunityPostCard(post: post) { Task { await load() } } }
   if loading { ProgressView().frame(maxWidth: .infinity) }
   if !loading && posts.isEmpty && error.isEmpty { ContentUnavailableView("Start the conversation", systemImage: "person.3", description: Text("Share an idea, introduce your project, or tell the community what you’re working on.")) }
   if !cursor.isEmpty { Button("Load more") { Task { await load(more: true) } }.frame(maxWidth: .infinity) }
  }.padding(20) }.refreshable { await load() }.task { await load() }
  .toolbar { ToolbarItem(placement: .principal) { Menu { Picker("Community feed", selection: $filter) { ForEach(["all", "post", "project", "blog", "hackathon", "event"], id: \.self) { kind in Text(label(kind)).tag(kind) } } } label: { HStack(spacing: 8) { Text(filter == "all" ? "Network" : label(filter)).font(.headline); Image(systemName: "chevron.down").font(.caption.weight(.semibold)) } }.menuStyle(.button).buttonStyle(.bordered).accessibilityLabel("Community feed filters") }; ToolbarItem(placement: .topBarTrailing) { NavigationLink { MemberNetworkView() } label: { Image(systemName: "person.2") }.accessibilityLabel("People and connections") } }
  .onChange(of: filter) { _, _ in Task { await load() } }
  .safeAreaInset(edge: .bottom, spacing: 0) {
   HStack { Spacer(); Button { compose = true } label: { Image(systemName: "plus").font(.system(size: 25, weight: .medium)).foregroundStyle(.black).frame(width: 58, height: 58).background(.cyan, in: Circle()).shadow(color: .cyan.opacity(0.2), radius: 16, y: 4) }.buttonStyle(.plain).accessibilityLabel("Create community post") }.padding(.horizontal, 22).padding(.bottom, 12).padding(.top, 8)
  }
  .sheet(isPresented: $compose) { CommunityComposer { Task { await load() } } }
 }
 func label(_ kind: String) -> String { ["all":"All", "post":"Conversations", "project":"Launches", "blog":"Frontier", "hackathon":"Hackathons", "event":"Events"][kind] ?? kind }
 func load(more: Bool = false) async {
  guard !loading else { return }; loading = true; defer { loading = false }
  do { var q = URLComponents(); q.queryItems = filter == "all" ? [] : [URLQueryItem(name: "kind", value: filter)]; if more { q.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
   let result = try await API.shared.call("community/feed?" + (q.percentEncodedQuery ?? ""))
   if more { let ids = Set(posts.map { $0.id }); posts += result["posts"].list.filter { !ids.contains($0.id) } } else { posts = result["posts"].list }
   cursor = result["next_cursor"].text; error = ""
  } catch { self.error = error.localizedDescription }
 }
}
struct CommunityPostCard: View {
 let post: APIValue
 let changed: () -> Void
 @State var error = ""
 @State var report = false
 @State var deleting = false
 @State var blocking = false
 var isCheckIn: Bool { post["kind"].text == "event" && post["body"].text == "Checked into the live session." }
 var body: some View {
  VStack(alignment: .leading, spacing: isCheckIn ? 8 : 14) {
   if isCheckIn {
    HStack(spacing: 10) {
     Avatar(url: post["author"]["avatar_url"].text).scaleEffect(0.7).frame(width: 34, height: 34)
     VStack(alignment: .leading, spacing: 3) {
      Text(post["author"]["display_name"].text).font(.subheadline.weight(.semibold))
      Text("Checked into " + post["title"].text).font(.caption).foregroundStyle(.secondary)
     }
     Spacer(minLength: 4)
     if let url = communityURL(post["link_url"].text) { Link(destination: url) { Image(systemName: "arrow.up.right").font(.subheadline.weight(.semibold)) }.accessibilityLabel("Open event") }
     Menu { Button("Report post", role: .destructive) { report = true }; if !post["author"]["profile_id"].text.isEmpty { Button("Block member", role: .destructive) { blocking = true } }; if post["can_delete"].flag { Button("Delete post", role: .destructive) { deleting = true } } } label: { Image(systemName: "ellipsis").padding(6) }
    }
   } else {
   HStack(spacing: 10) { Avatar(url: post["author"]["avatar_url"].text); VStack(alignment: .leading, spacing: 3) { Text(post["author"]["display_name"].text).font(.subheadline.bold()); Text(post["kind"].text == "post" ? "Conversation" : post["kind"].text.capitalized).font(.caption).foregroundStyle(.cyan); Text(post["created_at"].text.prefix(10)).font(.caption2).foregroundStyle(.secondary) }; Spacer()
    Menu { Button("Report post", role: .destructive) { report = true }; if !post["author"]["profile_id"].text.isEmpty { Button("Block member", role: .destructive) { blocking = true } }; if post["can_delete"].flag { Button("Delete post", role: .destructive) { deleting = true } } } label: { Image(systemName: "ellipsis").padding(8) }
   }
   if post["kind"].text != "blog" && !post["image_url"].text.isEmpty { AsyncImage(url: NativeRoutes.external(post["image_url"].text)) { image in image.resizable().scaledToFill() } placeholder: { Rectangle().fill(.white.opacity(0.05)) }.frame(height: 180).clipped().clipShape(RoundedRectangle(cornerRadius: 16)) }
   if post["kind"].text == "blog" {
    HStack(alignment: .top, spacing: 12) {
     VStack(alignment: .leading, spacing: 8) { Text(post["title"].text).font(.subheadline.bold()); if !post["body"].text.isEmpty { Text(post["body"].text).font(.caption).foregroundStyle(.secondary).lineLimit(3) } }
     if !post["image_url"].text.isEmpty { AsyncImage(url: NativeRoutes.external(post["image_url"].text)) { image in image.resizable().scaledToFill() } placeholder: { Rectangle().fill(.white.opacity(0.05)) }.frame(width: 82, height: 82).clipped().clipShape(RoundedRectangle(cornerRadius: 12)) }
    }
   } else if !post["title"].text.isEmpty { Label(post["title"].text, systemImage: post["kind"].text == "project" ? "paperplane" : post["kind"].text == "event" ? "calendar" : "flag").font(.headline) }
   if post["kind"].text != "blog" && !post["body"].text.isEmpty { Text(post["body"].text).font(.subheadline).textSelection(.enabled) }
   if let url = communityURL(post["link_url"].text) { Link(destination: url) { Label("Open " + (post["kind"].text == "blog" ? "article" : post["kind"].text), systemImage: "arrow.up.right") }.font(.subheadline.bold()).tint(.cyan) }
   }
   HStack(spacing: 22) {
    Button { Task { await action("reaction", method: post["reacted"].flag ? "DELETE" : "PUT") } } label: { Label(communityCount(post["reaction_count"]), systemImage: post["reacted"].flag ? "heart.fill" : "heart") }.tint(post["reacted"].flag ? .cyan : .secondary)
    NavigationLink { CommunityReplies(post: post, changed: changed) } label: { Label(communityCount(post["comment_count"]) + " replies", systemImage: "bubble.left") }.tint(.secondary)
   }.font(isCheckIn ? .caption : .subheadline)
   if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
  }.padding(isCheckIn ? 12 : post["kind"].text == "event" || post["kind"].text == "hackathon" ? 14 : 18).frame(maxWidth: .infinity, alignment: .leading).background(post["kind"].text == "project" ? Color.cyan.opacity(0.065) : Color.white.opacity(post["kind"].text == "post" ? 0.025 : 0.045), in: RoundedRectangle(cornerRadius: 24))
  .sheet(isPresented: $report) { CommunityReport(postID: post.id, commentID: nil) }
  .confirmationDialog("Delete this post?", isPresented: $deleting) { Button("Delete", role: .destructive) { Task { await action("", method: "DELETE") } } }
  .confirmationDialog("Block this member? Their activity will be hidden.", isPresented: $blocking) { Button("Block", role: .destructive) { Task { do { _ = try await API.shared.call("blocks", method: "POST", body: ["profile_id": post["author"]["profile_id"].text]); changed() } catch { self.error = error.localizedDescription } } } }
 }
 func action(_ suffix: String, method: String) async { do { _ = try await API.shared.call("community/posts/" + post.id + (suffix.isEmpty ? "" : "/" + suffix), method: method); changed() } catch { self.error = error.localizedDescription } }
}
func communityURL(_ value: String) -> URL? {
 guard !value.isEmpty, let url = URL(string: value, relativeTo: URL(string: "https://atlantium.ai")!)?.absoluteURL, url.scheme == "https", url.user == nil, url.password == nil else { return nil }; return url
}
struct CommunityComposer: View {
 @Environment(\.dismiss) var dismiss
 let changed: () -> Void
 @State var project = false
 @State var title = ""
 @State var link = ""
 @State var bodyText = ""
 @State var error = ""
 @State var busy = false
 var body: some View { NavigationStack { ScrollView { VStack(alignment: .leading, spacing: 20) {
  Text("Bring the community into what you’re building.").font(.title2.bold())
  Picker("Share", selection: $project) { Text("Conversation").tag(false); Text("Project launch").tag(true) }.pickerStyle(.segmented)
  if project { TextField("Project name", text: $title).textFieldStyle(.roundedBorder); TextField("Public HTTPS link", text: $link).keyboardType(.URL).textInputAutocapitalization(.never).textFieldStyle(.roundedBorder) }
  TextField("What’s happening?", text: $bodyText, axis: .vertical).lineLimit(6...12).padding(16).background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
  Text("Shared with Atlantium Insiders.").font(.caption).foregroundStyle(.secondary)
  if !error.isEmpty { Text(error).foregroundStyle(.red) }
  Button(busy ? "Sharing…" : "Share with the network") { Task { await share() } }.buttonStyle(.borderedProminent).tint(.cyan).disabled(busy || bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || bodyText.count > 5000 || (project && (title.isEmpty || communityURL(link) == nil)))
 }.padding(24) }.navigationTitle("Share").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } } } }
 func share() async { busy = true; defer { busy = false }; do { var payload: [String: Any] = ["kind": project ? "project" : "post", "body": bodyText]; if project { payload["title"] = title; payload["link_url"] = link }; _ = try await API.shared.call("community/posts", method: "POST", body: payload); changed(); dismiss() } catch { self.error = error.localizedDescription } }
}
struct CommunityReplies: View {
 let post: APIValue
 let changed: () -> Void
 @State var replies: [APIValue] = []
 @State var text = ""
 @State var error = ""
 @State var busy = false
 @State var reporting: APIValue?
 var body: some View { ScrollView { LazyVStack(alignment: .leading, spacing: 20) {
  Text(post["title"].text.isEmpty ? post["body"].text : post["title"].text).font(.headline)
  Divider()
  ForEach(replies, id: \.id) { reply in HStack(alignment: .top, spacing: 12) { Avatar(url: reply["author"]["avatar_url"].text); VStack(alignment: .leading, spacing: 6) { Text(reply["author"]["display_name"].text).font(.subheadline.bold()); Text(reply["body"].text).font(.subheadline) }; Spacer(minLength: 0); Menu { Button("Report reply", role: .destructive) { reporting = reply }; if reply["can_delete"].flag { Button("Delete", role: .destructive) { Task { do { _ = try await API.shared.call("community/comments/" + reply.id, method: "DELETE"); await load(); changed() } catch { self.error = error.localizedDescription } } } } } label: { Image(systemName: "ellipsis") } } }
  if replies.isEmpty { Text("Be the first to reply.").foregroundStyle(.secondary) }
  if !error.isEmpty { Text(error).foregroundStyle(.red) }
 }.padding(20) }.navigationTitle("Conversation").navigationBarTitleDisplayMode(.inline).task { await load() }.refreshable { await load() }
 .safeAreaInset(edge: .bottom) { HStack { TextField("Add to the conversation", text: $text, axis: .vertical).lineLimit(1...5); Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.tint(.cyan).disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 2000) }.padding(16).background(.ultraThinMaterial) }
 .sheet(isPresented: Binding(get: { reporting != nil }, set: { if !$0 { reporting = nil } })) { CommunityReport(postID: post.id, commentID: reporting?.id) }
 }
 func load() async { do { replies = try await API.shared.call("community/posts/" + post.id + "/comments")["comments"].list; error = "" } catch { self.error = error.localizedDescription } }
 func send() async { busy = true; defer { busy = false }; do { _ = try await API.shared.call("community/posts/" + post.id + "/comments", method: "POST", body: ["body": text]); text = ""; await load(); changed() } catch { self.error = error.localizedDescription } }
}
struct CommunityReport: View {
 @Environment(\.dismiss) var dismiss
 let postID: String
 let commentID: String?
 @State var reason = ""
 @State var error = ""
 @State var busy = false
 var body: some View { NavigationStack { VStack(alignment: .leading, spacing: 20) { Text("Help keep the community welcoming.").font(.title2.bold()); TextField("Describe the issue", text: $reason, axis: .vertical).lineLimit(4...8); if !error.isEmpty { Text(error).foregroundStyle(.red) }; Button("Send report") { Task { busy = true; defer { busy = false }; do { var payload: [String: Any] = ["reason": reason]; if let commentID { payload["comment_id"] = commentID }; _ = try await API.shared.call("community/posts/" + postID + "/report", method: "POST", body: payload); dismiss() } catch { self.error = error.localizedDescription } } }.buttonStyle(.borderedProminent).disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || reason.count > 1000); Spacer() }.padding(24).navigationTitle("Report").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } } } }
}

func communityCount(_ value: APIValue) -> String { if case .number(let count) = value { return String(Int(count)) }; return "0" }
