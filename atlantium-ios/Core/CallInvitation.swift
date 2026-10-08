import Foundation
public enum CallInvitation {
    public static let message = "Started a call — join me from this conversation."
    public static func isCurrent(body: String, createdAt: String, mine: Bool, now: Date = Date()) -> Bool {
        guard !mine, body == message else { return false }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: createdAt) ?? ISO8601DateFormatter().date(from: createdAt) else { return false }
        return now.timeIntervalSince(date) >= -5 && now.timeIntervalSince(date) <= 90
    }
}
