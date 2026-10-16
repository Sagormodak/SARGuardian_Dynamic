import { validateAnalysisRequest } from './validation';
import type { AnalysisRequest, InvestigationResult } from './types';

export function investigate(request: AnalysisRequest): InvestigationResult {
  const validation = validateAnalysisRequest(request);
  if (!validation.valid) throw new Error(validation.errors.join(' '));

  const isLangtangFixture = Math.abs(request.location.latitude - 28.21) < 0.5
    && Math.abs(request.location.longitude - 85.55) < 0.5;
  if (!isLangtangFixture) {
    return {
      status: 'no-data', request, sourceData: [],
      observability: { geometryStatus: 'undetermined', note: 'No verified observation fixture covers this location and time.' },
      qa: { status: 'UNVERIFIED', checks: ['Request geometry and timestamp validated', 'Catalog adapter returned no matching fixture'] },
      provenance: { sourceProducts: [], algorithm: 'fixture-catalog-adapter', notes: 'No live NISAR retrieval was performed.' },
      limitations: ['No relevant verified observation data is available for this request.'],
    };
  }
  return {
    status: 'finding', request,
    sourceData: ['reference-derived Langtang time-series fixture'],
    measurement: { value: 9.2, unit: 'mm/day', interpretation: 'Observed signal in the reference-derived fixture; this is not a confirmation of a landslide.' },
    uncertainty: { value: 2.1, unit: 'mm/day', confidence: 'moderate' },
    observability: { geometryStatus: 'usable', note: 'Fixture geometry is usable for this demonstration request.' },
    qa: { status: 'WARNING', checks: ['Request geometry and timestamp validated', 'Reference fixture matched', 'Live product retrieval not performed'] },
    provenance: { sourceProducts: ['reference-derived Langtang time-series fixture'], algorithm: 'fixture-catalog-adapter', notes: 'Reference-derived fixture only.' },
    limitations: ['This adapter does not perform global live NISAR discovery or processing.', 'The user polyline remains investigation geometry, not a measured movement trajectory.'],
  };
}