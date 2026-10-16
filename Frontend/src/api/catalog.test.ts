import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchNisarCatalog } from './catalog';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NISAR catalogue preflight API contract', () => {
  const user = { getIdToken: vi.fn().mockResolvedValue('firebase-id-token') };

  it('sends the manually drawn polygon coordinates unchanged', async () => {
    const response = {
      mode: 'catalog-preflight-only',
      checked_at: '2026-10-15T00:00:00Z',
      data_downloaded: false,
      scientific_analysis_performed: false,
      query: { platform: 'NISAR', product_type: 'GUNW', start_date: '2026-08-01', end_date: '2026-08-15', aoi_area_km2: 1 },
      product_count: 0,
      truncated: false,
      products_with_unknown_size: 0,
      estimated_full_granule_volume_gib: 0,
      estimated_full_granule_volume_is_complete: true,
      products: [],
      next_step: 'none',
      warnings: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal('fetch', fetchMock);
    const coordinates = [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]] as [number, number][];

    await searchNisarCatalog({ coordinates, startDate: '2026-08-01', endDate: '2026-08-15', productType: 'GUNW' }, user);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).coordinates).toEqual(coordinates);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer firebase-id-token',
    });
    expect(user.getIdToken).toHaveBeenCalledOnce();
  });

  it('surfaces an archive API failure to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ detail: 'Archive service unavailable.' }),
    }));

    await expect(searchNisarCatalog({
      coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]],
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      productType: 'GUNW',
    }, user)).rejects.toThrow('Archive service unavailable.');
  });

  it('reports missing authentication and token failures without requesting the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]] as [number, number][],
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      productType: 'GUNW' as const,
    };

    await expect(searchNisarCatalog(input, null)).rejects.toThrow('Sign in before checking');
    const tokenFailureUser = { getIdToken: vi.fn().mockRejectedValue(new Error('expired')) };
    await expect(searchNisarCatalog(input, tokenFailureUser)).rejects.toThrow('Firebase sign-in token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
