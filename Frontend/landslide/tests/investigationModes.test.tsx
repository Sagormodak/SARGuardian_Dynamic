import { renderToStaticMarkup } from 'react-dom/server';
import type { User } from 'firebase/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandslidePage } from '../ui/LandslidePage';
import { loadLandslideSessionState, persistLandslideSessionState } from '../ui/sessionState';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('investigation mode state integration', () => {
  it('shares saved selection across map, preparation, and return; clearing disables both cards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } });
    const state = loadLandslideSessionState('test-user');
    Object.assign(state, { coordinates: [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701]], areaClosed: true, windowStart: '2026-10-01', windowEnd: '2026-10-22' });
    persistLandslideSessionState('test-user', state);
    const render = (isDisplacementPage = false) => renderToStaticMarkup(<LandslidePage user={{ uid: 'test-user' } as User} isResultsPage={false} isDisplacementPage={isDisplacementPage} onHome={() => {}} onResults={() => {}} onDisplacements={() => {}} onBackToMap={() => {}} onSignOut={() => {}} />);
    const map = render();
    const cards = map.match(/<article class="investigation-mode-card[\s\S]*?<\/article>/g)!;
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card).not.toContain('disabled=""');
    expect(cards[0]).toContain('Explore NISAR Archive');
    expect(cards[1]).toContain('Find Displacements');
    expect(cards[0]).not.toContain('Explore available NISAR products for your selected area and time window.');
    expect(cards[1]).not.toContain('Prepare your selected AOI and time window for displacement analysis.');
    expect(map).not.toContain('class="mode-help"');
    expect(map).not.toContain('View NISAR results');
    const preparation = render(true);
    expect(preparation).not.toContain('POLYGON');
    expect(preparation).not.toContain('Copy Payload');
    expect(preparation).toContain('Start displacement processing');
    expect(render()).toBe(map);
    state.coordinates = [];
    state.areaClosed = false;
    persistLandslideSessionState('test-user', state);
    for (const card of render().match(/<article class="investigation-mode-card[\s\S]*?<\/article>/g)!) expect(card).toContain('disabled=""');
    expect(render(true)).toContain('Loading your account task');
  });
});
