import XCTest
@testable import AtlantiumCore
final class CoreTests: XCTestCase {
    func testPublicRoutesStayOnAtlantiumAPI() {
        XCTAssertEqual(NativeRoutes.url("directory?limit=1")?.absoluteString, "https://api.atlantium.ai/v1/directory?limit=1")
        XCTAssertEqual(NativeRoutes.url("/job_postings")?.host, "api.atlantium.ai")
        XCTAssertNil(NativeRoutes.url("https://evil.example")); XCTAssertNil(NativeRoutes.url("../auth/me")); XCTAssertNil(NativeRoutes.url("//evil.example"))
    }
    func testExternalLinksRejectUnsafeSchemesAndCredentials() {
        XCTAssertNotNil(NativeRoutes.external("https://example.com/job"))
        for value in ["javascript:alert(1)", "http://example.com", "https://key:secret@example.com"] { XCTAssertNil(NativeRoutes.external(value)) }
    }
    func testStreamPreservesWhitespaceAndMultipleDataLines() {
        var parser = SSEParser()
        XCTAssertNil(parser.consume(": keepalive"))
        XCTAssertNil(parser.consume("event: delta"))
        XCTAssertNil(parser.consume("data: {\"text\":\" hello\"}"))
        XCTAssertEqual(parser.consume("")?.data, "{\"text\":\" hello\"}")
        _ = parser.consume("data: first"); _ = parser.consume("data: second")
        XCTAssertEqual(parser.consume(""), SSEEvent(name: "message", data: "first\nsecond"))
        XCTAssertNil(parser.consume(""))
    }
    func testActualPublicShapesAndMissingOptionalFields() throws {
        let row = try JSONDecoder().decode(APIValue.self, from: Data("{\"id\":\"abc\",\"title\":\"Engineer\",\"content\":{\"tech_stack\":[\"Swift\"]},\"salary_min\":null}".utf8))
        XCTAssertEqual(row.id, "abc"); XCTAssertEqual(row["content"]["tech_stack"].list.first?.text, "Swift")
        XCTAssertEqual(row["missing"].text, ""); XCTAssertFalse(row["missing"].flag)
        XCTAssertEqual(try JSONDecoder().decode(APIValue.self, from: JSONEncoder().encode(row)), row)
    }
}
