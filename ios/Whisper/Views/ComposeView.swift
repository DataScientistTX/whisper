import SwiftUI

@MainActor
struct ComposeView: View {
    let target: ComposeTarget

    @EnvironmentObject private var store: SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?

    private let limit = 140

    var body: some View {
        NavigationStack {
            List {
                Section("Quick messages") {
                    ForEach(QuickMessages.all, id: \.self) { message in
                        Button(message) { send(message) }
                    }
                }

                Section {
                    TextField("Or write your own", text: $text, axis: .vertical)
                        .lineLimit(2...4)
                        .onChange(of: text) { _, value in
                            if value.count > limit { text = String(value.prefix(limit)) }
                        }
                    HStack {
                        Text("\(text.count)/\(limit)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Send") { send(text) }
                            .buttonStyle(.borderedProminent)
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                } footer: {
                    Text("They only see your nickname and description until they accept. Please don't type while driving.")
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .disabled(sending)
            .overlay {
                if sending { ProgressView() }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func send(_ message: String) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sending else { return }
        sending = true
        error = nil
        Task {
            let result = await store.send(to: target, text: trimmed)
            sending = false
            if let result {
                error = result
            } else {
                dismiss()
            }
        }
    }
}
