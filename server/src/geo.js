// Small geo helpers. All distances in metres, angles in degrees.

const R = 6371008.8; // mean Earth radius
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial compass bearing from a to b, 0..360 (0 = north).
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const RELATIVE = ['ahead', 'ahead right', 'right', 'behind right', 'behind', 'behind left', 'left', 'ahead left'];
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

// Human direction label. If we know which way the viewer is facing or moving
// (heading, degrees), the label is relative ("ahead left"); otherwise compass.
export function directionLabel(bearingDeg, heading) {
  if (typeof heading === 'number' && Number.isFinite(heading) && heading >= 0) {
    const rel = (bearingDeg - heading + 360) % 360;
    return RELATIVE[Math.round(rel / 45) % 8];
  }
  return COMPASS[Math.round(bearingDeg / 45) % 8];
}

// Coarse distance so exact positions can't be reconstructed.
export function roughDistance(m) {
  if (m < 10) return 5;
  if (m < 50) return Math.round(m / 5) * 5;
  return Math.round(m / 10) * 10;
}

export function validCoord(lat, lon) {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}
