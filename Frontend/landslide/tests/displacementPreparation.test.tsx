import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DisplacementPreparation } from '../ui/DisplacementPreparation';
import { prepareInvestigation } from '../engine/investigation';
import { isLandslideDisplacementRoute, LANDSLIDE_DISPLACEMENT_PATH, LANDSLIDE_PATH, LANDSLIDE_RESULTS_PATH, navigatePath } from '../../src/routing';

describe('displacement preparation route', () => {
  const user = { getIdToken: vi.fn() } as never;
  it('displays the real payload and submit boundary', () => {
    const preparation = prepareInvestigation({ coordinates: [[85, 27], [85.001, 27], [85, 27.001]], areaClosed: true, startDate: '2026-10-01', endDate: '2026-10-22', today: '2026-10-23' });
    const html = renderToStaticMarkup(<DisplacementPreparation preparation={preparation} onBack={() => {}} user={user} />);
    expect(html).toContain('POLYGON((85 27, 85.001 27, 85 27.001, 85 27))');
    expect(html).toContain('2026-10-01');
    expect(html).toContain('2026-10-22');
    expect(html).toContain('Copy WKT');
    expect(html).toContain('Copy Payload');
    expect(html).toContain('Start displacement processing');
    expect(html).toContain('Back to map');
  });
  it('shows accessible errors without a fabricated payload on an empty/direct visit', () => {
    const html = renderToStaticMarkup(<DisplacementPreparation preparation={{ valid: false, errors: ['Select an AOI.'] }} onBack={() => {}} user={user} />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('POLYGON');
    expect(html).not.toContain('Copy Payload');
  });
  it('uses existing navigation for both workflows and back, suppressing duplicate pushes', () => {
    const push = vi.fn();
    let path = navigatePath(LANDSLIDE_RESULTS_PATH, LANDSLIDE_PATH, push);
    expect(path).toBe('/landslide/results');
    path = navigatePath(LANDSLIDE_PATH, path, push);
    path = navigatePath(LANDSLIDE_DISPLACEMENT_PATH, path, push);
    expect(isLandslideDisplacementRoute(path)).toBe(true);
    navigatePath(path, path, push);
    expect(push).toHaveBeenCalledTimes(3);
    expect(navigatePath(LANDSLIDE_PATH, path, push)).toBe('/landslide');
  });
  it('does not submit automatically when the displacement page opens', () => {
    const preparation = prepareInvestigation({ coordinates: [[85, 27], [85.001, 27], [85, 27.001]], areaClosed: true, startDate: '2026-10-01', endDate: '2026-10-22', today: '2026-10-23' });
    const html = renderToStaticMarkup(<DisplacementPreparation preparation={preparation} onBack={() => {}} user={user} />);
    expect(html).toContain('Start displacement processing');
    expect(html).not.toContain('Preparing displacement job');
  });
});
