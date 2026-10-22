import type { Coordinate } from '../engine/types';

type AoiState = {
  coordinates: Coordinate[];
  areaClosed: boolean;
  drawing: boolean;
  selectedVertexIndex: number | null;
};

type AoiCallbacks = {
  onCoordinates: (coordinates: Coordinate[], closed: boolean) => void;
  onSelectedVertex: (index: number) => void;
};

// Bridge React state and Google's imperative overlays. State can arrive before the map.
export function createAoiOverlayController(callbacks: AoiCallbacks) {
  let map: google.maps.Map | null = null;
  let state: AoiState = { coordinates: [], areaClosed: false, drawing: false, selectedVertexIndex: null };
  let polygon: google.maps.Polygon | null = null;
  const vertices: Array<{ marker: google.maps.Marker; listeners: google.maps.MapsEventListener[] }> = [];

  const removeVertex = (vertex: typeof vertices[number]) => {
    vertex.listeners.forEach((listener) => listener.remove());
    vertex.marker.setMap(null);
  };

  const detach = () => {
    vertices.splice(0).forEach(removeVertex);
    polygon?.setMap(null);
    polygon = null;
    map = null;
  };

  const draw = () => {
    if (!map) return;
    const path = state.coordinates.map(([lng, lat]) => ({ lat, lng }));
    if (!polygon && path.length > 1) {
      polygon = new google.maps.Polygon({
        map, paths: path, strokeColor: '#48e1dc', fillColor: '#29c9cf',
        fillOpacity: 0.2, strokeOpacity: 1, strokeWeight: 2.5, clickable: false,
      });
    }
    polygon?.setPaths(path);
    polygon?.setVisible(path.length > 1);

    while (vertices.length > path.length) removeVertex(vertices.pop()!);
    path.forEach((position, index) => {
      let vertex = vertices[index];
      if (!vertex) {
        const marker = new google.maps.Marker({ map, position, draggable: true, clickable: true });
        const listeners = [
          marker.addListener('click', () => {
            callbacks.onSelectedVertex(index);
            if (index === 0 && state.coordinates.length >= 3) {
              callbacks.onCoordinates(state.coordinates, true);
            }
          }),
          marker.addListener('dragend', (event: google.maps.MapMouseEvent) => {
            if (!event.latLng) return;
            const updated = [...state.coordinates];
            updated[index] = [Number(event.latLng.lng().toFixed(6)), Number(event.latLng.lat().toFixed(6))];
            callbacks.onCoordinates(updated, state.areaClosed || (state.coordinates.length >= 3 && index === 0));
            callbacks.onSelectedVertex(index);
          }),
        ];
        vertex = { marker, listeners };
        vertices.push(vertex);
      }
      vertex.marker.setPosition(position);
      vertex.marker.setZIndex(index === 0 ? 30 : 25);
      vertex.marker.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        scale: state.selectedVertexIndex === index ? 7 : index === 0 ? 6.5 : 5.8,
        fillColor: index === 0 && state.drawing ? '#48e1dc' : '#f1ffff',
        fillOpacity: 1, strokeColor: '#16aebc',
        strokeWeight: state.selectedVertexIndex === index ? 2.5 : 1.8,
      });
    });
  };

  return {
    update(next: AoiState) { state = next; draw(); },
    attach(nextMap: google.maps.Map) {
      if (nextMap === map) return;
      detach();
      map = nextMap;
      draw();
    },
    detach,
  };
}
