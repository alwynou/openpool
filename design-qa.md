# OpenPool web redesign QA

## Visual truth and implementation

- Selected reference: `docs/design/openpool-console-new-york-light.png`
- Verified route: `http://localhost:5173/accounts`
- Desktop capture: `docs/design/qa/openpool-accounts-desktop.jpg` at 1440 × 1024
- Mobile capture: `docs/design/qa/openpool-accounts-mobile.jpg` at 390 × 844
- Side-by-side comparison: `docs/design/qa/openpool-accounts-comparison.png` (reference left, implementation right)
- Logo source: `docs/design/openpool-logo-source.png`
- Logo integration capture: `docs/design/qa/openpool-logo-integration.jpg`
- Logo comparison: `docs/design/qa/openpool-logo-comparison.png` (processed source left, rendered 28px mark right)

## Comparison passes

### Pass 1

- P1 layout: the first implementation used a 256px sidebar while the selected reference used approximately 176px. This shifted the title, filters, and table too far right.
- P2 navigation: the wider icon gap and 14px labels caused the compact sidebar labels to wrap after the width correction.
- P1 responsive containment: wide tables and the mobile navigation needed an explicit root overflow boundary while retaining their own horizontal scroll containers.

Corrections were made in `apps/web/src/components/app-shell.tsx` and `apps/web/src/styles.css`.

### Pass 2

- Layout: sidebar, header, page margins, filters, account table, and primary action align with the selected New York-light composition.
- Typography: the system sans stack, weight hierarchy, compact labels, and table density are visually consistent with the reference.
- Color and surfaces: the implementation stays within black, white, zinc, and restrained status colors; borders, radii, focus rings, and shadows are consistent.
- Icons: visible controls use one Phosphor icon family with consistent stroke weight and sizing.
- Responsive behavior: the desktop shell collapses to a compact header and horizontally scrollable navigation at 390px; the page remains contained, filters stack, the dialog fits within the viewport, and data tables retain local horizontal scrolling.
- Dynamic differences: account identifiers, timestamps, priorities, and status sublabels come from live API data. The reference's open action menu, verification error, and toast are interaction states rather than persistent page chrome; the implementation exposes equivalent working states.

No P0, P1, or P2 visual findings remain.

### Logo integration

- The latest selected OpenPool mark is preserved as the source asset and post-processed into a transparent 1024px application asset.
- The sidebar, mobile header, and authentication brand lockup all consume the same `/openpool-logo.png` asset at 28px without stretching or clipping.
- Dedicated 32px favicon and 180px Apple touch icon variants are generated from the same mark.
- Browser verification confirmed the application asset loads at its native 1024 × 1024 dimensions, renders at 28 × 28, and both icon links are present. The fresh-page console has no warnings or errors.

## Behavior and accessibility checks

- Administrator login and session restoration.
- All six primary routes and unknown-route fallback.
- Storage-account search, provider filter, status/health controls, refresh, account action menus, transition confirmation, dynamic provider fields, and client-side validation.
- Bucket creation dialog, shard form, and allowed shard transition options.
- File selection UI, logical object listing, download/delete accessible names, and direct-transfer copy.
- API-key listing and creation dialog without exposing a raw token.
- Audit-log search and actor filtering.
- Keyboard-visible focus states, semantic labels, dialogs, alerts, reduced-motion CSS, and mobile tap targets.
- Fresh-browser console check: no warnings or errors.
- `npm run verify`: lint, typecheck, 318 tests, web build, and Worker dry-run build passed.

final result: passed
