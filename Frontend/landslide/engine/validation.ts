import type { AnalysisRequest, Coordinate, InvestigationPolyline, TimestampSelection, ValidationResult } from './types';

const EARTH_RADIUS_METERS = 6371000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function calculateGeodesicAreaKm2(coordinates: Coordinate[]): number {
  if (coordinates.length < 3) return 0;

  const ring = [...coordinates, coordinates[0]];
  let total = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [lng1, lat1] = ring[index];
    const [lng2, lat2] = ring[index + 1];

    let deltaLng = toRadians(lng2 - lng1);
    if (deltaLng > Math.PI) deltaLng -= 2 * Math.PI;
    if (deltaLng < -Math.PI) deltaLng += 2 * Math.PI;

    const phi1 = toRadians(lat1);
    const phi2 = toRadians(lat2);
    total += deltaLng * (Math.sin(phi1) + Math.sin(phi2));
  }

  const areaMeters = Math.abs(total) * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS / 2;
  return areaMeters / 1_000_000;
}

const isCoordinate = (coordinate: unknown): coordinate is [number, number] => {
  if (!Array.isArray(coordinate) || coordinate.length !== 2) return false;
  const [longitude, latitude] = coordinate;
  return typeof longitude === 'number' && typeof latitude === 'number'
    && Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
};

const approximateLengthKm = (coordinates: [number, number][]) => coordinates.slice(1)
  .reduce((total, coordinate, index) => total + Math.hypot(coordinate[0] - coordinates[index][0], coordinate[1] - coordinates[index][1]) * 111, 0);

export function validatePolyline(polyline: InvestigationPolyline): ValidationResult {
  const errors: string[] = [];
  if (polyline.type !== 'LineString') errors.push('Geometry must be a LineString.');
  if (polyline.crs !== 'EPSG:4326') errors.push('Geometry must use WGS84 / EPSG:4326.');
  if (polyline.coordinates.length < 2) errors.push('Investigation polyline needs at least 2 vertices.');
  if (!polyline.coordinates.every(isCoordinate)) errors.push('Every vertex must be a valid longitude/latitude pair.');
  if (polyline.coordinates.every(isCoordinate) && approximateLengthKm(polyline.coordinates) > 5000) errors.push('Investigation polyline is too long; keep the selected geometry local to the area of interest.');
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function validateTimestamp(selection: TimestampSelection): ValidationResult {
  const values = selection.mode === 'date' ? [selection.value] : [selection.start, selection.end];
  const errors = values.map((value) => Number.isNaN(Date.parse(value)) ? `Invalid UTC timestamp: ${value}` : '').filter(Boolean);
  if (selection.mode === 'window' && Date.parse(selection.start) > Date.parse(selection.end)) {
    errors.push('Observation window start must be before its end.');
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function validateAnalysisRequest(request: AnalysisRequest): ValidationResult {
  const errors: string[] = [];
  if (!request.location || !Number.isFinite(request.location.latitude) || !Number.isFinite(request.location.longitude)) {
    errors.push('A valid searched location is required.');
  }
  const polylineResult = validatePolyline(request.polyline);
  if (!polylineResult.valid) errors.push(...polylineResult.errors);
  const timestampResult = typeof request.timestamp === 'string'
    ? validateTimestamp({ mode: 'date', value: request.timestamp })
    : validateTimestamp({ mode: 'window', ...request.timestamp });
  if (!timestampResult.valid) errors.push(...timestampResult.errors);
  return errors.length ? { valid: false, errors } : { valid: true };
}

export function validateCatalogPreflight(input: {
  coordinates: Coordinate[];
  areaClosed: boolean;
  startDate: string;
  endDate: string;
  today: string;
  maxWindowDays?: number;
  maxAreaKm2?: number;
}): ValidationResult {
  const errors: string[] = [];
  const maxWindowDays = input.maxWindowDays ?? 90;
  const maxAreaKm2 = input.maxAreaKm2 ?? 1000;

  if (!input.areaClosed || input.coordinates.length < 3) {
    errors.push('Close a valid AOI polygon with at least 3 vertices before checking the archive.');
  }

  const polylineResult = validatePolyline({
    type: 'LineString',
    coordinates: input.coordinates,
    crs: 'EPSG:4326',
  });
  if (!polylineResult.valid) errors.push(...polylineResult.errors);

  const areaKm2 = calculateGeodesicAreaKm2(input.coordinates);
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) {
    errors.push('Draw an AOI with positive area before checking the archive.');
  } else if (areaKm2 > maxAreaKm2) {
    const measuredArea = areaKm2.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const maximumArea = maxAreaKm2.toLocaleString(undefined, { maximumFractionDigits: 0 });
    errors.push(`Selected AOI: ${measuredArea} km². The maximum allowed area is ${maximumArea} km². Reduce the polygon before continuing.`);
  }

  if (!input.startDate || !input.endDate) {
    errors.push('Choose both a start date and an end date for the archive search.');
  } else {
    const start = Date.parse(`${input.startDate}T00:00:00Z`);
    const end = Date.parse(`${input.endDate}T00:00:00Z`);
    const today = Date.parse(`${input.today}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      errors.push('Choose valid archive dates.');
    } else {
      if (end < start) errors.push('Archive end date must be on or after the start date.');
      if (end > today) errors.push('Archive end date cannot be in the future.');
      const windowDays = Math.ceil((end - start) / 86400000);
      if (windowDays > maxWindowDays) errors.push(`Archive searches are limited to ${maxWindowDays} days; shorten the time window.`);
    }
  }

  return errors.length ? { valid: false, errors } : { valid: true };
}

export function canSubmitCatalogPreflight(validation: ValidationResult, isLoading: boolean): boolean {
  return validation.valid && !isLoading;
}

export function timestampToRequest(selection: TimestampSelection): string | { start: string; end: string } {
  return selection.mode === 'date' ? `${selection.value}T00:00:00Z` : {
    start: `${selection.start}T00:00:00Z`,
    end: `${selection.end}T23:59:59Z`,
  };
}