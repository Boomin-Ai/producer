import SwiftUI

@MainActor final class Session: ObservableObject {
    @Published var user: APIValue = .null
    @Published var showAuth = false
    @Published var ready = false
    @Published var profile: APIValue = .null
    var needsOnboarding: Bool { profile != .null && MemberQuestion.requiresQuestionnaire(signedIn: signedIn, completed: profile["registration_details"]["is_completed"].flag) }
    func loadProfile() async { if let value = try? await API.shared.call("profile/me") { profile = value }; if let access = try? await API.shared.call("me/network-access") { insider = access["insider"].flag } }
    @Published var insider = false
    var signedIn: Bool { !user["id"].text.isEmpty }
    func restore() async { defer { ready = true }; if let value = try? await API.shared.call("auth/me") { user = value; OneSignalManager.shared.identify(value["id"].text); await loadProfile() } }
    func verify(email: String, code: String) async throws {
        let value = try await API.shared.call("auth/verify", method: "POST", body: ["email": email, "code": code])
        user = value["user"]; guard signedIn else { throw APIError(message: "We couldn’t complete sign-in. Please try again.") }
        OneSignalManager.shared.identify(user["id"].text); await loadProfile(); showAuth = false
    }
    func signOut() async { _ = try? await API.shared.call("auth/logout", method: "POST"); API.shared.clear(); user = .null; profile = .null; insider = false; OneSignalManager.shared.logout() }
}
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        OneSignalManager.shared.initialize(launchOptions: launchOptions); return true
    }
}
@main struct AtlantiumApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject var session = Session()
    var body: some Scene { WindowGroup { AppEntryView().background(KeyboardDismissInstaller()).scrollDismissesKeyboard(.interactively).tint(.cyan).preferredColorScheme(.dark).modifier(PushRegistrationPrompt()).environmentObject(session).task { await session.restore() } } }
}
enum Tab: Hashable { case network, inbox, hq, frontier }
struct RootView: View {
    @EnvironmentObject var session: Session
    @ObservedObject var push = OneSignalManager.shared
    @State var pushed: PushDestination?
    @State var notificationSettings = false
    @State var tab: Tab = .hq
    @State var previous: Tab = .frontier
    @State var menu = false
    @State var destination: PublicSection?
    var body: some View {
        navigation.tint(.white).onAppear { openPush() }.onChange(of: push.pendingDestination) { _, _ in openPush() }.onChange(of: session.signedIn) { _, _ in openPush() }.onChange(of: tab) { old, new in if new == .inbox { previous = old } }
        .overlay {
            if menu {
                ZStack(alignment: .leading) {
                    Color.black.opacity(0.45).ignoresSafeArea().onTapGesture { withAnimation { menu = false } }
                    VStack(alignment: .leading, spacing: 24) {
                        HStack { Text("Atlantium").font(.title2.bold()); Spacer(); Button { withAnimation { menu = false } } label: { Image(systemName: "xmark") }.accessibilityLabel("Close menu") }
                        Button { open(.jobs) } label: { Label("Jobs", systemImage: "briefcase") }
                        Button { open(.directory) } label: { Label("Directory", systemImage: "building.2") }
                        Spacer()
                        if !session.insider {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Your people. Your next chapter.").font(.headline).foregroundStyle(.white)
                                Text("Build, share, and connect with Insiders.").font(.caption).foregroundStyle(.secondary)
                                JoinInsidersButton()
                            }.padding(18).background(.cyan.opacity(0.08), in: RoundedRectangle(cornerRadius: 22))
                        }
                    }.padding(24).frame(width: 290).frame(maxHeight: .infinity).background(Color(red: 0.025, green: 0.03, blue: 0.045)).transition(.move(edge: .leading))
                }.zIndex(10)
            }
        }
        .sheet(item: $pushed) { route in NavigationStack { PushDetailView(destination: route).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { pushed = nil } } } } }
        .sheet(isPresented: $notificationSettings) { NotificationSettingsView() }
        .sheet(item: $destination) { kind in NavigationStack { PublicList(kind: kind).navigationTitle(kind.rawValue).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { destination = nil } } } } }
    }
    func openPush() {
        guard let route = push.pendingDestination else { return }
        guard !route.needsAccount || session.signedIn else { session.showAuth = true; return }
        menu = false; destination = nil; notificationSettings = false
        pushed = route; push.pendingDestination = nil
    }
    @ViewBuilder var navigation: some View {
        if #available(iOS 18.0, *) {
            TabView(selection: $tab) {
                SwiftUI.Tab("Frontier", systemImage: "globe.americas", value: Tab.frontier) { stack { FrontierView() } }
                SwiftUI.Tab("HQ", systemImage: "building.2.crop.circle", value: Tab.hq) { stack { HQView() } }
                SwiftUI.Tab("Network", systemImage: "person.2", value: Tab.network) { stack { NetworkView() } }
                SwiftUI.Tab("Inbox", systemImage: "tray", value: Tab.inbox, role: .search) { stack { InboxView() } }
            }
        } else {
            TabView(selection: $tab) {
                stack { FrontierView() }.tabItem { Label("Frontier", systemImage: "globe.americas") }.tag(Tab.frontier)
                stack { HQView() }.tabItem { Label("HQ", systemImage: "building.2.crop.circle") }.tag(Tab.hq)
                stack { NetworkView() }.tabItem { Label("Network", systemImage: "person.2") }.tag(Tab.network)
                stack { InboxView() }.tabItem { Label("Inbox", systemImage: "tray") }.tag(Tab.inbox)
            }
        }
    }
    func stack<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        NavigationStack { content().toolbar { ToolbarItem(placement: .topBarLeading) { Button { withAnimation { menu = true } } label: { Image(systemName: "line.3.horizontal") }.accessibilityLabel("Open menu") } } }.tint(.cyan)
    }
    func open(_ kind: PublicSection) { menu = false; destination = kind }
}
struct SignInView: View {
    @EnvironmentObject var session: Session
    @Environment(\.dismiss) var dismiss
    @State var email = ""
    @State var code = ""
    @State var sent = false
    @State var busy = false
    @State var error = ""
    var body: some View {
        NavigationStack {
            ZStack {
                FrontierAtmosphere().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 30) {
                        Image("Brand").resizable().scaledToFit().frame(width: 60, height: 60).clipShape(RoundedRectangle(cornerRadius: 18)).padding(.top, 28)
                        VStack(alignment: .leading, spacing: 12) {
                            Text(sent ? "Check your inbox." : "Welcome to\nAtlantium.").font(.system(size: 36, weight: .medium)).tracking(-1).fixedSize(horizontal: false, vertical: true)
                            Text(sent ? "Enter the six-digit code we sent to " + email + "." : "Your path to the frontier.").font(.subheadline).foregroundStyle(.white.opacity(0.65))
                            if !sent { Text("Network · Live · Jobs · Directory").font(.caption).foregroundStyle(.white.opacity(0.45)) }
                        }
                        VStack(alignment: .leading, spacing: 12) {
                            Text(sent ? "SIGN-IN CODE" : "EMAIL ADDRESS").font(.caption2.weight(.semibold)).tracking(2).foregroundStyle(.white.opacity(0.6))
                            if sent {
                                TextField("Six-digit code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode).font(.title2.monospaced()).padding(20).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
                            } else {
                                TextField("you@example.com", text: $email).accessibilityLabel("Email address").keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().padding(20).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
                            }
                            Button { Task { await submit() } } label: {
                                HStack { Text(sent ? "Sign in" : "Send sign-in code"); Spacer(); if busy { ProgressView().tint(.black) } else { Image(systemName: "arrow.right") } }.font(.subheadline.weight(.semibold)).padding(20).foregroundStyle(.black).background(.white, in: Capsule())
                            }.buttonStyle(.plain).disabled(busy || (sent ? code.count != 6 : !email.contains("@"))).opacity(busy || (sent ? code.count != 6 : !email.contains("@")) ? 0.5 : 1)
                            if sent { Button("Use another email") { sent = false; code = "" }.font(.subheadline).padding(.top, 8) }
                            if !error.isEmpty { Text(error).font(.subheadline).foregroundStyle(.red).accessibilityLabel("Sign-in error: " + error) }
                        }
                        Text("We’ll email your code. Signing in doesn’t subscribe you to marketing emails.").font(.caption).foregroundStyle(.white.opacity(0.45))
                        HStack(spacing: 20) { Link("Privacy policy", destination: URL(string: "https://atlantium.ai/privacy")!); Link("Terms", destination: URL(string: "https://atlantium.ai/policies")!) }.font(.caption).foregroundStyle(.white.opacity(0.65))
                    }.padding(28).frame(maxWidth: 460).frame(maxWidth: .infinity, alignment: .center)
                }.scrollDismissesKeyboard(.interactively)
            }.navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Back") { session.showAuth = false } } }.toolbarBackground(.hidden, for: .navigationBar)
        }
    }
    func submit() async {
        busy = true; error = ""; defer { busy = false }
        do {
            if sent { try await session.verify(email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), code: code) }
            else { _ = try await API.shared.call("auth/otp", method: "POST", body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()]); sent = true }
        } catch { self.error = error.localizedDescription }
    }
}
struct AccountButton: View {
    @EnvironmentObject var session: Session
    @State var showing = false
    @AppStorage("atlantium.welcome.completed") var welcomed = false
    var body: some View { Button { if session.signedIn { showing = true } else { welcomed = false } } label: { HQMemberAvatar(url: session.avatarURL, name: session.user["name"].text.isEmpty ? "A" : session.user["name"].text).frame(width: 32, height: 32).scaleEffect(0.7) }.accessibilityLabel(session.signedIn ? "Account" : "Welcome to Atlantium").sheet(isPresented: $showing) { AccountView() } }
}
struct AccountView: View {
    @EnvironmentObject var session: Session
    @Environment(\.dismiss) var dismiss
    @State var deleting = false
    @State var error = ""
    var name: String { let value = session.profile.text("display_name"); return value.isEmpty ? session.user.text("name", "email") : value }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 20) {
                        HQMemberAvatar(url: session.avatarURL, name: name).scaleEffect(1.4).padding(10)
                        VStack(alignment: .leading, spacing: 8) {
                            Text(session.insider ? "ATLANTIUM INSIDER" : "ATLANTIUM MEMBER").font(.caption2.weight(.semibold)).tracking(2).foregroundStyle(.cyan)
                            Text(name).font(.system(size: 28, weight: .medium)).tracking(-0.7)
                            Text(session.user["email"].text).font(.subheadline).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                        }
                        if !session.insider { JoinInsidersButton() }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading).background { FrontierAtmosphere() }.clipShape(RoundedRectangle(cornerRadius: 28)).overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(.white.opacity(0.1), lineWidth: 1) }
                    VStack(spacing: 0) {
                        NavigationLink { OnboardingView(editing: true) } label: { AccountActionRow(title: "Edit profile", subtitle: "How the network sees you", icon: "person.crop.circle") }
                        Divider().overlay(.white.opacity(0.04)).padding(.leading, 56)
                        NavigationLink { NotificationPreferencesView() } label: { AccountActionRow(title: "Notifications", subtitle: "Choose what reaches you", icon: "bell") }
                    }.background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 24))
                    VStack(alignment: .leading, spacing: 0) {
                        Link(destination: URL(string: "mailto:team@atlantium.ai")!) { AccountActionRow(title: "Contact support", subtitle: "We’re here to help", icon: "bubble.left") }
                        Divider().padding(.leading, 56)
                        Link(destination: URL(string: "https://atlantium.ai/privacy")!) { AccountActionRow(title: "Privacy policy", icon: "hand.raised") }
                        Divider().padding(.leading, 56)
                        Link(destination: URL(string: "https://atlantium.ai/policies")!) { AccountActionRow(title: "Terms of use", icon: "doc.text") }
                    }.background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 24))
                    Button { Task { await session.signOut(); dismiss() } } label: { HStack { Text("Sign out"); Spacer(); Image(systemName: "arrow.right.square") }.font(.subheadline.weight(.medium)).padding(20).foregroundStyle(.white).background(.ultraThinMaterial, in: Capsule()) }.buttonStyle(.plain)
                    Button("Delete account", role: .destructive) { deleting = true }.font(.caption).foregroundStyle(.red.opacity(0.8)).frame(maxWidth: .infinity).padding(.bottom, 8)
                    if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
                }.padding(22).frame(maxWidth: 560).frame(maxWidth: .infinity)
            }.background(Color(red: 0.025, green: 0.03, blue: 0.04)).navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button { dismiss() } label: { Image(systemName: "xmark").font(.subheadline) }.accessibilityLabel("Done") } }
        }.presentationDragIndicator(.visible).presentationCornerRadius(32)
        .confirmationDialog("Permanently delete your Atlantium account?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete account", role: .destructive) { Task { do { _ = try await API.shared.call("account/delete", method: "POST"); await session.signOut(); dismiss() } catch { self.error = error.localizedDescription } } }
        }
    }
}
struct AccountActionRow: View {
    let title: String
    var subtitle: String = ""
    let icon: String
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 18)).foregroundStyle(.cyan).frame(width: 24)
            VStack(alignment: .leading, spacing: 4) { Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.white); if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary) } }
            Spacer(); Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(.secondary)
        }.padding(18).contentShape(Rectangle())
    }
}

