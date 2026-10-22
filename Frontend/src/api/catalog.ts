import type { User } from 'firebase/auth';
import type { Coordinate } from '../../landslide/engine/types';

export type NisarProductType = 'GUNW' | 'GOFF' | 'BOTH';

export type CatalogProduct = {
  granule_name: string;
  product_type: string;
  observation_dates: string[];
  start_time?: string | null;
  stop_time?: string | null;
  direction?: string | null;
  path?: string | number | null;
  size_mb?: number | null;
  processing_date?: string | null;
  processing_level?: string | null;
  footprint_wkt?: string | null;
};

export type ProcessingEligibility = {
  status: 'undetermined';
  reason: string;
};

export type CatalogResponse = {
  mode: 'catalog-preflight-only';
  status?: 'ready' | 'no_data' | 'insufficient_data' | 'not_configured' | 'upstream_error';
  message?: string;
  checked_at: string;
  data_downloaded: false;
  scientific_analysis_performed: false;
  processing_eligibility: ProcessingEligibility;
  preflight_id?: string | null;
  query: {
    platform: string;
    product_type: NisarProductType;
    start_date: string;
    end_date: string;
    aoi_area_km2: number;
  };
  product_count: number;
  truncated: boolean;
  products_with_unknown_size: number;
  estimated_full_granule_volume_gib: number;
  estimated_full_granule_volume_is_complete: boolean;
  products: CatalogProduct[];
  next_step: string;
  warnings: string[];
};

export type CatalogSearchRequest = {
  coordinates: Coordinate[];
  startDate: string;
  endDate: string;
  productType: NisarProductType;
};

export type ProcessingJobState = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ProcessingJob = {
  id: string;
  owner_uid: string;
  preflight_id: string;
  product_family: NisarProductType;
  state: ProcessingJobState;
  request_snapshot: Record<string, unknown>;
  manifest_snapshot: Record<string, unknown>;
  worker_run_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
};

const configuredApiUrl = (import.meta.env.VITE_SARGUARDIAN_API_URL as string | undefined)?.trim();
const API_BASE = (configuredApiUrl || 'http://localhost:8000').replace(/\/+$/, '');

export async function searchNisarCatalog(input: CatalogSearchRequest, user: Pick<User, 'getIdToken'> | null): Promise<CatalogResponse> {
  if (!user) throw new Error('Sign in before checking the NISAR archive.');
  if (input.productType !== 'GUNW' && input.productType !== 'GOFF' && input.productType !== 'BOTH') {
    throw new Error('Unsupported NISAR data family.');
  }

  let token: string;
  try {
    token = await user.getIdToken();
  } catch {
    throw new Error('Could not obtain your Firebase sign-in token. Sign in again and retry.');
  }
  if (!token) throw new Error('Could not obtain your Firebase sign-in token. Sign in again and retry.');

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/catalog/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        coordinates: input.coordinates,
        start_date: input.startDate,
        end_date: input.endDate,
        product_type: input.productType,
      }),
    });
  } catch {
    throw new Error('Could not reach the NISAR archive. Check your connection or try again.');
  }

  const payload = await response.json().catch(() => ({})) as { detail?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload.detail || payload.message || `Catalogue request failed (${response.status}).`);
  }
  return payload as CatalogResponse;
}

async function getFirebaseIdToken(user: Pick<User, 'getIdToken'> | null): Promise<string> {
  if (!user) throw new Error('Sign in before submitting a processing job.');
  try {
    const token = await user.getIdToken();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw new Error('Could not obtain your Firebase sign-in token. Sign in again and retry.');
  }
}

async function readAuthenticatedPayload<T>(
  url: string,
  user: Pick<User, 'getIdToken'> | null,
  fallback: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getFirebaseIdToken(user);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new Error(`Could not reach the processing service. ${fallback}`);
  }
  return readApiPayload<T>(response, fallback);
}

export async function createQueuedJob(
  preflightId: string,
  idempotencyKey: string,
  user: Pick<User, 'getIdToken'> | null,
): Promise<ProcessingJob> {
  return readAuthenticatedPayload<ProcessingJob>(
    `${API_BASE}/api/jobs`,
    user,
    'Could not create the queued job.',
    {
      method: 'POST',
      body: JSON.stringify({ preflight_id: preflightId, idempotency_key: idempotencyKey, confirm: true }),
    },
  );
}

