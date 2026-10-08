import Foundation
public struct PushRegistration: Equatable {
    public private(set) var registered = false
    public private(set) var acknowledged: Bool
    public init(acknowledged: Bool = false) { self.acknowledged = acknowledged }
    public var shouldOffer: Bool { registered && !acknowledged }
    public mutating func evaluate(_ id: String?) { registered = id.map { !$0.isEmpty && !$0.hasPrefix("local-") } ?? false }
    public mutating func acknowledge() { acknowledged = true }
}
