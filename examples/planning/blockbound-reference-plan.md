# Blockbound: three new islands

Authored reference plan for the local Lattice regression trial, October 10, 2026.
This is not a live external-provider result. No game changes or game checks have
been performed by this planning task. Paths below are relative to Blockbound's
`blockbound/` repository and describe its current, dirty working tree.

## Scope and sequence

Deliver Pirate Bay (district 3) as one complete slice, then Frost Observatory (4)
and Cloudtop Gardens (5). Each has five landmarks, tiers 0–4, a distinct palette,
and a four-card album set. Preserve roll/build/raid rules, resource types, upgrade
prices and repair transactions. No sailing, weather or flight systems are needed.

The current three islands and their curated prices live in
`web/src/store/gameStore.ts:280-318`. IDs must remain contiguous and in array
order: store transactions and island UI index the array by district ID
(`gameStore.ts:881-885`, `web/src/components/IslandView.tsx:22-31`). Append;
never renumber existing districts or buildings.

## Proposed content

The following are design proposals, not existing content or validated balance.
IDs intentionally contain the substrings recognized by
`web/src/components/LandmarkDiorama.tsx:1-7`; display names alone do not select
archetypes. Each list is ordered civic, culinary, residential, kinetic, plaza.

| Island | Visual direction | Landmarks and proposed stable IDs |
|---|---|---|
| Pirate Bay, 3 | Ocean blue, weathered wood, amber sails; coastal silhouettes. Pirate Bay's palette already appears in `DESIGN.md:48`. | Captain's Citadel (`p_keep`), Galley Kitchen (`p_bakery`), Crow's Nest Cottage (`p_cottage`), Tidewheel Mill (`p_windmill`), Treasure Lagoon (`p_park`) |
| Frost Observatory, 4 | Dark navy, pale ice and aurora teal/violet; crystalline roofs and observatory silhouettes. | Star Observatory (`f_spire`), Cocoa Lab (`f_bakery`), Ice Lodge (`f_cottage`), Aurora Turbine (`f_turbine`), Crystal Springs (`f_park`) |
| Cloudtop Gardens, 5 | Cream clouds, coral roofs, lavender shadows and leafy green; raised gardens and light bridges. | Sky Palace (`s_keep`), Tea Pavilion (`s_bakery`), Cloud Cottage (`s_cottage`), Zephyr Mill (`s_windmill`), Hanging Gardens (`s_park`) |

Provisional base coin costs / material costs in that landmark order:

| Island | Base coin costs | Base material costs | Total construction from tier 0 to 4 |
|---|---|---|---|
| Neon, existing baseline | 45k, 30k, 24k, 38k, 48k | 9, 7, 7, 8, 9 | 2,405,000 coins; 220 materials |
| Pirate Bay | 60k, 42k, 35k, 52k, 65k | 11, 9, 9, 10, 12 | 3,302,000 coins; 264 materials |
| Frost Observatory | 78k, 55k, 46k, 68k, 85k | 13, 11, 11, 12, 14 | 4,316,000 coins; 304 materials |
| Cloudtop Gardens | 100k, 71k, 60k, 88k, 110k | 15, 13, 13, 14, 16 | 5,577,000 coins; 344 materials |

Totals derive from `buildingUpgradeCost` in `web/src/game/rollRules.ts:181-197`:
four upgrades cost 13 × base coins and 4 × base materials + 12 per landmark.
They exclude repairs and rewards. Measure rolls and time-to-unlock, material
shortages, and album reward effects before accepting these curves; increasing
prices is not evidence of good pacing. Reuse the helper rather than copying it.

## Implementation steps

1. **Append Pirate Bay data and prove progression.** Add district 3 to
   `initialDistricts` in `web/src/store/gameStore.ts`, with all five buildings at
   tier 0 and undamaged. Use the existing next-lock, unlock, travel, upgrade and
   repair actions (`:320-329`, `:795-823`, `:881-926`). Retain the 2,500-coin repair
   rule. Extend `web/tests/store.test.mjs`, `web/tests/gameSave.test.mjs` and
   `web/tests/islandView.test.mjs` before repeating the data additions for 4/5.

