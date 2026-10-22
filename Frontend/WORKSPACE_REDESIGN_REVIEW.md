# Investigation workspace review — 2026-10-19

Implemented on `feature/nisar-results-scrolling`. All changes from this task are unstaged. The pre-existing staged patch is unchanged. No branch switch, stage/unstage, commit, push, merge, deployment, or main-branch modification was performed.

## Root causes and fixes

| Issue | Root cause | Fix |
| --- | --- | --- |
| Saved AOI missing after refresh | Overlay and location effects ran before the asynchronous map initializer populated a ref. Updating the ref did not rerun those effects. | Map readiness is now React state. A small overlay controller retains the latest coordinates until the real map is attached, then draws them. Restored location effects also depend on map readiness. |
| Closed AOI loses editing controls after a vertex drag | The old callback marked the area closed only when the dragged vertex index was zero. | Preserve an already-closed polygon while dragging any vertex, and exit drawing mode when closure completes. Geographic calculations and validation rules are unchanged. |
| Duplicate vertex callbacks and incomplete cleanup | Existing markers received new event listeners on each update; unmount only set an async flag. | Reuse owned polygons/markers, install each vertex handler once, and remove only owned listeners and overlays when detached. Async Maps/Places continuations check component lifetime. |
| Mobile Back to map hidden | A broad mobile `button:first-child` rule hid navigation and some profile controls. | Removed that rule and introduced an explicit responsive header with visible Home/Back controls and keyboard-accessible account actions. |
| Homepage horizontal overflow | The decorative background's scale transform extended beyond the page; Chromium measured 1454px content at a 1440px viewport. | Clip only horizontal homepage overflow while retaining visible vertical overflow and normal document scrolling. Removed the conflicting mobile overflow override. |
| Phone controls cover the map | Absolute controls and several accumulated viewport-height/theme overrides competed. | A scoped workspace stylesheet uses existing homepage colors and typography. Phone/short-screen controls follow the map in normal document flow. Desktop keeps the map dominant with compact glass panels. |
| Autocomplete selection ignored | The handler looked in `event.detail`; the installed Google Maps types specify `event.placePrediction`. | Use the documented event property and existing Places field-fetch workflow. Keep a usable text/coordinate fallback when Places cannot load. |
| Search failures looked like empty results | Geocoder HTTP failures were parsed as though they were successful result arrays. | Check HTTP status, distinguish no matches from service failures, expose loading feedback, and abort superseded/unmounted searches. |
| Duplicate catalogue submissions | Loading state alone cannot guard two calls before React rerenders. | A synchronous in-flight ref prevents repeated submissions. The existing success-only navigation and single API call site are retained. |
| Session and account restoration resilience | Stored dates, optional metadata, and product membership were insufficiently checked; changing accounts could reuse another account's component state. | Validate stored field shapes/ranges/dates, drop orphaned selections, write only allowed workflow fields, and key the workspace by user UID (never by route). |

The existing Google Maps provider, real tiles/attribution, map type/zoom controls, coordinate order and precision, AOI calculations/validation, API client/contracts, Firebase authentication, queued-job actions, and scientific workflow handlers remain in place. Map/results transitions retain the same workspace/map instance. No new runtime or test dependencies were added.

## Files changed by this task

- `src/App.tsx`: isolate workspace state when the authenticated user changes.
- `src/index.css`: shared branding tokens and horizontal background clipping; vertical scrolling remains in document flow.
- `landslide/ui/LandslidePage.tsx`: readiness/cleanup, search feedback and fallback, shared responsive header/profile, submission guard, existing route and state integration.
- `landslide/ui/landslide.css`: remove the broad mobile navigation-hiding rule; preserve existing style changes.
- `landslide/ui/workspace.css` (new): scoped map/results layout, homepage branding, responsive panels, focus states, readable metadata.
- `landslide/ui/mapOverlays.ts` (new): lifecycle and ownership of real Google Maps AOI overlays.
- `landslide/tests/mapOverlays.test.ts` (new): seven focused readiness, latest-edit, duplication, dragging/closed-state, cleanup, and clearing regressions.
- `landslide/ui/sessionState.ts` and `sessionState.test.ts`: restoration validation and three additional session/privacy regressions.
- This report (new).

## Verification

| Check | Actual result |
| --- | --- |
| `npm test` in Frontend | PASS — 36 tests in 7 files |
| `npm run build` in Frontend | PASS — TypeScript and Vite production build |
| `npm run lint` in Frontend | PASS — no disabled lint rules |
| `git diff --check` | PASS |
| `git diff --cached --check` | PASS |
| Existing index preservation | PASS — staged patch hash remains `675e321b25b57f2cc658c248aebe3b0cc26f3e8d` |
| Existing unrelated files | PASS — 21 unrelated changed/untracked files retain their starting SHA-256 hashes |
| Queued/scientific UI preservation | PASS — panels, job actions, and scientific workflow handlers compared against the original working file |

28 Chromium browser checks actually performed:

- Actual homepage document scrolling and no horizontal overflow at widths 1440, 640, 390, and 320px.
- Controlled integration against the real App/history, React workspace, session storage, and API client: external Firebase, Google Maps, geocoder, and catalogue services were replaced only in the browser test's request interception with explicit fixtures. Application source/configuration/authentication were not bypassed or replaced for production.
- AOI creation through existing handlers; non-first-vertex dragging retains editing controls; refreshing while map initialization is deliberately held, then releasing it and checking the restored polygon coordinates.
- Rapid repeated catalogue submission produces one request; loading feedback, results navigation, and product selection work.
- Results scrolling, visible Back to map, and no horizontal overflow at 1366, 768, 640, 390, and 320px.
- Map/results navigation, browser Back/Forward, and results refresh preserve AOI, dates, family, products, and selection with no navigation-induced request.
- Reachable investigation controls at 768, 640, 390, and 320px; controls sit below the map at phone widths and at a short 900×540 landscape viewport.
- Profile trigger and Escape dismissal; invalid AOI blocks requests; catalogue HTTP failure stays on the map; valid no-data results render an honest empty state.
- Enter-key search, empty results, service-failure feedback, the actual `gmp-select` payload shape, and coordinate search after a Places failure.
- No uncaught application exceptions in these controlled workspace scenarios.

