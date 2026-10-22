import type { Coordinate } from './types';
import { validateCatalogPreflight } from './validation';

// Map state is a single ring of [longitude, latitude] pairs, not Google LatLng objects.
// Nested rings, holes and multipolygons are deliberately rejected.
export function polygonToWkt(value: unknown): string {
  if (!Array.isArray(value) || !value.every((point) => Array.isArray(point) && point.length === 2
    && point.every((n) => typeof n === 'number' && Number.isFinite(n))
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)) {
    throw new Error('AOI must be a single polygon of valid longitude/latitude pairs.');
  }
  const points = value as Coordinate[];
  if (new Set(points.map(([lng, lat]) => `${lng},${lat}`)).size < 3) {
    throw new Error('AOI needs at least three distinct vertices.');
  }
  const first = points[0];
  const last = points[points.length - 1];
  const ring = first[0] === last[0] && first[1] === last[1] ? points : [...points, first];
  // JS number serialization round-trips without additional rounding.
  return `POLYGON((${ring.map(([lng, lat]) => `${lng} ${lat}`).join(', ')}))`;
}

export type DisplacementPayload = { aoi_wkt: string; start_date: string; end_date: string };
export type InvestigationSelection = Parameters<typeof validateCatalogPreflight>[0];
export type PreparedInvestigation = { valid: true; payload: DisplacementPayload } | { valid: false; errors: string[] };

export function prepareInvestigation(input: InvestigationSelection): PreparedInvestigation {
  let wkt: string;
  try { wkt = polygonToWkt(input.coordinates); }
  catch (error) { return { valid: false, errors: [(error as Error).message] }; }
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!isDate(input.startDate) || !isDate(input.endDate)) {
    return { valid: false, errors: ['Choose valid start and end dates (YYYY-MM-DD).'] };
  }
  const validation = validateCatalogPreflight(input);
  if (!validation.valid) return validation;
  return { valid: true, payload: { aoi_wkt: wkt, start_date: input.startDate, end_date: input.endDate } };
}

export async function copyPreparation(payload: DisplacementPayload, kind: 'wkt' | 'payload', writeText: (text: string) => Promise<void>): Promise<void> {
  await writeText(kind === 'wkt' ? payload.aoi_wkt : JSON.stringify(payload, null, 2));
}
