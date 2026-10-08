import Foundation
public struct CookieSnapshot: Codable, Equatable {
    public let name: String
    public let value: String
    public let domain: String
    public let path: String
    public let secure: Bool
    public let expires: Date?
    public init(_ cookie: HTTPCookie) { name = cookie.name; value = cookie.value; domain = cookie.domain; path = cookie.path; secure = cookie.isSecure; expires = cookie.expiresDate }
    public func restore(now: Date = Date()) -> HTTPCookie? {
        guard domain == "api.atlantium.ai" || domain == ".atlantium.ai" || domain == "atlantium.ai", expires.map({ $0 > now }) ?? true else { return nil }
        var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain, .path: path, .secure: secure ? "TRUE" : "FALSE"]
        if let expires { properties[.expires] = expires }
        return HTTPCookie(properties: properties)
    }
}
