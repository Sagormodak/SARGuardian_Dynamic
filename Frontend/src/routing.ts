export const LANDSLIDE_PATH = '/landslide';
export const LANDSLIDE_RESULTS_PATH = '/landslide/results';
export const LANDSLIDE_DISPLACEMENT_PATH = '/landslide/displacements';

export function isLandslideDisplacementRoute(pathname: string): boolean {
  return normalizePathname(pathname) === LANDSLIDE_DISPLACEMENT_PATH;
}

export function normalizePathname(pathname: string): string {
  const pathOnly = pathname.split(/[?#]/, 1)[0];
  return pathOnly || '/';
}

export function isLandslideRoute(pathname: string): boolean {
  const normalizedPathname = normalizePathname(pathname);
  return normalizedPathname === LANDSLIDE_PATH || normalizedPathname.startsWith(`${LANDSLIDE_PATH}/`);
}

export function isLandslideResultsRoute(pathname: string): boolean {
  return normalizePathname(pathname) === LANDSLIDE_RESULTS_PATH;
}

export function navigatePath(
  nextPath: string,
  currentPath: string,
  pushState: (state: unknown, unused: string, url?: string | URL | null) => void,
): string {
  const normalizedPath = normalizePathname(nextPath);
  if (normalizePathname(currentPath) !== normalizedPath) {
    pushState({}, '', normalizedPath);
  }
  return normalizedPath;
}
