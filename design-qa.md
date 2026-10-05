# Homepage Token Card QA — 2026-10-05

**Findings**

No remaining actionable P0/P1/P2 findings. The implementation follows the accepted light/green adaptation of Pools' large-image card, rather than copying its complete page or trading controls.

**Visual truth and captures**

- Reference: https://pools.fun/ — token grid, dark theme, MUSEGOD card.
- Artifact directory: `/Users/admin/.codex/visualizations/2026/10/05/01a10ba0-1ce5-7591-ba23-6530fa92fcf8/token-card/`.
- Source: `reference-desktop.jpg`; implementation: `production-desktop.jpg`, `production-mobile.jpg`, `production-card-final.jpg`.
- Combined full-view input: `comparison-full.png`; final focused input: `comparison-cards-final.png`. Both were opened and inspected together, with reference on the left and implementation on the right.
- Desktop CSS viewport: 1440×1000; tablet: 900×1000; mobile: 390×844. Browser device pixel ratio was 1. Native IAB viewport raster captures were 1424×989 (reference), 1425×990 (desktop implementation), and 375×812 (mobile); full comparison copies were normalized to the declared desktop CSS viewport before reducing both to 720×500. Focus comparison retains native CSS card sizes: reference 219×403, final implementation 364×616. The final implementation card was captured using document-relative clipping; viewport-relative clipping was discarded because it selected the wrong page region.
- State: grid browsing with loaded MUSEGOD summary, same token/image identity. Numeric values and fetched times differ because the captures were taken at different times; only layout and display semantics are compared. The project intentionally retains three/two/one columns, its sidebar and its original typography; Pools currently shows six desktop columns at this viewport.

**Required fidelity surfaces**

- Typography: existing DM Sans/Space Grotesk family retained; 16px name, compact metadata and three aligned metric rows. Long names truncate on one line with the full title preserved. Long symbols remain within their row.
- Layout: 16px card padding, 20px outer and 14px image radii, square contained image. DOM measurements confirmed equal image width/height. Desktop and tablet cards align; 390px mobile has one column without horizontal overflow.
- Colors: light/green project palette retained. Gains/losses use the existing semantic colors; zero and unknown are neutral. Metadata text was darkened within cards to meet normal-text contrast against the featured background.
- Images: pinned local MUSEGOD image remains intact and uncropped. Isolated fixtures verified missing images and actual failed HTTPS image loads fall back to a readable initial; quote logos remain visible independently.
- Content: identity, quote pair, venue, three requested metrics, source/time and creator/network footer are present. Description is omitted from the card and remains on details. Unknown creator and market values are explicit; no quick-buy control is introduced.

**Comparison history**

1. Initial rendered comparison identified P2 metadata contrast: the existing muted color `#7b8175` gave 3.94:1 against `#fcfef7`. Card-only `#68725f` raises it to 4.97:1 without changing global styles. The production bundle was rebuilt and the final captures/comparison were inspected after this fix.
2. Independent code review found disappearing directory cards during refresh and continued later Base batches after cancellation. Directory retention now uses the confirmed deployment and existing listing filter; canceled loaders stop before further requests. Browser checks confirmed retained Base cards and no transient MUSEGOD recommendation, plus stale Robinhood snapshots. These were functional findings, not substitutes for visual comparison.

**Implementation checklist / local acceptance before publication**

- `npm test`: 283 passed, 0 failed; typecheck for both targets and production build passed; `git diff --check` passed. The existing bundle-size warning remains outside this card change.
- Read-only production-bundle browser check served the final build locally and proxied GETs to the existing local runtime. Real MUSEGOD cap/volume/change were visible; its browser console had no entries. The existing dev server has Vite WebSocket errors in IAB, so production-bundle console evidence is used separately.
- Native Tab focus showed a 3px outline; Enter navigated to the exact MUSEGOD route and browser Back returned to Explore. Search, sort, empty search results and modified native link markup remain covered.
- Isolated browser fixtures verified long names, missing/broken images, Base true-zero/unknown/positive metrics, partial unavailable rows, retained cards during delayed/failed directory refresh, failed-market `Previous snapshot`, deployment switch to fork with cleared metrics, and actual automatic 24-hour snapshot expiry. Fixtures never touched the application database and are not evidence of live Base pools.
- Request-policy tests cover stable deduplication, 31 addresses split 30+1, serial batches, cancellation between batches, and no market requests for unconfirmed runtime, ordinary Robinhood launches or forks.
- No backend API, registration, database, signing permissions or transaction flow changed. No production publication, wallet transaction, commit or push was performed during this local acceptance pass. Subsequent publication is recorded separately by the immutable GitHub build and production Deployment.

**Open Questions / Follow-up Polish**

None required for the agreed card scope.

final result: passed
