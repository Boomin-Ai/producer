import SwiftUI
import AuthenticationServices

struct AppEntryView: View {
    @EnvironmentObject var session: Session
    @AppStorage("atlantium.welcome.completed") var welcomed = false
    #if DEBUG
    @StateObject private var accountPreview: Session = {
        let value = Session()
        value.user = .object(["id": .string("preview"), "name": .string("Atlantium member"), "email": .string("member@example.com")])
        value.profile = .object(["display_name": .string("Atlantium member")])
        return value
    }()
    #endif
    @ObservedObject var push = OneSignalManager.shared
    var previewWelcome: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("--preview-welcome")
        #else
        return false
        #endif
    }
    var body: some View {
        Group {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--preview-account") { AccountView().environmentObject(accountPreview) }
            else { entry }
            #else
            entry
            #endif
        }.onAppear { }
    }
    var entry: some View {
        Group {
            if previewWelcome {
                WelcomeView {}
            }
            else if !session.ready { ProgressView("Welcome to Atlantium") }
            else if session.showAuth && !session.signedIn { WelcomeView { session.showAuth = false; welcomed = true } }
            else if !welcomed && !session.signedIn { WelcomeView { welcomed = true } }
            else { RootView() }
        }.onAppear {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--show-welcome") { welcomed = false }
            #endif
        }.onChange(of: push.pendingDestination) { _, destination in
            guard session.ready, let destination else { return }; welcomed = true
            if destination.needsAccount && !session.signedIn { session.showAuth = true }
        }.onChange(of: session.ready) { _, ready in
            guard ready, let route = push.pendingDestination else { return }; welcomed = true
            if route.needsAccount && !session.signedIn { session.showAuth = true }
        }.onChange(of: session.signedIn) { _, value in if value { welcomed = true } }
    }
}
struct WelcomeView: View {
    @EnvironmentObject var session: Session
    let browse: () -> Void
    @State private var signingIn = false
    @State private var email = ""
    @State private var code = ""
    @State private var sent = false
    @State private var busy = false
    @State private var error = ""
    @StateObject private var google = NativeGoogleSignIn()
    @State private var appleNonce = ""
    @FocusState private var focused: Bool
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                FrontierAtmosphere().ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 0) {
                        HStack { Text("ATLANTIUM").font(.caption.weight(.semibold)).tracking(4); Spacer(); Image(systemName: "sparkle").foregroundStyle(.cyan) }.padding(.top, 22)
                        Spacer(minLength: signingIn ? 18 : 40)
                        ZStack {
                            Circle().fill(.cyan.opacity(0.12)).frame(width: signingIn ? 130 : 190, height: signingIn ? 130 : 190).blur(radius: 26)
                            Circle().strokeBorder(.white.opacity(0.12), lineWidth: 1).frame(width: signingIn ? 112 : 154, height: signingIn ? 112 : 154)
                            Image("Brand").resizable().scaledToFit().frame(width: signingIn ? 82 : 114, height: signingIn ? 82 : 114).clipShape(RoundedRectangle(cornerRadius: 30)).shadow(color: .cyan.opacity(0.25), radius: 30)
                        }.accessibilityHidden(true)
                        Spacer(minLength: signingIn ? 24 : 48)
                        VStack(alignment: .leading, spacing: 18) {
                            Text("Your path to\nthe frontier.").font(.system(size: signingIn ? 34 : 44, weight: .medium)).tracking(-1.8).fixedSize(horizontal: false, vertical: true)
                            Text("Find your people. Be part of what’s next.").font(.subheadline).foregroundStyle(.white.opacity(0.68))
                            Text("Network · Live · Jobs · Directory").font(.caption).foregroundStyle(.white.opacity(0.48)).padding(.top, 4)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Spacer(minLength: 34)
                        VStack(spacing: 12) {
                            if signingIn {
                                VStack(alignment: .leading, spacing: 12) {
                                    if sent {
                                        Text("Check your email").font(.headline)
                                        Text("Enter the code sent to " + email + ".").font(.caption).foregroundStyle(.secondary)
                                    }
                                    HStack(spacing: 10) {
                                        if sent {
                                            TextField("Six-digit code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode).font(.title3.monospaced()).focused($focused)
                                        } else {
                                            TextField("Email address", text: $email).keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused).font(.subheadline)
                                        }
                                        Button { Task { await verifyEmail() } } label: {
                                            Group { if busy { ProgressView().tint(.black) } else { Image(systemName: "arrow.right").font(.system(size: 18, weight: .semibold)) } }.frame(width: 46, height: 46).foregroundStyle(.black).background(.cyan, in: RoundedRectangle(cornerRadius: 15)).shadow(color: .cyan.opacity(0.18), radius: 10)
                                        }.buttonStyle(.plain).accessibilityLabel(sent ? "Verify code" : "Verify with email").disabled(busy || (sent ? code.count != 6 : !email.contains("@"))).opacity(busy || (sent ? code.count != 6 : !email.contains("@")) ? 0.4 : 1)
                                    }.padding(.leading, 18).padding(8).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 23)).overlay { RoundedRectangle(cornerRadius: 23).strokeBorder(.white.opacity(0.08), lineWidth: 1) }
                                    if !sent {
                                        HStack { Rectangle().frame(height: 1); Text("or").font(.caption); Rectangle().frame(height: 1) }.foregroundStyle(.white.opacity(0.2)).padding(.vertical, 2)
                                        SignInWithAppleButton(.continue) { request in
                                            focused = false; error = ""; busy = true
                                            request.requestedScopes = [.fullName, .email]
                                            request.nonce = appleNonce
                                        } onCompletion: { result in
                                            Task { await completeAppleSignIn(result) }
                                        }.signInWithAppleButtonStyle(.white)
                                            .frame(height: 54).clipShape(Capsule())
                                            .disabled(busy || appleNonce.isEmpty)
                                            .accessibilityLabel("Continue with Apple")
                                        Button { Task { await signInWithGoogle() } } label: { HStack(spacing: 10) { Image("GoogleMark").resizable().scaledToFit().frame(width: 18, height: 18); Text("Continue with Google").font(.subheadline.weight(.medium)) }.frame(maxWidth: .infinity).padding(18).background(.ultraThinMaterial, in: Capsule()) }.buttonStyle(.plain).disabled(busy)
                                    }
                                    if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
                                    Button(sent ? "Use another email" : "Back") { withAnimation(.easeInOut(duration: 0.25)) { if sent { sent = false; code = "" } else { signingIn = false; session.showAuth = false }; error = ""; focused = false } }.font(.caption).foregroundStyle(.secondary).disabled(busy).frame(maxWidth: .infinity).padding(.vertical, 4)
                                }.transition(.opacity)
                            } else {
                                Button { withAnimation(.easeInOut(duration: 0.3)) { signingIn = true } } label: { HStack { Text("Sign in"); Spacer(); Image(systemName: "arrow.up.right") }.font(.subheadline.weight(.semibold)).padding(20).frame(maxWidth: .infinity).foregroundStyle(.black).background(.white, in: Capsule()) }.buttonStyle(.plain)
                            }
                            if !signingIn { Button { focused = false; session.showAuth = false; browse() } label: { Text("Continue without an account").font(.subheadline.weight(.medium)).padding(20).frame(maxWidth: .infinity).background(.ultraThinMaterial, in: Capsule()).overlay { Capsule().strokeBorder(.white.opacity(0.14), lineWidth: 1) } }.buttonStyle(.plain).foregroundStyle(.white) }
                            Text(signingIn ? "We’ll email your code. No marketing subscription." : "Explore the frontier. Join when you’re ready.").font(.caption2).foregroundStyle(.white.opacity(0.45)).padding(.top, 8)
                        }.padding(.bottom, 26)
                    }.padding(.horizontal, 28).frame(maxWidth: 460).frame(minHeight: geometry.size.height).frame(maxWidth: .infinity)
                }.scrollBounceBehavior(.basedOnSize).scrollDismissesKeyboard(.interactively)
                .onAppear { signingIn = session.showAuth }
                .task(id: signingIn) { if signingIn { await prepareAppleSignIn() } }
            }
        }
    }
    func verifyEmail() async {
        busy = true; error = ""; focused = false; defer { busy = false }
        do {
            if sent { try await session.verify(email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), code: code) }
            else {
                _ = try await API.shared.call("auth/otp", method: "POST", body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()])
                withAnimation { sent = true }; focused = true
            }
        } catch { self.error = error.localizedDescription }
    }
    func prepareAppleSignIn() async {
        appleNonce = ""
        do { appleNonce = try await API.shared.call("auth/apple/start", method: "POST", body: [:])["nonce"].text }
        catch { self.error = "Apple sign-in is unavailable right now. You can still use email or Google." }
    }
    func completeAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        defer { busy = false }
        do {
            let authorization = try result.get()
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken, let token = String(data: tokenData, encoding: .utf8),
                  let codeData = credential.authorizationCode, let code = String(data: codeData, encoding: .utf8),
                  !appleNonce.isEmpty else { throw APIError(message: "Apple sign-in could not be completed. Please try again.") }
            var body: [String: Any] = ["token": token, "code": code, "nonce": appleNonce]
            if let first = credential.fullName?.givenName { body["first_name"] = first }
            if let last = credential.fullName?.familyName { body["last_name"] = last }
            _ = try await API.shared.call("auth/apple/verify", method: "POST", body: body)
            await session.restore()
            guard session.signedIn else { throw APIError(message: "Sign-in could not be completed.") }
            session.showAuth = false
        } catch {
            if (error as? ASAuthorizationError)?.code != .canceled { self.error = error.localizedDescription }
            await prepareAppleSignIn()
        }
    }
    func signInWithGoogle() async {
        busy = true; error = ""; focused = false; defer { busy = false }
        do { try await google.signIn(); await session.restore(); guard session.signedIn else { throw APIError(message: "Sign-in could not be completed.") }; session.showAuth = false }
        catch { if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { self.error = error.localizedDescription } }
    }

}

