import Foundation

enum Config {
    /// Your Railway URL, e.g. https://whisper-production.up.railway.app (no trailing slash).
    static let apiBaseURL = URL(string: "https://YOUR-APP.up.railway.app")!

    /// How often the app reports its location and refreshes while visible.
    static let tickSeconds: Double = 4
}
