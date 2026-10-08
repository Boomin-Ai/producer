import XCTest
@testable import AtlantiumCore
final class SSEByteTests: XCTestCase {
 func testPreservesEventBoundariesUnicodeAndCompletion() {
  var parser = SSEByteParser()
  let stream = ": keepalive\r\n\r\nevent: delta\r\ndata: {\"text\":\"Let’s go 🚀\"}\r\n\r\nevent: done\ndata: {\"message\":{\"body\":\"Let’s go 🚀\"}}\n\n"
  let events = stream.utf8.compactMap { parser.consume($0) }
  XCTAssertEqual(events.count, 2)
  XCTAssertEqual(events[0], SSEEvent(name: "delta", data: "{\"text\":\"Let’s go 🚀\"}"))
  XCTAssertEqual(events[1].name, "done")
 }
 func testEmitsOnlyAfterAnEntireEvent() {
  var parser = SSEByteParser()
  for byte in "event: delta\ndata: {\"text\":\"Hi\"}\n".utf8 { XCTAssertNil(parser.consume(byte)) }
  XCTAssertEqual(parser.consume(10)?.name, "delta")
 }
}
