import Foundation
import UIKit
import UserNotifications

enum ComposeTarget: Identifiable, Hashable {
    case person(Person)
    case everyone(count: Int)
    /// Answer a message you accepted. Works even once they're out of range.
    case reply(IncomingRequest)

    var id: String {
        switch self {
        case .person(let p): p.id
        case .everyone: "everyone"
        case .reply(let r): "reply-\(r.id)"
        }
    }

    var title: String {
        switch self {
        case .person(let p): p.title
        case .everyone(let n): n == 1 ? "Everyone nearby (1 person)" : "Everyone nearby (\(n) people)"
        case .reply(let r): "Reply to \(r.from.title)"
        }
    }

    var isReply: Bool {
        if case .reply = self { return true }
        return false
    }
}

enum ReportTarget: Identifiable {
    case person(Person)
    case incoming(IncomingRequest)

    var id: String {
        switch self {
        case .person(let p): "p-\(p.id)"
        case .incoming(let r): "r-\(r.id)"
        }
    }

    var title: String {
        switch self {
        case .person(let p): p.title
        case .incoming(let r): r.from.title
        }
    }
}

/// The app's state: hidden or visible, who is nearby, and the inbox.
@MainActor
final class SessionStore: ObservableObject {
    static let shared = SessionStore()

    enum Phase: Equatable { case hidden, joining, visible }

    @Published private(set) var phase: Phase = .hidden
    @Published private(set) var me: Me?
    @Published private(set) var people: [Person] = []
    @Published private(set) var incoming: [IncomingRequest] = []
    @Published private(set) var sent: [SentRequest] = []
    @Published private(set) var startedAt: Date?
    @Published var lastError: String?
    /// A short confirmation shown at the bottom of the screen, like "Sent to Red Owl".
    @Published private(set) var toast: String?
    /// "Everyone nearby" is allowed once every 2 minutes; this is when it's free again.
    @Published private(set) var broadcastAvailableAt: Date?

    @Published var descriptionText: String {
        didSet {
            if descriptionText.count > 40 { descriptionText = String(descriptionText.prefix(40)) }
            defaults.set(descriptionText, forKey: Keys.description)
        }
    }

    @Published var range: SearchRange {
        didSet {
            defaults.set(range.rawValue, forKey: Keys.range)
            guard phase == .visible, oldValue != range else { return }
            noteInteraction()
            Task { await refresh() }
        }
    }

    let location = LocationManager()

    static let maxSession: TimeInterval = 3 * 60 * 60
    // A few seconds under the server's 15 minutes, so the app hides first.
    static let inactivityLimit: TimeInterval = 15 * 60 - 10

    private let api = APIClient.shared
    private let defaults = UserDefaults.standard
    private var loop: Task<Void, Never>?
    private var isForeground = true
    private var lastInteraction = Date()
    private var pushToken: String?
    private var toastTask: Task<Void, Never>?
    private var knownPending: Set<String> = []

    private enum Keys {
        static let description = "whisper.description"
        static let range = "whisper.range"
        static let startedAt = "whisper.startedAt"
    }

    private init() {
        descriptionText = UserDefaults.standard.string(forKey: Keys.description) ?? ""
        range = SearchRange(rawValue: UserDefaults.standard.string(forKey: Keys.range) ?? "") ?? .normal
    }

    var pendingIncoming: [IncomingRequest] { incoming.filter(\.isPending) }
    var messages: [IncomingRequest] { incoming.filter { !$0.isPending } }
    var hidesAt: Date? { startedAt.map { $0.addingTimeInterval(Self.maxSession) } }

    // MARK: Going visible and hidden

    func goVisible() async {
        guard phase == .hidden else { return }
        lastError = nil
        phase = .joining
        guard await location.ensureAuthorized() else {
            phase = .hidden
            lastError = "Whisper needs your location to find people nearby."
            return
        }
        await requestNotifications()
        do {
            try await join(nickname: nil)
            let now = Date()
            startedAt = now
            defaults.set(now, forKey: Keys.startedAt)
            lastInteraction = now
            location.start()
            phase = .visible
            startLoop()
        } catch {
            phase = .hidden
            lastError = Self.describe(error)
        }
    }

    /// Picks up a session that is still alive after iOS relaunched the app.
    func restore() async {
        guard phase == .hidden else { return }
        guard api.token != nil,
              let started = defaults.object(forKey: Keys.startedAt) as? Date,
              Date().timeIntervalSince(started) < Self.maxSession,
              location.isAuthorized
        else {
            api.token = nil
            defaults.removeObject(forKey: Keys.startedAt)
            return
        }
        do {
            me = try await api.me()
            startedAt = started
            lastInteraction = Date()
            location.start()
            phase = .visible
            startLoop()
        } catch {
            api.token = nil
            defaults.removeObject(forKey: Keys.startedAt)
        }
    }

    func goHidden(notice: String? = nil) {
        loop?.cancel()
        loop = nil
        location.stop()
        if let token = api.token {
            api.token = nil
            let api = self.api
            Task { try? await api.deleteMe(token: token) }
        }
        defaults.removeObject(forKey: Keys.startedAt)
        startedAt = nil
        me = nil
        people = []
        incoming = []
        sent = []
        knownPending = []
        broadcastAvailableAt = nil
        toast = nil
        phase = .hidden
        if let notice { Notifications.showInfo(notice) }
    }

    private func join(nickname: String?) async throws {
        let s = try await api.createSession(nickname: nickname, description: descriptionText, pushToken: pushToken)
        me = s.me
    }

