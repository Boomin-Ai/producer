import SwiftUI
import UIKit
import OneSignalFramework

/// The single app-side SDK entry point. APNs keys and OneSignal REST keys never belong in this target.
@MainActor final class OneSignalManager: NSObject, ObservableObject, OSPushSubscriptionObserver, OSNotificationClickListener {
    static let shared = OneSignalManager()
    static let promptKey = "atlantium.push.permissionPromptAcknowledged"
    @Published private(set) var registration = PushRegistration(acknowledged: UserDefaults.standard.bool(forKey: promptKey))
    @Published var pendingDestination: PushDestination?
    @Published var preferences: [String: Bool] = ["messages": true, "events": true, "blog": true, "jobs": true]
    private var initialized = false
    private override init() { super.init() }
    func initialize(launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
        guard !initialized, let id = Bundle.main.object(forInfoDictionaryKey: "OneSignalAppID") as? String, UUID(uuidString: id) != nil else { return }
        initialized = true
        #if DEBUG
        OneSignal.Debug.setLogLevel(.LL_WARN)
        #else
        OneSignal.Debug.setLogLevel(.LL_NONE)
        #endif
        OneSignal.initialize(id, withLaunchOptions: launchOptions)
        // SDK observers are weak; the singleton retains this observer for the app lifetime.
        OneSignal.User.pushSubscription.addObserver(self)
        OneSignal.Notifications.addClickListener(self)
        for key in ["blog", "jobs"] { preferences[key] = UserDefaults.standard.object(forKey: "atlantium.push." + key) as? Bool ?? true }
        syncTags()
        evaluate(OneSignal.User.pushSubscription.id)
    }
    nonisolated func onPushSubscriptionDidChange(state: OSPushSubscriptionChangedState) {
        let id = state.current.id
        Task { @MainActor in self.evaluate(id) }
    }
    private func evaluate(_ id: String?) {
        registration.evaluate(id)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--push-smoke"), let id, !id.hasPrefix("local-") { print("ATLANTIUM_PUSH_SUBSCRIPTION " + id) }
        if ProcessInfo.processInfo.arguments.contains("--verify-push") { print("ATLANTIUM_PUSH_CHECK registered=\(registration.registered) permission=\(OneSignal.Notifications.permission) optedIn=\(OneSignal.User.pushSubscription.optedIn)") }
        #endif
    }
    nonisolated func onClick(event: OSNotificationClickEvent) {
        guard let raw = event.notification.additionalData else { return }
        var data: [String: String] = [:]
        for (key, value) in raw { if let key = key as? String, let value = value as? String { data[key] = value } }
        guard let destination = PushDestination.parse(data) else { return }
        Task { @MainActor in self.pendingDestination = destination }
    }
    func syncTags() {
        guard initialized else { return }
        for key in ["blog", "jobs"] { OneSignal.User.addTag(key: "push_" + key, value: preferences[key] == true ? "1" : "0") }
    }
    func loadPreferences() async {
        guard let data = try? await API.shared.call("me/push-preferences") else { return }
        for key in ["messages", "events", "blog", "jobs"] { preferences[key] = data[key].flag }
        syncTags()
    }
    func updatePreference(_ key: String, enabled: Bool, signedIn: Bool) async throws {
        if signedIn { _ = try await API.shared.call("me/push-preferences", method: "PATCH", body: [key: enabled]) }
        preferences[key] = enabled
        if ["blog", "jobs"].contains(key) { UserDefaults.standard.set(enabled, forKey: "atlantium.push." + key) }
        syncTags()
    }
    func identify(_ id: String) { guard initialized, !id.isEmpty else { return }; if OneSignal.User.externalId != id { OneSignal.login(id) }; Task { await loadPreferences() } }
    func logout() { if initialized && OneSignal.User.externalId != nil { OneSignal.logout() } }
    func acknowledgeAndRequestPermission() {
        registration.acknowledge(); UserDefaults.standard.set(true, forKey: Self.promptKey)
        OneSignal.Notifications.requestPermission({ _ in }, fallbackToSettings: true)
    }
    func openSettings() { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
    // Explicit opt-in only: these methods are never called from sign-in or onboarding.
    func addEmail(_ email: String) { if initialized { OneSignal.User.addEmail(email) } }
    func addSMS(_ number: String) { if initialized { OneSignal.User.addSms(number) } }
    func setTag(_ key: String, value: String) { if initialized { OneSignal.User.addTag(key: key, value: value) } }
}
struct PushRegistrationPrompt: ViewModifier {
    @ObservedObject private var push = OneSignalManager.shared
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var scenePhase
    @State private var presented = false
    @AppStorage("atlantium.welcome.completed") private var welcomed = false
    func body(content: Content) -> some View {
        content.onAppear { offer() }.onChange(of: welcomed) { _, _ in offer() }.onChange(of: push.registration.shouldOffer) { _, _ in offer() }.onChange(of: session.ready) { _, _ in offer() }.onChange(of: session.needsOnboarding) { _, _ in offer() }.onChange(of: session.showAuth) { _, _ in offer() }.onChange(of: scenePhase) { _, _ in offer() }
        .alert(title, isPresented: $presented) { Button("Got it") { push.acknowledgeAndRequestPermission() } } message: { Text(message) }
    }
    func offer() { guard welcomed, session.ready, !session.needsOnboarding, !session.showAuth, scenePhase == .active, push.registration.shouldOffer, !presented else { return }; presented = true }
    var title: String {
        #if DEBUG
        "Your OneSignal SDK integration is complete!"
        #else
        "Stay connected"
        #endif
    }
    var message: String {
        #if DEBUG
        "You can now send Push Notifications & In-App Messages through OneSignal. Tap below to enable push notifications."
        #else
        "Enable notifications for messages and community updates."
        #endif
    }
}
