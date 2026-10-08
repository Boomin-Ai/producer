import XCTest
@testable import AtlantiumCore
final class PushTests: XCTestCase {
    func testRegistrationRejectsPlaceholderAndAcknowledgesExactlyOnce() {
        var registration = PushRegistration()
        for id: String? in [nil, "", "local-123"] { registration.evaluate(id); XCTAssertFalse(registration.shouldOffer) }
        registration.evaluate("server-assigned"); XCTAssertTrue(registration.shouldOffer)
        registration.acknowledge(); XCTAssertFalse(registration.shouldOffer)
        registration.evaluate("another-real-id"); XCTAssertFalse(registration.shouldOffer)
        XCTAssertFalse(PushRegistration(acknowledged: true).shouldOffer)
    }
}
