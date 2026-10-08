import SwiftUI
struct ChatLine: Identifiable { let id: UUID; let mine: Bool; var text: String; var actions: [APIValue]; init(mine: Bool, text: String, actions: [APIValue] = []) { self.id = UUID(); self.mine = mine; self.text = text; self.actions = actions } }
@MainActor final class ReneStore: ObservableObject {
    @Published var lines = [ChatLine(mine: false, text: "I’m Rene. Ready to go to the frontier? What would you like to work toward?")]
    @Published var actions: [APIValue] = []
    @Published var objective: APIValue = .null
    @Published var references: APIValue = .null
    @Published var opening = false
    @Published var streaming = false
    @Published var activity = ""
    @Published var activitySteps: [APIValue] = []
    @Published var savedJobs: [APIValue] = []
    @Published var visitorDraft: APIValue = .null
    @Published var mutating = false
    @Published var error = ""
    var historySince = ISO8601DateFormatter().string(from: Date())
    var run: Task<Void, Never>?
    func refresh() async { if let value = try? await API.shared.call("rene/objective") { objective = value["objective"]; references = value["references"]; savedJobs = value["jobs"].list; visitorDraft = value["visitorDraft"] } }
    func goal(_ kind: String) async {
        do { objective = try await API.shared.call("rene/objective", method: "POST", body: ["operation": "start", "kind": kind])["objective"]; await send("My long-term goal is " + objective["plan"]["outcome"].text + ". Help me choose a realistic next step.") } catch { self.error = error.localizedDescription }
    }
    func confirm() async { do { let revision: Int; if case .number(let n) = objective["revision"] { revision = Int(n) } else { return }; objective = try await API.shared.call("rene/objective", method: "POST", body: ["operation": "confirm", "revision": revision])["objective"] } catch { self.error = error.localizedDescription } }
    func send(_ text: String) async {
        guard !streaming, !opening, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let retrying = !error.isEmpty && lines.last?.mine == false && lines.last?.text.isEmpty == true && lines.dropLast().last?.text == text
        if retrying { lines.removeLast() } else { lines.append(ChatLine(mine: true, text: text)) }
        lines.append(ChatLine(mine: false, text: "")); let id = lines.last!.id
        streaming = true; actions = []; activitySteps = []; error = ""; activity = "Thinking…"; defer { streaming = false; activity = "" }
        do {
            var body: [String: Any] = ["message": text, "page": "/ios/rene", "stream": true]; if !historySince.isEmpty { body["historySince"] = historySince }; var request = try API.shared.request("rene/chat", method: "POST", body: body); request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let (bytes, response) = try await API.shared.session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw APIError(message: "Rene couldn’t connect. Please sign in and try again.") }
            var parser = SSEByteParser(); var completed = false
            for try await byte in bytes {
                try Task.checkCancellation()
                guard let event = parser.consume(byte), let data = event.data.data(using: .utf8), let value = try? JSONDecoder().decode(APIValue.self, from: data) else { continue }
                if event.name == "delta", let index = lines.firstIndex(where: { $0.id == id }) { lines[index].text += value["text"].text; activity = "" }
                if event.name == "activity" { activitySteps.removeAll { $0.id == value.id }; activitySteps.append(value); if value["status"].text == "running" { activity = value["label"].text + "…" } }
                if event.name == "objective" { objective = value["objective"] }
                if event.name == "done" { if let index = lines.firstIndex(where: { $0.id == id }) { lines[index].text = value["message"]["body"].text; lines[index].actions = value["message"]["actions"].list }; actions = value["message"]["actions"].list; objective = value["objective"]; completed = true }
                if event.name == "error" { throw APIError(message: value["message"].text) }
            }
            guard completed else { throw APIError(message: "This reply was interrupted. Please try again.") }; await refresh()
        } catch is CancellationError { error = "Reply stopped." }
        catch { self.error = error.localizedDescription }
    }
    func openConversation() async {
        guard !streaming, !opening else { return }
        opening = true; activity = "Catching up…"; defer { opening = false; activity = "" }
        do {
            let data = try await API.shared.call("rene/open", method: "POST", body: [:])
            let messages = data["messages"].list
            if !messages.isEmpty {
                lines = messages.map { ChatLine(mine: $0["role"].text == "user", text: $0["body"].text, actions: $0["actions"].list) }
                actions = messages.last?["actions"].list ?? []
                historySince = ""
            }
        } catch { /* Keep chat available if the optional catch-up cannot load. */ }
    }
    func update(_ operation: String, milestone: String? = nil, evidence: String? = nil) async {
        guard !mutating && !streaming else { return }; mutating = true; defer { mutating = false }
        do {
            var body: [String: Any] = ["operation": operation]
            if case .number(let n) = objective["revision"] { body["revision"] = Int(n) }
            if let milestone { body["milestoneId"] = milestone }; if let evidence { body["evidence"] = evidence }
            objective = try await API.shared.call("rene/objective", method: "POST", body: body)["objective"]; error = ""; await refresh()
        } catch { self.error = error.localizedDescription; await refresh() }
    }
    func history() async { do { let data = try await API.shared.call("rene/messages"); lines = data["messages"].list.map { ChatLine(mine: $0["role"].text == "user", text: $0["body"].text, actions: $0["actions"].list) }; actions = data["messages"].list.last?["actions"].list ?? [] } catch { self.error = error.localizedDescription } }
}
struct ReneView: View {
    @EnvironmentObject var session: Session
    @Environment(\.scenePhase) var scenePhase
    @StateObject var store = ReneStore()
    @State var text = ""
    @State var knows = false
    @State private var onboarding = false
    @Environment(\.openURL) private var openURL
    @State var custom = false
    @State var guestGoal = ""
    @State var guestChatted = false
    @FocusState var focused: Bool
    var prompts: [APIValue] { store.actions.filter { $0["kind"].text == "prompt" } }
    var body: some View { VStack(spacing: 0) {
        if store.objective != .null { ReneGoalCard(store: store).padding(.horizontal, 14).padding(.vertical, 8) }
        ScrollViewReader { proxy in ScrollView { LazyVStack(alignment: .leading, spacing: 18) {
            if session.signedIn && !store.streaming { Button("Load previous messages") { Task { await store.history() } }.font(.caption).foregroundStyle(.secondary) }
            ForEach(store.lines) { line in
                VStack(alignment: .leading, spacing: 10) {
                    if !line.text.isEmpty { HStack { if line.mine { Spacer(minLength: 30) }; MarkdownText(text: line.text).font(.subheadline).padding(14).background(line.mine ? Color.cyan.opacity(0.1) : Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 18)); if !line.mine { Spacer(minLength: 15) } } }
                    if !line.mine {
                        if !line.text.isEmpty && !store.streaming { Button { UIPasteboard.general.string = line.text } label: { Label("Copy reply", systemImage: "doc.on.doc").font(.system(size: 10)).foregroundStyle(.secondary) }.buttonStyle(.plain) }
                        ForEach(line.actions.filter { $0["kind"].text == "link" }, id: \.self) { action in ReneResourceCard(action: action) { runAction(action) } }
                        ForEach(line.actions.filter { ["signup", "onboarding"].contains($0["kind"].text) }, id: \.self) { action in Button { runAction(action) } label: { Label(action["label"].text, systemImage: action["kind"].text == "onboarding" ? "person.crop.circle.badge.checkmark" : "arrow.right") }.buttonStyle(ReneChoiceStyle()) }
                    }
                }.id(line.id)
            }
            if !store.activitySteps.isEmpty { ReneActivityCard(steps: store.activitySteps) }
            if !store.savedJobs.isEmpty { DisclosureGroup("Your saved jobs") { ForEach(store.savedJobs, id: \.self) { job in Button { if let url = actionURL("/jobs/" + job["slug"].text) { openURL(url) } } label: { VStack(alignment: .leading, spacing: 4) { Text(job["title"].text).font(.subheadline.weight(.medium)); Text(job["company"].text + " · " + job["status"].text).font(.caption).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(ReneChoiceStyle()) } }.font(.caption).padding(12).background(.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 16)) }
            if store.objective == .null && store.visitorDraft != .null { Button("Save your visitor plan") { Task { await store.update("claim") } }.buttonStyle(ReneChoiceStyle()) }

            if !store.activity.isEmpty { HStack { ProgressView(); Text(store.activity).font(.caption).foregroundStyle(.secondary) } }
            if !store.error.isEmpty { Text(store.error).foregroundStyle(.red); Button("Try again") { if let last = store.lines.last(where: { $0.mine }) { startSend(last.text) } } }
            Color.clear.frame(height: 1).id("bottom")
        }.padding() }.onChange(of: store.lines.last?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }.onChange(of: store.activity) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) } }
    }.navigationTitle("Rene").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .principal) { HStack(spacing: 8) { Image("Rene").resizable().scaledToFill().frame(width: 30, height: 30).clipShape(Circle()); Text("Rene").font(.headline) } }
        ToolbarItem(placement: .topBarTrailing) { if session.signedIn { Button { knows = true } label: { Image(systemName: "brain.head.profile") }.accessibilityLabel("What Rene knows") } else { AccountButton() } }
    }.modifier(ReneComposerBar { composer }).sheet(isPresented: $knows) { references }.sheet(isPresented: $onboarding) { NavigationStack { OnboardingView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { onboarding = false } } } } }.task(id: session.signedIn) { if session.signedIn { await store.refresh(); await store.openConversation(); if !guestGoal.isEmpty && store.objective == .null { await store.goal(guestGoal) } } }
    .onChange(of: scenePhase) { _, phase in if phase == .active && session.signedIn { Task { await store.openConversation() } } }
    .environment(\.openURL, OpenURLAction { url in guard let routed = NativeRoutes.reneLink(url.absoluteString, email: session.user["email"].text) else { return .discarded }; return .systemAction(routed) })
    .onDisappear { store.run?.cancel() } }
    var composer: some View { VStack(alignment: .leading, spacing: 12) {
        if !session.signedIn {
            if guestGoal.isEmpty && !guestChatted { Text("Pick an objective").font(.caption).foregroundStyle(.secondary); HStack { guestButton("Find tech work", "job"); guestButton("Ship an MVP", "mvp"); guestButton("Portfolio", "portfolio") } }
            else { Button("Sign in to begin") { session.showAuth = true }.buttonStyle(.borderedProminent).clipShape(Capsule()) }
        } else if store.objective == .null && store.lines.count == 1 { HStack { goalButton("Find tech work", "job"); goalButton("Ship an MVP", "mvp"); goalButton("Portfolio", "portfolio") } }
        Group {
            if !prompts.isEmpty && !custom { LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) { ForEach(prompts, id: \.self) { action in Button(action["label"].text) { startSend(action["value"].text) }.buttonStyle(ReneChoiceStyle()).disabled(store.streaming || store.opening) } }; Button("Write your own answer") { custom = true; focused = true }.font(.caption).foregroundStyle(.secondary) }
            HStack(alignment: .bottom) { TextField("Ask Rene anything…", text: $text, axis: .vertical).lineLimit(1...5).focused($focused); if store.streaming { Button { store.run?.cancel() } label: { Image(systemName: "stop.circle.fill").font(.title) } } else { Button { let value = text; text = ""; focused = false; startSend(value) } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.disabled(store.opening || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } }.modifier(MessageComposerSurface())
        }
    }.padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading).background(Color.black) }
    func guestButton(_ title: String, _ kind: String) -> some View { Button(title) { guestGoal = kind; store.lines.append(ChatLine(mine: true, text: title)); store.lines.append(ChatLine(mine: false, text: "Good choice. Sign in and we’ll build a plan around your experience, interests, and next step.")) }.buttonStyle(ReneChoiceStyle()) }
    func goalButton(_ title: String, _ kind: String) -> some View { Button(title) { store.run = Task { await store.goal(kind) } }.buttonStyle(ReneChoiceStyle()).disabled(store.streaming || store.opening) }
    func startSend(_ value: String) {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        custom = false
        if !session.signedIn {
            store.lines.append(ChatLine(mine: true, text: value))
            store.lines.append(ChatLine(mine: false, text: "I can help you find tech work, build a project, or grow your portfolio. Sign in so I can understand your experience and help you make a plan."))
            guestChatted = true
            return
        }
        store.run = Task { await store.send(value) }
    }
    func actionURL(_ value: String) -> URL? { NativeRoutes.reneLink(value, email: session.user["email"].text) }
    func runAction(_ action: APIValue) {
        switch action["kind"].text {
        case "prompt": startSend(action["value"].text)
        case "onboarding": if session.signedIn { onboarding = true } else { session.showAuth = true }
        case "signup": if session.signedIn { Task { await store.refresh() } } else { session.showAuth = true }
        case "link": if let url = actionURL(action["value"].text) { openURL(url) }
        default: break
        }
    }
    var references: some View { NavigationStack { List { Text("Private references from your answers. These don’t change your public profile.").font(.footnote).foregroundStyle(.secondary)
        if case .object(let facts) = store.references { ForEach(facts.keys.sorted(), id: \.self) { key in VStack(alignment: .leading) { Text(key.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(.secondary); Text(facts[key]?.text("value") ?? ""); Button("Remove", role: .destructive) { Task { do { store.references = try await API.shared.call("rene/profile", method: "POST", body: ["forget": [key]])["references"] } catch { store.error = error.localizedDescription } } }.font(.caption) } } }
    }.navigationTitle("What Rene knows").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { knows = false } } } } }
}

