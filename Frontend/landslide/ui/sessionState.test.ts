import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLandslideSessionState, persistLandslideSessionState } from './sessionState';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validated Landslide session state', () => {
  it('round-trips workflow state without including authentication data', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    } });
    const state = loadLandslideSessionState('user-1');
    state.coordinates = [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701]];
    state.areaClosed = true;
    state.windowStart = '2026-08-01';
    state.windowEnd = '2026-08-15';
    state.productType = 'GOFF';
    state.catalogResult = {
      mode: 'catalog-preflight-only',
      status: 'ready',
      message: 'Ready',
      checked_at: '2026-10-19T00:00:00Z',
      data_downloaded: false,
      scientific_analysis_performed: false,
      processing_eligibility: { status: 'undetermined', reason: 'Metadata-only preflight.' },
      query: { platform: 'NISAR', product_type: 'GOFF', start_date: '2026-08-01', end_date: '2026-08-15', aoi_area_km2: 1 },
      product_count: 1,
      truncated: false,
      products_with_unknown_size: 0,
      estimated_full_granule_volume_gib: 2,
      estimated_full_granule_volume_is_complete: true,
      products: [{ granule_name: 'NISAR_GOFF_1', product_type: 'GOFF', observation_dates: ['2026-08-01'] }],
      next_step: 'Review metadata.',
      warnings: [],
    };
    state.selectedHarmonyProduct = state.catalogResult.products[0];
    persistLandslideSessionState('user-1', state);

    const restored = loadLandslideSessionState('user-1');
    expect(restored.coordinates).toEqual(state.coordinates);
    expect(restored.areaClosed).toBe(true);
    expect(restored.windowStart).toBe('2026-08-01');
    expect(restored.productType).toBe('GOFF');
    expect(restored.catalogResult?.products[0].granule_name).toBe('NISAR_GOFF_1');
    expect(restored.selectedHarmonyProduct?.granule_name).toBe('NISAR_GOFF_1');
    expect(storage.get('sarguardian.landslide.session.v1.user-1')).not.toContain('token');
  });

  it('rejects malformed stored coordinates and catalogue data', () => {
    const storage = new Map<string, string>([['sarguardian.landslide.session.v1.user-1', JSON.stringify({
      coordinates: [['not', 'coordinates']],
      areaClosed: true,
      productType: 'SECRET',
      catalogResult: { mode: 'not-a-catalogue' },
    })]]);
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: vi.fn(),
    } });

    const restored = loadLandslideSessionState('user-1');
    expect(restored.coordinates).toEqual([]);
    expect(restored.areaClosed).toBe(false);
    expect(restored.productType).toBe('GUNW');
    expect(restored.catalogResult).toBeNull();
  });

  it('rejects invalid dates, out-of-range coordinates, and orphaned selections', () => {
    vi.stubGlobal('window', { sessionStorage: {
      getItem: () => JSON.stringify({
        coordinates: [[181, 20], [85, 91], [85, 20]], areaClosed: true,
        windowStart: '2026-02-30', windowEnd: 'invalid',
        selectedHarmonyProduct: { granule_name: 'orphan', product_type: 'GUNW', observation_dates: [] },
      }),
    } });
    const state = loadLandslideSessionState('user-1');
    expect(state.coordinates).toEqual([]);
    expect(state.areaClosed).toBe(false);
    expect(state.windowStart).toBe('');
    expect(state.windowEnd).toBe('');
    expect(state.selectedHarmonyProduct).toBeNull();
  });

  it('keeps users isolated and persists only allowed workflow fields', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    } });
    const state = { ...loadLandslideSessionState('user-1'), searchText: 'Saved location', token: 'must-not-be-stored' };
    persistLandslideSessionState('user-1', state);
    expect(loadLandslideSessionState('user-1').searchText).toBe('Saved location');
    expect(loadLandslideSessionState('user-2').searchText).toBe('');
    expect([...storage.values()][0]).not.toContain('must-not-be-stored');
  });

  it('falls back to in-memory defaults when optional session storage is blocked', () => {
    vi.stubGlobal('window', { sessionStorage: {
      getItem: () => { throw new Error('Storage blocked'); },
      setItem: () => { throw new Error('Storage blocked'); },
    } });
    const state = loadLandslideSessionState('user-1');
    expect(state.coordinates).toEqual([]);
    expect(() => persistLandslideSessionState('user-1', state)).not.toThrow();
  });
});
