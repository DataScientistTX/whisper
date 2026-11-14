import SwiftUI

struct VisibleView: View {
    @EnvironmentObject private var store: SessionStore
    @State private var composeTarget: ComposeTarget?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.me.map { $0.description.isEmpty ? $0.nickname : "\($0.nickname) · \($0.description)" } ?? "Visible")
                            .font(.headline)
                        if let hidesAt = store.hidesAt {
                            (Text("Visible. Hides automatically ") + Text(hidesAt, style: .relative) + Text(" from now."))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    RangePicker()
                }

                if !store.pendingIncoming.isEmpty {
                    Section("Wants to message you") {
                        ForEach(store.pendingIncoming) { r in
                            IncomingRow(request: r)
                        }
                    }
                }

                Section {
                    if store.people.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Nobody visible nearby yet").foregroundStyle(.secondary)
                            Text("People show up here when they're within \(store.range.meters) m and have Whisper open.")
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                        }
                    } else {
                        ForEach(store.people) { p in
                            Button {
                                store.noteInteraction()
                                composeTarget = .person(p)
                            } label: {
                                PersonRow(person: p)
                            }
                            .tint(.primary)
                        }
                        Button {
                            store.noteInteraction()
                            composeTarget = .everyone(count: store.people.count)
                        } label: {
                            Label("Message everyone nearby", systemImage: "person.3.fill")
                        }
                    }
                } header: {
                    Text("Nearby")
                }

                if !store.messages.isEmpty {
                    Section("Messages") {
                        ForEach(store.messages) { r in
                            MessageRow(request: r)
                        }
                    }
                }

                if !store.sent.isEmpty {
                    Section("Sent") {
                        ForEach(store.sent) { r in
                            SentRow(request: r)
                        }
                    }
                }

                if let error = store.lastError {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Whisper")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Go hidden", role: .destructive) {
                        store.goHidden()
                    }
                }
            }
            .refreshable { await store.refresh() }
            .sheet(item: $composeTarget) { target in
                ComposeView(target: target)
            }
        }
    }
}

struct PersonRow: View {
    let person: Person

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "location.north.fill")
                .foregroundStyle(.tint)
                .rotationEffect(.degrees(Self.angle(for: person.direction)))
            VStack(alignment: .leading, spacing: 2) {
                Text(person.title).font(.body.weight(.medium))
                Text(person.whereabouts).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "paperplane").foregroundStyle(.tint)
        }
        .contentShape(Rectangle())
    }

    /// Points the arrow roughly the way the label says.
    static func angle(for direction: String) -> Double {
        let table: [String: Double] = [
            "ahead": 0, "ahead right": 45, "right": 90, "behind right": 135,
            "behind": 180, "behind left": 225, "left": 270, "ahead left": 315,
            "north": 0, "north-east": 45, "east": 90, "south-east": 135,
            "south": 180, "south-west": 225, "west": 270, "north-west": 315,
        ]
        return table[direction] ?? 0
    }
}

struct IncomingRow: View {
    @EnvironmentObject private var store: SessionStore
    let request: IncomingRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(request.from.title) wants to send you a message")
            HStack {
                Button("Accept") { Task { await store.accept(request) } }
                    .buttonStyle(.borderedProminent)
                Button("Decline") { Task { await store.decline(request, block: false) } }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Block", role: .destructive) { Task { await store.decline(request, block: true) } }
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 4)
    }
}

struct MessageRow: View {
    let request: IncomingRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(request.from.title).font(.footnote.weight(.semibold))
                Spacer()
                if let d = request.date {
                    Text(d, style: .time).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(request.text ?? "").font(.title3)
        }
        .padding(.vertical, 4)
    }
}

struct SentRow: View {
    let request: SentRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("To \(request.to.title)").font(.footnote.weight(.semibold))
                Spacer()
                StatusBadge(status: request.status)
            }
            if let text = request.text {
                Text(text).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String {
        switch status {
        case "accepted": "Accepted"
        case "declined": "Declined"
        default: "Waiting"
        }
    }

    private var color: Color {
        switch status {
        case "accepted": .green
        case "declined": .red
        default: .orange
        }
    }
}
