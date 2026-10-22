import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coordinate } from '../engine/types';
import { createAoiOverlayController } from '../ui/mapOverlays';

class FakePolygon {
  static instances: FakePolygon[] = [];
  setMap = vi.fn();
  setPaths = vi.fn();
  setVisible = vi.fn();
  constructor(public options: google.maps.PolygonOptions) { FakePolygon.instances.push(this); }
}
class FakeMarker {
  static instances: FakeMarker[] = [];
  setMap = vi.fn();
  setPosition = vi.fn();
  setZIndex = vi.fn();
  setIcon = vi.fn();
  listeners = new Map<string, { callback: (event: google.maps.MapMouseEvent) => void; remove: ReturnType<typeof vi.fn> }>();
  constructor() { FakeMarker.instances.push(this); }
  addListener = vi.fn((name: string, callback: (event: google.maps.MapMouseEvent) => void) => {
    const listener = { callback, remove: vi.fn() };
    this.listeners.set(name, listener);
    return listener;
  });
}

const coordinates: Coordinate[] = [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701]];
const map = {} as google.maps.Map;
beforeEach(() => {
  FakePolygon.instances = [];
  FakeMarker.instances = [];
  vi.stubGlobal('google', { maps: { Polygon: FakePolygon, Marker: FakeMarker, SymbolPath: { CIRCLE: 0 } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('AOI overlay lifecycle', () => {
  it('draws restored coordinates when map initialization finishes later', () => {
    const overlays = createAoiOverlayController({ onCoordinates: vi.fn(), onSelectedVertex: vi.fn() });
    overlays.update({ areaClosed: false, coordinates, drawing: false, selectedVertexIndex: null });
    expect(FakePolygon.instances).toHaveLength(0);
    expect(FakeMarker.instances).toHaveLength(0);
    overlays.attach(map);
    expect(FakePolygon.instances).toHaveLength(1);
    expect(FakePolygon.instances[0].options.paths).toEqual(coordinates.map(([lng, lat]) => ({ lat, lng })));
    expect(FakeMarker.instances).toHaveLength(3);
  });

  it('uses the latest edits if coordinates change while the map is loading', () => {
    const overlays = createAoiOverlayController({ onCoordinates: vi.fn(), onSelectedVertex: vi.fn() });
    overlays.update({ areaClosed: false, coordinates, drawing: false, selectedVertexIndex: null });
    const edited: Coordinate[] = [...coordinates, [85.3, 27.701]];
    overlays.update({ areaClosed: false, coordinates: edited, drawing: true, selectedVertexIndex: 3 });
    overlays.attach(map);
    expect(FakeMarker.instances).toHaveLength(4);
    expect(FakePolygon.instances[0].setPaths).toHaveBeenLastCalledWith(edited.map(([lng, lat]) => ({ lat, lng })));
  });

  it('updates overlays without duplicating geometry or event listeners', () => {
    const onCoordinates = vi.fn();
    const overlays = createAoiOverlayController({ onCoordinates, onSelectedVertex: vi.fn() });
    overlays.attach(map);
    overlays.update({ areaClosed: false, coordinates, drawing: true, selectedVertexIndex: 1 });
    overlays.update({ areaClosed: false, coordinates, drawing: false, selectedVertexIndex: 2 });
    overlays.attach(map);
    expect(FakePolygon.instances).toHaveLength(1);
    expect(FakeMarker.instances).toHaveLength(3);
    expect(FakeMarker.instances[0].listeners.size).toBe(2);
    expect(FakeMarker.instances[0].addListener).toHaveBeenCalledTimes(2);
    FakeMarker.instances[0].listeners.get('click')!.callback({} as google.maps.MapMouseEvent);
    expect(onCoordinates).toHaveBeenCalledOnce();
    expect(onCoordinates).toHaveBeenCalledWith(coordinates, true);
  });

  it('vertex dragging uses current coordinates rather than an old event closure', () => {
    const onCoordinates = vi.fn();
    const overlays = createAoiOverlayController({ onCoordinates, onSelectedVertex: vi.fn() });
    overlays.attach(map);
    overlays.update({ areaClosed: false, coordinates, drawing: true, selectedVertexIndex: 0 });
    const edited: Coordinate[] = [[85.4, 27.8], ...coordinates.slice(1)];
    overlays.update({ areaClosed: false, coordinates: edited, drawing: true, selectedVertexIndex: 1 });
    FakeMarker.instances[1].listeners.get('dragend')!.callback({ latLng: { lng: () => 85.42, lat: () => 27.81 } } as google.maps.MapMouseEvent);
    expect(onCoordinates).toHaveBeenCalledWith([edited[0], [85.42, 27.81], edited[2]], false);
  });

  it('removes only owned overlays/listeners and supports a subsequent map lifecycle', () => {
    const overlays = createAoiOverlayController({ onCoordinates: vi.fn(), onSelectedVertex: vi.fn() });
    overlays.update({ areaClosed: false, coordinates, drawing: false, selectedVertexIndex: null });
    overlays.attach(map);
    const oldMarkers = [...FakeMarker.instances];
    overlays.detach();
    expect(FakePolygon.instances[0].setMap).toHaveBeenCalledWith(null);
    oldMarkers.forEach((marker) => {
      expect(marker.setMap).toHaveBeenCalledWith(null);
      marker.listeners.forEach((listener) => expect(listener.remove).toHaveBeenCalledOnce());
    });
    overlays.attach({} as google.maps.Map);
    expect(FakeMarker.instances).toHaveLength(6);
    expect(FakePolygon.instances).toHaveLength(2);
  });

  it('keeps a closed AOI closed when any vertex is dragged', () => {
    const onCoordinates = vi.fn();
    const overlays = createAoiOverlayController({ onCoordinates, onSelectedVertex: vi.fn() });
    overlays.attach(map);
    overlays.update({ areaClosed: true, coordinates, drawing: false, selectedVertexIndex: 0 });
    FakeMarker.instances[1].listeners.get('dragend')!.callback({ latLng: { lng: () => 85.302, lat: () => 27.702 } } as google.maps.MapMouseEvent);
    expect(onCoordinates).toHaveBeenCalledWith([coordinates[0], [85.302, 27.702], coordinates[2]], true);
  });

  it('clearing the AOI removes vertex handlers and hides its polygon', () => {
    const overlays = createAoiOverlayController({ onCoordinates: vi.fn(), onSelectedVertex: vi.fn() });
    overlays.attach(map);
    overlays.update({ areaClosed: false, coordinates, drawing: false, selectedVertexIndex: null });
    overlays.update({ areaClosed: false, coordinates: [], drawing: false, selectedVertexIndex: null });
    expect(FakePolygon.instances[0].setVisible).toHaveBeenLastCalledWith(false);
    FakeMarker.instances.forEach((marker) => expect(marker.setMap).toHaveBeenCalledWith(null));
  });
});
