import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueuedJob, getProcessingJob, listProcessingJobs, searchNisarCatalog } from './catalog';

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

  it('supports the GOFF product family requested by the catalogue toggle', async () => {
    const response = {
      mode: 'catalog-preflight-only', checked_at: '2026-10-15T00:00:00Z', data_downloaded: false, scientific_analysis_performed: false,
      query: { platform: 'NISAR', product_type: 'GOFF', start_date: '2026-08-01', end_date: '2026-08-15', aoi_area_km2: 1 },
      product_count: 0, truncated: false, products_with_unknown_size: 0, estimated_full_granule_volume_gib: 0,
      estimated_full_granule_volume_is_complete: true, products: [], next_step: 'none', warnings: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal('fetch', fetchMock);

    await searchNisarCatalog({
      coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]],
      startDate: '2026-08-01', endDate: '2026-08-15', productType: 'GOFF',
    }, user);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).product_type).toBe('GOFF');
  });

  it('requests both GUNW and GOFF metadata when the Both archive control is selected', async () => {
    const response = {
      mode: 'catalog-preflight-only', checked_at: '2026-10-15T00:00:00Z', data_downloaded: false, scientific_analysis_performed: false,
      query: { platform: 'NISAR', product_type: 'BOTH', start_date: '2026-08-01', end_date: '2026-08-15', aoi_area_km2: 1 },
      product_count: 0, truncated: false, products_with_unknown_size: 0, estimated_full_granule_volume_gib: 0,
      estimated_full_granule_volume_is_complete: true, products: [], next_step: 'none', warnings: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal('fetch', fetchMock);

    await searchNisarCatalog({
      coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]],
      startDate: '2026-08-01', endDate: '2026-08-15', productType: 'BOTH',
    }, user);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).product_type).toBe('BOTH');
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

  it('uses the compact user-facing message when the archive cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    await expect(searchNisarCatalog({
      coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]],
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      productType: 'GUNW',
    }, user)).rejects.toThrow('Could not reach the NISAR archive. Check your connection or try again.');
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

  it('creates a confirmed queued job with the Firebase bearer token', async () => {
    const response = {
      id: 'job-1',
      owner_uid: 'firebase-user',
      preflight_id: 'preflight-1',
      product_family: 'GUNW',
      state: 'queued',
      request_snapshot: {},
      manifest_snapshot: {},
      created_at: '2026-10-15T00:00:00Z',
      updated_at: '2026-10-15T00:00:00Z',
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal('fetch', fetchMock);
    const jobUser = { getIdToken: vi.fn().mockResolvedValue('firebase-id-token') };

    await createQueuedJob('preflight-1', 'sarguardian-idempotency-001', jobUser);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/api/jobs');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      preflight_id: 'preflight-1',
      idempotency_key: 'sarguardian-idempotency-001',
      confirm: true,
    });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer firebase-id-token',
    });
  });

  it('loads owner-scoped job list and detail through the existing endpoints', async () => {
    const job = { id: 'job-1', state: 'queued' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [job] })
      .mockResolvedValueOnce({ ok: true, json: async () => job });
    vi.stubGlobal('fetch', fetchMock);
    const jobUser = { getIdToken: vi.fn().mockResolvedValue('firebase-id-token') };

    await listProcessingJobs(jobUser);
    await getProcessingJob('job-1', jobUser);

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/api/jobs');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8000/api/jobs/job-1');
  });

  it('does not request job creation without an authenticated user', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createQueuedJob('preflight-1', 'sarguardian-idempotency-001', null)).rejects.toThrow('Sign in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
