import Foundation
import Security
import AuthenticationServices
import SwiftUI
import CryptoKit

struct APIError: LocalizedError { let message: String; var code: String = ""; var errorDescription: String? { message } }
final class API: @unchecked Sendable {
    static let shared = API()
    let session: URLSession
    private init() {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        config.timeoutIntervalForRequest = 90
        session = URLSession(configuration: config)
        restoreCookies()
    }
    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard let url = NativeRoutes.url(path) else { throw APIError(message: "This link is unavailable.") }
        var req = URLRequest(url: url); req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Atlantium/2.0 (iOS)", forHTTPHeaderField: "User-Agent")
        // The auth API validates a trusted origin for cookie-based sign-in.
        // URLSession does not add the browser's Origin header automatically.
        req.setValue("https://atlantium.ai", forHTTPHeaderField: "Origin")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return req
    }
    func call(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> APIValue {
        let (data, response) = try await session.data(for: request(path, method: method, body: body))
        let decoded = (try? JSONDecoder().decode(APIValue.self, from: data)) ?? .null
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(message: decoded.text("message", "error").isEmpty ? "We couldn’t load this. Please try again." : decoded.text("message", "error"), code: decoded.text("code", "error"))
        }
        saveCookies(); return decoded
    }
    private let key = "com.atlantium.app.session.cookies"
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: key, kSecAttrAccount as String: "session"] }
    private func restoreCookies() {
        var q = query; q[kSecReturnData as String] = true; var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data,
              let rows = try? JSONDecoder().decode([CookieSnapshot].self, from: data) else { return }
        for row in rows { if let cookie = row.restore() { session.configuration.httpCookieStorage?.setCookie(cookie) } }
    }
    func saveCookies() {
        let cookies = session.configuration.httpCookieStorage?.cookies(for: NativeRoutes.base) ?? []
        guard let data = try? JSONEncoder().encode(cookies.map(CookieSnapshot.init)) else { return }
        var update = query
        let status = SecItemUpdate(update as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            update[kSecValueData as String] = data; update[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(update as CFDictionary, nil)
        }
    }
    func clear() {
        session.configuration.httpCookieStorage?.cookies?.filter { $0.domain.contains("atlantium.ai") }.forEach { session.configuration.httpCookieStorage?.deleteCookie($0) }
        SecItemDelete(query as CFDictionary)
    }
}

// Google uses the existing web OAuth provider, with a one-time PKCE-bound return.
@MainActor final class NativeGoogleSignIn: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    private var authentication: ASWebAuthenticationSession?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
    func signIn() async throws {
        let verifier = UUID().uuidString + UUID().uuidString
        let challenge = SHA256.hash(data: Data(verifier.utf8)).map { String(format: "%02x", $0) }.joined()
        let result = try await API.shared.call("auth/mobile/start", method: "POST", body: ["challenge": challenge])
        guard let url = NativeRoutes.external(result["url"].text) else { throw APIError(message: "Google sign-in is unavailable.") }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            authentication = ASWebAuthenticationSession(url: url, callbackURLScheme: "atlantium-auth") { url, error in
                if let error { continuation.resume(throwing: error) }
                else if let url { continuation.resume(returning: url) }
                else { continuation.resume(throwing: APIError(message: "Sign-in was interrupted.")) }
            }
            authentication?.presentationContextProvider = self
            authentication?.prefersEphemeralWebBrowserSession = true
            if authentication?.start() != true { continuation.resume(throwing: APIError(message: "Couldn’t open Google sign-in.")) }
        }
        authentication = nil
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let ticket = items.first(where: { $0.name == "ticket" })?.value else { throw APIError(message: "Google sign-in was not completed. Please try again.") }
        _ = try await API.shared.call("auth/mobile/exchange", method: "POST", body: ["ticket": ticket, "verifier": verifier])
    }
}
