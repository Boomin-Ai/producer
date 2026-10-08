import XCTest
@testable import AtlantiumCore
final class CookieTests: XCTestCase {
    func testSecureCookieExpirySurvivesRelaunchAndRejectsOtherDomains() throws {
        let expires = Date(timeIntervalSinceNow: 86400)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "session", .value: "test", .domain: "api.atlantium.ai", .path: "/", .secure: "TRUE", .expires: expires]))
        let snapshot = try JSONDecoder().decode(CookieSnapshot.self, from: JSONEncoder().encode(CookieSnapshot(cookie)))
        let restored = try XCTUnwrap(snapshot.restore())
        XCTAssertTrue(restored.isSecure); XCTAssertEqual(restored.name, "session")
        XCTAssertEqual(try XCTUnwrap(restored.expiresDate).timeIntervalSince1970, expires.timeIntervalSince1970, accuracy: 1)
        XCTAssertNil(snapshot.restore(now: expires.addingTimeInterval(1)))
        let other = try XCTUnwrap(HTTPCookie(properties: [.name: "session", .value: "test", .domain: "evil.example", .path: "/"]))
        XCTAssertNil(CookieSnapshot(other).restore())
    }
}
