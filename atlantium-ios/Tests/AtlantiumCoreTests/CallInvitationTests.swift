import XCTest
@testable import AtlantiumCore
final class CallInvitationTests: XCTestCase {
    func testOnlyRecentIncomingInvitationsOfferAnAnswer() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let formatter = ISO8601DateFormatter()
        let recent = formatter.string(from: now.addingTimeInterval(-30))
        XCTAssertTrue(CallInvitation.isCurrent(body: CallInvitation.message, createdAt: recent, mine: false, now: now))
        XCTAssertFalse(CallInvitation.isCurrent(body: CallInvitation.message, createdAt: recent, mine: true, now: now))
        XCTAssertFalse(CallInvitation.isCurrent(body: "hello", createdAt: recent, mine: false, now: now))
        XCTAssertFalse(CallInvitation.isCurrent(body: CallInvitation.message, createdAt: formatter.string(from: now.addingTimeInterval(-91)), mine: false, now: now))
        XCTAssertFalse(CallInvitation.isCurrent(body: CallInvitation.message, createdAt: formatter.string(from: now.addingTimeInterval(30)), mine: false, now: now))
        XCTAssertFalse(CallInvitation.isCurrent(body: CallInvitation.message, createdAt: "invalid", mine: false, now: now))
    }
}
