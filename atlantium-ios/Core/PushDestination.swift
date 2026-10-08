import Foundation

enum PushDestination: Hashable, Identifiable {
    case message(String), blog(String), jobs(String), event(String)
    var id: String { switch self { case .message(let value): return "message:" + value; case .blog(let value): return "blog:" + value; case .jobs(let value): return "jobs:" + value; case .event(let value): return "event:" + value } }
    var needsAccount: Bool { switch self { case .message, .event: return true; default: return false } }
    static func parse(_ data: [String: String]) -> PushDestination? {
        switch data["push_kind"] {
        case "message": guard let id = data["thread_id"], UUID(uuidString: id) != nil else { return nil }; return .message(id)
        case "event": guard let id = data["event_id"], UUID(uuidString: id) != nil else { return nil }; return .event(id)
        case "blog": guard let slug = data["slug"], !slug.isEmpty, slug.count <= 200, slug.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil else { return nil }; return .blog(slug)
        case "jobs": guard let day = data["report_day"], day.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { return nil }; return .jobs(day)
        default: return nil
        }
    }
}
