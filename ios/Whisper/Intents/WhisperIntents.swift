import AppIntents
import Foundation

// Siri and Shortcuts support, so drivers can send without touching the phone:
// "Hey Siri, Whisper headlights off". Works through CarPlay's Siri too.

enum SpokenMessage: String, AppEnum {
    case headlights, merge, trunk, tire, gasCap, dragging, signal, thanks

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Quick message"

    static var caseDisplayRepresentations: [SpokenMessage: DisplayRepresentation] = [
        .headlights: DisplayRepresentation(title: "headlights off", synonyms: ["headlights", "lights off", "your lights", "lights"]),
        .merge: DisplayRepresentation(title: "can I merge", synonyms: ["merge", "let me in", "can I get in"]),
        .trunk: DisplayRepresentation(title: "trunk open", synonyms: ["trunk", "your trunk"]),
        .tire: DisplayRepresentation(title: "tire low", synonyms: ["tire", "flat tire", "low tire"]),
        .gasCap: DisplayRepresentation(title: "gas cap open", synonyms: ["gas cap", "fuel cap"]),
        .dragging: DisplayRepresentation(title: "something dragging", synonyms: ["dragging", "something under your car"]),
        .signal: DisplayRepresentation(title: "turn signal on", synonyms: ["blinker", "turn signal", "signal"]),
        .thanks: DisplayRepresentation(title: "thanks", synonyms: ["thank you", "thanks for letting me in"]),
    ]

    var text: String {
        switch self {
        case .headlights: "Your headlights are off"
        case .merge: "Can I merge in front of you?"
        case .trunk: "Your trunk is open"
        case .tire: "Your tire looks low"
        case .gasCap: "Your gas cap is open"
        case .dragging: "Something is dragging under your car"
        case .signal: "Your turn signal is still on"
        case .thanks: "Thanks for letting me in!"
        }
    }
}

enum SpokenRecipient: String, AppEnum {
    case ahead, nearest, everyone

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Recipient"

    static var caseDisplayRepresentations: [SpokenRecipient: DisplayRepresentation] = [
        .ahead: DisplayRepresentation(title: "the car ahead", synonyms: ["ahead", "in front"]),
        .nearest: DisplayRepresentation(title: "the closest person", synonyms: ["nearest", "closest"]),
        .everyone: DisplayRepresentation(title: "everyone nearby", synonyms: ["everyone", "everybody"]),
    ]
}

@MainActor
enum IntentSupport {
    /// Makes sure we're visible and have a fresh nearby list, waiting a moment
    /// if iOS just launched the app for this request.
    static func readyStore() async -> SessionStore? {
        let store = SessionStore.shared
        if store.phase == .hidden { await store.restore() }
        guard store.phase == .visible else { return nil }
        for _ in 0..<6 {
            await store.refresh()
            if !store.people.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return store
    }

    static func pick(_ recipient: SpokenRecipient, from people: [Person]) -> ComposeTarget? {
        guard let nearest = people.first else { return nil }
        switch recipient {
        case .everyone:
            return .everyone(count: people.count)
        case .nearest:
            return .person(nearest)
        case .ahead:
            // People are sorted by distance. Prefer straight ahead, then ahead
            // left or right; when standing still the labels are compass points,
            // so fall back to the closest person.
            if let p = people.first(where: { $0.direction == "ahead" }) { return .person(p) }
            if let p = people.first(where: { $0.direction.hasPrefix("ahead") }) { return .person(p) }
            return .person(nearest)
        }
    }

    static func send(_ text: String, to recipient: SpokenRecipient) async -> String {
        guard let store = await readyStore() else {
            return "Whisper is hidden. Open Whisper and tap Go visible first."
        }
        guard let target = pick(recipient, from: store.people) else {
            return "Nobody with Whisper is close enough right now."
        }
        if let error = await store.send(to: target, text: text) {
            return error
        }
        switch target {
        case .person(let p):
            return "Sent to \(p.title). They'll see it if they accept."
        case .everyone(let n):
            return n == 1 ? "Sent to the 1 person nearby." : "Sent to \(n) people nearby."
        case .reply(let r):
            return "Replied to \(r.from.title)."
        }
    }
}

struct SendQuickWhisperIntent: AppIntent {
    static var title: LocalizedStringResource = "Send a Whisper"
    static var description = IntentDescription("Send a quick message to someone nearby without touching your phone.")
    static var openAppWhenRun = false

    @Parameter(title: "Message")
    var message: SpokenMessage

    @Parameter(title: "To", default: .ahead)
    var recipient: SpokenRecipient

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to \(\.$recipient)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let reply = await IntentSupport.send(message.text, to: recipient)
        return .result(dialog: IntentDialog(stringLiteral: reply))
    }
}

struct SendCustomWhisperIntent: AppIntent {
    static var title: LocalizedStringResource = "Send a custom Whisper"
    static var description = IntentDescription("Dictate a short message (140 characters) to someone nearby.")
    static var openAppWhenRun = false

    @Parameter(title: "Message", requestValueDialog: "What should it say?")
    var text: String

    @Parameter(title: "To", default: .ahead)
    var recipient: SpokenRecipient

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$text) to \(\.$recipient)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(140))
        guard !trimmed.isEmpty else { return .result(dialog: "There was nothing to send.") }
        let reply = await IntentSupport.send(trimmed, to: recipient)
        return .result(dialog: IntentDialog(stringLiteral: reply))
    }
}

struct GoVisibleIntent: AppIntent {
    static var title: LocalizedStringResource = "Go visible on Whisper"
    static var description = IntentDescription("Let people nearby find you on Whisper.")
    // Starting location needs the app in the foreground the first time.
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = SessionStore.shared
        if store.phase == .hidden { await store.goVisible() }
        if store.phase == .visible {
            return .result(dialog: "You're visible on Whisper.")
        }
        return .result(dialog: IntentDialog(stringLiteral: store.lastError ?? "Couldn't go visible."))
    }
}

struct GoHiddenIntent: AppIntent {
    static var title: LocalizedStringResource = "Go hidden on Whisper"
    static var description = IntentDescription("Stop being visible and erase your Whisper session.")
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = SessionStore.shared
        if store.phase == .hidden { await store.restore() }
        store.goHidden()
        return .result(dialog: "You're hidden. Your Whisper session is erased.")
    }
}

struct WhisperShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendQuickWhisperIntent(),
            phrases: [
                "\(.applicationName) \(\.$message)",
                "Send \(\.$message) with \(.applicationName)",
                "Tell the car ahead \(\.$message) with \(.applicationName)",
                "Send a \(.applicationName)",
            ],
            shortTitle: "Send a Whisper",
            systemImageName: "bubble.left.fill"
        )
        AppShortcut(
            intent: SendCustomWhisperIntent(),
            phrases: [
                "Send a custom \(.applicationName)",
                "Dictate a \(.applicationName)",
            ],
            shortTitle: "Dictate a Whisper",
            systemImageName: "mic.fill"
        )
        AppShortcut(
            intent: GoVisibleIntent(),
            phrases: ["Go visible on \(.applicationName)", "Start \(.applicationName)"],
            shortTitle: "Go visible",
            systemImageName: "eye.fill"
        )
        AppShortcut(
            intent: GoHiddenIntent(),
            phrases: ["Hide me on \(.applicationName)", "Stop \(.applicationName)"],
            shortTitle: "Go hidden",
            systemImageName: "eye.slash.fill"
        )
    }
}