export async function listProcessingJobs(user: Pick<User, 'getIdToken'> | null): Promise<ProcessingJob[]> {
  return readAuthenticatedPayload<ProcessingJob[]>(
    `${API_BASE}/api/jobs`,
    user,
    'Could not load your processing jobs.',
  );
}

export async function getProcessingJob(jobId: string, user: Pick<User, 'getIdToken'> | null): Promise<ProcessingJob> {
  const safeId = jobId.trim();
  if (!safeId) throw new Error('A processing job ID is required.');
  return readAuthenticatedPayload<ProcessingJob>(
    `${API_BASE}/api/jobs/${encodeURIComponent(safeId)}`,
    user,
    'Could not load the selected processing job.',
  );
}


export type AoiWindowResponse = {
  service: string;
  job_id: string;
  job_status: string;
  result_filename?: string;
  aoi_cropped: boolean;
  crop_representation?: string;
  result_file_downloaded?: boolean;
  full_raster_downloaded?: boolean;
  raster_window_pixels_read?: boolean;
  persistent_storage_used?: boolean;
  scientific_analysis_performed?: boolean;
  scientific_displacement_analysis_performed?: boolean;
  source_driver?: string;
  source_crs?: string;
  source_width?: number;
  source_height?: number;
  source_nodata?: number | null;
  aoi_window?: { width: number; height: number; window_pixels: number };
  aoi_window_bounds_wgs84?: number[];
  pixels_inside_polygon?: number;
  valid_unmasked_pixels?: number;
  valid_fraction_of_polygon_pixels?: number;
  raw_phase_diagnostic_statistics?: { min: number; max: number; mean: number; std: number; unit: string } | null;
  aoi_window_read_from_remote_cog?: boolean;
  aoi_area_km2?: number;
  warning?: string;
  detail?: string;
  message?: string;
};

