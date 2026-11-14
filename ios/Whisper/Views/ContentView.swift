import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: SessionStore

    var body: some View {
        switch store.phase {
        case .hidden, .joining:
            HiddenView()
        case .visible:
            VisibleView()
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