2. **Complete every visual layer.** Append explicit themes in
   `web/src/game/boardThemes.ts`; remove modulo reuse for known district IDs and
   keep an explicit default for invalid IDs. Replace App's `% 3` routing
   (`web/src/App.tsx:222-224`). Add island 3, then 4/5, to
   `web/src/components/GameFeel.css` and `web/src/components/IslandView.css`.
   Extend district palettes in `web/src/components/LandmarkDiorama.tsx:14-18`.
   Preserve its five archetypes and add only theme-specific visual details
   needed for the proposed silhouettes. Verify each tier and damaged state;
   tint alone must not turn three new islands into the same scene.

3. **Preserve navigation and archive behavior.** Keep five plots so the existing
   terrain/map layout and 20-star total remain valid. Exercise
   `web/src/components/IslandView.tsx` and `web/src/game/islandNavigation.ts`
   through active, completed, archived and locked states. Extend the current
   theme tests that explicitly assert three themes and modulo wrap in
   `web/tests/boardTheming.test.mjs:14-71`; retain invalid-ID fallback coverage.

4. **Ship album parity with each island.** Extend `CARD_SETS` and `CARD_DEFS` in
   `web/src/game/cards.ts`, retaining two common, one rare and one epic card per
   set. Proposed sets are Pirate Crew (captain, cook, navigator, keeper), Aurora
   Watch (astronomer, cocoa maker, engineer, explorer), and Sky Gardeners (host,
   tea maker, gardener, wind keeper). Add twelve new JPG assets under
   `web/public/cards/v2/` and entries in its existing `manifest.json`, four for
   each released district. These are proposed new assets. Extend
   `web/tests/cards.test.mjs`, including hard-coded set/card counts and manifest
   parity, and use the existing card-art checker. Inspect the full card asset
   pipeline before producing art; the provided excerpts do not prove its
   complete invocation contract. Do not publish an island with a promised but
   incomplete album. Set rewards need pacing review alongside build costs.

5. **Repeat the complete slice for Frost and Cloudtop.** Only append the next
   district after its predecessor's data, visual layers, album and checks are
   complete. Finish with six explicit themes and six album sets / 24 cards.
   No new dependency, save format or content framework is necessary.

## Save compatibility

`web/src/game/gameSave.ts:201-224` limits unlocked IDs to 0–7 / eight entries,
and merges saved building state onto known defaults. Hydration in
`web/src/store/gameStore.ts:398-446` preserves curated names/prices and restores
tier/damage by stable IDs. Adding districts 3–5 fits SaveV1; do not invent a
SaveV2 migration. An expansion beyond district 7 would need a separate schema
change. Source hashes in the Lattice receipt are needed because HEAD alone
does not describe this dirty working tree.

An ordinary existing save containing only districts 0–2 must retain its progress
and resources, with new districts present at tier 0 and locked. Completing Neon
makes Pirate Bay eligible; the explicit unlock action focuses it. Round-trip
new tiers, damage, selection, card ownership and claimed rewards. Preserve
existing filtering of unknown district/building IDs and locked selections.
Do not describe this client-side validation as tamper-proof or silently add a
new anti-cheat policy to the island work.

## Acceptance and validation

- Premature and repeated unlock actions have no effect. Complete 2 → unlock 3,
  complete 3 → unlock 4, complete 4 → unlock 5; the final completed district
  has no further unlock. Locked/unknown travel and travel while rolling remain
  rejected. Completed previous islands remain reachable through the archive.
- Every landmark progresses through tiers 0–4; build charges the shared formula
  once, insufficient resources and damaged buildings cannot upgrade, repair
  charges once and preserves the tier, and max-tier builds have no effect.
- An old save, new-save round trip, corrupt/unknown IDs and locked current
  selection retain the existing guarantees. Album drops only include unlocked
  district sets; new assets/manifest entries resolve and set rewards claim once.
- No new island falls through Sunny's board, shell, overlay or landmark palette.
  Check 320/360/390/430px portrait and desktop: map labels, travel controls,
  archive, HUD contrast, touch targets, tier/damage silhouettes, reduced motion,
  reward overlays and reload persistence.
- Run from `web/`: `npm test`, `npm run typecheck`, `npm run build` (build runs
  tests again). Add focused save/store/theme/landmark/card assertions to the
  existing test files. Browser playthrough and screenshots are separate proof.
- Android assets are generated from the canonical web client
  (`docs/ARCHITECTURE.md:9-36`). Run `npm run sync:android` only for a requested
  packaging step and validate on a device separately; web checks prove neither.

Open product decisions: accept the three themes and landmark names; tune the
provisional costs and album rewards; approve actual art and landmark silhouettes.
The excerpts do not establish long-session balance or mobile GPU performance.
