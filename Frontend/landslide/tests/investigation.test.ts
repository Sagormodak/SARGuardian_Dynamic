import { describe, expect, it, vi } from 'vitest';
import { copyPreparation, polygonToWkt, prepareInvestigation, type InvestigationSelection } from '../engine/investigation';
import { createAoiOverlayController } from '../ui/mapOverlays';

const selection: InvestigationSelection = {
  coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701]],
  areaClosed: true, startDate: '2026-10-01', endDate: '2026-10-22', today: '2026-10-23',
};

describe('AOI WKT', () => {
  it('preserves longitude/latitude order and source precision without mutation', () => {
    const points = [[85.30000012345678, 27.7], [85.301, 27.7], [85.301, 27.701]];
    const before = JSON.stringify(points);
    expect(polygonToWkt(points)).toBe('POLYGON((85.30000012345678 27.7, 85.301 27.7, 85.301 27.701, 85.30000012345678 27.7))');
    expect(JSON.stringify(points)).toBe(before);
  });
  it('does not double-close an already closed ring', () => {
    expect(polygonToWkt([...selection.coordinates, selection.coordinates[0]])).toBe(polygonToWkt(selection.coordinates));
  });
  it.each([[], [[1, 2], [2, 3]], [[1, 2], [2, 3], [1, 2]], [[NaN, 2], [2, 3], [3, 4]], [[Infinity, 2], [2, 3], [3, 4]], [[181, 2], [2, 3], [3, 4]], [[1, -91], [2, 3], [3, 4]], [[[1, 2], [2, 3], [3, 4]]], { type: 'MultiPolygon', coordinates: [] }])('rejects invalid or unsupported geometry %j', (points) => {
    expect(() => polygonToWkt(points)).toThrow();
  });
  it('accepts the actual coordinate structure emitted by Google Maps drag events', () => {
    const callbacks: Record<string, (event: unknown) => void> = {};
    class Polygon { setPaths() {} setVisible() {} }
    class Marker {
      addListener(name: string, handler: (event: unknown) => void) { callbacks[name] = handler; return { remove() {} }; }
      setPosition() {} setZIndex() {} setIcon() {}
    }
    vi.stubGlobal('google', { maps: { Polygon, Marker, SymbolPath: { CIRCLE: 0 } } });
    try {
      const onCoordinates = vi.fn();
      const controller = createAoiOverlayController({ onCoordinates, onSelectedVertex: vi.fn() });
      controller.update({ coordinates: selection.coordinates, areaClosed: true, drawing: false, selectedVertexIndex: null });
      controller.attach({} as google.maps.Map);
      callbacks.dragend({ latLng: { lng: () => 85.302, lat: () => 27.702 } });
      expect(polygonToWkt(onCoordinates.mock.calls[0][0])).toContain('85.302 27.702');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('shared investigation selection', () => {
  it('creates the exact date/geometry payload for the current selection', () => {
    expect(prepareInvestigation(selection)).toEqual({ valid: true, payload: {
      aoi_wkt: polygonToWkt(selection.coordinates), start_date: selection.startDate, end_date: selection.endDate,
    } });
  });
  it.each(['', '2026-02-30', '2026-1-01', 'invalid', '2026-10-24'])('rejects invalid or future end date %s', (endDate) => {
    expect(prepareInvestigation({ ...selection, endDate }).valid).toBe(false);
  });
  it('enforces ordering, maximum window, area and closure rules', () => {
    for (const change of [{ endDate: '2026-09-30' }, { startDate: '2026-01-01' }, { areaClosed: false }, { coordinates: [[0, 0], [20, 0], [20, 20]] as [number, number][] }]) {
      expect(prepareInvestigation({ ...selection, ...change }).valid).toBe(false);
    }
  });
  it('recomputes edited geometry and dates, and invalidates cleared AOIs', () => {
    const before = prepareInvestigation(selection);
    const after = prepareInvestigation({ ...selection, coordinates: [[85.3, 27.7], [85.302, 27.7], [85.301, 27.701]], endDate: '2026-10-23' });
    expect(after.valid && after.payload).not.toEqual(before.valid && before.payload);
    expect(prepareInvestigation({ ...selection, coordinates: [], areaClosed: false }).valid).toBe(false);
  });
  it('copies exact WKT and JSON, and propagates clipboard failures', async () => {
    const prepared = prepareInvestigation(selection);
    if (!prepared.valid) throw new Error('Fixture invalid');
    const write = vi.fn().mockResolvedValue(undefined);
    await copyPreparation(prepared.payload, 'wkt', write);
    expect(write).toHaveBeenLastCalledWith(prepared.payload.aoi_wkt);
    await copyPreparation(prepared.payload, 'payload', write);
    expect(JSON.parse(write.mock.calls[1][0])).toEqual(prepared.payload);
    await expect(copyPreparation(prepared.payload, 'wkt', vi.fn().mockRejectedValue(new Error('denied')))).rejects.toThrow('denied');
  });
});