// Keep the composer in the keyboard-aware safe area, with native scroll-edge treatment.
private struct ReneComposerBar<Composer: View>: ViewModifier {
    @ViewBuilder let composer: () -> Composer
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .bottom, spacing: 0) { composer() }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) { composer() }
        }
    }
}
private struct ReneGlassSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28))
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28))
        }
    }
}

private struct ReneChoiceStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 12, weight: .medium)).multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 11)
            .foregroundStyle(.white.opacity(0.9))
            .background(.white.opacity(configuration.isPressed ? 0.09 : 0.04), in: RoundedRectangle(cornerRadius: 13))
            .overlay { RoundedRectangle(cornerRadius: 13).strokeBorder(.cyan.opacity(configuration.isPressed ? 0.4 : 0.18)) }
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}
private struct ReneResourceCard: View {
    let action: APIValue
    let open: () -> Void
    var preview: APIValue { action["preview"] }
    var job: Bool { action["value"].text.contains("/jobs/") }
    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) { Image(systemName: job ? "briefcase" : "square.stack.3d.up"); Text(preview["site"].text.isEmpty ? "Atlantium" : preview["site"].text).lineLimit(1); Spacer(); Image(systemName: "arrow.up.right").foregroundStyle(.cyan.opacity(0.8)) }.font(.system(size: 10)).foregroundStyle(.white.opacity(0.5)).padding(.horizontal, 12).padding(.vertical, 8)
                Rectangle().fill(.white.opacity(0.055)).frame(height: 1)
                HStack(alignment: .top, spacing: 10) {
                    if let url = NativeRoutes.external(preview["image"].text) { AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Color.white.opacity(0.03) }.frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 10)) }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(preview["title"].text.isEmpty ? action["label"].text : preview["title"].text).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                        if !preview["description"].text.isEmpty { Text(preview["description"].text).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55)).lineLimit(3).lineSpacing(2) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.padding(12)
            }.background(Color(red: 0.028, green: 0.053, blue: 0.073), in: RoundedRectangle(cornerRadius: 16)).overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.1)) }
        }.buttonStyle(.plain)
    }
}
private struct ReneActivityCard: View {
    let steps: [APIValue]
    var running: Bool { steps.contains { $0["status"].text == "running" } }
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(steps, id: \.self) { step in HStack(spacing: 8) { Image(systemName: step["status"].text == "failed" ? "exclamationmark.circle" : step["status"].text == "running" ? "ellipsis" : "checkmark.circle").foregroundStyle(step["status"].text == "failed" ? Color.red.opacity(0.7) : Color.cyan.opacity(0.6)); Text(step["label"].text).frame(maxWidth: .infinity, alignment: .leading); Text(step["status"].text).foregroundStyle(.secondary) }.font(.system(size: 10)) }
            }.padding(.top, 8)
        } label: { HStack(spacing: 8) { if running { ProgressView().controlSize(.mini) } else { Image(systemName: "checkmark.circle").foregroundStyle(.cyan.opacity(0.7)) }; Text(running ? "Working with your context" : "\(steps.count) steps checked").foregroundStyle(.secondary) }.font(.caption) }
            .padding(12).background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 14)).overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.08)) }
    }
}
private struct ReneGoalCard: View {
    @ObservedObject var store: ReneStore
    @State private var expanded = false
    @State private var reportID = ""
    @State private var reporting = false
    @State private var evidence = ""
    var plan: APIValue { store.objective["proposal"] == .null ? store.objective["plan"] : store.objective["proposal"] }
    var proposed: Bool { store.objective["status"].text == "draft" || store.objective["proposal"] != .null }
    var locked: Bool { store.streaming || store.opening || store.mutating }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 10) {
                    Image(systemName: "target").font(.system(size: 17)).foregroundStyle(.cyan.opacity(0.8))
                    VStack(alignment: .leading, spacing: 3) { Text(proposed ? "PROPOSED GOAL" : "YOUR GOAL").font(.system(size: 9, weight: .semibold)).tracking(1.2).foregroundStyle(.white.opacity(0.5)); Text(plan["title"].text).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white).lineLimit(2) }
                    Spacer(); Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.secondary)
                }
            }.buttonStyle(.plain)
            if proposed { HStack(spacing: 6) { Button("Accept plan") { Task { await store.update("confirm") } }.buttonStyle(ReneChoiceStyle()); if store.objective["proposal"] != .null { Button("Keep current plan") { Task { await store.update("dismiss") } }.buttonStyle(ReneChoiceStyle()) } }.disabled(locked) }
            if expanded { details }
        }.padding(12).background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 16)).overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.08)) }
        .alert("Report milestone progress", isPresented: $reporting) {
            TextField("What did you complete?", text: $evidence)
            Button("Save progress") { Task { await store.update("report", milestone: reportID, evidence: String(evidence.prefix(1000))) } }.disabled(evidence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) { evidence = "" }
        } message: { Text("Describe the work you completed. This records your own progress report.") }
    }
    var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !plan["outcome"].text.isEmpty { Text(plan["outcome"].text).font(.caption).foregroundStyle(.secondary) }
            let next = store.objective["state"]["nextAction"].text.isEmpty ? plan["nextAction"].text : store.objective["state"]["nextAction"].text
            if !next.isEmpty { VStack(alignment: .leading, spacing: 4) { Text("NEXT STEP").font(.system(size: 9, weight: .semibold)).foregroundStyle(.cyan.opacity(0.8)); Text(next).font(.caption).foregroundStyle(.white.opacity(0.8)) } }
            ForEach(plan["milestones"].list, id: \.id) { milestone in
                let complete = store.objective["state"]["progress"][milestone.id] != .null
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: complete ? "checkmark.circle.fill" : "circle").foregroundStyle(complete ? Color.mint.opacity(0.8) : Color.white.opacity(0.3))
                    VStack(alignment: .leading, spacing: 3) { Text(milestone["title"].text).font(.caption.weight(.medium)); Text(milestone["criteria"].text).font(.system(size: 10)).foregroundStyle(.secondary) }
                    Spacer(minLength: 0)
                    if !complete && store.objective["status"].text == "active" && !proposed { Button { reportID = milestone.id; evidence = ""; reporting = true } label: { Image(systemName: "plus.circle").foregroundStyle(.cyan.opacity(0.7)) }.disabled(locked).accessibilityLabel("Report progress for " + milestone["title"].text) }
                }.font(.caption).padding(.vertical, 3)
            }
            if !proposed { HStack(spacing: 6) {
                if store.objective["status"].text == "active" { Button("Pause goal") { Task { await store.update("pause") } }.buttonStyle(ReneChoiceStyle()); Button("Mark goal achieved") { Task { await store.update("finish") } }.buttonStyle(ReneChoiceStyle()) }
                if store.objective["status"].text == "paused" { Button("Resume goal") { Task { await store.update("resume") } }.buttonStyle(ReneChoiceStyle()) }
            }.disabled(locked) }
        }
    }
}
