import { useCallback, useEffect, useRef, useState } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import type { User } from 'firebase/auth';
import { analyzeGunwAoiQuality, getNisarHarmonyJobStatus, inspectNisarAoiWindow, searchNisarCatalog, startGunwQualityLayers, startNisarHarmonyLayerJob, verifyGunwNativeSourceMask } from '../../src/api/catalog';
import type { AoiWindowResponse, CatalogProduct, CatalogResponse, GunwQualityAnalysisResponse, HarmonyLayerRole, HarmonyQualityLayerBundle, HarmonyQualityLayerJob, NativeSourceMaskVerificationResponse, NisarProductType, SubmittedHarmonyLayerJob } from '../../src/api/catalog';
import { investigate } from '../engine/adapter';
import { calculateGeodesicAreaKm2, canSubmitCatalogPreflight, timestampToRequest, validateAnalysisRequest, validateCatalogPreflight, validatePolyline } from '../engine/validation';
import { scheduleErrorToastDismissal } from './errorToast';
import type { AnalysisRequest, Coordinate, InvestigationPolyline, InvestigationResult, LocationSelection, TimestampSelection } from '../engine/types';
import './landslide.css';

let mapsLoaderConfigured = false;
const MIN_MAP_ZOOM = 5;
const DEFAULT_MAP_ZOOM = 5;

type MapCanvasProps = {
  location: LocationSelection | null;
  coordinates: Coordinate[];
  drawing: boolean;
  selectedVertexIndex: number | null;
  onLocation: (location: LocationSelection) => void;
  onCoordinates: (coordinates: Coordinate[], isClosed: boolean) => void;
  onSelectedVertex: (index: number | null) => void;
  onSearchText: (value: string) => void;
  onMapReady: (map: google.maps.Map) => void;
};

function MapCanvas({ location, coordinates, drawing, selectedVertexIndex, onLocation, onCoordinates, onSelectedVertex, onSearchText, onMapReady }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const polygonRef = useRef<google.maps.Polygon | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const drawingRef = useRef(drawing);
  const coordinatesRef = useRef(coordinates);
  const onCoordinatesRef = useRef(onCoordinates);
  const onLocationRef = useRef(onLocation);
  const onSelectedVertexRef = useRef(onSelectedVertex);
  const [mapError, setMapError] = useState('');
  const [placesError, setPlacesError] = useState('');

  drawingRef.current = drawing;
  coordinatesRef.current = coordinates;
  onCoordinatesRef.current = onCoordinates;
  onLocationRef.current = onLocation;
  onSelectedVertexRef.current = onSelectedVertex;

  useEffect(() => {
    let active = true;
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

    if (!apiKey) {
          setMapError('Add VITE_GOOGLE_MAPS_API_KEY to .env to enable Google Maps imagery.');
      return undefined;
    }

    if (!mapsLoaderConfigured) {
      setOptions({ key: apiKey, v: 'weekly' });
      mapsLoaderConfigured = true;
    }

    void Promise.all([importLibrary('maps'), importLibrary('geometry')])
      .then(async ([maps]) => {
        if (!active || !containerRef.current) return;
        const map = new maps.Map(containerRef.current, {
          center: { lat: 22, lng: 82 },
          zoom: DEFAULT_MAP_ZOOM,
          minZoom: MIN_MAP_ZOOM,
          maxZoom: 18,
          mapTypeId: 'terrain',
          fullscreenControl: false,
          streetViewControl: false,
          mapTypeControl: false,
          zoomControl: false,
          clickableIcons: false,
          backgroundColor: '#dfeff3',
        });

        map.addListener('click', (event: google.maps.MapMouseEvent) => {
          if (!drawingRef.current || !event.latLng) return;
          const next: Coordinate = [Number(event.latLng.lng().toFixed(6)), Number(event.latLng.lat().toFixed(6))];
          const existing = coordinatesRef.current.map((point) => point);
          if (existing.length >= 2) {
            const first = existing[0];
            const distanceKm = Math.hypot(next[0] - first[0], next[1] - first[1]) * 111;
            if (distanceKm < 0.1) {
              onCoordinatesRef.current(existing, true);
              onSelectedVertexRef.current(0);
              return;
            }
          }
          onCoordinatesRef.current([...existing, next], false);
          onSelectedVertexRef.current([...existing, next].length - 1);
        });

        mapRef.current = map;
        onMapReady(map);

        try {
          const places = await importLibrary('places');
          const searchContainer = document.querySelector<HTMLElement>('#landslide-place-search');
          if (!searchContainer) return;

          type PlacePrediction = {
            toPlace: () => Promise<{ fetchFields: (options: { fields: string[] }) => Promise<void>; displayName?: string; formattedAddress?: string; location?: google.maps.LatLng }>;
          };
          type PlacesLibrary = typeof places & {
            PlaceAutocompleteElement?: new (options: { includedPrimaryTypes: string[] }) => HTMLElement & {
              addEventListener: (type: 'gmp-select', listener: (event: Event) => void) => void;
            };
          };
          const PlaceAutocompleteElement = (places as PlacesLibrary).PlaceAutocompleteElement;
          if (!PlaceAutocompleteElement) {
            setPlacesError('Places search is unavailable. Enable Places API (New) for this key.');
            return;
          }

          const autocomplete = new PlaceAutocompleteElement({
            includedPrimaryTypes: ['administrative_area_level_1', 'administrative_area_level_2', 'country', 'locality', 'natural_feature', 'establishment'],
          });
          autocomplete.classList.add('place-autocomplete-element');
          searchContainer.innerHTML = '';
          searchContainer.appendChild(autocomplete);
          autocomplete.addEventListener('input', () => onSearchText(autocomplete.value));
          autocomplete.addEventListener('gmp-select', (event: Event) => {
            void (async () => {
              const prediction = (event as CustomEvent<{ placePrediction?: PlacePrediction }>).detail?.placePrediction;
              if (!prediction) return;
              const place = await prediction.toPlace();
              await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
              if (!place.location) return;
              const displayName = place.formattedAddress || place.displayName || 'Selected place';
              onLocationRef.current({
                searchText: displayName,
                name: displayName,
                latitude: place.location.lat(),
                longitude: place.location.lng(),
              });
            })().catch(() => setPlacesError('The selected place could not be loaded. Check Places API (New) access for this key.'));
          });
        } catch {
          setPlacesError('Places search is unavailable. Enable Places API (New) and billing for this key.');
        }
      })
      .catch(() => setMapError('Google Maps could not load. Check the API key and Maps JavaScript API access.'));

    return () => { active = false; };
  }, [onMapReady, onSearchText]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const path = coordinates.map(([lng, lat]) => ({ lat, lng }));

    if (polygonRef.current) {
      polygonRef.current.setPaths(path);
      polygonRef.current.setVisible(path.length > 1);
    } else if (path.length > 1) {
      polygonRef.current = new google.maps.Polygon({
        map,
        paths: path,
        strokeColor: '#bfeaff',
        fillColor: '#49b8f2',
        fillOpacity: 0.24,
        strokeOpacity: 0.95,
        strokeWeight: 2.5,
        clickable: false,
      });
    }

    if (path.length <= 1 && polygonRef.current) {
      polygonRef.current.setVisible(false);
    }

    const nextMarkers: google.maps.Marker[] = [];
    for (let index = 0; index < coordinates.length; index += 1) {
      const coordinate = coordinates[index];
      const existing = markersRef.current[index];
      const marker = existing ?? new google.maps.Marker({
        map,
        position: { lat: coordinate[1], lng: coordinate[0] },
        draggable: true,
        clickable: true,
        zIndex: index === 0 ? 30 : 25,
      });

      marker.setPosition({ lat: coordinate[1], lng: coordinate[0] });
      marker.setMap(map);
      marker.setDraggable(true);
      marker.setVisible(true);
      marker.setZIndex(index === 0 ? 30 : 25);
      marker.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        scale: selectedVertexIndex === index ? 7 : index === 0 ? 6.5 : 5.8,
        fillColor: index === 0 && drawing ? '#d4f5ff' : '#f3fcff',
        fillOpacity: 1,
        strokeColor: index === 0 && drawing ? '#9ae5ff' : '#d8f2ff',
        strokeWeight: selectedVertexIndex === index ? 2.5 : 1.8,
      });

      marker.addListener('click', () => {
        onSelectedVertexRef.current(index);
        if (index === 0 && coordinatesRef.current.length >= 3) {
          onCoordinatesRef.current(coordinatesRef.current, true);
          onSelectedVertexRef.current(0);
        }
      });

      marker.addListener('dragend', (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return;
        const updated = coordinatesRef.current.map((point) => point);
        const next: Coordinate = [Number(event.latLng.lng().toFixed(6)), Number(event.latLng.lat().toFixed(6))];
        updated[index] = next;
        onCoordinatesRef.current(updated, coordinatesRef.current.length >= 3 && index === 0);
        onSelectedVertexRef.current(index);
      });

      nextMarkers.push(marker);
    }

    for (let index = markersRef.current.length - 1; index >= coordinates.length; index -= 1) {
      markersRef.current[index].setMap(null);
    }

    markersRef.current = nextMarkers;
  }, [coordinates, drawing, selectedVertexIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !location) return;
    const position = { lat: location.latitude, lng: location.longitude };
    map.panTo(position);
    map.setZoom(Math.max(7, map.getZoom() ?? 7));
    markerRef.current?.setMap(null);
    markerRef.current = new google.maps.Marker({
      map,
      position,
      title: location.name,
      animation: google.maps.Animation.DROP,
    });
  }, [location]);

  return (
    <div className="map-canvas-wrap">
      <div ref={containerRef} className="google-map" aria-label="Google satellite map" />
      {mapError && (
        <div className="map-unavailable">
          <span>MAPS SETUP</span>
          <strong>Satellite imagery is not connected.</strong>
          <small>{mapError}</small>
        </div>
      )}
      {placesError && (
        <div className="places-unavailable" role="status">{placesError}</div>
      )}
      {drawing && !mapError && (
        <div className="draw-hint">Click to trace the area and snap back to the first vertex to close it.</div>
      )}
    </div>
  );
}

