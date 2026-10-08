import XCTest
@testable import AtlantiumCore
final class PricingHandoffTests: XCTestCase {
    func testPricingHandoffEncodesEmailAndKeepsOtpSeparate() throws {
        let url = NativeRoutes.insiderPricing(email: "member+tech@example.com")
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.host, "atlantium.ai")
        XCTAssertEqual(components.path, "/pricing")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "email" })?.value, "member+tech@example.com")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "source" })?.value, "ios")
        XCTAssertFalse(components.queryItems?.contains(where: { $0.name == "code" || $0.name == "token" }) ?? true)
    }
    func testRenePaymentLinksUseWebPricingWhileOtherResourcesRemainIntact() {
        XCTAssertEqual(NativeRoutes.reneLink("/pricing", email: "me@example.com"), NativeRoutes.insiderPricing(email: "me@example.com"))
        XCTAssertEqual(NativeRoutes.reneLink("https://checkout.stripe.com/c/pay/test", email: "me@example.com"), NativeRoutes.insiderPricing(email: "me@example.com"))
        XCTAssertEqual(NativeRoutes.reneLink("/jobs/software-engineer")?.path, "/jobs/software-engineer")
        XCTAssertNil(NativeRoutes.reneLink("javascript:alert(1)"))
        XCTAssertNil(NativeRoutes.reneLink("//evil.example"))
        XCTAssertEqual(NativeRoutes.reneLink("https://docs.stripe.com/payments")?.host, "docs.stripe.com")
    }
}
