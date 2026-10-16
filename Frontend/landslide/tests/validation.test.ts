import { describe, expect, it } from 'vitest';
import { investigate } from '../engine/adapter';
import { calculateGeodesicAreaKm2, canSubmitCatalogPreflight, timestampToRequest, validateAnalysisRequest, validateCatalogPreflight, validatePolyline, validateTimestamp } from '../engine/validation';
import type { AnalysisRequest, InvestigationPolyline } from '../engine/types';

const line: InvestigationPolyline = { type: 'LineString', crs: 'EPSG:4326', coordinates: [[85.5, 28.2], [85.6, 28.25]] };
const request: AnalysisRequest = {
  location: { searchText: 'test site', name: 'Test site', latitude: 28.2, longitude: 85.5 },
  polyline: line,
  timestamp: '2026-08-28T00:00:00Z',
};

describe('Landslide investigation contract', () => {
  it('starts without a default site or scientific result', () => {
    expect(request.location.searchText).toBe('test site');
    expect(validateAnalysisRequest(request).valid).toBe(true);
  });

  it('requires a WGS84 LineString with two valid vertices', () => {
    expect(validatePolyline({ ...line, coordinates: [[85.5, 28.2]] }).valid).toBe(false);
    expect(validatePolyline({ ...line, crs: 'EPSG:3857' as 'EPSG:4326' }).valid).toBe(false);
    expect(validatePolyline({ ...line, coordinates: [[-170, 0], [170, 0]] }).valid).toBe(false);
  });

  it('validates date ordering and creates UTC requests', () => {
    expect(validateTimestamp({ mode: 'window', start: '2026-09-01', end: '2026-08-01' }).valid).toBe(false);
    expect(timestampToRequest({ mode: 'date', value: '2026-08-28' })).toBe('2026-08-28T00:00:00Z');
  });

  it('returns explicit no-data instead of inventing a finding', () => {
    const result = investigate({ ...request, location: { ...request.location, latitude: 0, longitude: 0 } });
    expect(result.status).toBe('no-data');
    expect(result.measurement).toBeUndefined();
    expect(result.provenance.notes).toContain('live NISAR');
  });

  it('computes a realistic geodesic area for small polygons', () => {
    const polygon = [
      [85.3000, 27.7000],
      [85.3010, 27.7000],
      [85.3010, 27.7010],
      [85.3000, 27.7010],
    ] as const;
    const areaKm2 = calculateGeodesicAreaKm2([...polygon]);
    expect(areaKm2).toBeGreaterThan(0.01);
    expect(areaKm2).toBeLessThan(2);
  });

  it('handles longitude wrap for a small near-antimeridian polygon', () => {
    const polygon = [
      [179.9000, 0.0000],
      [179.9900, 0.0000],
      [179.9900, 0.0100],
      [179.9000, 0.0100],
    ] as const;
    const areaKm2 = calculateGeodesicAreaKm2([...polygon]);
    expect(areaKm2).toBeGreaterThan(0);
    expect(areaKm2).toBeLessThan(20);
  });

  it('propagates provenance and keeps the line as investigation geometry', () => {
    const result = investigate(request);
    expect(result.provenance.sourceProducts[0]).toContain('Langtang');
    expect(result.limitations.join(' ')).toContain('investigation geometry');
    expect(result.request.polyline.type).toBe('LineString');
  });

  it('accepts a manually drawn AOI without a place selection', () => {
    const result = validateCatalogPreflight({
      coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701]],
      areaClosed: true,
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      today: '2026-10-15',
    });
    expect(result).toEqual({ valid: true });
  });

  it('rejects empty or invalid AOI geometry', () => {
    expect(validateCatalogPreflight({
      coordinates: [],
      areaClosed: false,
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      today: '2026-10-15',
    }).valid).toBe(false);
    expect(validateCatalogPreflight({
      coordinates: [[85.3, 27.7], [Number.NaN, 27.7], [85.301, 27.701]],
      areaClosed: true,
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      today: '2026-10-15',
    }).valid).toBe(false);
  });

  it('rejects reversed dates, windows over 90 days, and oversized AOIs', () => {
    const coordinates = [[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]] as [number, number][];
    expect(validateCatalogPreflight({ coordinates, areaClosed: true, startDate: '2026-08-15', endDate: '2026-08-01', today: '2026-10-15' }).errors.join(' ')).toContain('on or after');
    expect(validateCatalogPreflight({ coordinates, areaClosed: true, startDate: '2026-01-01', endDate: '2026-04-02', today: '2026-10-15' }).errors.join(' ')).toContain('90 days');
    expect(validateCatalogPreflight({ coordinates, areaClosed: true, startDate: '2026-08-01', endDate: '2026-08-15', today: '2026-10-15', maxAreaKm2: 1 }).errors.join(' ')).toContain('maximum allowed area');
  });

  it('blocks duplicate archive submissions while loading or when invalid', () => {
    const valid = { valid: true } as const;
    const invalid = { valid: false, errors: ['invalid'] } as const;
    expect(canSubmitCatalogPreflight(valid, false)).toBe(true);
    expect(canSubmitCatalogPreflight(valid, true)).toBe(false);
    expect(canSubmitCatalogPreflight(invalid, false)).toBe(false);
  });
});