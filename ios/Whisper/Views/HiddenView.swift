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
