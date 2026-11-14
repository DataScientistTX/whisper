import Foundation

enum SearchRange: String, CaseIterable, Identifiable {
    case close, normal, wide

    var id: String { rawValue }
    var meters: Int {
        switch self {
        case .close: 40
        case .normal: 80
        case .wide: 150
        }
    }
    var label: String {
        switch self {
        case .close: "Close"
        case .normal: "Normal"
        case .wide: "Wide"
        }
    }
}

struct Me: Decodable, Equatable {
    let id: String
    let nickname: String
    let description: String
    let radius: Int
    let expiresAt: String
}

struct SessionResponse: Decodable {
    let token: String
    let id: String
    let nickname: String
    let description: String
    let radius: Int
    let expiresAt: String

    var me: Me { Me(id: id, nickname: nickname, description: description, radius: radius, expiresAt: expiresAt) }
}

struct Person: Decodable, Identifiable, Hashable {
    let id: String
    let nickname: String
    let description: String
    let distance: Int
    let direction: String

    var title: String { description.isEmpty ? nickname : "\(nickname) · \(description)" }
    var whereabouts: String { "~\(distance) m · \(direction)" }
}

struct NearbyResponse: Decodable {
    let radius: Int
    let people: [Person]
}

struct Party: Decodable, Hashable {
    let id: String?
    let nickname: String
    let description: String

    var title: String { description.isEmpty ? nickname : "\(nickname) · \(description)" }
}

struct IncomingRequest: Decodable, Identifiable, Hashable {
    let id: String
    let from: Party
    let status: String
    let text: String?
    let broadcast: Bool
    let createdAt: String

    var isPending: Bool { status == "pending" }
    var date: Date? { ISODate.parse(createdAt) }
}

struct SentRequest: Decodable, Identifiable, Hashable {
    let id: String
    let to: Party
    let status: String
    let text: String?
    let broadcast: Bool
    let createdAt: String

    var date: Date? { ISODate.parse(createdAt) }
}

struct InboxResponse: Decodable {
    let me: Me
    let incoming: [IncomingRequest]
    let sent: [SentRequest]
}

struct SendResponse: Decodable {
    let sent: Int
    let skipped: Int
}

struct AcceptResponse: Decodable {
    let id: String
    let status: String
    let text: String
    let from: Party
}

struct DeclineResponse: Decodable {
    let blocked: Bool
}

struct OKResponse: Decodable {
    let ok: Bool?
}

struct ErrorBody: Decodable {
    let error: String
    let message: String?
}

enum ISODate {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ s: String) -> Date? {
        withFraction.date(from: s) ?? plain.date(from: s)
    }
}

enum QuickMessages {
    static let all = [
        "Your headlights are off",
        "Can I merge in front of you?",
        "Your trunk is open",
        "Your tire looks low",
        "Your gas cap is open",
        "Something is dragging under your car",
        "Your turn signal is still on",
        "Thanks for letting me in!",
    ]
}