struct OnboardingView: View {
    var editing = false
    var body: some View { if editing { ProfileFormView(editing: true) } else { MemberOnboardingView() } }
}
struct MemberOnboardingView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var session: Session
    @State var answers: [String: String] = [:]
    @State var multiple: [String: Set<String>] = [:]
    @State var index = 0
    @State var loaded = false
    @State var busy = false
    @State var error = ""
    @State var companies: [APIValue] = []
    @State var orgSearch = ""
    @State var selectedOrg: APIValue = .null
    @State var orgNone = false
    var steps: [MemberQuestion] { MemberQuestion.steps(branch: answers["branch"] ?? "") }
    var question: MemberQuestion { steps[min(index, steps.count - 1)] }
    func binding(_ key: String) -> Binding<String> { Binding(get: { answers[key] ?? "" }, set: { answers[key] = $0 }) }
    var valid: Bool {
        if question.optional { return true }
        switch question.kind {
        case "identity": return ["first_name", "last_name"].allSatisfy { !(answers[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (answers[$0] ?? "").count <= 50 }
        case "multi": return !(multiple[question.field ?? ""] ?? []).isEmpty
        case "choice", "branch", "text":
            let value = (answers[question.field ?? ""] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return !value.isEmpty && (question.id != "headline" || value.count <= 140) && (question.id != "hiring_roles" || value.count <= 600)
        default: return true
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) { HStack { Text("Your introduction").font(.caption.weight(.semibold)); Spacer(); Text("\(index + 1) of \(steps.count)").font(.caption).foregroundStyle(.secondary) }; ProgressView(value: Double(index + 1), total: Double(steps.count)) }.padding(.horizontal, 24).padding(.top, 16)
            ScrollView { VStack(alignment: .leading, spacing: 20) {
                Text(question.question).font(.title.bold())
                if let help = question.help { Text(help).foregroundStyle(.secondary) }
                controls
                if !error.isEmpty { Text(error).foregroundStyle(.red) }
            }.padding(24).frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity) }.scrollDismissesKeyboard(.interactively)
        }.navigationTitle("Welcome to the network").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            HStack {
                if index > 0 { Button("Back") { index -= 1; error = "" }.buttonStyle(.bordered) }
                Button { Task { await next() } } label: { HStack { Text(index == steps.count - 1 ? "Finish — join free" : "Continue"); if busy { ProgressView() } }.frame(maxWidth: .infinity).padding(.vertical, 8) }.buttonStyle(.borderedProminent).disabled(!loaded || !valid || busy)
            }.padding(20).background(.regularMaterial)
        }.toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Sign out") { Task { await session.signOut() } }.disabled(busy) } }
        .task { await load() }
        .task(id: orgSearch) { guard orgSearch.count > 1 else { companies = []; return }; try? await Task.sleep(for: .milliseconds(350)); guard !Task.isCancelled else { return }; var c = URLComponents(); c.queryItems = [URLQueryItem(name: "q", value: orgSearch), URLQueryItem(name: "kind", value: "company"), URLQueryItem(name: "limit", value: "10")]; if let data = try? await API.shared.call("directory?" + (c.percentEncodedQuery ?? "")), !Task.isCancelled { companies = data["entries"].list } }
    }
    @ViewBuilder var controls: some View {
        switch question.kind {
        case "identity":
            field("First name", "first_name", type: .givenName)
            field("Last name", "last_name", type: .familyName)
            Text("You can add a photo from your profile later.").font(.footnote).foregroundStyle(.secondary)
        case "text":
            TextField(question.placeholder ?? "Your answer", text: binding(question.field!), axis: .vertical).lineLimit(question.id == "hiring_roles" ? 3...8 : 1...3).textFieldStyle(.roundedBorder)
        case "branch", "choice", "multi":
            ForEach(question.options) { option in
                let key = question.field ?? ""; let selected = question.kind == "multi" ? (multiple[key] ?? []).contains(option.value) : answers[key] == option.value
                Button { if question.kind == "multi" { var set = multiple[key] ?? []; if selected { set.remove(option.value) } else { set.insert(option.value) }; multiple[key] = set } else {
                    if key == "branch" && answers[key] != option.value {
                        for field in ["org_entry_id", "org_proposed_name", "org_name", "org_title"] { answers.removeValue(forKey: field) }
                        selectedOrg = .null; orgNone = false; orgSearch = ""
                    }
                    answers[key] = option.value
                } } label: { HStack { Text(option.label).foregroundStyle(.primary).multilineTextAlignment(.leading); Spacer(); Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? .cyan : .secondary) }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(selected ? Color.cyan.opacity(0.12) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16)) }.accessibilityAddTraits(selected ? .isSelected : [])
            }
        case "org":
            TextField("Search for your company", text: $orgSearch).textFieldStyle(.roundedBorder)
            if selectedOrg != .null { Label(selectedOrg["name"].text, systemImage: "checkmark.circle.fill").foregroundStyle(.cyan); Button("Choose another") { selectedOrg = .null; answers.removeValue(forKey: "org_entry_id"); answers.removeValue(forKey: "org_name") } }
            ForEach(companies, id: \.id) { org in Button(org["name"].text) { selectedOrg = org; answers["org_entry_id"] = org.id; answers["org_name"] = org["name"].text; answers.removeValue(forKey: "org_proposed_name"); orgNone = false; orgSearch = "" }.buttonStyle(.bordered) }
            if selectedOrg == .null && !orgNone { field("Company not listed? Enter its name", "org_proposed_name") }
            if question.withTitle { field("Your title (optional)", "org_title") }
            Button(question.noOrgLabel ?? "Skip company for now") { orgNone = true; selectedOrg = .null; answers.removeValue(forKey: "org_entry_id"); answers.removeValue(forKey: "org_proposed_name"); answers.removeValue(forKey: "org_name"); orgSearch = "" }.buttonStyle(.bordered)
            if orgNone { Text("No organization selected.").font(.footnote).foregroundStyle(.secondary) }
        case "seeking":
            Picker("Looking for work", selection: binding("seeking")) { Text("Open to opportunities").tag("open"); Text("Actively looking").tag("actively_looking"); Text("Not seeking").tag("not_seeking") }.pickerStyle(.inline)
            Picker("Who can see this?", selection: binding("seeking_visibility")) { Text("Only me").tag("private"); Text("Matched members").tag("matched_only"); Text("Verified employers").tag("verified_employers"); Text("All members").tag("all_members") }.pickerStyle(.inline)
        default: EmptyView()
        }
        if question.optional { Text("Optional — continue to skip.").font(.footnote).foregroundStyle(.secondary) }
    }
    func field(_ title: String, _ key: String, type: UITextContentType? = nil) -> some View { TextField(title, text: binding(key)).textContentType(type).textFieldStyle(.roundedBorder) }
    func load() async {
        guard !loaded else { return }; await session.loadProfile()
        let profile = session.profile
        if case .object(let registration) = profile["registration_details"] { for (key, value) in registration { if case .array(let values) = value { multiple[key] = Set(values.map(\.text)) } else if case .string(let text) = value { answers[key] = text } } }
        answers["first_name"] = profile["first_name"].text; answers["last_name"] = profile["last_name"].text
        answers["headline"] = profile["bio"].text
        orgNone = profile["registration_details"]["org_none"].flag
        if let orgID = answers["org_entry_id"] { selectedOrg = .object(["id": .string(orgID), "name": .string(answers["org_name"] ?? "Your company")]) }
        if answers["seeking"] == nil { answers["seeking"] = "open" }; if answers["seeking_visibility"] == nil { answers["seeking_visibility"] = "private" }
        if case .number(let saved) = profile["registration_details"]["ios_onboarding_step"] { index = min(Int(saved), steps.count - 1) }
        loaded = true
    }
    func next() async {
        busy = true; error = ""; defer { busy = false }
        do {
            let finish = index == steps.count - 1
            var registration: [String: Any] = answers.filter { !["first_name", "last_name"].contains($0.key) }.mapValues { $0 as Any }
            for (key, values) in multiple { registration[key] = values.sorted() }
            registration["timezone"] = TimeZone.current.identifier; registration["org_none"] = orgNone
            registration["is_completed"] = finish; registration["ios_onboarding_step"] = finish ? 0 : index + 1
            if finish { registration["membership_tier"] = "free"; registration["onboarding_completed_at"] = ISO8601DateFormatter().string(from: Date()) }
            let first = (answers["first_name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines), last = (answers["last_name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await API.shared.call("profile/edit", method: "POST", body: ["profile": ["first_name": first, "last_name": last, "display_name": first + " " + last, "bio": answers["headline"] ?? "", "registration_details": registration]])
            if finish { await saveRole(); await session.loadProfile(); dismiss() } else { withAnimation { index += 1 } }
        } catch { self.error = error.localizedDescription }
    }
    func saveRole() async {
        let branch = answers["branch"] ?? "professional", role = branchRole
        do {
            var payload: [String: Any] = ["role": role, "is_primary": true]
            if let org = answers["org_entry_id"] { payload["entry_id"] = org }; if let title = answers["org_title"] { payload["title"] = title }
            let roles = try await API.shared.call("me/roles", method: "POST", body: payload)["roles"].list
            if let memberRole = roles.first(where: { $0["role"].text == role }) {
                if branch == "professional" { _ = try await API.shared.call("me/roles/" + memberRole.id + "/seeking", method: "PATCH", body: ["seeking": answers["seeking"] ?? "open", "visibility": answers["seeking_visibility"] ?? "private"]) }
                var details: [String: Any] = [:]
                let keys = branch == "professional" ? ["education"] : branch == "founder" ? ["venture_stage", "needs"] : branch == "investor" ? ["focus_stages", "intro_appetite"] : branch == "advisor" ? ["domains", "engagement", "availability"] : ["hiring_contact"]
                for key in keys { if let value = answers[key], !value.isEmpty { details[key] = value }; if let value = multiple[key], !value.isEmpty { details[key] = value.sorted() } }
                if branch == "hiring" { details["hiring_roles"] = Array((answers["hiring_roles_text"] ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.prefix(12)) }
                if branch == "investor" { let bands: [String: [String: Int]] = ["under_25k": ["check_min": 0, "check_max": 25000], "25_100k": ["check_min": 25000, "check_max": 100000], "100_500k": ["check_min": 100000, "check_max": 500000], "500k_plus": ["check_min": 500000]]; for (key, value) in bands[answers["check_band"] ?? ""] ?? [:] { details[key] = value } }
                if !details.isEmpty { _ = try await API.shared.call("me/roles/" + memberRole.id + "/details", method: "PATCH", body: details) }
            }
            let relationship = branch == "founder" ? "founder" : branch == "investor" ? "representative" : branch == "hiring" ? "recruiter" : "employee"
            if let proposed = answers["org_proposed_name"], !proposed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { _ = try await API.shared.call("org-requests", method: "POST", body: ["proposed_name": proposed, "relationship": relationship, "evidence": "Named during iOS onboarding."]) }
            else if let entry = answers["org_entry_id"], ["founder", "investor", "hiring"].contains(branch) { _ = try await API.shared.call("org-requests", method: "POST", body: ["entry_id": entry, "relationship": relationship, "evidence": "Claimed during iOS onboarding."]) }
        } catch { /* Questionnaire is saved; affiliation review can be revisited from the profile. */ }
    }
    var branchRole: String { answers["branch"] == "hiring" ? "professional" : answers["branch"] ?? "professional" }
}

// Shared native artwork keeps the welcome, authentication, and HQ surfaces cohesive.
struct FrontierAtmosphere: View {
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color(red: 0.018, green: 0.025, blue: 0.04)
                RadialGradient(colors: [Color(red: 0.15, green: 0.17, blue: 0.44).opacity(0.85), .clear], center: .topTrailing, startRadius: 0, endRadius: geometry.size.width * 0.95)
                Ellipse().fill(.cyan.opacity(0.16)).frame(width: geometry.size.width * 1.4, height: 230).blur(radius: 65).offset(x: 70, y: geometry.size.height * 0.28)
                Canvas { context, size in
                    for index in 0..<48 {
                        let x = CGFloat((index * 73 + 19) % 997) / 997 * size.width
                        let y = CGFloat((index * 137 + 47) % 991) / 991 * size.height
                        let radius: CGFloat = index % 7 == 0 ? 1.1 : 0.6
                        context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: radius * 2, height: radius * 2)), with: .color(.white.opacity(index % 3 == 0 ? 0.42 : 0.16)))
                    }
                    var arc = Path()
                    arc.addEllipse(in: CGRect(x: -size.width * 0.8, y: size.height * 0.64, width: size.width * 2.7, height: size.height * 0.8))
                    context.stroke(arc, with: .color(.cyan.opacity(0.35)), lineWidth: 1)
                }
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}