export async function inspectNisarAoiWindow(input: {
  jobId: string;
  coordinates: Coordinate[];
}): Promise<AoiWindowResponse> {
  const jobId = input.jobId.trim();
  if (!jobId || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new Error('Enter the valid NASA Harmony Job ID.');
  }

  const response = await fetch(`${API_BASE}/api/harmony/jobs/${encodeURIComponent(jobId)}/crop-aoi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: input.coordinates }),
  });

  const payload = await response.json().catch(() => ({})) as AoiWindowResponse;
  if (!response.ok) {
    throw new Error(payload.detail || payload.message || `AOI window read failed (${response.status}).`);
  }
  return payload;
}

export type HarmonyQualityLayerJob = {
  job_id: string;
  status: string;
  variable?: string;
  job_status_url?: string;
  reused_existing_job?: boolean;
};

export type HarmonyLayerRole =
  | 'unwrapped_phase'
  | 'coherence'
  | 'connected_components'
  | 'ionosphere_phase_screen'
  | 'ionosphere_phase_screen_uncertainty'
  | 'mask';

export type HarmonySingleLayerSubmissionResponse = {
  service: string;
  mode: string;
  harmony_http_status: number;
  job_id: string;
  job_status_url: string;
  granule_name: string;
  layer_role: HarmonyLayerRole;
  variable: string;
  polarization: 'HH' | 'VV';
  maturity?: 'PROVISIONAL' | 'BETA';
  collection_maturity?: 'PROVISIONAL' | 'BETA';
  production?: 'PR' | 'UR';
  product_type?: 'GUNW';
  output_format: string;
  input_granules_limit: number;
  variables_requested: number;
  full_granule_layer: boolean;
  aoi_subset_requested: boolean;
  data_downloaded_by_sarguardian: boolean;
  scientific_analysis_performed: boolean;
  message: string;
};

export type SubmittedHarmonyLayerJob = {
  job_id: string;
  granule_name: string;
  layer_role: HarmonyLayerRole;
  polarization: 'HH' | 'VV';
  maturity: 'PROVISIONAL' | 'BETA';
  variable: string;
  status: string;
  submitted_at: string;
  status_error?: string;
};

export type HarmonyQualityLayerBundle = {
  service: string;
  mode: string;
  granule_name: string;
  polarization: string;
  maturity: string;
  jobs: Record<string, HarmonyQualityLayerJob>;
  submission_errors: Record<string, string>;
  all_required_layers_submitted: boolean;
  aoi_area_km2?: number;
  warning?: string;
  next_step?: string;
};

export type HarmonyJobStatusResponse = {
  job_id: string;
  job?: { status?: string; progress?: number; message?: string };
};

export type GunwQualityAnalysisResponse = {
  service: string;
  mode: string;
  granule_name: string;
  polarization: string;
  aoi?: { window_width_px: number; window_height_px: number; window_pixels: number; polygon_pixels: number; crs: string };
  layers?: Record<string, { min: number; max: number; mean: number; std: number; count: number } | null>;
  mask_intersection_diagnostics?: {
    candidate_population?: string;
    candidate_pixels_after_ionosphere_validity?: number;
    candidate_mask_valid_pixels?: number;
    candidate_mask_invalid_or_nodata_pixels?: number;
    candidate_ionosphere_flagged_pixels?: number;
    candidate_ionosphere_unflagged_pixels?: number;
    candidate_packed_values_ge_2pow24_pixels?: number;
    candidate_base_wrs_pass_pixels?: number;
    candidate_reference_exception_pixels?: number;
    candidate_secondary_exception_pixels?: number;
    candidate_wrs_and_exceptions_pass_before_precision_quarantine_pixels?: number;
    candidate_strict_mask_pass_pixels?: number;
    candidate_passes_all_mask_rules_pixels?: number;
    candidate_raw_mask_value_counts_top10?: Array<{ value: number; count: number }>;
    candidate_wrs_low_byte_counts_top10?: Array<{ value: number; count: number }>;
    interpretation_note?: string;
  };
  layer_diagnostics?: Record<string, {
    dtype?: string | null;
    nodata_value?: number | null;
    polygon_pixels?: number;
    finite_pixels_in_polygon?: number;
    valid_data_pixels_in_polygon?: number;
    masked_or_nodata_pixels_in_polygon?: number;
    zero_value_pixels_in_polygon_including_masked?: number;
    zero_value_pixels_among_valid_data?: number;
    positive_value_pixels_among_valid_data?: number;
    negative_value_pixels_among_valid_data?: number;
    min_valid?: number | null;
    max_valid?: number | null;
    mean_valid?: number | null;
    unique_value_count?: number;
    most_common_values?: Array<{ value: number; count: number }>;
    mask_encoding?: string;
    wrs_low_byte_value_counts?: Array<{ value: number; count: number }>;
    base_wrs_land_valid_subswath_pixels?: number;
    strict_usable_pixels?: number;
    reference_input_exception_nonzero_pixels?: number;
    secondary_input_exception_nonzero_pixels?: number;
    ionosphere_filter_flag_pixels?: number;
    packed_wrs_decode_ambiguous_pixels?: number;
    wrs_decode_reliable_pixels?: number;
  }>;
  warnings?: string[];
  quality_gates?: {
    phase_nonzero_finite_pixels: number;
    coherence_valid_pixels: number;
    coherence_threshold: number;
    coherence_pass_pixels: number;
    phase_and_coherence_pixels?: number;
    connected_components_positive_pixels: number;
    after_connected_components_pixels?: number;
    ionosphere_phase_screen_valid_pixels: number;
    after_ionosphere_validity_pixels?: number;
    mask_valid_land_subswath_pixels: number;
    after_land_and_subswath_mask_pixels?: number;
    mask_low_byte_land_valid_subswath_pixels?: number;
    mask_reference_exception_pixels?: number;
    mask_secondary_exception_pixels?: number;
    mask_ionosphere_filter_flagged_pixels?: number;
    mask_packed_wrs_ambiguous_pixels?: number;
    after_ionosphere_filter_mask_pixels?: number;
    jointly_qualified_pixels: number;
    jointly_qualified_fraction_of_polygon: number;
    dominant_connected_component_id: number | null;
    dominant_component_share_among_phase_coherence_pixels: number | null;
    distinct_positive_components_in_phase_coherence_pixels: number;
  };
  ionosphere_corrected_phase_statistics?: { min: number; max: number; mean: number; std: number; count: number } | null;
  physical_displacement?: { computed: boolean; unit: string | null; reason: string };
  original_scientific_engine?: { hdf5_read_gunw_invoked: boolean; reader_compatible_core_gates_applied_to_aligned_aoi_arrays: boolean; note: string };
  detail?: string;
};


export type NativeSourceMaskVerificationResponse = {
  service: string;
  mode: string;
  verified: boolean;
  comparison_performed: boolean;
  mask_values_match?: boolean;
  granule_name: string;
  polarization: string;
  harmony_mask_job_id?: string;
  harmony_mask_variable?: string;
  source_collection?: string;
  native_source_host?: string;
  native_source_file_opened?: boolean;
  native_mask_dataset_path?: string;
  native_mask_dtype?: string;
  native_mask_shape?: number[];
  native_mask_metadata?: { attribute_names?: string[]; selected_attributes?: Record<string, unknown> };
  native_mask_parent_group?: string;
  native_mask_parent_metadata?: { attribute_names?: string[]; selected_attributes?: Record<string, unknown> };
  source_mask_bit_counts?: {
    samples?: number;
    low_byte_values?: Array<{ value: number; count: number }>;
    secondary_exception_byte_nonzero_pixels?: number;
    reference_exception_byte_nonzero_pixels?: number;
    bit_24_set_pixels?: number;
    bit_24_clear_pixels?: number;
    bits_25_to_31_nonzero_pixels?: number;
    full_values?: Array<{ value: number; count: number }>;
  };
  source_processing_metadata?: Record<string, { path?: string; value?: unknown }>;
  native_valid_data_mask_diagnostics?: {
    status?: string;
    polarization?: string;
    search_root?: string;
    dataset_path?: string | null;
    dtype?: string;
    shape?: number[];
    source_mask_shape?: number[];
    fill_value?: unknown;
    encoding?: string;
    grid_relation?: string;
    aoi_polygon_pixels?: number;
    samples_checked?: number;
    well_formed_samples?: number;
    reserved_bit_or_unknown_samples?: number;
    reference_valid_pixels?: number;
    secondary_valid_pixels?: number;
    both_reference_and_secondary_valid_pixels?: number;
    neither_reference_nor_secondary_valid_pixels?: number;
    valid_data_mask_value_counts?: Array<{ value: number; count: number }>;
    wrs_reference_digit_zero_pixels?: number;
    wrs_secondary_digit_zero_pixels?: number;
    wrs_reference_zero_but_validmask_reference_valid_pixels?: number;
    wrs_secondary_zero_but_validmask_secondary_valid_pixels?: number;
    wrs_reference_nonzero_but_validmask_reference_invalid_pixels?: number;
    wrs_secondary_nonzero_but_validmask_secondary_invalid_pixels?: number;
    message?: string;
  };
  related_mask_qa_objects?: Array<{
    path: string; object_type: string; dtype?: string; shape?: number[];
    dataset_value?: unknown;
    metadata?: { attribute_names?: string[]; selected_attributes?: Record<string, unknown> };
  }>;
  native_x_coordinates_path?: string;
  native_y_coordinates_path?: string;
  native_projection_dataset_path?: string;
  native_crs?: string;
  cog_dtype?: string;
  cog_crs?: string;
  grid_alignment?: {
    pixel_centres_aligned?: boolean;
    x_coordinate_max_error_m?: number;
    y_coordinate_max_error_m?: number;
    x_alignment_tolerance_m?: number;
    y_alignment_tolerance_m?: number;
  };
  comparison?: {
    aoi_window_width_px?: number;
    aoi_window_height_px?: number;
    polygon_pixels?: number;
    comparable_pixels?: number;
    exact_matches?: number;
    mismatches?: number;
    exact_match_fraction?: number;
    mismatch_pairs_top10?: Array<{ source_value: number; cog_value: number; count: number }>;
    mismatches_compatible_with_float32_rounding?: number;
  };
  full_source_hdf5_downloaded?: boolean;
  aoi_source_window_read_remotely?: boolean;
  persistent_storage_used?: boolean;
  quality_gate_changed?: boolean;
  scientific_displacement_calculated?: boolean;
  interpretation?: string;
  next_step?: string;
  message?: string;
};

export async function verifyGunwNativeSourceMask(input: {
  granuleName: string;
  maskJobId: string;
  coordinates: Coordinate[];
  maturity?: 'PROVISIONAL' | 'BETA';
  polarization?: 'HH' | 'VV';
}): Promise<NativeSourceMaskVerificationResponse> {
  const response = await fetch(`${API_BASE}/api/harmony/gunw-quality/verify-source-mask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      granule_name: input.granuleName.trim(),
      mask_job_id: input.maskJobId.trim(),
      coordinates: input.coordinates,
      maturity: input.maturity ?? 'PROVISIONAL',
      polarization: input.polarization ?? 'HH',
    }),
  });
  const payload = await response.json().catch(() => ({})) as NativeSourceMaskVerificationResponse & { detail?: string };
  if (!response.ok) {
    throw new Error(payload.detail || payload.message || `Native source-mask verification failed (${response.status}).`);
  }
  return payload;
}

