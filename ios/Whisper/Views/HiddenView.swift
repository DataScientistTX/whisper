import SwiftUI

struct HiddenView: View {
    @EnvironmentObject private var store: SessionStore
    @EnvironmentObject private var location: LocationManager

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Image(systemName: "bubble.left.and.text.bubble.right.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(.tint)
                        Text("Send a short, anonymous note to someone right around you, like the car in the next lane or the table across the room.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }

                Section {
                    TextField("e.g. White Toyota, red jacket", text: $store.descriptionText)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                    DescriptionChips(text: $store.descriptionText)
                } header: {
                    Text("How people can spot you")
                } footer: {
                    Text("GPS is only accurate to about 5–10 m, so this is how people tell who's who.")
                }

                Section("Range") {
                    RangePicker()
                }

                Section {
                    Button {
                        Task { await store.goVisible() }
                    } label: {
                        HStack {
                            Spacer()
                            if store.phase == .joining {
                                ProgressView()
                            } else {
                                Label("Go visible", systemImage: "eye.fill").font(.headline)
                            }
                            Spacer()
                        }
                    }
                    .disabled(store.phase == .joining)
                } footer: {
                    Text("No account, no name. You get a random nickname, and nothing is stored once you leave. You go hidden when you tap Go hidden, after 3 hours, or after 15 minutes without using the app.")
                }

                if let error = store.lastError {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }

                Section {
                    Link(destination: URL(string: "mailto:\(Config.supportEmail)")!) {
                        Label("Report a problem: \(Config.supportEmail)", systemImage: "envelope")
                    }
                } footer: {
                    Text("To report someone you met here, swipe on them or long-press their message in the app.")
                }

                if location.isDenied {
                    Section {
                        Text("Location is turned off for Whisper.")
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Whisper")
        }
    }
}

/// One-tap descriptions: a colour and a kind of car make "White SUV".
/// Tapping another colour or kind swaps that word and keeps the rest.
struct DescriptionChips: View {
    @Binding var text: String

    static let colors = ["White", "Black", "Silver", "Grey", "Red", "Blue", "Green"]
    static let kinds = ["Sedan", "SUV", "Pickup", "Hatchback", "Van", "Motorbike"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            chipRow(Self.colors, selected: Self.word(in: text, from: Self.colors)) { text = Self.applying(color: $0, to: text) }
            chipRow(Self.kinds, selected: Self.word(in: text, from: Self.kinds)) { text = Self.applying(kind: $0, to: text) }
        }
        .padding(.vertical, 2)
    }

    private func chipRow(_ words: [String], selected: String?, tap: @escaping (String) -> Void) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(words, id: \.self) { word in
                    Button(word) { tap(word) }
                        .font(.footnote.weight(.medium))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(word == selected ? .accentColor : .secondary)
                }
            }
        }
    }

    static func word(in text: String, from list: [String]) -> String? {
        let words = text.split(separator: " ").map { $0.lowercased() }
        return list.first { words.contains($0.lowercased()) }
    }

    static func applying(color: String, to text: String) -> String {
        var words = text.split(separator: " ").map(String.init)
        if let i = words.firstIndex(where: { w in colors.contains { $0.lowercased() == w.lowercased() } }) {
            words[i] = color
        } else {
            words.insert(color, at: 0)
        }
        return String(words.joined(separator: " ").prefix(40))
    }

    static func applying(kind: String, to text: String) -> String {
        var words = text.split(separator: " ").map(String.init)
        if let i = words.firstIndex(where: { w in kinds.contains { $0.lowercased() == w.lowercased() } }) {
            words[i] = kind
        } else {
            words.append(kind)
        }
        return String(words.joined(separator: " ").prefix(40))
    }
}
