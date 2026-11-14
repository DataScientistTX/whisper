import SwiftUI

/// Shown once before first use. App Store guideline 1.2 asks apps with
/// user-generated content to have people agree to terms that make clear
/// there is no tolerance for objectionable content or abusive users.
struct TermsView: View {
    var onAgree: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Whisper lets you send short notes to people around you. Keep it kind and useful.")
                        .font(.title3)

                    rule("hand.thumbsup", "Be helpful", "Headlights off, trunk open, thanks for letting me in. That's what Whisper is for.")
                    rule("nosign", "Zero tolerance", "No harassment, threats, sexual content, hate speech or spam. Messages like that are filtered, and people who send them get blocked, reported and suspended.")
                    rule("hand.raised", "You're in control", "Nobody can read their message to you until you accept. You can decline, block or report anyone at any time.")
                    rule("car", "Stay safe on the road", "Never type while driving. Use quick messages, or let a passenger do it.")
                    rule("lock", "Private by design", "No account, no name, no stored location history. Exact positions are never shown to anyone.")

                    Text("Questions or a problem with someone? Email \(Config.supportEmail).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding()
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: onAgree) {
                    Text("I agree").font(.headline).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
                .background(.bar)
            }
            .navigationTitle("Before you start")
        }
    }

    private func rule(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(text).foregroundStyle(.secondary)
            }
        }
    }
}
