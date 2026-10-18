// Resolves a file in static/ (served at the app root) so the app also works
// when hosted under a sub-path, e.g. /m2m/ inside Autorig Workbench.
// This module sits one folder below the app root both in dev (src/lib/) and
// in a build (dist/assets/), so '../' is the root in either case.
export function asset_url (path: string): string {
  return new URL('../' + path.replace(/^(\.\.\/|\/)+/, ''), import.meta.url).href
}
