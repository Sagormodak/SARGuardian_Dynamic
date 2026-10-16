export function canOpenEngine(engineName: string, isAuthenticated: boolean): boolean {
  if (!isAuthenticated) return false;
  return engineName === 'Landslide' || engineName === 'Glacier Collapse' || engineName === 'Farming Activities' || engineName === 'Flood';
}

export function isLandslideRouteAllowed(isAuthenticated: boolean): boolean {
  return isAuthenticated;
}
