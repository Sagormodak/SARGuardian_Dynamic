export type Coordinate = [longitude: number, latitude: number];

export type LocationSelection = {
  searchText: string;
  name: string;
  latitude: number;
  longitude: number;
};

export type InvestigationPolyline = {
  type: 'LineString';
  coordinates: Coordinate[];
  crs: 'EPSG:4326';
};

export type TimestampSelection =
  | { mode: 'date'; value: string }
  | { mode: 'window'; start: string; end: string };

export type AnalysisRequest = {
  location: LocationSelection;
  polyline: InvestigationPolyline;
  timestamp: string | { start: string; end: string };
};

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

export type InvestigationResult = {
  status: 'finding' | 'no-data';
  request: AnalysisRequest;
  sourceData: string[];
  measurement?: { value: number; unit: string; interpretation: string };
  uncertainty?: { value: number; unit: string; confidence: 'low' | 'moderate' | 'high' };
  observability: { geometryStatus: string; note: string };
  qa: { status: string; checks: string[] };
  provenance: { sourceProducts: string[]; algorithm: string; notes: string };
  limitations: string[];
};