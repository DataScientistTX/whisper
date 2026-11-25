import Foundation
import CoreLocation

enum APIError: LocalizedError {
    case unauthorized
    case server(status: Int, code: String, message: String?)
    case transport(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Your session ended."
        case .server(_, let code, let message): message ?? code
        case .transport: "Can't reach the Whisper server. Check your connection."
        case .decoding: "Unexpected answer from the server."
        }
    }
}

/// Talks to the Whisper server. The anonymous session token is kept in
/// UserDefaults so lock-screen actions work even if iOS relaunched the app.
final class APIClient: @unchecked Sendable {
    static let shared = APIClient()

    private let base: String
    private let session: URLSession
    private let defaults = UserDefaults.standard
    private let tokenKey = "whisper.token"

    var token: String? {
        get { defaults.string(forKey: tokenKey) }
        set { defaults.set(newValue, forKey: tokenKey) }
    }

    init(baseURL: URL = Config.apiBaseURL) {
        var b = baseURL.absoluteString
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    // MARK: Endpoints

    func createSession(nickname: String?, description: String, pushToken: String?) async throws -> SessionResponse {
        var body: [String: Any] = ["description": description]
        if let nickname { body["nickname"] = nickname }
        if let pushToken { body["pushToken"] = pushToken }
        let r: SessionResponse = try await call("POST", "/v1/sessions", body: body, auth: .some(nil))
        token = r.token
        return r
    }

    func me() async throws -> Me {
        try await call("GET", "/v1/me", foreground: true)
    }

    @discardableResult
    func updateMe(_ fields: [String: Any]) async throws -> Me {
        try await call("PATCH", "/v1/me", body: fields)
    }

    func deleteMe(token: String) async throws {
        let _: OKResponse = try await call("DELETE", "/v1/me", auth: token)
    }

    func putLocation(_ location: CLLocation, heading: Double?) async throws {
        var body: [String: Any] = [
            "lat": location.coordinate.latitude,
            "lon": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
        ]
        if let heading { body["heading"] = heading }
        let _: OKResponse = try await call("PUT", "/v1/me/location", body: body)
    }

    func nearby(radius: String, foreground: Bool) async throws -> NearbyResponse {
        try await call("GET", "/v1/nearby?radius=\(radius)", foreground: foreground)
    }

    func inbox(foreground: Bool) async throws -> InboxResponse {
        try await call("GET", "/v1/inbox", foreground: foreground)
    }

    func sendRequest(to: String, text: String) async throws -> SendResponse {
        try await call("POST", "/v1/requests", body: ["to": to, "text": text])
    }

    /// Answers a message you accepted. It's delivered without an accept step.
    func sendReply(to requestId: String, text: String) async throws -> SendResponse {
        try await call("POST", "/v1/requests", body: ["replyTo": requestId, "text": text])
    }

    func accept(id: String) async throws -> AcceptResponse {
        try await call("POST", "/v1/requests/\(id)/accept")
    }

    @discardableResult
    func decline(id: String, block: Bool) async throws -> DeclineResponse {
        try await call("POST", "/v1/requests/\(id)/decline", body: ["block": block])
    }

    func block(personId: String) async throws {
        let _: OKResponse = try await call("POST", "/v1/blocks", body: ["personId": personId])
    }

    /// Reports a request or message (`requestId`) or someone on the nearby list
    /// (`personId`). The server blocks them as well.
    func report(requestId: String? = nil, personId: String? = nil, reason: ReportReason, note: String) async throws {
        var body: [String: Any] = ["reason": reason.rawValue, "note": note]
        if let requestId { body["requestId"] = requestId }
        if let personId { body["personId"] = personId }
        let _: OKResponse = try await call("POST", "/v1/reports", body: body)
    }

    // MARK: Plumbing

    private func call<T: Decodable>(
        _ method: String,
        _ path: String,
        body: [String: Any]? = nil,
        foreground: Bool = false,
        auth: String?? = .none
    ) async throws -> T {
        guard let url = URL(string: base + path) else { throw APIError.transport(URLError(.badURL)) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        // `auth` = .none uses the stored token, .some(nil) sends none, .some(t) sends t.
        let bearer: String? = auth ?? token
        if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if foreground { req.setValue("1", forHTTPHeaderField: "X-Whisper-Foreground") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(status) else {
            let e = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw APIError.server(status: status, code: e?.error ?? "http_\(status)", message: e?.message)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}
