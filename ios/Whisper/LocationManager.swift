import CoreLocation

/// Continuous location while visible. Uses When In Use permission plus the
/// location background mode, so iOS shows the blue location pill in the
/// background and the user can see Whisper is running.
@MainActor
final class LocationManager: NSObject, ObservableObject {
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    @Published private(set) var latest: CLLocation?
    private var compassHeading: Double?

    private let manager = CLLocationManager()
    private var backgroundSession: CLBackgroundActivitySession?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        authorization = manager.authorizationStatus
    }

    var isAuthorized: Bool {
        authorization == .authorizedWhenInUse || authorization == .authorizedAlways
    }

    var isDenied: Bool {
        authorization == .denied || authorization == .restricted
    }

    /// Asks for permission if needed and waits for the answer.
    func ensureAuthorized() async -> Bool {
        if isAuthorized { return true }
        if isDenied { return false }
        manager.requestWhenInUseAuthorization()
        var waited = 0
        while authorization == .notDetermined && waited < 600 { // up to a minute
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        return isAuthorized
    }

    func start() {
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        backgroundSession = CLBackgroundActivitySession()
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
        manager.allowsBackgroundLocationUpdates = false
        backgroundSession?.invalidate()
        backgroundSession = nil
        latest = nil
    }

    /// Direction of travel when moving (so "ahead" means ahead of the car),
    /// otherwise the way the phone is pointing.
    var travelHeading: Double? {
        if let l = latest, l.speed > 1.5, l.course >= 0 { return l.course }
        return compassHeading
    }
}

extension LocationManager: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last, last.horizontalAccuracy >= 0 else { return }
        Task { @MainActor in self.latest = last }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        let h = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        Task { @MainActor in self.compassHeading = h >= 0 ? h : nil }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in self.authorization = status }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Temporary GPS errors are normal (tunnels, garages). Keep going.
    }
}