struct SignInPrompt: View {
    @EnvironmentObject var session: Session
    let title: String
    let message: String
    var body: some View { ContentUnavailableView { Label(title, systemImage: "person.2") } description: { Text(message) } actions: { Button("Sign in") { session.showAuth = true }.buttonStyle(.borderedProminent) } }
}
struct LoadError: View {
    let message: String
    let retry: () -> Void
    var body: some View { ContentUnavailableView { Label("Let’s try again", systemImage: "wifi.exclamationmark") } description: { Text(message) } actions: { Button("Retry", action: retry).buttonStyle(.bordered) } }
}

import SwiftUI
import UIKit

extension Session {
    var avatarURL: String {
        profile.text("avatar_url").isEmpty ? (profile["profile"].text("avatar_url").isEmpty ? user.text("image", "avatar_url") : profile["profile"]["avatar_url"].text) : profile["avatar_url"].text
    }
}
// Window-level gestures also cover sheets. Keep all controls responsive and
// leave taps in editable text views alone so focus and selection still work.
struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> KeyboardDismissView { KeyboardDismissView() }
    func updateUIView(_ uiView: KeyboardDismissView, context: Context) {}
}
final class KeyboardDismissView: UIView, UIGestureRecognizerDelegate {
    private weak var installedWindow: UIWindow?
    private var tap: UITapGestureRecognizer?
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let window, installedWindow !== window else { return }
        if let tap { installedWindow?.removeGestureRecognizer(tap) }
        let recognizer = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        recognizer.cancelsTouchesInView = false
        recognizer.delegate = self
        window.addGestureRecognizer(recognizer)
        installedWindow = window; tap = recognizer
    }
    @objc private func dismissKeyboard() { installedWindow?.endEditing(true) }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view {
            if current is UITextField || current is UITextView { return false }
            view = current.superview
        }
        return true
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
}

