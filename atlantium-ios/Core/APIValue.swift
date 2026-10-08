import Foundation
public enum APIValue: Codable, Hashable, Sendable {
    case object([String: APIValue]), array([APIValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([APIValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: APIValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v); case .null: try c.encodeNil() }
    }
    public subscript(_ key: String) -> APIValue { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    public var text: String { if case .string(let v) = self { return v }; return "" }
    public var list: [APIValue] { if case .array(let v) = self { return v }; return [] }
    public var flag: Bool { if case .bool(let v) = self { return v }; return false }
    public var id: String { self["id"].text.isEmpty ? self["profile_id"].text : self["id"].text }
    public func text(_ keys: String...) -> String { keys.map { self[$0].text }.first { !$0.isEmpty } ?? "" }
}
public struct SSEEvent: Equatable, Sendable { public let name: String; public let data: String }
public struct SSEParser {
    private var name = "message"
    private var lines: [String] = []
    public init() {}
    public mutating func consume(_ line: String) -> SSEEvent? {
        if line.isEmpty {
            defer { name = "message"; lines = [] }
            return lines.isEmpty ? nil : SSEEvent(name: name, data: lines.joined(separator: "\n"))
        }
        if line.hasPrefix("event:") { name = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        else if line.hasPrefix("data:") { let data = String(line.dropFirst(5)); lines.append(data.hasPrefix(" ") ? String(data.dropFirst()) : data) }
        return nil
    }
}
public struct SSEByteParser {
    private var line: [UInt8] = []
    private var parser = SSEParser()
    public init() {}
    public mutating func consume(_ byte: UInt8) -> SSEEvent? {
        guard byte == 10 else { line.append(byte); return nil }
        if line.last == 13 { line.removeLast() }
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        return parser.consume(text)
    }
}
public enum NativeRoutes {
    public static let base = URL(string: "https://api.atlantium.ai/v1/")!
    public static func url(_ path: String) -> URL? {
        guard !path.contains("://"), !path.contains(".."), !path.hasPrefix("//") else { return nil }
        return URL(string: path.hasPrefix("/") ? String(path.dropFirst()) : path, relativeTo: base)?.absoluteURL
    }
    public static func insiderPricing(email: String = "") -> URL {
        var url = URLComponents(string: "https://atlantium.ai/pricing")!
        url.queryItems = [URLQueryItem(name: "source", value: "ios"), URLQueryItem(name: "intent", value: "insider")]
        if !email.isEmpty && email.count <= 254 && email.contains("@") { url.queryItems?.append(URLQueryItem(name: "email", value: email)) }
        return url.url!
    }
    public static func reneLink(_ value: String, email: String = "") -> URL? {
        let absolute = value.hasPrefix("/") && !value.hasPrefix("//") ? "https://atlantium.ai" + value : value
        guard let url = external(absolute) else { return nil }
        let paymentPath = ["/pricing", "/checkout", "/billing", "/upgrade"].contains { url.path == $0 || url.path.hasPrefix($0 + "/") }
        if ((url.host == "atlantium.ai" || url.host == "www.atlantium.ai") && paymentPath) || url.host == "checkout.stripe.com" { return insiderPricing(email: email) }
        return url
    }
    public static func external(_ value: String) -> URL? {
        guard let u = URL(string: value), u.scheme == "https", u.host != nil, u.user == nil, u.password == nil else { return nil }; return u
    }
}
