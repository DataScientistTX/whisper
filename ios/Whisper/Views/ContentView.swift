import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: SessionStore
    @AppStorage("whisper.termsAccepted.v1") private var termsAccepted = false

    var body: some View {
        if !termsAccepted {
            TermsView { termsAccepted = true }
        } else {
            switch store.phase {
            case .hidden, .joining:
                HiddenView()
            case .visible:
                VisibleView()
            }
        }
    }
}

struct RangePicker: View {
    @EnvironmentObject private var store: SessionStore

    var body: some View {
        Picker("Range", selection: $store.range) {
            ForEach(SearchRange.allCases) { r in
                Text("\(r.label) \(r.meters) m").tag(r)
            }
        }
        .pickerStyle(.segmented)
    }
}
