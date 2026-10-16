import { describe, expect, it } from 'vitest';
import { canOpenEngine, isLandslideRouteAllowed } from './authGating';

describe('engine authentication gating', () => {
  it('blocks all engines until a user is authenticated', () => {
    expect(canOpenEngine('Landslide', false)).toBe(false);
    expect(canOpenEngine('Glacier Collapse', false)).toBe(false);
    expect(canOpenEngine('Farming Activities', false)).toBe(false);
    expect(canOpenEngine('Flood', false)).toBe(false);
  });

  it('allows Landslide only after authentication', () => {
    expect(isLandslideRouteAllowed(false)).toBe(false);
    expect(isLandslideRouteAllowed(true)).toBe(true);
  });
});
