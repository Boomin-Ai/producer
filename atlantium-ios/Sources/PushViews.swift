import SwiftUI

struct NotificationSettingsView: View {
    @Environment(\.dismiss) var dismiss
    var body: some View { NavigationStack { NotificationPreferencesView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } } } }
}
struct NotificationPreferencesView: View {
    @EnvironmentObject var session: Session
    @ObservedObject var push = OneSignalManager.shared
    @State var error = ""
    @State var saving = false
    var body: some View { Form {
        Section { Button("iPhone notification settings") { push.openSettings() } }
        Section("Keep me updated") {
            preference("Frontier blog posts", "blog")
            preference("Daily job report", "jobs")
        }
        if session.signedIn { Section("My activity") { preference("New messages", "messages"); preference("Registered event reminders", "events") } }
        Section { Text("Event reminders arrive about 10 minutes before and when your registered session starts. Message alerts keep the message text off your lock screen.").font(.footnote).foregroundStyle(.secondary) }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Notifications").task(id: session.signedIn) { if session.signedIn { await push.loadPreferences() } } }
    func preference(_ title: String, _ key: String) -> some View {
        Toggle(title, isOn: Binding(get: { push.preferences[key] ?? true }, set: { enabled in
            saving = true
            Task { do { try await push.updatePreference(key, enabled: enabled, signedIn: session.signedIn); error = "" } catch { self.error = error.localizedDescription }; saving = false }
        })).disabled(saving)
    }
}
struct PushDetailView: View {
    let destination: PushDestination
    @State var data: APIValue = .null
    @State var error = ""
    @State var loaded = false
    var body: some View { Group {
        switch destination {
        case .blog(let slug): PublicDetail(kind: .feed, item: .object(["slug": .string(slug)]))
        case .jobs(let day): JobReportView(day: day)
        case .message:
            if data != .null { if data["other_name"].text.lowercased() == "rene" { ReneView().toolbar(.hidden, for: .tabBar) } else { ThreadView(thread: data) } } else { loading }
        case .event:
            if data != .null { EventDetail(event: data) } else { loading }
        }
    }.task(id: destination) { await load() } }
    @ViewBuilder var loading: some View {
        if !error.isEmpty { LoadError(message: error) { Task { await load() } } }
        else { ProgressView("Opening…").frame(maxWidth: .infinity, maxHeight: .infinity) }
    }
    func load() async {
        do {
            switch destination {
            case .message(let id): data = try await API.shared.call("threads/" + id + "/messages")["conversation"]
            case .event(let id):
                let sessions = try await API.shared.call("office-hours")["sessions"].list
                guard let event = sessions.first(where: { $0.id == id }) else { throw APIError(message: "This event is no longer available. Check Events for upcoming sessions.") }; data = event
            default: break
            }; loaded = true; error = ""
        } catch { self.error = error.localizedDescription }
    }
}
struct JobReportView: View {
    let day: String
    @State var report: APIValue = .null
    @State var error = ""
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 24) {
        Text("Your job report").font(.largeTitle.bold()); Text(day).foregroundStyle(.secondary)
        if report != .null {
            HStack { metric("Active roles", "total_active"); Spacer(); metric("New today", "new_today") }
            HStack { metric("Remote roles", "remote_count"); Spacer(); metric("New this week", "new_7d") }
        } else if error.isEmpty { ProgressView() }
        if !error.isEmpty { Text(error).foregroundStyle(.secondary) }
        NavigationLink { PublicList(kind: .jobs).navigationTitle("Jobs") } label: { Label("Browse tech jobs", systemImage: "briefcase") }.buttonStyle(.borderedProminent)
    }.padding(24).frame(maxWidth: .infinity, alignment: .leading) }.navigationTitle("Job report").navigationBarTitleDisplayMode(.inline).task { do {
        let reports = try await API.shared.call("job_postings/history?days=90")["snapshots"].list
        report = reports.first(where: { String($0["day"].text.prefix(10)) == day }) ?? .null
        if report == .null { error = "This report is no longer available. You can still browse the latest jobs." }
    } catch { self.error = error.localizedDescription } } }
    func metric(_ title: String, _ key: String) -> some View { VStack(alignment: .leading, spacing: 6) { Text(report[key].text).font(.title.bold()); Text(title).font(.subheadline).foregroundStyle(.secondary) } }
}