Desktop/mobile workspace and mobile results screenshots were inspected. Their map backdrop is explicitly labeled as a test fixture, not live imagery.

Browser runner and generated artifacts (temporary, outside the repository):

`C:/Users/sagor/AppData/Local/Temp/sarguardian-workspace-browser-39725cb40be8429f87aa21ae26001dbe/`

This contains `review.mjs`, `maps-fixture.mjs`, `results.json`, `homepage-mobile.png`, `workspace-desktop.png`, `workspace-mobile.png`, and `results-mobile.png`.

## Errors and remaining limits

- The application bugs above were fixed at their source. Recoverable Maps/Places/geocoder/catalogue failures retain user-visible messages; no global console suppression or fabricated production responses were introduced.
- Sandbox `spawn EPERM` is a process-permission issue, not an application failure. Approved test/build/browser runs completed successfully with the required permissions.
- An initially used test matcher was unavailable in the installed Vitest version; it was replaced with supported assertions. Tests and lint rules were not disabled.
- Git's LF/CRLF notices and inaccessible pre-existing Backend pytest-cache directories are development/worktree conditions. Those files/configurations were left alone.
- No separate map design image or local reference artwork was supplied; only the text brief was attached. The existing homepage provided the actual logo, typography, and brand reference. Exact visual matching to an unavailable image cannot be claimed.
- Live Firebase popup sign-in/sign-out, real Google Maps tile/Places credentials and provider warnings, and a successful request to the deployed catalogue service were **not** end-to-end browser-tested. Verify these manually with the existing configured account/services. No backend/environment changes were made.
- The fixed runtime files are currently unstaged; the older staged snapshot does not yet include these stability/UI changes.

## Final Git state

Full `git status --short`:

```text
 M Backend/.gitignore
 M Backend/app/asf_catalog.py
 M Backend/app/main.py
 M Backend/app/persistence.py
 M Backend/requirements.txt
 M Backend/tests/test_jobs.py
 M Backend/tests/test_main.py
 M Frontend/.env.example
 M Frontend/.gitignore
 M Frontend/README.md
MM Frontend/landslide/ui/LandslidePage.tsx
MM Frontend/landslide/ui/landslide.css
AM Frontend/landslide/ui/sessionState.test.ts
AM Frontend/landslide/ui/sessionState.ts
MM Frontend/src/App.tsx
 M Frontend/src/api/catalog.test.ts
 M Frontend/src/api/catalog.ts
MM Frontend/src/index.css
A  Frontend/src/routing.test.ts
A  Frontend/src/routing.ts
?? Backend/STAGING_MIGRATION_RUNBOOK.md
?? Backend/app/config.py
?? Backend/app/config_diagnostic.py
?? Backend/tests/test_config.py
?? Backend/tests/test_config_diagnostic.py
?? Backend/tests/test_persistence_headers.py
?? Frontend/SARGuardian_Dynamic.code-workspace
?? Frontend/WORKSPACE_REDESIGN_REVIEW.md
?? Frontend/landslide/tests/mapOverlays.test.ts
?? Frontend/landslide/ui/mapOverlays.ts
?? Frontend/landslide/ui/workspace.css
```

Existing staged diff summary (unchanged):

```text
 Frontend/landslide/ui/LandslidePage.tsx    | 268 +++++++++++++++++++++--------
 Frontend/landslide/ui/landslide.css        |  57 ++++++
 Frontend/landslide/ui/sessionState.test.ts |  70 ++++++++
 Frontend/landslide/ui/sessionState.ts      | 139 +++++++++++++++
 Frontend/src/App.tsx                       |  33 ++--
 Frontend/src/index.css                     |  11 +-
 Frontend/src/routing.test.ts               |  28 +++
 Frontend/src/routing.ts                    |  28 +++
 8 files changed, 542 insertions(+), 92 deletions(-)
```

Unstaged tracked diff summary (includes preserved unrelated work):

```text
 Backend/.gitignore                         |   2 +
 Backend/app/asf_catalog.py                 |  34 +-
 Backend/app/main.py                        |  21 +-
 Backend/app/persistence.py                 |  61 ++-
 Backend/requirements.txt                   |   3 +-
 Backend/tests/test_jobs.py                 |   8 +
 Backend/tests/test_main.py                 |  29 ++
 Frontend/.env.example                      |   5 +-
 Frontend/.gitignore                        |   2 +
 Frontend/README.md                         |  16 +-
 Frontend/landslide/ui/LandslidePage.tsx    | 782 ++++++++++++++++++-----------
 Frontend/landslide/ui/landslide.css        |   2 +-
 Frontend/landslide/ui/sessionState.test.ts |  39 ++
 Frontend/landslide/ui/sessionState.ts      |  30 +-
 Frontend/src/App.tsx                       |   1 +
 Frontend/src/api/catalog.test.ts           |  56 ++-
 Frontend/src/api/catalog.ts                |  85 ++++
 Frontend/src/index.css                     |  18 +-
 18 files changed, 829 insertions(+), 365 deletions(-)
```

New untracked task files are listed in status but are not included by `git diff --stat`. All pre-existing staged, unstaged, and untracked work was preserved. This report ends the task; further Git mutations require explicit user approval.
