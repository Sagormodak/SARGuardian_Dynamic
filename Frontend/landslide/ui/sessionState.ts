import type { CatalogProduct, CatalogResponse } from '../../src/api/catalog';
import type { Coordinate, LocationSelection } from '../engine/types';

const STORAGE_KEY_PREFIX = 'sarguardian.landslide.session.v1';

export type LandslideSessionState = {
  searchText: string;
  searchState: string;
  location: LocationSelection | null;
  coordinates: Coordinate[];
  areaClosed: boolean;
  drawing: boolean;
  windowStart: string;
  windowEnd: string;
  catalogResult: CatalogResponse | null;
  selectedHarmonyProduct: CatalogProduct | null;
};

function emptyState(): LandslideSessionState {
  return {
    searchText: '',
    searchState: '',
    location: null,
    coordinates: [],
    areaClosed: false,
    drawing: false,
    windowStart: '',
    windowEnd: '',
    catalogResult: null,
    selectedHarmonyProduct: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value)
    && value.length === 2
    && value.every((part) => typeof part === 'number' && Number.isFinite(part))
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  const time = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isLocation(value: unknown): value is LocationSelection {
  return isRecord(value)
    && typeof value.searchText === 'string'
    && typeof value.name === 'string'
    && typeof value.latitude === 'number'
    && Number.isFinite(value.latitude)
    && typeof value.longitude === 'number'
    && Number.isFinite(value.longitude)
    && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180;
}

function isCatalogProduct(value: unknown): value is CatalogProduct {
  return isRecord(value)
    && typeof value.granule_name === 'string'
    && typeof value.product_type === 'string'
    && ['start_time', 'stop_time', 'direction', 'processing_date', 'processing_level', 'footprint_wkt'].every((key) => value[key] == null || typeof value[key] === 'string')
    && (value.path == null || typeof value.path === 'string' || (typeof value.path === 'number' && Number.isFinite(value.path)))
    && (value.size_mb == null || (typeof value.size_mb === 'number' && Number.isFinite(value.size_mb) && value.size_mb >= 0))
    && Array.isArray(value.observation_dates)
    && value.observation_dates.every((date) => typeof date === 'string');
}

function isCatalogResponse(value: unknown): value is CatalogResponse {
  if (!isRecord(value) || value.mode !== 'catalog-preflight-only') return false;
  if (value.status !== undefined && !['ready', 'no_data', 'insufficient_data', 'not_configured', 'upstream_error'].includes(value.status as string)) return false;
  if (value.message !== undefined && typeof value.message !== 'string') return false;
  if (value.preflight_id != null && typeof value.preflight_id !== 'string') return false;
  if (typeof value.checked_at !== 'string' || value.data_downloaded !== false || value.scientific_analysis_performed !== false) return false;
  if (!isRecord(value.processing_eligibility) || value.processing_eligibility.status !== 'undetermined' || typeof value.processing_eligibility.reason !== 'string') return false;
  if (!isRecord(value.query)
    || typeof value.query.platform !== 'string'
    || (value.query.product_type !== 'GUNW' && value.query.product_type !== 'GOFF')
    || typeof value.query.start_date !== 'string'
    || typeof value.query.end_date !== 'string'
    || typeof value.query.aoi_area_km2 !== 'number'
    || !Number.isFinite(value.query.aoi_area_km2)) return false;
  return typeof value.product_count === 'number'
    && Number.isFinite(value.product_count)
    && value.product_count >= 0
    && typeof value.truncated === 'boolean'
    && typeof value.products_with_unknown_size === 'number'
    && Number.isFinite(value.products_with_unknown_size)
    && typeof value.estimated_full_granule_volume_gib === 'number'
    && Number.isFinite(value.estimated_full_granule_volume_gib)
    && typeof value.estimated_full_granule_volume_is_complete === 'boolean'
    && Array.isArray(value.products)
    && value.products.every(isCatalogProduct)
    && typeof value.next_step === 'string'
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === 'string');
}

function storageKey(uid: string): string {
  return `${STORAGE_KEY_PREFIX}.${uid}`;
}

export function loadLandslideSessionState(uid: string): LandslideSessionState {
  const fallback = emptyState();
  try {
    const raw = window.sessionStorage.getItem(storageKey(uid));
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;

    const coordinates = Array.isArray(parsed.coordinates) && parsed.coordinates.every(isCoordinate)
      ? parsed.coordinates
      : [];
    const catalogResult = parsed.catalogResult === null || parsed.catalogResult === undefined
      ? null
      : isCatalogResponse(parsed.catalogResult) ? parsed.catalogResult : null;
    const selectedHarmonyProduct = parsed.selectedHarmonyProduct === null || parsed.selectedHarmonyProduct === undefined
      ? null
      : isCatalogProduct(parsed.selectedHarmonyProduct) ? parsed.selectedHarmonyProduct : null;

    return {
      searchText: typeof parsed.searchText === 'string' ? parsed.searchText : fallback.searchText,
      searchState: typeof parsed.searchState === 'string' ? parsed.searchState : fallback.searchState,
      location: parsed.location === null || parsed.location === undefined
        ? null
        : isLocation(parsed.location) ? parsed.location : null,
      coordinates,
      areaClosed: typeof parsed.areaClosed === 'boolean' && coordinates.length >= 3 ? parsed.areaClosed : false,
      drawing: typeof parsed.drawing === 'boolean' ? parsed.drawing : false,
      windowStart: isDate(parsed.windowStart) ? parsed.windowStart : fallback.windowStart,
      windowEnd: isDate(parsed.windowEnd) ? parsed.windowEnd : fallback.windowEnd,
      catalogResult,
      selectedHarmonyProduct: selectedHarmonyProduct && catalogResult
        ? catalogResult.products.find((product) => product.granule_name === selectedHarmonyProduct.granule_name) ?? null
        : null,
    };
  } catch {
    return fallback;
  }
}

export function persistLandslideSessionState(uid: string, state: LandslideSessionState): void {
  try {
    const { searchText, searchState, location, coordinates, areaClosed, drawing, windowStart, windowEnd, catalogResult, selectedHarmonyProduct } = state;
    window.sessionStorage.setItem(storageKey(uid), JSON.stringify({ searchText, searchState, location, coordinates, areaClosed, drawing, windowStart, windowEnd, catalogResult, selectedHarmonyProduct }));
  } catch {
    // Session storage is optional; the mounted LandslidePage remains the primary route state.
  }
}
