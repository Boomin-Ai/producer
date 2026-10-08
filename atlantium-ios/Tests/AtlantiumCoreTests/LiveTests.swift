import Foundation
import XCTest
@testable import AtlantiumCore
final class LiveTests: XCTestCase {
    func testPublicFeedsAndGuestAgentGateWithNativeNetworking() async throws {
        guard ProcessInfo.processInfo.environment["ATLANTIUM_LIVE_CHECK"] == "1" else { throw XCTSkip("Opt-in production read-only verification") }
        let routes = [("content/documents?type=post&limit=1", "documents"), ("job_postings?format=paged&limit=1", "jobs"), ("directory?limit=1", "entries"), ("office-hours", "sessions")]
        for (route, key) in routes {
            var req = URLRequest(url: try XCTUnwrap(NativeRoutes.url(route)))
            req.setValue("Atlantium/2.0 (iOS)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await URLSession.shared.data(for: req)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, route)
            let value = try JSONDecoder().decode(APIValue.self, from: data)
            if case .array = value[key] {} else { XCTFail("Missing \(key) array at \(route)") }
            print("NATIVE_API_CHECK \(key) \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config)
        var req = URLRequest(url: try XCTUnwrap(NativeRoutes.url("rene/chat")))
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Atlantium/2.0 (iOS)", forHTTPHeaderField: "User-Agent")
        req.httpBody = Data("{\"message\":\"hello\",\"page\":\"/ios/rene\",\"stream\":true}".utf8)
        let (_, response) = try await session.data(for: req)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
    }
}
