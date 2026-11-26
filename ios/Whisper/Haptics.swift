import UIKit

/// Small taps that confirm what happened without looking at the screen.
@MainActor
enum Haptics {
    static func sent() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func failed() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    static func newRequest() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