function Icon({ name }: { name: 'plus' | 'minus' | 'locate' | 'layers' | 'fullscreen' | 'search' | 'draw' | 'undo' | 'clear' | 'area' | 'home' }) {
  const paths = {
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    locate: 'M12 2v4m0 12v4M2 12h4m12 0h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    fullscreen: 'M8 3H3v5m13-5h5v5M8 21H3v-5m18 0v5h-5',
    search: 'm21 21-4.3-4.3m2.3-5.2a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
    draw: 'm4 20 4.5-1L19 8.5a2.1 2.1 0 0 0-3-3L5.5 16 4 20Zm10-13 3 3',
    undo: 'M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6',
    clear: 'M6 6l12 12M18 6 6 18',
    area: 'M5 18l7-7 6 4 6-10v17H5z',
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1v-9.5Z',
  } as const;

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

function ResultPanel({ result, onReset }: { result: InvestigationResult; onReset: () => void }) {
  const title = result.status === 'finding'
    ? 'Evidence available'
    : result.qa.status === 'FAILED'
      ? 'Failed'
      : result.observability.geometryStatus === 'insufficient'
        ? 'Insufficient evidence'
        : 'No matching evidence';

  return (
    <div className="evidence-panel">
      <div className="evidence-top">
        <div>
          <span className="result-kicker">LANDSLIDE INVESTIGATION</span>
          <h2>{title}</h2>
        </div>
        <button type="button" className="close-result" onClick={onReset} aria-label="Close result">×</button>
      </div>
      <p className="reference-demo-notice">Reference/demo result only: the current engine uses precomputed fixture data. It did not fetch or process new NISAR products for this request.</p>
      <div className="evidence-grid">
        <div><span>Location</span><strong>{result.request.location.name}</strong></div>
        <div><span>Timestamp</span><strong>{typeof result.request.timestamp === 'string' ? result.request.timestamp.slice(0, 10) : `${result.request.timestamp.start.slice(0, 10)} — ${result.request.timestamp.end.slice(0, 10)}`}</strong></div>
        <div><span>Geometry</span><strong>{result.request.polyline.type}</strong></div>
        <div><span>Observation</span><strong>{result.observability.geometryStatus}</strong></div>
        {result.measurement && <div><span>Measurement</span><strong className="measurement-value">{result.measurement.value} {result.measurement.unit}</strong></div>}
        <div><span>Uncertainty</span><strong>{result.uncertainty ? `${result.uncertainty.value} ${result.uncertainty.unit}` : 'Not reported'}</strong></div>
        <div><span>Observability</span><strong>{result.observability.note}</strong></div>
        <div><span>QA</span><strong>{result.qa.status}</strong></div>
        <div><span>Provenance</span><strong>{result.provenance.algorithm}</strong><small>{result.provenance.notes}</small></div>
      </div>
      <div className="evidence-note">{result.measurement?.interpretation ?? result.limitations.join(' ')}<b>Investigation AOI · {result.request.polyline.coordinates.length} vertices · EPSG:4326</b></div>
    </div>
  );
}


function formatGib(value: number): string {
  if (value >= 1) return `${value.toFixed(2)} GiB`;
  return `${(value * 1024).toFixed(0)} MiB`;
}

function CatalogPreflightPanel({
  result,
  onClose,
  onSelectProduct,
  selectedGranuleName,
}: {
  result: CatalogResponse;
  onClose: () => void;
  onSelectProduct: (product: CatalogProduct) => void;
  selectedGranuleName: string;
}) {
  return (
    <div className="catalog-preflight" aria-live="polite">
      <div className="catalog-preflight-heading">
        <div>
          <span className="result-kicker">ASF CATALOGUE PREFLIGHT · METADATA ONLY</span>
          <h3>{result.product_count} matching {result.query.product_type} granule{result.product_count === 1 ? '' : 's'}</h3>
        </div>
        <button className="close-result" type="button" onClick={onClose} aria-label="Close catalogue results">×</button>
      </div>
      <div className="catalog-stats">
        <div><span>AOI</span><strong>{result.query.aoi_area_km2.toFixed(2)} km²</strong></div>
        <div><span>Reported metadata size sum</span><strong>{result.product_count === 0 ? 'No products' : result.products_with_unknown_size === result.product_count && result.estimated_full_granule_volume_gib === 0 ? 'Unknown' : formatGib(result.estimated_full_granule_volume_gib)}</strong></div>
        <div><span>Checked (UTC)</span><strong>{new Date(result.checked_at).toLocaleString()}</strong></div>
      </div>
      <p className="catalog-notice"><b>Search status: {result.status || 'unknown'}.</b>{result.truncated ? ' The result set is incomplete because ASF reached the configured cap.' : ''}</p>
      <p className="catalog-notice"><b>Processing eligibility: undetermined.</b> {result.processing_eligibility.reason}</p>
      {result.status === 'not_configured' && (
        <p className="catalog-warning" role="status">{result.message || 'Live ASF catalogue search is not connected yet. No products were returned.'}</p>
      )}
      <p className="catalog-notice"><b>No satellite files were downloaded.</b> This is a metadata search, not a movement analysis. The reported metadata size sum is not a guaranteed download or processing disk requirement.</p>
      {result.truncated && <p className="catalog-warning">More than the configured result limit may match. Narrow the location or date range before analysis.</p>}
      {result.products_with_unknown_size > 0 && <p className="catalog-warning">Size metadata is missing for {result.products_with_unknown_size} product(s), so the total is incomplete.</p>}
      {result.product_count === 0 ? (
        <p className="catalog-empty">No matching products were returned for this area, time range and product family. Try another date range or switch between GUNW and GOFF.</p>
      ) : (
        <div className="catalog-product-list">
          {result.products.map((product, index) => {
            const isExtractableGunw = result.query.product_type === 'GUNW'
              && /^NISAR_L2_(PR|UR)_GUNW_[A-Za-z0-9_]+$/.test(product.granule_name);
            const isSelected = selectedGranuleName === product.granule_name;
            return (
              <div className={`catalog-product-row${isSelected ? ' is-selected' : ''}`} key={`${product.granule_name}-${index}`}>
                <div className="catalog-product-main">
                  <strong title={product.granule_name}>{product.granule_name}</strong>
                  <small>{product.observation_dates.join(' → ') || product.start_time || 'Acquisition date not parsed'} · {product.direction || 'Direction unknown'}{product.path ? ` · path ${product.path}` : ''}</small>
                </div>
                <div className="catalog-product-actions">
                  <span>{product.size_mb == null ? 'Size n/a' : formatGib(product.size_mb / 1024)}</span>
                  <button type="button" className="catalog-select-product" disabled={!isExtractableGunw} onClick={() => onSelectProduct(product)}>
                    {isSelected ? 'Selected' : isExtractableGunw ? 'Select product' : 'GUNW only'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <details className="catalog-disclaimers">
        <summary>Important scientific and storage notes</summary>
        {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </details>
    </div>
  );
}

const HARMONY_LAYER_OPTIONS: Array<{ value: HarmonyLayerRole; label: string }> = [
  { value: 'unwrapped_phase', label: 'Unwrapped phase · starting layer' },
  { value: 'coherence', label: 'Coherence magnitude' },
  { value: 'connected_components', label: 'Connected components' },
  { value: 'ionosphere_phase_screen', label: 'Ionosphere phase screen' },
  { value: 'ionosphere_phase_screen_uncertainty', label: 'Ionosphere phase-screen uncertainty' },
  { value: 'mask', label: 'GUNW quality mask' },
];

function HarmonyJobSubmissionPanel({
  product,
  areaClosed,
  coordinatesCount,
  layerRole,
  onLayerRoleChange,
  maturity,
  onMaturityChange,
  polarization,
  onPolarizationChange,
  confirmFullGranule,
  onConfirmFullGranuleChange,
  isSubmitting,
  error,
  message,
  jobs,
  checkingJobs,
  onSubmit,
  onCheckJob,
  onCheckMatchingJobs,
  onUseAsPhase,
  onUseAsMask,
}: {
  product: CatalogProduct | null;
  areaClosed: boolean;
  coordinatesCount: number;
  layerRole: HarmonyLayerRole;
  onLayerRoleChange: (value: HarmonyLayerRole) => void;
  maturity: 'PROVISIONAL' | 'BETA';
  onMaturityChange: (value: 'PROVISIONAL' | 'BETA') => void;
  polarization: 'HH' | 'VV';
  onPolarizationChange: (value: 'HH' | 'VV') => void;
  confirmFullGranule: boolean;
  onConfirmFullGranuleChange: (value: boolean) => void;
  isSubmitting: boolean;
  error: string;
  message: string;
  jobs: SubmittedHarmonyLayerJob[];
  checkingJobs: boolean;
  onSubmit: () => void;
  onCheckJob: (jobId: string) => void;
  onCheckMatchingJobs: () => void;
  onUseAsPhase: (job: SubmittedHarmonyLayerJob) => void;
  onUseAsMask: (job: SubmittedHarmonyLayerJob) => void;
}) {
  const extractable = Boolean(product && /^NISAR_L2_(PR|UR)_GUNW_[A-Za-z0-9_]+$/.test(product.granule_name));
  const matchingJobs = product ? jobs.filter((job) => job.granule_name === product.granule_name && job.maturity === maturity && job.polarization === polarization) : [];
  return (
    <section className="harmony-submit-panel" aria-live="polite">
      <div className="catalog-preflight-heading">
        <div>
          <span className="result-kicker">NASA HARMONY · DIRECT JOB SUBMISSION</span>
          <h3>Select a product, submit a layer, receive its Job ID</h3>
        </div>
      </div>
      <p className="catalog-notice">Select a GUNW product in the archive list above. The backend checks the live Harmony collection/layer capability, submits one granule and one variable, then returns the job ID here. AOI cropping happens later; it is not sent as an extraction subset.</p>
      {!product ? (
        <p className="catalog-empty">No product selected yet. Press <b>Select product</b> on a GUNW catalogue result to begin.</p>
      ) : (
        <>
          <div className="selected-harmony-product">
            <small>SELECTED ASF GRANULE</small>
            <strong title={product.granule_name}>{product.granule_name}</strong>
            <span>{product.observation_dates.join(' → ') || product.start_time || 'Observation date unavailable'} · {product.direction || 'Direction unknown'}</span>
          </div>
          {!extractable && <p className="catalog-warning">This product name is not a supported PR/UR GUNW granule. Current Harmony extraction pilot does not submit GOFF jobs.</p>}
          <div className="harmony-workflow-fields">
            <label className="aoi-job-label">
              <span>Layer to submit</span>
              <select value={layerRole} onChange={(event) => onLayerRoleChange(event.target.value as HarmonyLayerRole)}>
                {HARMONY_LAYER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="aoi-job-label">
              <span>Collection maturity</span>
              <select value={maturity} onChange={(event) => onMaturityChange(event.target.value as 'PROVISIONAL' | 'BETA')}>
                <option value="PROVISIONAL">PROVISIONAL</option>
                <option value="BETA">BETA</option>
              </select>
            </label>
            <label className="aoi-job-label">
              <span>Polarization</span>
              <select value={polarization} onChange={(event) => onPolarizationChange(event.target.value as 'HH' | 'VV')}>
                <option value="HH">HH</option>
                <option value="VV">VV</option>
              </select>
            </label>
          </div>
          <label className="harmony-full-granule-confirm">
            <input type="checkbox" checked={confirmFullGranule} onChange={(event) => onConfirmFullGranuleChange(event.target.checked)} />
            <span>I understand this queues one variable for the <b>full granule</b>. The selected polygon is used later for AOI diagnostics, not as a Harmony subset.</span>
          </label>
          <button type="button" className="investigate-button harmony-submit-button" disabled={!extractable || !areaClosed || coordinatesCount < 3 || !confirmFullGranule || isSubmitting} onClick={onSubmit}>
            {isSubmitting ? 'Checking capability & submitting…' : `Submit ${HARMONY_LAYER_OPTIONS.find((item) => item.value === layerRole)?.label || 'layer'} job`}
          </button>
          {!areaClosed && <p className="action-hint">Close the AOI polygon before submitting, so the workflow carries the correct area into the follow-up analysis.</p>}
        </>
      )}
      {error && <p className="catalog-error" role="alert">{error}</p>}
      {message && <p className="action-hint" role="status">{message}</p>}
      {jobs.length > 0 && (
        <div className="submitted-harmony-jobs">
          <div className="submitted-harmony-jobs-heading">
            <strong>Jobs submitted from this website ({jobs.length})</strong>
            <button type="button" className="demo-button quality-action-button" disabled={!matchingJobs.length || checkingJobs} onClick={onCheckMatchingJobs}>
              {checkingJobs ? 'Checking…' : 'Check selected product jobs'}
            </button>
          </div>
          {jobs.map((job) => (
            <div className="submitted-harmony-job" key={job.job_id}>
              <div className="submitted-harmony-job-top">
                <strong>{HARMONY_LAYER_OPTIONS.find((item) => item.value === job.layer_role)?.label || job.layer_role.replace(/_/g, ' ')}</strong>
                <span className={`harmony-job-status ${['successful', 'completed', 'complete'].includes(job.status.toLowerCase()) ? 'is-success' : ['failed', 'error', 'canceled', 'cancelled'].includes(job.status.toLowerCase()) ? 'is-error' : ''}`}>{job.status}</span>
              </div>
              <small title={job.granule_name}>{job.granule_name}</small>
              <code>{job.job_id}</code>
              {job.status_error && <small className="catalog-error">{job.status_error}</small>}
              <div className="submitted-harmony-job-actions">
                <span>{job.maturity} · {job.polarization} · {new Date(job.submitted_at).toLocaleString()}</span>
                <button type="button" className="demo-button" disabled={checkingJobs} onClick={() => onCheckJob(job.job_id)}>Refresh status</button>
                {job.layer_role === 'unwrapped_phase' && <button type="button" className="demo-button" disabled={!['successful', 'completed', 'complete'].includes(job.status.toLowerCase())} onClick={() => onUseAsPhase(job)}>Use as phase ID</button>}
                {job.layer_role === 'mask' && <button type="button" className="demo-button" disabled={!['successful', 'completed', 'complete'].includes(job.status.toLowerCase())} onClick={() => onUseAsMask(job)}>Use as mask ID</button>}
              </div>
            </div>
          ))}
          <p className="catalog-notice">Job IDs remain in this browser tab if you refresh it. Do not submit the same layer repeatedly without checking the existing job status first.</p>
        </div>
      )}
    </section>
  );
}

function AoiWindowPanel({
  coordinates,
  areaClosed,
  jobId,
  onJobIdChange,
  isLoading,
  error,
  result,
  onRun,
  granuleName,
  onGranuleNameChange,
  qualityBundle,
  qualityStatuses,
  individualLayerJobs,
  individualLayersAvailable,
  qualityMessage,
  qualityError,
  qualityStartLoading,
  qualityCheckLoading,
  qualityAnalyzeLoading,
  qualityAnalysis,
  sourceMaskJobId,
  onSourceMaskJobIdChange,
  sourceMaskJobOptions,
  sourceMaskVerification,
  sourceMaskVerificationLoading,
  sourceMaskVerificationError,
  onVerifySourceMask,
  onStartQualityLayers,
  onCheckQualityLayers,
  onAnalyzeQuality,
}: {
  coordinates: Coordinate[];
  areaClosed: boolean;
  jobId: string;
  onJobIdChange: (value: string) => void;
  isLoading: boolean;
  error: string;
  result: AoiWindowResponse | null;
  onRun: () => void;
  granuleName: string;
  onGranuleNameChange: (value: string) => void;
  qualityBundle: HarmonyQualityLayerBundle | null;
  qualityStatuses: Record<string, string>;
  individualLayerJobs: Record<string, HarmonyQualityLayerJob>;
  individualLayersAvailable: boolean;
  qualityMessage: string;
  qualityError: string;
  qualityStartLoading: boolean;
  qualityCheckLoading: boolean;
  qualityAnalyzeLoading: boolean;
  qualityAnalysis: GunwQualityAnalysisResponse | null;
  sourceMaskJobId: string;
  onSourceMaskJobIdChange: (value: string) => void;
  sourceMaskJobOptions: SubmittedHarmonyLayerJob[];
  sourceMaskVerification: NativeSourceMaskVerificationResponse | null;
  sourceMaskVerificationLoading: boolean;
  sourceMaskVerificationError: string;
  onVerifySourceMask: () => void;
  onStartQualityLayers: () => void;
  onCheckQualityLayers: () => void;
  onAnalyzeQuality: () => void;
}) {
  const requiredQualityRoles = ['unwrapped_phase', 'coherence', 'connected_components', 'ionosphere_phase_screen', 'mask'];
  const activeQualityJobs = qualityBundle?.jobs || individualLayerJobs;
  const qualityRolesToCheck = [...requiredQualityRoles, ...(activeQualityJobs.ionosphere_phase_screen_uncertainty ? ['ionosphere_phase_screen_uncertainty'] : [])];
  const hasAllRequiredQualityJobs = requiredQualityRoles.every((role) => Boolean(activeQualityJobs[role]?.job_id));
  const successfulStatuses = ['successful', 'completed', 'complete'];
  const selectedSourceMaskJob = sourceMaskJobOptions.find((job) => job.job_id === sourceMaskJobId);
  const sourceMaskJobIsValid = Boolean(selectedSourceMaskJob
    && selectedSourceMaskJob.layer_role === 'mask'
    && successfulStatuses.includes(selectedSourceMaskJob.status.toLowerCase())
    && selectedSourceMaskJob.granule_name === granuleName.trim());
  const canAnalyzeQuality = hasAllRequiredQualityJobs
    && qualityRolesToCheck.every((role) => ['successful', 'completed', 'complete'].includes(String(qualityStatuses[role] || activeQualityJobs[role]?.status || '').toLowerCase()));
  return (
    <div className="aoi-window-panel" aria-live="polite">
      <div className="catalog-preflight-heading">
        <div>
          <span className="result-kicker">REMOTE COG · AOI WINDOW PILOT</span>
          <h3>Read the selected area from a completed GUNW result</h3>
        </div>
      </div>
      <p className="catalog-notice">This reads only the pixels intersecting your polygon from the remote Cloud-Optimized GeoTIFF where HTTP byte-range access works. It does not save the TIFF or calculate landslide displacement.</p>
      <label className="aoi-job-label">
        <span>Harmony Job ID</span>
        <input
          value={jobId}
          onChange={(event) => onJobIdChange(event.target.value)}
          placeholder="Paste the successful Harmony job ID"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button className="investigate-button aoi-window-button" type="button" disabled={!areaClosed || coordinates.length < 3 || !jobId.trim() || isLoading} onClick={onRun}>
        {isLoading ? 'Reading AOI window…' : 'Read selected AOI window'}
      </button>
      {!areaClosed && <p className="action-hint">Close the polygon first to send its coordinates.</p>}
      {error && <p className="catalog-error" role="alert">{error}</p>}
      {result && (
        <div className="aoi-window-result">
          <strong>AOI window returned</strong>
          <div className="catalog-stats">
            <div><span>Window</span><strong>{result.aoi_window ? `${result.aoi_window.width} × ${result.aoi_window.height} px` : 'Not available'}</strong></div>
            <div><span>Polygon pixels</span><strong>{result.pixels_inside_polygon ?? '—'}</strong></div>
            <div><span>Valid phase pixels</span><strong>{result.valid_unmasked_pixels ?? '—'}</strong></div>
          </div>
          {result.raw_phase_diagnostic_statistics && (
            <div className="catalog-stats">
              <div><span>Raw phase min</span><strong>{result.raw_phase_diagnostic_statistics.min.toFixed(4)}</strong></div>
              <div><span>Raw phase max</span><strong>{result.raw_phase_diagnostic_statistics.max.toFixed(4)}</strong></div>
              <div><span>Raw phase mean</span><strong>{result.raw_phase_diagnostic_statistics.mean.toFixed(4)}</strong></div>
            </div>
          )}
          <p className="catalog-warning">{result.warning || 'Raw phase diagnostics only; this is not a displacement or landslide finding.'}</p>
          <small className="aoi-window-meta">CRS: {result.source_crs || 'unknown'} · Persistent storage: {result.persistent_storage_used ? 'used' : 'not used'} · Full raster downloaded: {result.full_raster_downloaded ? 'yes' : 'no'}</small>
        </div>
      )}
      <div className="quality-layer-section">
        <span className="result-kicker">NEXT · MULTI-LAYER QUALITY CHECK</span>
        <p className="catalog-notice">You can submit each matching layer one by one in the submission panel above, or submit the remaining companion layers as a batch here. Do not mix both approaches for the same product/settings: that can create duplicate full-granule jobs.</p>
        <label className="aoi-job-label">
          <span>Exact granule name for this phase job</span>
          <input
            value={granuleName}
            onChange={(event) => onGranuleNameChange(event.target.value)}
            placeholder="Paste the exact GUNW granule name from ASF"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button className="investigate-button aoi-window-button" type="button" disabled={!areaClosed || coordinates.length < 3 || !jobId.trim() || !granuleName.trim() || qualityStartLoading || Boolean(qualityBundle)} onClick={onStartQualityLayers}>
          {qualityStartLoading ? 'Submitting quality layers…' : qualityBundle ? 'Companion jobs submitted — check status below' : 'Submit remaining companion layers (batch)'}
        </button>
        {qualityError && <p className="catalog-error" role="alert">{qualityError}</p>}
        {qualityMessage && <p className="action-hint" role="status">{qualityMessage}</p>}
        {(qualityBundle || individualLayersAvailable) && (
          <div className="quality-job-list">
            <strong>{qualityBundle ? 'Harmony companion-layer jobs' : 'Individually submitted Harmony layer jobs'}</strong>
            {Object.entries(activeQualityJobs).map(([role, job]) => (
              <div className="quality-job-row" key={role}>
                <span>{role.replace(/_/g, ' ')}</span>
                <code>{job.job_id}</code>
                <b>{qualityStatuses[role] || job.status}</b>
              </div>
            ))}
            {Object.entries(qualityBundle?.submission_errors || {}).map(([role, message]) => (
              <p className="catalog-warning" key={role}>{role}: {message}</p>
            ))}
            {!qualityBundle && <p className="catalog-notice">These job IDs were submitted one layer at a time. Only jobs matching the currently selected granule, maturity, and polarization are included.</p>}
            <button type="button" className="demo-button quality-action-button" disabled={qualityCheckLoading} onClick={onCheckQualityLayers}>
              {qualityCheckLoading ? 'Checking jobs…' : 'Check all layer jobs'}
            </button>
            <button type="button" className="investigate-button quality-action-button" disabled={!canAnalyzeQuality || qualityAnalyzeLoading} onClick={onAnalyzeQuality}>
              {qualityAnalyzeLoading ? 'Analyzing AOI quality…' : 'Analyze aligned AOI quality gates'}
            </button>
            {!canAnalyzeQuality && <p className="action-hint">Submit the missing layers and check their statuses. Analysis is enabled only when every required layer job is present and successful.</p>}
          </div>
        )}
        {qualityAnalysis?.quality_gates && (
          <div className="aoi-window-result">
            <strong>Multi-layer AOI quality diagnostics</strong>
            <div className="catalog-stats">
              <div><span>Polygon pixels</span><strong>{qualityAnalysis.aoi?.polygon_pixels ?? '—'}</strong></div>
              <div><span>Jointly qualified</span><strong>{qualityAnalysis.quality_gates.jointly_qualified_pixels}</strong></div>
              <div><span>Qualified fraction</span><strong>{(100 * qualityAnalysis.quality_gates.jointly_qualified_fraction_of_polygon).toFixed(1)}%</strong></div>
              <div><span>Coherence pass (≥ {qualityAnalysis.quality_gates.coherence_threshold})</span><strong>{qualityAnalysis.quality_gates.coherence_pass_pixels}</strong></div>
              <div><span>Positive component IDs</span><strong>{qualityAnalysis.quality_gates.connected_components_positive_pixels}</strong></div>
              <div><span>Base WRS land/subswath (low byte)</span><strong>{qualityAnalysis.quality_gates.mask_low_byte_land_valid_subswath_pixels ?? '—'}</strong></div>
              <div><span>Strict mask pass (flags/exceptions excluded)</span><strong>{qualityAnalysis.quality_gates.mask_valid_land_subswath_pixels}</strong></div>
              <div><span>Ionosphere-filter flagged</span><strong>{qualityAnalysis.quality_gates.mask_ionosphere_filter_flagged_pixels ?? '—'}</strong></div>
              <div><span>Ambiguous packed WRS values</span><strong>{qualityAnalysis.quality_gates.mask_packed_wrs_ambiguous_pixels ?? '—'}</strong></div>
            </div>
            {qualityAnalysis.ionosphere_corrected_phase_statistics && (
              <div className="catalog-stats">
                <div><span>Corrected phase mean (rad)</span><strong>{qualityAnalysis.ionosphere_corrected_phase_statistics.mean.toFixed(4)}</strong></div>
                <div><span>Corrected phase std (rad)</span><strong>{qualityAnalysis.ionosphere_corrected_phase_statistics.std.toFixed(4)}</strong></div>
                <div><span>Pixels after all gates</span><strong>{qualityAnalysis.ionosphere_corrected_phase_statistics.count}</strong></div>
              </div>
            )}
            <p className="catalog-warning">{qualityAnalysis.physical_displacement?.reason || 'This is a quality-gated phase diagnostic, not LOS displacement or landslide detection.'}</p>
            {qualityAnalysis.warnings?.map((warning) => (
              <p className="catalog-warning" role="status" key={warning}>{warning}</p>
            ))}
            {qualityAnalysis.quality_gates && (
              <div className="gate-funnel">
                <strong>Pixel gate funnel</strong>
                <div className="catalog-stats">
                  <div><span>Phase + coherence</span><strong>{qualityAnalysis.quality_gates.phase_and_coherence_pixels ?? '—'}</strong></div>
                  <div><span>After components</span><strong>{qualityAnalysis.quality_gates.after_connected_components_pixels ?? '—'}</strong></div>
                  <div><span>After ionosphere validity</span><strong>{qualityAnalysis.quality_gates.after_ionosphere_validity_pixels ?? '—'}</strong></div>
                  <div><span>After strict mask gate</span><strong>{qualityAnalysis.quality_gates.after_land_and_subswath_mask_pixels ?? '—'}</strong></div>
                  <div><span>After ionosphere filter mask</span><strong>{qualityAnalysis.quality_gates.after_ionosphere_filter_mask_pixels ?? '—'}</strong></div>
                </div>
              </div>
            )}
            {qualityAnalysis.mask_intersection_diagnostics && (
              <div className="gate-funnel mask-intersection-panel">
                <strong>Candidate-to-mask intersection</strong>
                <p className="aoi-window-meta">{qualityAnalysis.mask_intersection_diagnostics.candidate_population || 'Pixels surviving earlier quality stages'}.</p>
                <div className="catalog-stats">
                  <div><span>Candidate pixels</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_pixels_after_ionosphere_validity ?? '—'}</strong></div>
                  <div><span>Mask valid</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_mask_valid_pixels ?? '—'}</strong></div>
                  <div><span>Mask invalid / NoData</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_mask_invalid_or_nodata_pixels ?? '—'}</strong></div>
                  <div><span>Flagged candidates</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_ionosphere_flagged_pixels ?? '—'}</strong></div>
                  <div><span>Unflagged candidates</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_ionosphere_unflagged_pixels ?? '—'}</strong></div>
                  <div><span>Packed values ≥ 2²⁴</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_packed_values_ge_2pow24_pixels ?? '—'}</strong></div>
                  <div><span>Base WRS pass</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_base_wrs_pass_pixels ?? '—'}</strong></div>
                  <div><span>Reference exceptions</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_reference_exception_pixels ?? '—'}</strong></div>
                  <div><span>Secondary exceptions</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_secondary_exception_pixels ?? '—'}</strong></div>
                  <div><span>WRS + exceptions pass before precision quarantine</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_wrs_and_exceptions_pass_before_precision_quarantine_pixels ?? '—'}</strong></div>
                  <div><span>Strict mask pass among candidates</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_strict_mask_pass_pixels ?? '—'}</strong></div>
                  <div><span>Pass all mask rules among candidates</span><strong>{qualityAnalysis.mask_intersection_diagnostics.candidate_passes_all_mask_rules_pixels ?? '—'}</strong></div>
                </div>
                {!!qualityAnalysis.mask_intersection_diagnostics.candidate_raw_mask_value_counts_top10?.length && (
                  <small>Candidate raw mask values: {qualityAnalysis.mask_intersection_diagnostics.candidate_raw_mask_value_counts_top10.map((item) => `${item.value} (${item.count})`).join(', ')}</small>
                )}
                {!!qualityAnalysis.mask_intersection_diagnostics.candidate_wrs_low_byte_counts_top10?.length && (
                  <small>Candidate WRS low-byte values: {qualityAnalysis.mask_intersection_diagnostics.candidate_wrs_low_byte_counts_top10.map((item) => `${item.value} (${item.count})`).join(', ')}</small>
                )}
                <p className="catalog-warning">{qualityAnalysis.mask_intersection_diagnostics.interpretation_note || 'Diagnostics only; do not relax quality gates based on these counts.'}</p>
              </div>
            )}
            {qualityAnalysis.layer_diagnostics && (
              <details className="layer-diagnostic-details">
                <summary>Inspect layer values and NoData (important when zero pixels qualify)</summary>
                <div className="layer-diagnostic-list">
                  {Object.entries(qualityAnalysis.layer_diagnostics).map(([role, diag]) => (
                    <section className="layer-diagnostic-card" key={role}>
                      <strong>{role.replace(/_/g, ' ')}</strong>
                      <div className="layer-diagnostic-grid">
                        <span>dtype: {diag.dtype || 'unknown'}</span>
                        <span>NoData: {diag.nodata_value ?? 'not set'}</span>
                        <span>Valid: {diag.valid_data_pixels_in_polygon ?? '—'}</span>
                        <span>Masked/NoData: {diag.masked_or_nodata_pixels_in_polygon ?? '—'}</span>
                        <span>Zeros in AOI: {diag.zero_value_pixels_in_polygon_including_masked ?? '—'}</span>
                        {role !== 'mask' && <span>{role === 'connected_components' ? 'Positive component IDs' : 'Values > 0 (sign only)'}: {diag.positive_value_pixels_among_valid_data ?? '—'}</span>}
                        {role !== 'mask' && role !== 'connected_components' && <span>Values &lt; 0 (sign only): {diag.negative_value_pixels_among_valid_data ?? '—'}</span>}
                        <span>Min: {diag.min_valid ?? '—'}</span>
                        <span>Max: {diag.max_valid ?? '—'}</span>
                        {diag.unique_value_count !== undefined && <span>Unique values: {diag.unique_value_count}</span>}
                      </div>
                      {!!diag.most_common_values?.length && (
                        <small>Most common: {diag.most_common_values.map((item) => `${item.value} (${item.count})`).join(', ')}</small>
                      )}
                      {role === 'mask' && !!diag.mask_encoding && (
                        <div className="layer-mask-decoding">
                          <small>Encoding: {diag.mask_encoding}</small>
                          {!!diag.wrs_low_byte_value_counts?.length && <small>WRS low-byte values: {diag.wrs_low_byte_value_counts.map((item) => `${item.value} (${item.count})`).join(', ')}</small>}
                          <small>Base WRS land/subswath valid: {diag.base_wrs_land_valid_subswath_pixels ?? '—'}</small>
                          <small>Reference input exceptions: {diag.reference_input_exception_nonzero_pixels ?? '—'}</small>
                          <small>Secondary input exceptions: {diag.secondary_input_exception_nonzero_pixels ?? '—'}</small>
                          <small>Ionosphere filter/interpolation flag: {diag.ionosphere_filter_flag_pixels ?? '—'}</small>
                          <small>Ambiguous WRS values (≥ 2²⁴): {diag.packed_wrs_decode_ambiguous_pixels ?? '—'}</small>
                          <small>WRS decode reliable: {diag.wrs_decode_reliable_pixels ?? '—'}</small>
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              </details>
            )}
            <small className="aoi-window-meta">Full TIFF downloaded: no · Persistent raster storage: no · Original HDF5 reader invoked: {qualityAnalysis.original_scientific_engine?.hdf5_read_gunw_invoked ? 'yes' : 'no'}</small>
          </div>
        )}
        <div className="gate-funnel source-mask-verification-panel">
          <strong>Verify original NISAR source mask</strong>
          <p className="catalog-notice">Compare the native integer mask inside the original HDF5 product against the matching Harmony COG pixels using authenticated remote range reads. The full HDF5 file is not intentionally downloaded or saved. This does not relax any quality gate.</p>
          <label className="aoi-job-label">
            <span>Successful GUNW quality mask job for this product</span>
            <select
              value={sourceMaskJobOptions.some((job) => job.job_id === sourceMaskJobId) ? sourceMaskJobId : ''}
              onChange={(event) => onSourceMaskJobIdChange(event.target.value)}
            >
              <option value="">{sourceMaskJobOptions.length ? 'Select a GUNW quality mask job…' : 'Submit a mask job for this selected product first'}</option>
              {sourceMaskJobOptions.map((job) => {
                const isSuccessful = successfulStatuses.includes(job.status.toLowerCase());
                return (
                  <option key={job.job_id} value={job.job_id} disabled={!isSuccessful}>
                    {isSuccessful ? 'Successful' : job.status} · {job.job_id} · {new Date(job.submitted_at).toLocaleString()}
                  </option>
                );
              })}
            </select>
          </label>
          <p className="action-hint">Only the GUNW quality mask job is accepted here. Do not use an unwrapped-phase, coherence, or connected-components Job ID. Those layers have their own roles in the multi-layer quality analysis.</p>
          <button type="button" className="investigate-button quality-action-button" disabled={!areaClosed || coordinates.length < 3 || !granuleName.trim() || !sourceMaskJobIsValid || sourceMaskVerificationLoading} onClick={onVerifySourceMask}>
            {sourceMaskVerificationLoading ? 'Reading source mask window…' : 'Verify native source mask'}
          </button>
          {sourceMaskVerificationError && <p className="catalog-error" role="alert">{sourceMaskVerificationError}</p>}
          {sourceMaskVerification && (
            <div className="aoi-window-result" role="status">
              <strong>{sourceMaskVerification.comparison_performed ? (sourceMaskVerification.mask_values_match ? 'Native source and COG values match' : 'Native source-to-COG comparison completed') : 'Source-mask comparison inconclusive'}</strong>
              <div className="catalog-stats">
                <div><span>Source HDF5 opened</span><strong>{sourceMaskVerification.native_source_file_opened ? 'Yes' : 'No'}</strong></div>
                <div><span>Native dtype</span><strong>{sourceMaskVerification.native_mask_dtype || '—'}</strong></div>
                <div><span>COG dtype</span><strong>{sourceMaskVerification.cog_dtype || '—'}</strong></div>
                <div><span>Comparable pixels</span><strong>{sourceMaskVerification.comparison?.comparable_pixels ?? '—'}</strong></div>
                <div><span>Exact matches</span><strong>{sourceMaskVerification.comparison?.exact_matches ?? '—'}</strong></div>
                <div><span>Mismatches</span><strong>{sourceMaskVerification.comparison?.mismatches ?? '—'}</strong></div>
                <div><span>float32-rounding-compatible mismatches</span><strong>{sourceMaskVerification.comparison?.mismatches_compatible_with_float32_rounding ?? '—'}</strong></div>
              </div>
              {sourceMaskVerification.native_mask_dataset_path && <small>Native dataset: {sourceMaskVerification.native_mask_dataset_path}</small>}
              {sourceMaskVerification.source_mask_bit_counts && (
                <div className="layer-mask-decoding">
                  <strong>Native source mask bit/byte counts (comparable AOI pixels)</strong>
                  <small>Samples counted: {sourceMaskVerification.source_mask_bit_counts.samples ?? '—'}</small>
                  <small>Bit 24 set: {sourceMaskVerification.source_mask_bit_counts.bit_24_set_pixels ?? '—'} · Bit 24 clear: {sourceMaskVerification.source_mask_bit_counts.bit_24_clear_pixels ?? '—'}</small>
                  <small>Reference-exception byte nonzero: {sourceMaskVerification.source_mask_bit_counts.reference_exception_byte_nonzero_pixels ?? '—'} · Secondary-exception byte nonzero: {sourceMaskVerification.source_mask_bit_counts.secondary_exception_byte_nonzero_pixels ?? '—'}</small>
                  <small>Bits 25–31 nonzero: {sourceMaskVerification.source_mask_bit_counts.bits_25_to_31_nonzero_pixels ?? '—'}</small>
                  {!!sourceMaskVerification.source_mask_bit_counts.low_byte_values?.length && <small>Native low-byte counts: {sourceMaskVerification.source_mask_bit_counts.low_byte_values.map((item) => `${item.value} (${item.count})`).join(', ')}</small>}
                  {!!sourceMaskVerification.source_mask_bit_counts.full_values?.length && <small>Native full mask values: {sourceMaskVerification.source_mask_bit_counts.full_values.map((item) => `${item.value} (${item.count})`).join(', ')}</small>}
                </div>
              )}
              {sourceMaskVerification.source_processing_metadata && Object.keys(sourceMaskVerification.source_processing_metadata).length > 0 && (
                <div className="layer-mask-decoding">
                  <strong>Native product processing metadata values</strong>
                  {Object.entries(sourceMaskVerification.source_processing_metadata).map(([name, item]) => (
                    <small key={name}>{name}: {JSON.stringify(item.value)} · {item.path || 'source metadata path unavailable'}</small>
                  ))}
                </div>
              )}
              {sourceMaskVerification.native_valid_data_mask_diagnostics && (
                <div className="layer-mask-decoding">
                  <strong>Independent polarization-specific validDataMask</strong>
                  <small>Status: {sourceMaskVerification.native_valid_data_mask_diagnostics.status || 'not reported'}</small>
                  {sourceMaskVerification.native_valid_data_mask_diagnostics.dataset_path && <small>Dataset: {sourceMaskVerification.native_valid_data_mask_diagnostics.dataset_path}</small>}
                  {sourceMaskVerification.native_valid_data_mask_diagnostics.encoding && <small>Encoding: {sourceMaskVerification.native_valid_data_mask_diagnostics.encoding}</small>}
                  {sourceMaskVerification.native_valid_data_mask_diagnostics.samples_checked != null && <small>AOI samples checked: {sourceMaskVerification.native_valid_data_mask_diagnostics.samples_checked} · well formed: {sourceMaskVerification.native_valid_data_mask_diagnostics.well_formed_samples ?? '—'} · unknown/reserved-bit samples: {sourceMaskVerification.native_valid_data_mask_diagnostics.reserved_bit_or_unknown_samples ?? '—'}</small>}
                  {sourceMaskVerification.native_valid_data_mask_diagnostics.reference_valid_pixels != null && <small>Reference valid: {sourceMaskVerification.native_valid_data_mask_diagnostics.reference_valid_pixels} · secondary valid: {sourceMaskVerification.native_valid_data_mask_diagnostics.secondary_valid_pixels} · both valid: {sourceMaskVerification.native_valid_data_mask_diagnostics.both_reference_and_secondary_valid_pixels} · neither valid: {sourceMaskVerification.native_valid_data_mask_diagnostics.neither_reference_nor_secondary_valid_pixels}</small>}
                  {sourceMaskVerification.native_valid_data_mask_diagnostics.wrs_reference_zero_but_validmask_reference_valid_pixels != null && <small>WRS reference digit = 0 but validDataMask says reference valid: {sourceMaskVerification.native_valid_data_mask_diagnostics.wrs_reference_zero_but_validmask_reference_valid_pixels}</small>}
                  {sourceMaskVerification.native_valid_data_mask_diagnostics.wrs_secondary_zero_but_validmask_secondary_valid_pixels != null && <small>WRS secondary digit = 0 but validDataMask says secondary valid: {sourceMaskVerification.native_valid_data_mask_diagnostics.wrs_secondary_zero_but_validmask_secondary_valid_pixels}</small>}
                  {sourceMaskVerification.native_valid_data_mask_diagnostics.message && <small>{sourceMaskVerification.native_valid_data_mask_diagnostics.message}</small>}
                </div>
              )}
              {sourceMaskVerification.native_mask_metadata && (
                <details className="aoi-layer-details">
                  <summary>Native mask HDF5 attributes</summary>
                  <small>Attribute names: {(sourceMaskVerification.native_mask_metadata.attribute_names || []).join(', ') || 'none exposed'}</small>
                  <pre className="source-mask-json">{JSON.stringify(sourceMaskVerification.native_mask_metadata.selected_attributes || {}, null, 2)}</pre>
                  {sourceMaskVerification.native_mask_parent_metadata && <><small>Parent group: {sourceMaskVerification.native_mask_parent_group || '—'}</small><pre className="source-mask-json">{JSON.stringify(sourceMaskVerification.native_mask_parent_metadata.selected_attributes || {}, null, 2)}</pre></>}
                </details>
              )}
              {!!sourceMaskVerification.related_mask_qa_objects?.length && (
                <details className="aoi-layer-details">
                  <summary>Related source QA/mask metadata ({sourceMaskVerification.related_mask_qa_objects.length})</summary>
                  {sourceMaskVerification.related_mask_qa_objects.map((item) => (
                    <div className="layer-diagnostic-card" key={item.path}>
                      <small><strong>{item.object_type}</strong> · {item.path}</small>
                      {item.dtype && <small>dtype {item.dtype} · shape {(item.shape || []).join(' × ')}</small>}
                      {item.dataset_value !== undefined && <small>Dataset value: {JSON.stringify(item.dataset_value)}</small>}
                      {!!item.metadata?.attribute_names?.length && <small>Attributes: {item.metadata.attribute_names.join(', ')}</small>}
                      {!!Object.keys(item.metadata?.selected_attributes || {}).length && <pre className="source-mask-json">{JSON.stringify(item.metadata?.selected_attributes, null, 2)}</pre>}
                    </div>
                  ))}
                </details>
              )}
              {sourceMaskVerification.comparison?.mismatch_pairs_top10?.length ? (
                <small>Most common source → COG pairs: {sourceMaskVerification.comparison.mismatch_pairs_top10.map((item) => `${item.source_value} → ${item.cog_value} (${item.count})`).join(', ')}</small>
              ) : null}
              <p className="catalog-warning">{sourceMaskVerification.interpretation || sourceMaskVerification.message || 'Comparison did not provide an interpretation.'}</p>
              {sourceMaskVerification.next_step && <p className="catalog-notice">{sourceMaskVerification.next_step}</p>}
              <small className="aoi-window-meta">Full HDF5 downloaded: {sourceMaskVerification.full_source_hdf5_downloaded ? 'yes' : 'no'} · Source AOI read remotely: {sourceMaskVerification.aoi_source_window_read_remotely ? 'yes' : 'no'} · Persistent storage: {sourceMaskVerification.persistent_storage_used ? 'used' : 'not used'} · Quality gate changed: {sourceMaskVerification.quality_gate_changed ? 'yes' : 'no'}</small>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const SUBMITTED_HARMONY_JOBS_STORAGE_KEY = 'sarguardian.submittedHarmonyLayerJobs.v1';

function loadSubmittedHarmonyJobs(): SubmittedHarmonyLayerJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(SUBMITTED_HARMONY_JOBS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SubmittedHarmonyLayerJob => Boolean(
      item && typeof item === 'object'
      && typeof (item as SubmittedHarmonyLayerJob).job_id === 'string'
      && typeof (item as SubmittedHarmonyLayerJob).granule_name === 'string'
      && typeof (item as SubmittedHarmonyLayerJob).layer_role === 'string'
      && typeof (item as SubmittedHarmonyLayerJob).status === 'string'
    )).slice(0, 40);
  } catch {
    return [];
  }
}

export function LandslidePage({ user, onHome, onSignOut }: { user: User; onHome: () => void; onSignOut: () => void }) {
  const [searchText, setSearchText] = useState('');
  const [location, setLocation] = useState<LocationSelection | null>(null);
  const [searchState, setSearchState] = useState('');
  const [coordinates, setCoordinates] = useState<Coordinate[]>([]);
  const [areaClosed, setAreaClosed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [result, setResult] = useState<InvestigationResult | null>(null);
  const [error, setError] = useState('');
  const [layerOpen, setLayerOpen] = useState(false);
  const [layerMode, setLayerMode] = useState<'satellite' | 'hybrid' | 'terrain'>('terrain');
  const [profileImageFailed, setProfileImageFailed] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [productType, setProductType] = useState<NisarProductType>('GUNW');
  const [catalogResult, setCatalogResult] = useState<CatalogResponse | null>(null);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [validationAlertDismissed, setValidationAlertDismissed] = useState(false);
  const [toastRevision, setToastRevision] = useState(0);
  const [selectedHarmonyProduct, setSelectedHarmonyProduct] = useState<CatalogProduct | null>(null);
  const [harmonyLayerRole, setHarmonyLayerRole] = useState<HarmonyLayerRole>('unwrapped_phase');
  const [harmonyWorkflowMaturity, setHarmonyWorkflowMaturity] = useState<'PROVISIONAL' | 'BETA'>('PROVISIONAL');
  const [harmonyWorkflowPolarization, setHarmonyWorkflowPolarization] = useState<'HH' | 'VV'>('HH');
  const [confirmFullGranuleLayer, setConfirmFullGranuleLayer] = useState(false);
  const [isSubmittingHarmonyJob, setIsSubmittingHarmonyJob] = useState(false);
  const [harmonySubmitError, setHarmonySubmitError] = useState('');
  const [harmonySubmitMessage, setHarmonySubmitMessage] = useState('');
  const [submittedHarmonyJobs, setSubmittedHarmonyJobs] = useState<SubmittedHarmonyLayerJob[]>(loadSubmittedHarmonyJobs);
  const [isCheckingSubmittedJobs, setIsCheckingSubmittedJobs] = useState(false);
  const [harmonyJobId, setHarmonyJobId] = useState('');
  const [aoiWindowResult, setAoiWindowResult] = useState<AoiWindowResponse | null>(null);
  const [isAoiWindowLoading, setIsAoiWindowLoading] = useState(false);
  const [aoiWindowError, setAoiWindowError] = useState('');
  const [qualityGranuleName, setQualityGranuleName] = useState('');
  const [qualityBundle, setQualityBundle] = useState<HarmonyQualityLayerBundle | null>(null);
  const [qualityStatuses, setQualityStatuses] = useState<Record<string, string>>({});
  const [qualityMessage, setQualityMessage] = useState('');
  const [qualityError, setQualityError] = useState('');
  const [isQualityStarting, setIsQualityStarting] = useState(false);
  const [isQualityChecking, setIsQualityChecking] = useState(false);
  const [isQualityAnalyzing, setIsQualityAnalyzing] = useState(false);
  const [qualityAnalysis, setQualityAnalysis] = useState<GunwQualityAnalysisResponse | null>(null);
  const [sourceMaskJobId, setSourceMaskJobId] = useState('');
  const [isSourceMaskVerifying, setIsSourceMaskVerifying] = useState(false);
  const [sourceMaskVerificationError, setSourceMaskVerificationError] = useState('');
  const [sourceMaskVerification, setSourceMaskVerification] = useState<NativeSourceMaskVerificationResponse | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const workflowGranuleName = selectedHarmonyProduct?.granule_name || qualityGranuleName.trim();
  const individualLayerJobs: Record<string, HarmonyQualityLayerJob> = {};
  for (const job of submittedHarmonyJobs) {
    if (job.granule_name !== workflowGranuleName || job.maturity !== harmonyWorkflowMaturity || job.polarization !== harmonyWorkflowPolarization) continue;
    if (['failed', 'error', 'canceled', 'cancelled'].includes(job.status.toLowerCase())) continue;
    if (!individualLayerJobs[job.layer_role]) {
      individualLayerJobs[job.layer_role] = {
        job_id: job.job_id,
        status: job.status,
        variable: job.variable,
        job_status_url: `https://harmony.earthdata.nasa.gov/jobs/${job.job_id}`,
        reused_existing_job: false,
      };
    }
  }
  const individualLayersAvailable = Object.keys(individualLayerJobs).length > 0;
  const sourceMaskJobOptions = submittedHarmonyJobs.filter((job) =>
    job.layer_role === 'mask'
    && job.granule_name === qualityGranuleName.trim()
    && job.maturity === harmonyWorkflowMaturity
    && job.polarization === harmonyWorkflowPolarization
    && !['failed', 'error', 'canceled', 'cancelled'].includes(job.status.toLowerCase())
  );

  useEffect(() => {
    try {
      window.sessionStorage.setItem(SUBMITTED_HARMONY_JOBS_STORAGE_KEY, JSON.stringify(submittedHarmonyJobs.slice(0, 40)));
    } catch {
      // Session storage can be disabled in some privacy modes; in-memory job IDs still work.
    }
  }, [submittedHarmonyJobs]);

  useEffect(() => {
    setProfileImageFailed(false);
  }, [user.photoURL]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (!target.closest('.layers-menu') && !target.closest('[aria-label="Layers"]')) {
        setLayerOpen(false);
      }
      if (!target.closest('.profile-inline')) {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentPointerDown);
    return () => document.removeEventListener('mousedown', handleDocumentPointerDown);
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const timestamp: TimestampSelection = { mode: 'window', start: windowStart, end: windowEnd };
  const polygon: InvestigationPolyline = { type: 'LineString', coordinates: areaClosed && coordinates.length > 2 ? [...coordinates, coordinates[0]] : coordinates, crs: 'EPSG:4326' };
  const polygonAreaKm2 = coordinates.length > 2 ? calculateGeodesicAreaKm2(coordinates) : 0;
  // The AOI polygon itself is sufficient for catalogue search. Place search is optional;
  // if no named place was selected, the reference demo can use the polygon centre.
  const ready = Boolean(areaClosed && coordinates.length >= 3 && windowStart && windowEnd && windowEnd >= windowStart && windowEnd <= today);
  const catalogValidation = validateCatalogPreflight({
    coordinates,
    areaClosed,
    startDate: windowStart,
    endDate: windowEnd,
    today,
  });
  const catalogEligible = catalogValidation.valid;
  const actionableValidationError = catalogValidation.valid
    ? ''
    : catalogValidation.errors.find((message) => !message.startsWith('Close a valid AOI') && !message.startsWith('Choose both a start date')) || '';
  const validationPopupError = !validationAlertDismissed ? actionableValidationError : '';
  const visibleError = catalogError || error || validationPopupError;

  useEffect(() => {
    if (!visibleError) return undefined;
    const displayedError = visibleError;
    return scheduleErrorToastDismissal(displayedError, (expiredError) => {
      setCatalogError((current) => current === expiredError ? '' : current);
      setError((current) => current === expiredError ? '' : current);
      setValidationAlertDismissed(true);
    });
  }, [visibleError, toastRevision]);

  const handleMapReady = useCallback((map: google.maps.Map) => { mapRef.current = map; }, []);

  const updateLocation = (next: LocationSelection) => {
    setLocation(next);
    setSearchText(next.name);
    setSearchState('Location selected.');
    setResult(null);
    setCatalogResult(null);
    setCatalogError('');
    setAoiWindowResult(null);
    setAoiWindowError('');
    setError('');
    setValidationAlertDismissed(false);
  };

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const query = searchText.trim();
    if (!query) return;

    const numeric = query.split(/[ ,]+/).map(Number);
    if (numeric.length === 2 && numeric.every(Number.isFinite) && Math.abs(numeric[0]) <= 90 && Math.abs(numeric[1]) <= 180) {
      updateLocation({ searchText: query, name: `${numeric[0].toFixed(4)}, ${numeric[1].toFixed(4)}`, latitude: numeric[0], longitude: numeric[1] });
      return;
    }

    setSearchState('Searching...');
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`);
      const matches = await response.json() as Array<{ display_name: string; lat: string; lon: string }>;
      if (!matches.length) throw new Error('no matches');
      const match = matches[0];
      updateLocation({
        searchText: query,
        name: match.display_name.split(',').slice(0, 2).join(','),
        latitude: Number(match.lat),
        longitude: Number(match.lon),
      });
    } catch {
      setSearchState('No location found.');
    }
  };

  const handleWindowStartChange = (value: string) => {
    setWindowStart(value);
    if (windowEnd && value > windowEnd) setWindowEnd('');
    setResult(null);
    setCatalogResult(null);
    setCatalogError('');
    setAoiWindowResult(null);
    setAoiWindowError('');
    setQualityAnalysis(null);
    setQualityError('');
    setQualityMessage('');
    setValidationAlertDismissed(false);
  };

  const handleWindowEndChange = (value: string) => {
    setWindowEnd(value);
    setResult(null);
    setCatalogResult(null);
    setCatalogError('');
    setAoiWindowResult(null);
    setAoiWindowError('');
    setQualityAnalysis(null);
    setQualityError('');
    setQualityMessage('');
    if (windowStart && value < windowStart) {
      setError('Ending date cannot be before starting date.');
      setToastRevision((current) => current + 1);
    } else if (value > today) {
      setError('Ending date cannot be after today.');
      setToastRevision((current) => current + 1);
    } else setError('');
    setValidationAlertDismissed(false);
  };

  const handleCoordinates = (next: Coordinate[], closed: boolean) => {
    setCoordinates(next);
    setAreaClosed(closed);
    setSelectedVertexIndex(closed ? 0 : next.length ? next.length - 1 : null);
    setResult(null);
    setCatalogResult(null);
    setCatalogError('');
    setAoiWindowResult(null);
    setAoiWindowError('');
    setQualityAnalysis(null);
    setQualityError('');
    setQualityMessage('');
    setError('');
    setValidationAlertDismissed(false);
  };

  const beginGeometry = () => {
    setDrawing(true);
    setCoordinates([]);
    setAreaClosed(false);
    setSelectedVertexIndex(null);
    setResult(null);
    setCatalogResult(null);
    setCatalogError('');
    setAoiWindowResult(null);
    setAoiWindowError('');
    setQualityAnalysis(null);
    setQualityError('');
    setQualityMessage('');
    setError('');
    setValidationAlertDismissed(false);
  };

  const undo = () => {
    setCoordinates((current) => {
      const next = current.slice(0, -1);
      setSelectedVertexIndex(next.length ? next.length - 1 : null);
      return next;
    });
    setAreaClosed(false);
    setResult(null);
    setCatalogResult(null);
    setAoiWindowResult(null);
    setAoiWindowError('');
    setQualityAnalysis(null);
    setQualityError('');
    setQualityMessage('');
    setValidationAlertDismissed(false);
  };

  const clearGeometry = () => {
    setCoordinates([]);
    setAreaClosed(false);
    setDrawing(false);
    setSelectedVertexIndex(null);
    setResult(null);
    setCatalogResult(null);
    setAoiWindowResult(null);
    setAoiWindowError('');
    setError('');
    setValidationAlertDismissed(false);
  };

  const completeGeometry = () => {
    const valid = validatePolyline({ type: 'LineString', coordinates: coordinates.length >= 3 ? [...coordinates, coordinates[0]] : coordinates, crs: 'EPSG:4326' }).valid;
    if (!valid) {
      setError('Select at least three valid vertices to close the AOI.');
      setToastRevision((current) => current + 1);
      return;
    }
    setDrawing(false);
    setAreaClosed(true);
    setSelectedVertexIndex(0);
    setError('');
    setValidationAlertDismissed(false);
  };

  const runCatalogPreflight = async () => {
    if (!catalogValidation.valid) {
      setValidationAlertDismissed(false);
      setToastRevision((current) => current + 1);
      setCatalogError(catalogValidation.errors.join(' '));
      return;
    }

    setCatalogError('');
    setSelectedHarmonyProduct(null);
    setConfirmFullGranuleLayer(false);
    setHarmonySubmitError('');
    setHarmonySubmitMessage('');
    setResult(null);
    setAoiWindowResult(null);
    setAoiWindowError('');
    setIsCatalogLoading(true);
    setCatalogResult(null);
    try {
      const response = await searchNisarCatalog({
        coordinates: [...coordinates, coordinates[0]],
        startDate: windowStart,
        endDate: windowEnd,
        productType,
      }, user);
      setCatalogResult(response);
    } catch (error) {
      setToastRevision((current) => current + 1);
      setCatalogError(error instanceof Error ? error.message : 'Could not check the NISAR catalogue.');
    } finally {
      setIsCatalogLoading(false);
    }
  };

  const selectHarmonyProduct = (product: CatalogProduct) => {
    setSelectedHarmonyProduct(product);
    setQualityGranuleName(product.granule_name);
    setConfirmFullGranuleLayer(false);
    setHarmonySubmitError('');
    setHarmonySubmitMessage('Product selected. Choose a layer and submit it when ready.');
    setHarmonyJobId('');
    setAoiWindowResult(null);
    setAoiWindowError('');
    setQualityBundle(null);
    setQualityStatuses({});
    setQualityAnalysis(null);
    setQualityError('');
    setQualityMessage('');
    setSourceMaskJobId('');
    setSourceMaskVerification(null);
    setSourceMaskVerificationError('');
  };

  const submitSelectedHarmonyLayer = async () => {
    if (!selectedHarmonyProduct) {
      setHarmonySubmitError('Select a GUNW product from the catalogue first.');
      return;
    }
    if (!areaClosed || coordinates.length < 3) {
      setHarmonySubmitError('Close the AOI polygon before submitting a job.');
      return;
    }
    if (!confirmFullGranuleLayer) {
      setHarmonySubmitError('Confirm the full-granule layer warning before submitting.');
      return;
    }
    const existingJob = submittedHarmonyJobs.find((job) => job.granule_name === selectedHarmonyProduct.granule_name
      && job.layer_role === harmonyLayerRole && job.maturity === harmonyWorkflowMaturity
      && job.polarization === harmonyWorkflowPolarization
      && !['failed', 'error', 'canceled', 'cancelled'].includes(job.status.toLowerCase()));
    if (existingJob) {
      setHarmonySubmitError(`A matching ${harmonyLayerRole.replace(/_/g, ' ')} job already exists (${existingJob.job_id}). Refresh or reuse that job rather than submitting a duplicate.`);
      setHarmonySubmitMessage('No duplicate job was submitted.');
      return;
    }
    setIsSubmittingHarmonyJob(true);
    setHarmonySubmitError('');
    setHarmonySubmitMessage('Checking live NASA Harmony capabilities and submitting one layer…');
    try {
      const response = await startNisarHarmonyLayerJob({
        granuleName: selectedHarmonyProduct.granule_name,
        layerRole: harmonyLayerRole,
        coordinates: [...coordinates, coordinates[0]],
        maturity: harmonyWorkflowMaturity,
        polarization: harmonyWorkflowPolarization,
      });
      const record: SubmittedHarmonyLayerJob = {
        job_id: response.job_id,
        granule_name: response.granule_name,
        layer_role: response.layer_role,
        polarization: harmonyWorkflowPolarization,
        maturity: harmonyWorkflowMaturity,
        variable: response.variable,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
      };
      setSubmittedHarmonyJobs((current) => [record, ...current.filter((job) => job.job_id !== record.job_id)].slice(0, 40));
      setQualityGranuleName(response.granule_name);
      if (response.layer_role === 'unwrapped_phase') {
        setHarmonyJobId(response.job_id);
        setAoiWindowResult(null);
        setAoiWindowError('');
        setQualityBundle(null);
        setQualityStatuses({});
        setQualityAnalysis(null);
        setQualityError('');
        setQualityMessage('Phase job submitted. Refresh its status and wait for successful completion before reading the AOI or submitting companion jobs.');
        setSourceMaskJobId('');
        setSourceMaskVerification(null);
        setSourceMaskVerificationError('');
      } else if (response.layer_role === 'mask') {
        setSourceMaskJobId(response.job_id);
        setSourceMaskVerification(null);
        setSourceMaskVerificationError('');
      }
      setHarmonySubmitMessage(`Job ID received for ${response.layer_role.replace(/_/g, ' ')}. Check its status below; no raster was downloaded by SARGuardian.`);
    } catch (error) {
      setHarmonySubmitError(error instanceof Error ? error.message : 'Could not submit the selected layer to NASA Harmony.');
      setHarmonySubmitMessage('');
    } finally {
      setIsSubmittingHarmonyJob(false);
    }
  };

  const checkSubmittedHarmonyJob = async (jobId: string) => {
    setIsCheckingSubmittedJobs(true);
    try {
      const response = await getNisarHarmonyJobStatus(jobId);
      const status = String(response.job?.status || 'unknown').toLowerCase();
      setSubmittedHarmonyJobs((current) => current.map((job) => job.job_id === jobId
        ? { ...job, status, status_error: undefined }
        : job));
      setHarmonySubmitMessage(`Harmony job ${jobId}: ${status}${response.job?.progress != null ? ` · ${response.job.progress}%` : ''}.`);
      setHarmonySubmitError('');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not check this Harmony job.';
      setSubmittedHarmonyJobs((current) => current.map((job) => job.job_id === jobId ? { ...job, status_error: detail } : job));
      setHarmonySubmitError(detail);
    } finally {
      setIsCheckingSubmittedJobs(false);
    }
  };

  const checkSelectedProductHarmonyJobs = async () => {
    if (!selectedHarmonyProduct) return;
    const matchingJobs = submittedHarmonyJobs.filter((job) => job.granule_name === selectedHarmonyProduct.granule_name
      && job.maturity === harmonyWorkflowMaturity && job.polarization === harmonyWorkflowPolarization);
    if (!matchingJobs.length) {
      setHarmonySubmitMessage('No submitted jobs match this product, maturity, and polarization yet.');
      return;
    }
    setIsCheckingSubmittedJobs(true);
    setHarmonySubmitError('');
    setHarmonySubmitMessage(`Checking ${matchingJobs.length} selected-product job(s)…`);
    try {
      const results = await Promise.all(matchingJobs.map(async (job) => {
        try {
          const response = await getNisarHarmonyJobStatus(job.job_id);
          return { jobId: job.job_id, status: String(response.job?.status || 'unknown').toLowerCase(), error: undefined as string | undefined };
        } catch (error) {
          return { jobId: job.job_id, status: job.status, error: error instanceof Error ? error.message : 'Status check failed.' };
        }
      }));
      const byId = new Map(results.map((item) => [item.jobId, item]));
      setSubmittedHarmonyJobs((current) => current.map((job) => {
        const result = byId.get(job.job_id);
        return result ? { ...job, status: result.status, status_error: result.error } : job;
      }));
      const complete = results.filter((item) => ['successful', 'completed', 'complete'].includes(item.status)).length;
      setHarmonySubmitMessage(`Status refresh finished: ${complete} of ${results.length} jobs complete. Wait for every required layer to succeed before quality analysis.`);
    } finally {
      setIsCheckingSubmittedJobs(false);
    }
  };

  const useSubmittedJobAsPhase = (job: SubmittedHarmonyLayerJob) => {
    const matchingProduct = catalogResult?.products.find((product) => product.granule_name === job.granule_name);
    setSelectedHarmonyProduct(matchingProduct || { granule_name: job.granule_name, product_type: 'GUNW', observation_dates: [] });
    setConfirmFullGranuleLayer(false);
    setQualityGranuleName(job.granule_name);
    setHarmonyJobId(job.job_id);
    setHarmonyWorkflowMaturity(job.maturity);
    setHarmonyWorkflowPolarization(job.polarization);
    setQualityBundle(null);
    setQualityStatuses({});
    setQualityAnalysis(null);
    setQualityError('');
    setSourceMaskJobId('');
    setSourceMaskVerification(null);
    setHarmonySubmitMessage('This phase Job ID and its product settings are now selected for the AOI and quality workflow. Check status before continuing.');
  };

  const useSubmittedJobAsMask = (job: SubmittedHarmonyLayerJob) => {
    const matchingProduct = catalogResult?.products.find((product) => product.granule_name === job.granule_name);
    setSelectedHarmonyProduct(matchingProduct || { granule_name: job.granule_name, product_type: 'GUNW', observation_dates: [] });
    setConfirmFullGranuleLayer(false);
    setQualityGranuleName(job.granule_name);
    setSourceMaskJobId(job.job_id);
    setHarmonyWorkflowMaturity(job.maturity);
    setHarmonyWorkflowPolarization(job.polarization);
    setSourceMaskVerification(null);
    setSourceMaskVerificationError('');
    setQualityBundle(null);
    setQualityStatuses({});
    setQualityAnalysis(null);
    setHarmonySubmitMessage('This mask Job ID and its product settings are selected for native-source verification. Check status before verifying.');
  };

  const runAoiWindowRead = async () => {
    if (!areaClosed || coordinates.length < 3) {
      setAoiWindowError('Close the polygon before reading its raster window.');
      return;
    }
    setAoiWindowError('');
    setAoiWindowResult(null);
    setIsAoiWindowLoading(true);
    try {
      const response = await inspectNisarAoiWindow({
        jobId: harmonyJobId,
        coordinates: [...coordinates, coordinates[0]],
      });
      setAoiWindowResult(response);
    } catch (error) {
      setAoiWindowError(error instanceof Error ? error.message : 'Could not read the selected AOI window.');
    } finally {
      setIsAoiWindowLoading(false);
    }
  };

  const startQualityLayers = async () => {
    if (!areaClosed || coordinates.length < 3) {
      setQualityError('Close the polygon before starting quality-layer jobs.');
      return;
    }
    if (!harmonyJobId.trim() || !qualityGranuleName.trim()) {
      setQualityError('Select a successful phase Job ID and the exact GUNW granule name used by that job.');
      return;
    }
    if (qualityBundle) {
      setQualityError('Companion jobs have already been submitted for this workflow. Refresh their statuses instead of submitting duplicates.');
      return;
    }
    const existingIndividualCompanion = submittedHarmonyJobs.find((job) => job.granule_name === qualityGranuleName.trim()
      && job.maturity === harmonyWorkflowMaturity && job.polarization === harmonyWorkflowPolarization
      && job.layer_role !== 'unwrapped_phase'
      && !['failed', 'error', 'canceled', 'cancelled'].includes(job.status.toLowerCase()));
    if (existingIndividualCompanion) {
      setQualityError(`A companion layer was already submitted individually (${existingIndividualCompanion.layer_role}, ${existingIndividualCompanion.job_id}). Continue the one-by-one workflow or reuse the existing jobs; batch submission was blocked to avoid duplicate jobs.`);
      return;
    }
    setQualityError('');
    setQualityMessage('Submitting companion layers to NASA Harmony…');
    setQualityAnalysis(null);
    setQualityBundle(null);
    setQualityStatuses({});
    setSourceMaskJobId('');
    setSourceMaskVerification(null);
    setSourceMaskVerificationError('');
    setIsQualityStarting(true);
    try {
      const response = await startGunwQualityLayers({
        granuleName: qualityGranuleName.trim(),
        phaseJobId: harmonyJobId.trim(),
        coordinates: [...coordinates, coordinates[0]],
        maturity: harmonyWorkflowMaturity,
        polarization: harmonyWorkflowPolarization,
      });
      const batchRecords: SubmittedHarmonyLayerJob[] = Object.entries(response.jobs).map(([role, job]) => ({
        job_id: job.job_id,
        granule_name: response.granule_name,
        layer_role: role as HarmonyLayerRole,
        polarization: response.polarization === 'VV' ? 'VV' : 'HH',
        maturity: response.maturity === 'BETA' ? 'BETA' : 'PROVISIONAL',
        variable: job.variable || '',
        status: job.status,
        submitted_at: new Date().toISOString(),
      }));
      setSubmittedHarmonyJobs((current) => [...batchRecords, ...current.filter((old) => !batchRecords.some((item) => item.job_id === old.job_id))].slice(0, 40));
      setQualityBundle(response);
      setSourceMaskJobId(response.jobs.mask?.job_id || '');
      setSourceMaskVerification(null);
      setSourceMaskVerificationError('');
      const initialStatuses = Object.fromEntries(Object.entries(response.jobs).map(([role, job]) => [role, job.status]));
      setQualityStatuses(initialStatuses);
      const errorCount = Object.keys(response.submission_errors || {}).length;
      setQualityMessage(errorCount
        ? `Some layers were not submitted (${errorCount}). Review each message before continuing; do not blindly repeat the request.`
        : 'Layer jobs submitted. Wait for them to finish, then check all job statuses.');
    } catch (error) {
      setQualityError(error instanceof Error ? error.message : 'Could not submit the companion quality layers.');
      setQualityMessage('');
    } finally {
      setIsQualityStarting(false);
    }
  };

  const checkQualityLayers = async () => {
    const jobsToCheck: Record<string, HarmonyQualityLayerJob> = qualityBundle?.jobs || individualLayerJobs;
    const entries = Object.entries(jobsToCheck);
    if (!entries.length) {
      setQualityError('No layer jobs match the currently selected granule, maturity, and polarization. Submit them first.');
      return;
    }
    setQualityError('');
    setQualityMessage('Checking NASA Harmony job statuses…');
    setIsQualityChecking(true);
    try {
      const statuses = await Promise.all(entries.map(async ([role, job]) => {
        try {
          const response = await getNisarHarmonyJobStatus(job.job_id);
          return { role, jobId: job.job_id, status: String(response.job?.status || 'unknown').toLowerCase(), error: undefined as string | undefined };
        } catch (error) {
          return { role, jobId: job.job_id, status: String(job.status || 'unknown').toLowerCase(), error: error instanceof Error ? error.message : 'Could not check this job.' };
        }
      }));
      const next = Object.fromEntries(statuses.map((item) => [item.role, item.status]));
      setQualityStatuses(next);
      const statusById = new Map(statuses.map((item) => [item.jobId, item]));
      setSubmittedHarmonyJobs((current) => current.map((job) => {
        const item = statusById.get(job.job_id);
        return item ? { ...job, status: item.status, status_error: item.error } : job;
      }));
      const required = ['unwrapped_phase', 'coherence', 'connected_components', 'ionosphere_phase_screen', 'mask'];
      const allRequiredPresent = required.every((role) => Boolean(jobsToCheck[role]?.job_id));
      const allRequiredSuccessful = allRequiredPresent && required.every((role) => ['successful', 'completed', 'complete'].includes(next[role] || ''));
      const pending = statuses.filter((item) => !['successful', 'completed', 'complete'].includes(item.status));
      setQualityMessage(allRequiredSuccessful
        ? 'All required layer jobs are complete. You can run the AOI quality diagnostics.'
        : `${pending.length} checked layer job(s) are not complete yet${allRequiredPresent ? '' : '; some required layers are still missing'}. Wait or submit the missing layers before analysis.`);
    } finally {
      setIsQualityChecking(false);
    }
  };

  const runQualityAnalysis = async () => {
    const jobsForAnalysis = qualityBundle?.jobs || individualLayerJobs;
    const required = ['unwrapped_phase', 'coherence', 'connected_components', 'ionosphere_phase_screen', 'mask'];
    const missing = required.filter((role) => !jobsForAnalysis[role]?.job_id);
    if (!areaClosed || coordinates.length < 3 || missing.length) {
      setQualityError(missing.length
        ? `Submit the following layer(s) for this exact granule/maturity/polarization first: ${missing.join(', ')}.`
        : 'Close the AOI polygon before quality analysis.');
      return;
    }
    const pending = required.filter((role) => !['successful', 'completed', 'complete'].includes(String(qualityStatuses[role] || jobsForAnalysis[role]?.status || '').toLowerCase()));
    if (pending.length) {
      setQualityError(`Wait for these layer job(s) to succeed before analysis: ${pending.join(', ')}. Refresh job status first.`);
      return;
    }
    setQualityError('');
    setQualityMessage('Reading aligned remote AOI windows and applying quality gates…');
    setIsQualityAnalyzing(true);
    try {
      const response = await analyzeGunwAoiQuality({
        granuleName: qualityGranuleName.trim(),
        polarization: harmonyWorkflowPolarization,
        coordinates: [...coordinates, coordinates[0]],
        jobs: jobsForAnalysis,
      });
      setQualityAnalysis(response);
      setQualityMessage('Quality diagnostics completed. Displacement was not calculated.');
    } catch (error) {
      setQualityError(error instanceof Error ? error.message : 'Could not analyze the multi-layer AOI.');
      setQualityMessage('');
    } finally {
      setIsQualityAnalyzing(false);
    }
  };

  const runSourceMaskVerification = async () => {
    if (!areaClosed || coordinates.length < 3) {
      setSourceMaskVerificationError('Close the AOI polygon before verifying the native source mask.');
      return;
    }
    if (!qualityGranuleName.trim() || !sourceMaskJobId.trim()) {
      setSourceMaskVerificationError('Select a successful GUNW quality mask job for the selected granule.');
      return;
    }
    const selectedMaskJob = submittedHarmonyJobs.find((job) => job.job_id === sourceMaskJobId);
    if (!selectedMaskJob || selectedMaskJob.layer_role !== 'mask') {
      setSourceMaskVerificationError('Wrong Job ID type: this check accepts only a GUNW quality mask job. A connected-components Job ID cannot be used here. Select the mask job from the list.');
      return;
    }
    if (selectedMaskJob.granule_name !== qualityGranuleName.trim()
      || selectedMaskJob.maturity !== harmonyWorkflowMaturity
      || selectedMaskJob.polarization !== harmonyWorkflowPolarization) {
      setSourceMaskVerificationError('The selected mask job does not match the current granule, maturity and polarization. Use the matching mask job card to select it.');
      return;
    }
    if (!['successful', 'completed', 'complete'].includes(selectedMaskJob.status.toLowerCase())) {
      setSourceMaskVerificationError('The mask job must be successful before source verification. Refresh its status first.');
      return;
    }
    setSourceMaskVerificationError('');
    setSourceMaskVerification(null);
    setIsSourceMaskVerifying(true);
    try {
      const response = await verifyGunwNativeSourceMask({
        granuleName: qualityGranuleName.trim(),
        maskJobId: sourceMaskJobId.trim(),
        coordinates: [...coordinates, coordinates[0]],
        maturity: qualityBundle?.maturity === 'BETA' ? 'BETA' : harmonyWorkflowMaturity,
        polarization: qualityBundle?.polarization === 'VV' ? 'VV' : harmonyWorkflowPolarization,
      });
      setSourceMaskVerification(response);
    } catch (error) {
      setSourceMaskVerificationError(error instanceof Error ? error.message : 'Could not verify the native GUNW source mask. No quality gate was changed.');
    } finally {
      setIsSourceMaskVerifying(false);
    }
  };

  const runInvestigation = () => {
    if (!areaClosed || coordinates.length < 3) {
      setError('Draw at least three vertices and press Close area before investigating.');
      setToastRevision((current) => current + 1);
      return;
    }

    // A polygon is a complete spatial selection by itself. Use its centre only as
    // contextual metadata when the user did not choose a named place in search.
    const analysisLocation: LocationSelection = location ?? {
      searchText: 'Selected area centre',
      name: 'Selected area centre',
      latitude: coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length,
      longitude: coordinates.reduce((sum, point) => sum + point[0], 0) / coordinates.length,
    };
    const request: AnalysisRequest = { location: analysisLocation, polyline: polygon, timestamp: timestampToRequest(timestamp) };
    const validation = validateAnalysisRequest(request);
    if (!validation.valid) {
      setError(validation.errors.join(' '));
      setToastRevision((current) => current + 1);
      return;
    }

    setError('');
    setCatalogResult(null);
    setCatalogError('');
    setIsProcessing(true);
    window.setTimeout(() => {
      setResult(investigate(request));
      setIsProcessing(false);
    }, 350);
  };

  return (
    <div className="landslide-page">
      <header className="map-header">
        <button className="map-brand" type="button" onClick={onHome}>
          <span className="brand-orbit" />
          <span>SAR</span><span>GUARDIAN</span>
        </button>
        <div className="map-title">
          <span>LANDSLIDE</span>
          <small>Investigation workspace</small>
        </div>
        <div className="map-header-actions">
          <button type="button" onClick={onHome}>Home</button>
          <div className="profile-inline" aria-label="Authenticated user profile" onClick={() => setProfileMenuOpen((current) => !current)}>
            {user.photoURL && !profileImageFailed ? <img src={user.photoURL} alt="" className="profile-avatar" onError={() => setProfileImageFailed(true)} /> : <span className="profile-avatar profile-fallback">{(user.displayName ?? user.email ?? 'U').charAt(0).toUpperCase()}</span>}
            <span>{user.displayName ?? user.email ?? 'Authenticated user'}</span>
            {profileMenuOpen && (
              <div className="profile-popover glass-float">
                <strong>{user.displayName ?? 'Authenticated user'}</strong>
                <span>{user.email ?? 'No email available'}</span>
                <div className="signout-actions">
                  <button type="button" className="cancel-button" onClick={(event) => { event.stopPropagation(); setProfileMenuOpen(false); }}>Close</button>
                  <button type="button" className="confirm-button" onClick={(event) => { event.stopPropagation(); onSignOut(); setProfileMenuOpen(false); }}>Sign out</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="map-main">
        <MapCanvas
          location={location}
          coordinates={coordinates}
          drawing={drawing}
          selectedVertexIndex={selectedVertexIndex}
          onLocation={updateLocation}
          onCoordinates={handleCoordinates}
          onSelectedVertex={setSelectedVertexIndex}
          onSearchText={setSearchText}
          onMapReady={handleMapReady}
        />

        <form className="map-search glass-float" onSubmit={handleSearch}>
          <Icon name="search" />
          <div id="landslide-place-search" className="google-place-autocomplete" aria-label="Search a place" />
          <button type="submit">Search</button>
          {location && <span className="selected-place">{location.name}</span>}
          <small>{searchState || 'Search a place to begin.'}</small>
        </form>

        <div className="map-tools glass-float" aria-label="Map controls">
          <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.setZoom((mapRef.current.getZoom() ?? 5) + 1)}><Icon name="plus" /></button>
          <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.setZoom(Math.max(MIN_MAP_ZOOM, (mapRef.current.getZoom() ?? DEFAULT_MAP_ZOOM) - 1))}><Icon name="minus" /></button>
          <button type="button" aria-label="Locate selected place" onClick={() => location && mapRef.current?.panTo({ lat: location.latitude, lng: location.longitude })}><Icon name="locate" /></button>
          <div className="layers-menu-wrap">
            <button type="button" aria-label="Layers" onClick={() => setLayerOpen((current) => !current)}><Icon name="layers" /></button>
            {layerOpen && (
              <div className="layers-menu glass-float" role="menu" aria-label="Map layers">
                {(['satellite', 'hybrid', 'terrain'] as const).map((mode) => (
                  <button key={mode} type="button" role="menuitemradio" aria-checked={layerMode === mode} className={layerMode === mode ? 'active' : ''} onClick={() => { setLayerMode(mode); mapRef.current?.setMapTypeId(mode); setLayerOpen(false); }}>
                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" aria-label="Fullscreen map" onClick={() => document.querySelector('.map-canvas-wrap')?.requestFullscreen()}><Icon name="fullscreen" /></button>
        </div>

        <section className="action-bar glass-float">
          {!result ? (
            <>
              {coordinates.length > 0 && (
                <div className="geometry-summary" aria-live="polite">
                  <span>Area selected</span>
                  <strong>{coordinates.length} vertices</strong>
                  <small>{polygonAreaKm2.toFixed(2)} km²</small>
                </div>
              )}

              <div className="draw-actions">
                <button type="button" className={!drawing && !areaClosed ? 'active' : ''} onClick={beginGeometry}><Icon name="area" />Draw area</button>
                {drawing && (
                  <>
                    <button type="button" disabled={!coordinates.length} onClick={undo}><Icon name="undo" />Undo</button>
                    <button type="button" disabled={!coordinates.length} onClick={clearGeometry}><Icon name="clear" />Clear</button>
                    {coordinates.length > 2 && !areaClosed && (
                      <button type="button" className="confirm-button" onClick={completeGeometry}>Close area</button>
                    )}
                  </>
                )}
                {!drawing && areaClosed && (
                  <>
                    <button type="button" onClick={() => setDrawing(true)}><Icon name="draw" />Edit</button>
                    <button type="button" onClick={clearGeometry}><Icon name="clear" />Clear</button>
                  </>
                )}
              </div>

              <div className="time-actions">
                <span>Time window</span>
                <div className="date-range">
                  <input type="date" value={windowStart} max={today} onChange={(event) => handleWindowStartChange(event.target.value)} aria-label="Starting date" />
                  <span>to</span>
                  <input type="date" value={windowEnd} min={windowStart || undefined} max={today} onChange={(event) => handleWindowEndChange(event.target.value)} aria-label="Ending date" />
                </div>
                <label className="dataset-selector">
                  <span>Data family</span>
                  <select value={productType} onChange={(event) => { setProductType(event.target.value as NisarProductType); setCatalogResult(null); setCatalogError(''); setSelectedHarmonyProduct(null); setConfirmFullGranuleLayer(false); setAoiWindowResult(null); setAoiWindowError(''); setQualityBundle(null); setQualityStatuses({}); setQualityAnalysis(null); setHarmonyJobId(''); setQualityGranuleName(''); setSourceMaskJobId(''); setSourceMaskVerification(null); }} aria-label="NISAR product family">
                    <option value="GUNW">GUNW · interferometry</option>
                    <option value="GOFF">GOFF · pixel offsets</option>
                  </select>
                </label>
              </div>

              <div className="action-buttons">
                <button className="investigate-button" type="button" aria-invalid={!catalogEligible} disabled={!canSubmitCatalogPreflight(catalogValidation, isCatalogLoading)} onClick={runCatalogPreflight}>{isCatalogLoading ? 'Checking ASF...' : 'Check NISAR archive'}</button>
                <button className="demo-button" type="button" disabled={!ready || isProcessing} onClick={runInvestigation}>{isProcessing ? 'Preparing demo...' : 'Reference demo'}</button>
              </div>
              {catalogResult && <CatalogPreflightPanel
                result={catalogResult}
                onClose={() => { setCatalogResult(null); setSelectedHarmonyProduct(null); }}
                onSelectProduct={selectHarmonyProduct}
                selectedGranuleName={selectedHarmonyProduct?.granule_name || ''}
              />}
              {catalogResult && (
                <HarmonyJobSubmissionPanel
                  product={selectedHarmonyProduct}
                  areaClosed={areaClosed}
                  coordinatesCount={coordinates.length}
                  layerRole={harmonyLayerRole}
                  onLayerRoleChange={(value) => { setHarmonyLayerRole(value); setConfirmFullGranuleLayer(false); setHarmonySubmitError(''); }}
                  maturity={harmonyWorkflowMaturity}
                  onMaturityChange={(value) => { setHarmonyWorkflowMaturity(value); setConfirmFullGranuleLayer(false); setHarmonyJobId(''); setAoiWindowResult(null); setAoiWindowError(''); setQualityBundle(null); setQualityStatuses({}); setQualityAnalysis(null); setQualityError(''); setQualityMessage(''); setSourceMaskJobId(''); setSourceMaskVerification(null); setSourceMaskVerificationError(''); }}
                  polarization={harmonyWorkflowPolarization}
                  onPolarizationChange={(value) => { setHarmonyWorkflowPolarization(value); setConfirmFullGranuleLayer(false); setHarmonyJobId(''); setAoiWindowResult(null); setAoiWindowError(''); setQualityBundle(null); setQualityStatuses({}); setQualityAnalysis(null); setQualityError(''); setQualityMessage(''); setSourceMaskJobId(''); setSourceMaskVerification(null); setSourceMaskVerificationError(''); }}
                  confirmFullGranule={confirmFullGranuleLayer}
                  onConfirmFullGranuleChange={setConfirmFullGranuleLayer}
                  isSubmitting={isSubmittingHarmonyJob}
                  error={harmonySubmitError}
                  message={harmonySubmitMessage}
                  jobs={submittedHarmonyJobs}
                  checkingJobs={isCheckingSubmittedJobs}
                  onSubmit={submitSelectedHarmonyLayer}
                  onCheckJob={checkSubmittedHarmonyJob}
                  onCheckMatchingJobs={checkSelectedProductHarmonyJobs}
                  onUseAsPhase={useSubmittedJobAsPhase}
                  onUseAsMask={useSubmittedJobAsMask}
                />
              )}
              {catalogResult && productType === 'GUNW' && (
                <AoiWindowPanel
                  coordinates={coordinates}
                  areaClosed={areaClosed}
                  jobId={harmonyJobId}
                  onJobIdChange={(value) => { setHarmonyJobId(value); setAoiWindowResult(null); setAoiWindowError(''); setQualityBundle(null); setQualityStatuses({}); setQualityAnalysis(null); setSourceMaskJobId(''); setSourceMaskVerification(null); setSourceMaskVerificationError(''); setQualityError(''); setQualityMessage(''); }}
                  isLoading={isAoiWindowLoading}
                  error={aoiWindowError}
                  result={aoiWindowResult}
                  onRun={runAoiWindowRead}
                  granuleName={qualityGranuleName}
                  onGranuleNameChange={(value) => { setQualityGranuleName(value); setQualityBundle(null); setQualityAnalysis(null); setSourceMaskJobId(''); setSourceMaskVerification(null); setSourceMaskVerificationError(''); setQualityError(''); setQualityMessage(''); }}
                  qualityBundle={qualityBundle}
                  qualityStatuses={qualityStatuses}
                  individualLayerJobs={individualLayerJobs}
                  individualLayersAvailable={individualLayersAvailable}
                  qualityMessage={qualityMessage}
                  qualityError={qualityError}
                  qualityStartLoading={isQualityStarting}
                  qualityCheckLoading={isQualityChecking}
                  qualityAnalyzeLoading={isQualityAnalyzing}
                  qualityAnalysis={qualityAnalysis}
                  sourceMaskJobId={sourceMaskJobId}
                  onSourceMaskJobIdChange={(value) => { setSourceMaskJobId(value); setSourceMaskVerification(null); setSourceMaskVerificationError(''); }}
                  sourceMaskJobOptions={sourceMaskJobOptions}
                  sourceMaskVerification={sourceMaskVerification}
                  sourceMaskVerificationLoading={isSourceMaskVerifying}
                  sourceMaskVerificationError={sourceMaskVerificationError}
                  onVerifySourceMask={runSourceMaskVerification}
                  onStartQualityLayers={startQualityLayers}
                  onCheckQualityLayers={checkQualityLayers}
                  onAnalyzeQuality={runQualityAnalysis}
                />
              )}
            </>
          ) : (
            <ResultPanel result={result} onReset={() => setResult(null)} />
          )}

        </section>
        {visibleError && (
          <div id="catalog-validation-error" className="validation-toast" role="alert" aria-live="assertive">
            <span className="validation-alert-icon" aria-hidden="true">!</span>
            <span className="validation-toast-message">{visibleError}</span>
            <button type="button" className="validation-toast-close" aria-label="Dismiss error" onClick={() => { setCatalogError(''); setError(''); setValidationAlertDismissed(true); }}>×</button>
          </div>
        )}
      </main>
    </div>
  );
}
