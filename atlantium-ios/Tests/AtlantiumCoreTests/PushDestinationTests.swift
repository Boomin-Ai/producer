import XCTest
@testable import AtlantiumCore
final class PushDestinationTests: XCTestCase {
    func testPushTargetsOpenTheCorrectExperience() {
        let id = "00000000-0000-4000-8000-000000000001"
        XCTAssertEqual(PushDestination.parse(["push_kind": "message", "thread_id": id]), .message(id))
        XCTAssertEqual(PushDestination.parse(["push_kind": "event", "event_id": id]), .event(id))
        XCTAssertEqual(PushDestination.parse(["push_kind": "blog", "slug": "new-frontier"]), .blog("new-frontier"))
        XCTAssertEqual(PushDestination.parse(["push_kind": "jobs", "report_day": "2026-10-04"]), .jobs("2026-10-04"))
        XCTAssertTrue(PushDestination.message(id).needsAccount)
        XCTAssertFalse(PushDestination.blog("new-frontier").needsAccount)
    }
    func testUntrustedPayloadCannotNavigateToArbitraryRoutes() {
        XCTAssertNil(PushDestination.parse(["push_kind": "message", "thread_id": "../../account/delete"]))
        XCTAssertNil(PushDestination.parse(["push_kind": "blog", "slug": "https://other.example"]))
        XCTAssertNil(PushDestination.parse(["push_kind": "blog", "slug": "../admin"]))
        XCTAssertNil(PushDestination.parse(["push_kind": "event", "event_id": "not-a-uuid"]))
        XCTAssertNil(PushDestination.parse(["push_kind": "jobs", "report_day": "invalid"]))
        XCTAssertNil(PushDestination.parse(["push_kind": "unknown"]))
    }
}