async function readApiPayload<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { detail?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload.detail || payload.message || `${fallback} (${response.status}).`);
  }
  return payload as T;
}

export async function startNisarHarmonyLayerJob(input: {
  granuleName: string;
  layerRole: HarmonyLayerRole;
  coordinates: Coordinate[];
  maturity?: 'PROVISIONAL' | 'BETA';
  polarization?: 'HH' | 'VV';
}): Promise<HarmonySingleLayerSubmissionResponse> {
  const granuleName = input.granuleName.trim();
  if (!/^NISAR_L2_(PR|UR)_GUNW_[A-Za-z0-9_]+$/.test(granuleName)) {
    throw new Error('Select an exact PR/UR GUNW granule from the ASF catalogue. GOFF and other products are not enabled for this extraction workflow yet.');
  }
  if (input.coordinates.length < 3) {
    throw new Error('Close the area polygon before submitting a Harmony job.');
  }
  const response = await fetch(`${API_BASE}/api/harmony/extract/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      granule_name: granuleName,
      coordinates: input.coordinates,
      product_type: 'GUNW',
      maturity: input.maturity ?? 'PROVISIONAL',
      polarization: input.polarization ?? 'HH',
      layer_role: input.layerRole,
      confirm_full_granule_layer: true,
    }),
  });
  return readApiPayload<HarmonySingleLayerSubmissionResponse>(response, 'Could not submit the selected layer to NASA Harmony');
}

export async function startGunwQualityLayers(input: {
  granuleName: string;
  phaseJobId: string;
  coordinates: Coordinate[];
  maturity?: 'PROVISIONAL' | 'BETA';
  polarization?: 'HH' | 'VV';
}): Promise<HarmonyQualityLayerBundle> {
  const response = await fetch(`${API_BASE}/api/harmony/gunw-quality/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      granule_name: input.granuleName,
      phase_job_id: input.phaseJobId,
      coordinates: input.coordinates,
      maturity: input.maturity ?? 'PROVISIONAL',
      polarization: input.polarization ?? 'HH',
      confirm_full_granule_layers: true,
      include_iono_uncertainty: true,
    }),
  });
  return readApiPayload<HarmonyQualityLayerBundle>(response, 'Could not start GUNW quality-layer jobs');
}

