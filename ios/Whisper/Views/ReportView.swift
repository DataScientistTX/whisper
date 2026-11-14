import SwiftUI

/// Report someone. Reporting also blocks them, and the report goes to the
/// people running Whisper for review.
@MainActor
struct ReportView: View {
    let target: ReportTarget

    @EnvironmentObject private var store: SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var reason: ReportReason = .harassment
    @State private var note = ""
    @State private var sending = false
    @State private var error: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                if done {
                    Section {
                        Label("Thanks. They're blocked, and we'll review the report.", systemImage: "checkmark.shield.fill")
                            .foregroundStyle(.green)
                    }
                } else {
                    Section("What's wrong?") {
                        Picker("Reason", selection: $reason) {
                            ForEach(ReportReason.allCases) { r in
                                Text(r.label).tag(r)
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                    Section {
                        TextField("Anything else? (optional)", text: $note, axis: .vertical)
                            .lineLimit(2...4)
                            .onChange(of: note) { _, v in
                                if v.count > 200 { note = String(v.prefix(200)) }
                            }
                    } footer: {
                        Text(footer)
                    }
                    if let error {
                        Section { Text(error).foregroundStyle(.red) }
                    }
                }
            }
            .navigationTitle("Report \(target.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(done ? "Done" : "Cancel") { dismiss() }
                }
                if !done {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Report", role: .destructive) { submit() }
                            .disabled(sending)
                    }
                }
            }
        }
        .presentationDetents([.large])
    }

    private var footer: String {
        switch target {
        case .incoming(let r) where !r.isPending:
            "We'll block them and send this message to our team for review."
        default:
            "We'll block them and send their nickname and description to our team for review."
        }
    }

    private func submit() {
        sending = true
        error = nil
        Task {
            let result = await store.report(target, reason: reason, note: note)
            sending = false
            if let result {
                error = result
            } else {
                done = true
            }
        }
    }
}
