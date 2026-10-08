import SwiftUI
struct ProfileFormView: View {
    @EnvironmentObject var session: Session
    var editing = false
    @State var first = ""
    @State var last = ""
    @State var headline = ""
    @State var branch = "professional"
    @State var seeking = "open"
    @State var visibility = "private"
    @State var interests = Set<String>()
    @State var error = ""
    @State var busy = false
    @State var loaded = false
    let options = [("ai_fundamentals", "AI fundamentals"), ("building_agents", "AI agents"), ("software_engineering", "Software engineering"), ("product_design", "Product design"), ("startups_entrepreneurship", "Startups"), ("research_papers", "Research")]
    var body: some View { Form {
        Section { Text(editing ? "Your profile" : "Welcome to the network").font(.title2.bold()); Text("Help members understand who you are and what you’re working toward.").foregroundStyle(.secondary) }
        Section("What should we call you?") { TextField("First name", text: $first).textContentType(.givenName); TextField("Last name", text: $last).textContentType(.familyName) }
        Section("About you") {
            Picker("I’m here as a", selection: $branch) { Text("Professional").tag("professional"); Text("Founder").tag("founder"); Text("Investor").tag("investor"); Text("Advisor").tag("advisor"); Text("Hiring").tag("hiring") }
            TextField("What are you working on?", text: $headline, axis: .vertical).lineLimit(1...3)
            if branch == "professional" { Picker("Looking for work", selection: $seeking) { Text("Open to opportunities").tag("open"); Text("Actively looking").tag("actively_looking"); Text("Not seeking").tag("not_seeking") }; Picker("Who can see this", selection: $visibility) { Text("Only me").tag("private"); Text("Matched members").tag("matched_only"); Text("Verified employers").tag("verified_employers"); Text("All members").tag("all_members") } }
        }
        Section("Your interests") { ForEach(options, id: \.0) { key, title in Button { if interests.contains(key) { interests.remove(key) } else { interests.insert(key) } } label: { HStack { Text(title).foregroundStyle(.primary); Spacer(); if interests.contains(key) { Image(systemName: "checkmark.circle.fill") } } } } }
        Section { Text("Your name, headline, and interests appear to other members. Rene can use your saved answers to guide you.").font(.footnote).foregroundStyle(.secondary); Button(editing ? "Save profile" : "Join the network") { Task { await save() } }.disabled(busy || first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || last.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || headline.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || interests.isEmpty); if busy { ProgressView() }; if !error.isEmpty { Text(error).foregroundStyle(.red) } }
    }.task { guard !loaded else { return }; await session.loadProfile(); let value = session.profile; first = value["first_name"].text; last = value["last_name"].text; headline = value["bio"].text; let registration = value["registration_details"]; if !registration["branch"].text.isEmpty { branch = registration["branch"].text }; interests = Set(registration["interests"].list.map(\.text)); if !registration["seeking"].text.isEmpty { seeking = registration["seeking"].text }; if !registration["seeking_visibility"].text.isEmpty { visibility = registration["seeking_visibility"].text }; loaded = true } }
    func save() async { busy = true; defer { busy = false }; do {
        // Existing fields are merged by the backend; this never discards prior questionnaire answers.
        _ = try await API.shared.call("profile/edit", method: "POST", body: ["profile": ["display_name": first.trimmingCharacters(in: .whitespacesAndNewlines) + " " + last.trimmingCharacters(in: .whitespacesAndNewlines), "bio": headline, "registration_details": ["branch": branch, "headline": headline, "interests": Array(interests), "timezone": TimeZone.current.identifier, "seeking": seeking, "seeking_visibility": visibility, "is_completed": true]]])
        let roles = try await API.shared.call("me/roles")["roles"].list
        let role = branch == "hiring" ? "professional" : branch
        if !roles.contains(where: { $0["role"].text == role }) { _ = try await API.shared.call("me/roles", method: "POST", body: ["role": role, "is_primary": roles.isEmpty]) }
        if branch == "professional", let professional = try await API.shared.call("me/roles")["roles"].list.first(where: { $0["role"].text == "professional" }) { _ = try await API.shared.call("me/roles/" + professional.id + "/seeking", method: "PATCH", body: ["seeking": seeking, "visibility": visibility]) }
        await session.loadProfile(); error = "Profile saved."
    } catch { self.error = error.localizedDescription } }
}
