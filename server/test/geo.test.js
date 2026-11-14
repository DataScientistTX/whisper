import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, bearing, directionLabel, roughDistance } from '../src/geo.js';

test('distance and bearing', () => {
  const a = { lat: 0, lon: 0 };
  const north = { lat: 0.001, lon: 0 };
  assert.ok(Math.abs(distance(a, north) - 111.2) < 0.5);
  assert.ok(Math.abs(bearing(a, north)) < 0.01);
  assert.ok(Math.abs(bearing(a, { lat: 0, lon: 0.001 }) - 90) < 0.01);
});

test('direction labels', () => {
  assert.equal(directionLabel(0, 0), 'ahead');
  assert.equal(directionLabel(315, 0), 'ahead left');
  assert.equal(directionLabel(90, 180), 'left');
  assert.equal(directionLabel(180, null), 'south');
  assert.equal(directionLabel(45, undefined), 'north-east');
});

test('rough distance', () => {
  assert.equal(roughDistance(3), 5);
  assert.equal(roughDistance(23), 25);
  assert.equal(roughDistance(87), 90);
});
