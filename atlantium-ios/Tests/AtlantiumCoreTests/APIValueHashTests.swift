import XCTest
@testable import AtlantiumCore

final class APIValueHashTests: XCTestCase {
    func testEqualNestedObjectsHaveStableHashesRegardlessOfKeyOrder() throws {
        let first = try JSONDecoder().decode(APIValue.self, from: Data(#"{"kind":"prompt","label":"Find a role","value":{"b":2,"a":1},"items":[true,null]}"#.utf8))
        let reversed = try JSONDecoder().decode(APIValue.self, from: Data(#"{"items":[true,null],"value":{"a":1,"b":2},"label":"Find a role","kind":"prompt"}"#.utf8))
        XCTAssertEqual(first, reversed)
        var lookup = [first: "choice"]
        for _ in 0..<1000 {
            XCTAssertEqual(first.hashValue, reversed.hashValue)
            XCTAssertEqual(lookup[reversed], "choice")
            lookup[reversed] = "choice"
        }
        XCTAssertEqual(lookup.count, 1)
        XCTAssertEqual(Set([first, reversed]).count, 1)
    }
}