    /// The server lost our session (for example it restarted). Rejoin quietly
    /// with the same nickname.
    private func reconnect() async {
        guard phase == .visible else { return }
        do {
            try await join(nickname: me?.nickname)
            people = []
            incoming = []
            sent = []
        } catch {
            // Try again on the next tick.
        }
    }

    // MARK: The 4-second loop

    private func startLoop() {
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(Config.tickSeconds))
            }
        }
    }

    func refresh() async {
        await tick()
    }

    private func tick() async {
        guard phase == .visible, let startedAt else { return }
        let now = Date()
        if isForeground { lastInteraction = now }
        if now.timeIntervalSince(startedAt) >= Self.maxSession {
            goHidden(notice: "You're hidden now. Sessions end after 3 hours.")
            return
        }
        if now.timeIntervalSince(lastInteraction) >= Self.inactivityLimit {
            goHidden(notice: "You're hidden now, after 15 minutes without using Whisper.")
            return
        }
        do {
            if let fix = location.latest {
                do {
                    try await api.putLocation(fix, heading: location.travelHeading)
                } catch APIError.server {
                    // e.g. a GPS glitch the server rejects as implausible: skip this fix.
                }
                let n = try await api.nearby(radius: range.rawValue, foreground: isForeground)
                people = n.people
            }
            let box = try await api.inbox(foreground: isForeground)
            me = box.me
            let pending = Set(box.incoming.filter(\.isPending).map(\.id))
            if isForeground, !pending.subtracting(knownPending).isEmpty { Haptics.newRequest() }
            knownPending = pending
            incoming = box.incoming
            sent = box.sent
        } catch APIError.unauthorized {
            await reconnect()
        } catch {
            // Network blips are normal on the road. Keep going quietly.
        }
    }

    // MARK: User actions

    func noteInteraction() {
        lastInteraction = Date()
    }

    func setForeground(_ foreground: Bool) {
        isForeground = foreground
        if foreground {
            noteInteraction()
            Task { await refresh() }
        }
    }

    /// Returns an error message, or nil when sent.
    func send(to target: ComposeTarget, text: String) async -> String? {
        noteInteraction()
        do {
            let r: SendResponse
            switch target {
            case .person(let p): r = try await api.sendRequest(to: p.id, text: text)
            case .everyone: r = try await api.sendRequest(to: "everyone", text: text)
            case .reply(let original): r = try await api.sendReply(to: original.id, text: text)
            }
            if case .everyone = target { broadcastAvailableAt = Date().addingTimeInterval(Self.broadcastCooldown) }
            await refresh()
            guard r.sent > 0 else { return "Nobody could receive it right now." }
            Haptics.sent()
            showToast(Self.sentMessage(for: target, count: r.sent))
            return nil
        } catch APIError.unauthorized {
            await reconnect()
            return "You were reconnected. Please try again."
        } catch let error as APIError {
            if error.code == "broadcast_cooldown", let wait = error.retryAfter {
                broadcastAvailableAt = Date().addingTimeInterval(TimeInterval(wait))
            }
            Haptics.failed()
            return Self.describe(error)
        } catch {
            Haptics.failed()
            return Self.describe(error)
        }
    }

    func accept(_ request: IncomingRequest) async {
        noteInteraction()
        do {
            _ = try await api.accept(id: request.id)
            Haptics.tap()
        } catch {
            lastError = Self.describe(error)
        }
        await refresh()
    }

    /// Accepts a request and returns its text, for Siri to read out.
    func acceptAndRead(_ request: IncomingRequest) async -> String? {
        noteInteraction()
        defer { Task { await refresh() } }
        do {
            return try await api.accept(id: request.id).text
        } catch {
            lastError = Self.describe(error)
            return nil
        }
    }

    func decline(_ request: IncomingRequest, block: Bool) async {
        noteInteraction()
        do {
            try await api.decline(id: request.id, block: block)
        } catch {
            lastError = Self.describe(error)
        }
        await refresh()
    }

    func block(_ person: Person) async {
        noteInteraction()
        people.removeAll { $0.id == person.id }
        do {
            try await api.block(personId: person.id)
        } catch {
            lastError = Self.describe(error)
        }
        await refresh()
    }

    /// Returns an error message, or nil when the report went through.
    func report(_ target: ReportTarget, reason: ReportReason, note: String) async -> String? {
        noteInteraction()
        do {
            switch target {
            case .person(let p):
                try await api.report(personId: p.id, reason: reason, note: note)
                people.removeAll { $0.id == p.id }
            case .incoming(let r):
                try await api.report(requestId: r.id, reason: reason, note: note)
                incoming.removeAll { $0.id == r.id }
            }
            await refresh()
            return nil
        } catch {
            return Self.describe(error)
        }
    }

    // MARK: Push

    func setPushToken(_ hex: String) {
        pushToken = hex
        guard phase == .visible else { return }
        let api = self.api
        Task { try? await api.updateMe(["pushToken": hex]) }
    }

    private func requestNotifications() async {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        UIApplication.shared.registerForRemoteNotifications()
    }

    static let broadcastCooldown: TimeInterval = 2 * 60

    static func sentMessage(for target: ComposeTarget, count: Int) -> String {
        switch target {
        case .person(let p): "Sent to \(p.nickname). They'll see it if they accept."
        case .everyone: count == 1 ? "Sent to 1 person nearby." : "Sent to \(count) people nearby."
        case .reply(let r): "Reply sent to \(r.from.nickname)."
        }
    }

    func showToast(_ text: String) {
        toastTask?.cancel()
        toast = text
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    static func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