struct JoinInsidersButton: View {
    var title = "Join Insiders"
    @EnvironmentObject var session: Session
    @Environment(\.openURL) private var openURL
    @State private var confirming = false
    var body: some View {
        Button { confirming = true } label: {
            HStack { Text(title); Spacer(); Image(systemName: "arrow.up.right") }
                .font(.subheadline.weight(.semibold)).padding(14)
                .foregroundStyle(.black).background(.cyan, in: Capsule())
        }.buttonStyle(.plain)
        .confirmationDialog("Join Insiders on web", isPresented: $confirming, titleVisibility: .visible) {
            Button("Continue on web") { openURL(NativeRoutes.insiderPricing(email: session.user["email"].text)) }
        } message: { Text("Choose your membership on Atlantium’s website.") }
    }
}
struct MessageComposerSurface: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(.horizontal, 18).padding(.vertical, 12)
            .background(Color(red: 0.09, green: 0.11, blue: 0.12), in: RoundedRectangle(cornerRadius: 26))
            .overlay { RoundedRectangle(cornerRadius: 26).strokeBorder(.white.opacity(0.1), lineWidth: 1) }
    }
}
extension String {
    var inboxTime: String {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: self) ?? ISO8601DateFormatter().date(from: self) else { return "" }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

struct AppNightBackground: View {
    var body: some View {
        ZStack {
            Color(red: 0.018, green: 0.023, blue: 0.032)
            RadialGradient(colors: [Color(red: 0.025, green: 0.075, blue: 0.13).opacity(0.5), .clear], center: .topTrailing, startRadius: 0, endRadius: 620)
        }.ignoresSafeArea()
    }
}