export async function getNisarHarmonyJobStatus(jobId: string): Promise<HarmonyJobStatusResponse> {
  const safeId = jobId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(safeId)) throw new Error('Invalid Harmony Job ID.');
  const response = await fetch(`${API_BASE}/api/harmony/jobs/${encodeURIComponent(safeId)}`);
  return readApiPayload<HarmonyJobStatusResponse>(response, 'Could not check Harmony job status');
}

export async function analyzeGunwAoiQuality(input: {
  granuleName: string;
  polarization?: 'HH' | 'VV';
  coordinates: Coordinate[];
  jobs: Record<string, HarmonyQualityLayerJob>;
}): Promise<GunwQualityAnalysisResponse> {
  const required = ['unwrapped_phase', 'coherence', 'connected_components', 'ionosphere_phase_screen', 'mask'];
  const missing = required.filter((role) => !input.jobs[role]?.job_id);
  if (missing.length) throw new Error(`Missing layer jobs: ${missing.join(', ')}`);
  const body: Record<string, unknown> = {
    granule_name: input.granuleName,
    polarization: input.polarization ?? 'HH',
    coordinates: input.coordinates,
    phase_job_id: input.jobs.unwrapped_phase.job_id,
    coherence_job_id: input.jobs.coherence.job_id,
    connected_components_job_id: input.jobs.connected_components.job_id,
    ionosphere_phase_screen_job_id: input.jobs.ionosphere_phase_screen.job_id,
    mask_job_id: input.jobs.mask.job_id,
    coherence_threshold: 0.3,
  };
  if (input.jobs.ionosphere_phase_screen_uncertainty?.job_id) {
    body.ionosphere_phase_screen_uncertainty_job_id = input.jobs.ionosphere_phase_screen_uncertainty.job_id;
  }
  const response = await fetch(`${API_BASE}/api/harmony/gunw-quality/analyze-aoi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readApiPayload<GunwQualityAnalysisResponse>(response, 'Could not analyze the selected GUNW AOI');
}
