import Foundation
import UserNotifications

/// Lock-screen actions on a message request, and local notifications.
enum Notifications {
    static let requestCategory = "WHISPER_REQUEST"
    static let acceptAction = "WHISPER_ACCEPT"
    static let declineAction = "WHISPER_DECLINE"
    static let blockAction = "WHISPER_BLOCK"

    static func registerCategories() {
        let category = UNNotificationCategory(
            identifier: requestCategory,
            actions: [
                UNNotificationAction(identifier: acceptAction, title: "Accept", options: []),
                UNNotificationAction(identifier: declineAction, title: "Decline", options: [.destructive]),
                UNNotificationAction(identifier: blockAction, title: "Decline & block", options: [.destructive]),
            ],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// Handles a lock-screen button on a request push.
    static func handle(action: String, requestId: String) async {
        let api = APIClient.shared
        guard api.token != nil else { return }
        switch action {
        case acceptAction:
            if let r = try? await api.accept(id: requestId) {
                showMessage(from: r.from.title, text: r.text, id: r.id)
            }
        case declineAction:
            _ = try? await api.decline(id: requestId, block: false)
        case blockAction:
            _ = try? await api.decline(id: requestId, block: true)
        default:
            break
        }
    }

    /// Shows an accepted message's text as a local notification.
    static func showMessage(from: String, text: String, id: String) {
        let content = UNMutableNotificationContent()
        content.title = from
        content.body = text
        content.sound = .default
        content.threadIdentifier = "whisper-messages"
        let request = UNNotificationRequest(identifier: "msg-\(id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    static func showInfo(_ text: String) {
        let content = UNMutableNotificationContent()
        content.title = "Whisper"
        content.body = text
        let request = UNNotificationRequest(identifier: "info-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
