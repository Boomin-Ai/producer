import XCTest
@testable import AtlantiumCore
final class OnboardingTests: XCTestCase {
    func testQuestionsFollowWebsiteBranches() {
        let professional = MemberQuestion.steps(branch: "professional")
        XCTAssertEqual(professional.map(\.id), ["identity", "branch", "headline", "interests", "work", "education", "seeking"])
        XCTAssertEqual(MemberQuestion.steps(branch: "founder").map(\.id), ["identity", "branch", "headline", "interests", "founder_org", "venture_stage", "needs"])
        XCTAssertEqual(MemberQuestion.steps(branch: "investor").map(\.id), ["identity", "branch", "headline", "interests", "investor_org", "check_band", "focus_stages", "intro_appetite"])
        XCTAssertEqual(MemberQuestion.steps(branch: "advisor").map(\.id), ["identity", "branch", "headline", "interests", "domains", "engagement", "availability"])
        XCTAssertEqual(MemberQuestion.steps(branch: "hiring").map(\.id), ["identity", "branch", "headline", "interests", "hiring_org", "hiring_roles", "hiring_contact"])
        XCTAssertEqual(MemberQuestion.all.first(where: { $0.id == "interests" })?.options.count, 10)
    }
    func testExistingMembersAndGuestsSkipQuestionnaire() {
        XCTAssertFalse(MemberQuestion.requiresQuestionnaire(signedIn: false, completed: false))
        XCTAssertFalse(MemberQuestion.requiresQuestionnaire(signedIn: true, completed: true))
        XCTAssertTrue(MemberQuestion.requiresQuestionnaire(signedIn: true, completed: false))
    }
}
