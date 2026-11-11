# Patch Notes (Detailed) — Overwatch Ranked Tracker

> **What this is.** The detailed, permanent record of every patch. Newest patch on top.
> Each patch has a summary table and one entry per change (symptom → root cause → fix → files →
> DB impact). Append the next patch as a new `## vX.Y.Z` section above the current one.
>
> **Two versions.** This is the detailed one. The short, plain-English bullet list of every
> patch (added / changed / fixed / retired) is [PATCH-NOTES-SIMPLE.md](PATCH-NOTES-SIMPLE.md).
> Every patch gets an entry in BOTH, written at the same time.
>
> **Convention.** "DB change? No" means no table/view/column/RLS/SQL was touched — the fix is
> client/logic only. Note it explicitly for every change so deploys never guess.

---

## v1.2.0 — 11 November 2026

Season 5: Doctrine, Grímsvötn, the Roadhog and Sombra kit changes, **Sombra's move from DPS
to support** (the first hero ever to change role), hero pages that cope with a kit or role
changing between seasons, HDR support, and **bulk session upload** — a whole play session's
screenshots uploaded at once in any order and grouped into matches by the app (§8), added
ALONGSIDE the per-match upload, which is unchanged (sunset, not deleted).
The user now plays with HDR on, which brightens the whole screenshot by ~25–30%: three
fixed cut-offs that had been calibrated on SDR sat close enough to the line that HDR crossed
them. **Validated in `/testing`** on 5 matches captured twice, HDR off and on (10 runs): every
HDR run now returns the same heroes, roles and breakdown values as its SDR twin, and after
§5 every board reads 1-2-2 with Sombra as support.
**DB change? Yes — the Season 5 SQL, one transaction, run in the Supabase SQL editor** (§7, §7b — both
run and confirmed 7 Oct 2026), plus the Echo fold (§9b — run and confirmed). None for the HDR fixes or bulk upload.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Extraction | HDR scoreboards: table edge found 11–23px right → icon window and portrait crops shifted, DPS read as tank, wrong heroes (Cassidy → Mauga) | Table-edge scan accepts the bright HDR cyan | No |
| 2 | Extraction | HDR: ally icon strip counted as "bright", icon bounds blew out; DPS third bar clipped by the window | Icon pixels tested as white (min channel); scan no longer capped by the window | No |
| 3 | Breakdown OCR | HDR: "41%" read as `410%`, "72%" as `72070`; hero tile "87%" read as `8%` (since the beta) | `%` pieces found by SHAPE (short circles, thin slash) instead of area | No |
| 4 | Content | Doctrine (hero 54), Grímsvötn, Roadhog/Sombra kit changes | Reference lists, portrait, stat lists, catalog | Yes (§7) |
| 5 | Roles | Sombra is support from Season 5 but DPS before it; every role lookup assumed one role forever | Role history in `HEROES` + `heroRoleAt(hero, playedAt)` used wherever a role is tied to a game | Yes (§7) |
| 6 | Hero pages | A rework mixed old and new kits with no way to tell; hero page had no season filter | Season filter (current season default), Current kit / Retired split, per-stat game counts, role tiles per role held | No |
| 7 | Database | Matchups would rewrite Sombra's past as support | `hero_role_history` (dated) joined by game date; `hero_role_ref` kept one-row-per-hero | **Yes** |
| 8 | Upload / process | Logging one match at a time is tedious; a session's screenshots arrive in any order | Bulk session upload: read → group → preview → auto-save clean matches, hold the rest for review | No (storage only) |
| 9 | Bulk upload test | 40 real games: a career-best tile broke a stat label; 4th/5th heroes dropped; Echo stat unfolded; Genji singular | Elimination for unlabelled tiles; sidebar heroes passed to the pipeline; folds added | Yes (§9b) |
| 9c | Analytics nav | Feel and Builder get no new data once questions are retired | Marked retired: dimmer, right-hand end of the nav, own section in the menu | No |

---

### 1. ⭐ HDR moved the scoreboard 11–23px to the right

**Symptom.** On HDR scoreboards, DPS rows came back as tank and the role filter then forced
wrong heroes: the user's Cassidy saved as Mauga, an enemy Cassidy as D.Va, comps `2-2-1`.

**Root cause.** `detectTableEdges()` takes the table's left edge as the first pixel passing
`isBlue() || isRed()`. The true left edge is the ally role-icon strip, which is
`(1,186,250)` in SDR and `(83,232,255)` in HDR. `isBlue` requires `r < 40`, so under HDR the
strip fails and the scan anchors on whatever blue pixel comes next: tableLeft 1093 and 1081
on the two worst boards, against a baseline of 1070. Every x-constant shifts with tableLeft
(icon window, portrait crops, gamertag crops), so one bad edge spoils the whole board.

**Fix.** `isTableBlue()` = `isBlue() || (g > 200 && b > 200 && b − r > 120)`, used by the
edge scan only. SDR answers are unchanged: the SDR strip already passes `isBlue`, and the
SDR anti-alias edge `(44,169,223)` fails `g > 200`. The HDR page background (~`95,88,196`)
fails it too. Only ally rows are scanned, so red needs no equivalent.

**Files.** `src/lib/scoreboard-extractor.ts`. **DB change? No.**

### 2. Role icons: an HDR failure, and a 1–2px edge case that predates it

**Symptom.** Even with the table edge correct, HDR ally icons misread.

**Root cause (HDR).** Icon pixels were "average brightness > 180". The ally strip averages
143 in SDR and **188** in HDR, so the whole strip counted as glyph and the icon's top/bottom
blew out to the ±30px search limits.

**Root cause (latent, SDR too).** `classifyRoleIcon()` scanned `left .. min(left+34,
right+1)`, and `right` is capped by the 5v5 window end at x=1109. The DPS glyph's third bar
starts at ~1108, so the three-bar test was seeing it by 1–2px. The file's own comment said
the scan was not capped by the window; it was.

**Fix.** `isIconWhite()`: the minimum of r/g/b must clear the threshold (180 for bounds, 200
for classification). The white glyph is ≥ 200 on all three channels; cyan and red each keep
one channel low in both modes. The classification scan is now genuinely `left .. left+34`.
Pre-fix, on the 5 HDR boards: 0/5 correct. Post-fix: 5/5, SDR unchanged at 5/5.

**Files.** `src/lib/scoreboard-extractor.ts`. **DB change? No.**

### 3. HDR glow turned the `%` sign into a digit

**Symptom.** HDR breakdowns stored percentages like `410%`, `480%`, `72070`, `100070`.

**Root cause.** `smartSegment()` Pass 2 rebuilds `%` from its pieces, each under 400 px.
Measured in SDR: circles 383–388, slash 371–374 (~15px of margin). HDR glow grows them
to 401–408 and 389, so one circle fails, drops to Pass 3 as a digit, and reads as `0`.

**First fix, superseded.** The ceiling was raised 400 → 460 (the stat-tile "1" measures
512–523). Testing bulk upload then showed the hero-info tile — % played on the Personal page
and the Summary slots — uses a SMALLER font, where real digits sit under both ceilings: "7"
346 px (so "87%" had read as `8%` since the beta, under 400) and "3" 438 px (so 460 turned
"13%" into `1%`). No area threshold fits both fonts.

**Fix.** `%` pieces are identified by SHAPE relative to the line's tallest character-sized
blob: a circle is ≤ 0.75 × line height (`PCT_CIRCLE_MAX_H`), the slash fills ≤ 0.3 of its
bounding box (`PCT_SLASH_MAX_FILL`); every digit is full height and fills ≥ ~0.4. A group
needs ≥ 2 pieces including a circle. Line height ignores blobs < 8 px wide (a tile-edge bar,
80 px tall, on Roadhog's R2C3 would otherwise make every character look short).
Validated on real HDR pixels: stat tiles 48 %, 72 %, 31 %, 12 %, 36 %, 41 %, 2,116, 4,545,
1,032, 00:29; hero tile 87 %, 13 %, 100 %, 04:48; Summary slots 87 %, 13 % — all segment
correctly, and the full pipeline returns the same values as before with Cassidy now 87 %.

**Files.** `src/lib/breakdown-ocr.ts`. **DB change? No.**

### 4. Season 5 content

- **Doctrine** (hero 54, support / survivor): `reference.ts`, portrait
  `public/heroes/Doctrine.png` (128×128 from the supplied art), `HERO_BREAKDOWN_ORDER`,
  catalog (6 tiles), `/test-breakdowns` map. Identified correctly on every summary,
  breakdown and scoreboard slot in the test set (SDR and HDR), with no false positives.
  ⚠️ Its breakdown leaves **R2C3 empty** and continues on row 3; the positional catalog
  can't express that, so the label-OCR-failed fallback is wrong for its row-3 tiles (noted
  on the catalog entry; follow-up task raised).
- **Grímsvötn** (escort, Iceland): `MAPS` + `findMapName` keywords `GRIMSV` / `GRÍMSV`.
- **Roadhog**: catalog 7 → 8 tiles in the new order. `AVERAGE TRASH COMPACTED` (new, percent)
  and `ULTIMATES NEGATED` added; `WHOLE HOG KILLS` retired but kept in
  `HERO_BREAKDOWN_ORDER` for earlier matches.
- **Sombra**: new 8-tile kit (Cyberspace Damage/Healing, Hotfix Healing, Health Packs Hacked,
  Critical Hit Accuracy; support tile `PLAYERS SAVED` replaces `FINAL BLOWS`/`SOLO KILLS`);
  old stats kept for her earlier matches. Catalog entry moved to the support section.
  Her role change is §5.

**Singular at 1.** `HEALTH PACKS HACKED` (Sombra) and `ULTIMATES NEGATED` (Roadhog, and the
heroes that already had it) show singular at exactly 1 on screen. Neither noun is the
trailing KILL(S)-type word nor a leading PLAYER/ENEMY, so the count-grammar rules never
reached them. `breakdown-ocr.ts` now has `PHRASE_FORMS` (whole-phrase singular/plural pairs,
applied by `applyCountGrammar`) and matching-only folds `PACKS→PACK`, `ULTIMATES→ULTIMATE`,
so `HEALTH PACK HACKED` / `ULTIMATE NEGATED` are stored at 1 and fold to the plural in
`STAT_NORMALISE` and `hero_stats_normalised` (§7b). Every other new name has no plural.

**DB change?** Yes — `hero_role_ref` / `hero_role_history` (§7) and two folds (§7b).

### 5. ⭐ Sombra moved from DPS to support — a hero's role now depends on the date

**Symptom.** Season 5 moved Sombra to support (tactician). Every role lookup in the app was
a fixed hero → role map: switching it would have rewritten her history (old boards 1-1-3,
DPS-era games in support pools, the wrong share metric); not switching it saved her support
games as DPS.

**Fix.** The role belongs to the MATCH.
- `reference.ts`: `Hero.previously` records earlier roles with the date they ended
  (Sombra: `dps` / recon until `2026-10-06`). `heroRoleAt(name, playedAt)` returns the role
  on that date (UTC calendar day of `played_at`, the same day boundary as
  `get_season_for_date`); `heroRoleEras()` lists them.
- `/process` re-derives EVERY saved scoreboard row's role, and the team comps, for the
  match's date — not just audit-corrected rows.
- `HERO_ROLE_MAP` (scoreboard-extractor) is now built from `HEROES` instead of being a
  second hand-kept list. Runbook Step 2 retired.
- Date-aware: Home appearances, Matches hero buckets, Combat 6v6 role filter
  (`HeroRoleLookup`), Feel (now selects `played_at`), Heroes list (role = most recent game
  in scope; role tiles for every role held).
- Matchups keeps the eras apart: `applyRoleEras()` renames rows from an earlier role to
  `"Sombra (DPS era)"` at load, and re-derives pair roles by date, so the page is right
  before and after the SQL. Suggestions iterate the current roster → current era only.
  `heroPortrait()` strips the era label.

**Validated.** `/testing`, all 10 Season 5 runs: both teams 1-2-2 (were 1-3-1), every Sombra
saved as support, heroes unchanged.

**Files.** `reference.ts`, `scoreboard-extractor.ts`, `process/page.tsx`, `page.tsx`,
`matches/page.tsx`, `combat/*`, `feel/page.tsx`, `heroes/page.tsx`, `matchups/*`,
`hero-image.ts`. **DB change?** Yes (§7).

### 6. Hero pages: kits and roles that change between seasons

- **Hero page** (`/analytics/heroes/[name]`): **Season filter** added, defaulting to the
  current season (it had none — it always averaged a hero's whole history). Role stats get
  one block per role held in the games in view. The breakdown splits into **Current kit**
  and **Retired** (`isCurrentKitStat()`: in `HERO_BREAKDOWN_ORDER` but no longer in the
  catalog — Whole Hog Kills, Sombra's DPS kit, and the five tank ultimates dropped in
  v1.1.1); retired stats show only when the games in view hold them. Every stat line has a
  **Games** column, because current and retired stats average over different games. Header
  shows "Formerly DPS until 6 Oct 2026".
- **Hero Compare**: per-slot (and shared) **Season** filter, current-season default, so one
  hero can sit either side of a rework. Role rows follow each column's games; retired
  stats labelled, and dropped when no slot has a value.
- **`/testing`**: "COPY hero role SQL" now regenerates both role views.

**Files.** `heroes/[name]/page.tsx`, `hero_compare/page.tsx`, `hero-stat-catalog.ts`,
`new-content-readiness.ts`, `testing/page.tsx`. **DB change? No.**

### 7. Database — Season 5 SQL (Supabase SQL editor, one transaction)

One transaction (session pinned to UTC); every check must pass or nothing is kept, and it
ends by returning "all checks passed — changes saved". A read-only query run first saved
the previous `hero_role_ref` / `matchup_rows` / `matchup_user` definitions as rollback
statements. The script itself was run from the chat and not kept in the repo.
1. **`hero_role_history`** (new view): every hero's role over time, `[valid_from, valid_to)`.
2. **`matchup_rows` / `matchup_user`** join `hero_role_history` on hero AND game date. Edited
   from their LIVE `pg_get_viewdef` text; the script stops, changing nothing, if any other
   view reads `hero_role_ref` or the join isn't the expected one.
3. **`hero_role_ref`**: 54 heroes, current roles (Doctrine added, Sombra support), still one
   row per hero so no consumer can double-count.
4. **Data fix**: Season 5 Sombra rows saved with a non-support role → `support`, and those
   matches' team comps rebuilt.
5. **Checks**: 54 unique heroes; Sombra/Doctrine support; history covers every hero with no
   overlapping ranges; `matchup_rows`/`matchup_user` row counts unchanged; no new null
   `anchor_role`; every dated Sombra row DPS before 2026-10-06 and support from it; no
   Doctrine row flagged `hero_role_unknown`.

### 7b. Database — singular/plural folds in `hero_stats_normalised`

A second transaction, run after §7. Adds a `WHEN` fold for each singular form not already
in the LIVE view (built from its own `pg_get_viewdef`, reusing its own left-hand
expression): `HEALTH PACK HACKED` and `ULTIMATE NEGATED` (new in this patch), and — only if
missing — `CHAIN HOOK KILL`, `EMP KILL`, `PLAYER SAVED`, `PLAYER PROTECTED`. Stops if the
view doesn't have exactly one `ELSE`. Checks: every fold present; row count unchanged; no
row's `stat_canonical` changed except rows whose raw name is one of those singulars.
**Outcome:** the live view already had `ULTIMATE NEGATED` and the four KILL/PLAYER folds, so
only `HEALTH PACK HACKED` was added. (The database was again ahead of the code: the app had
been saving `ULTIMATES NEGATED` as plural even at 1 until this patch.)

> **Run notes.** The first attempt at §7 stopped on a PL/pgSQL name clash — a record
> variable `b` shadowed the table alias `b` in the overlap check — and, being one
> transaction, changed nothing. Renamed (`snap`, `h1`/`h2`) and re-run cleanly. Before
> running, a read-only query saved the previous `hero_role_ref` / `matchup_rows` /
> `matchup_user` (and, for §7b, `hero_stats_normalised`) definitions as rollback
> statements. The live definitions matched what the scripts expected.

### 8. ⭐ Bulk session upload — a whole session at once, in any order

**Why.** Logging one match at a time (upload wizard per game) is tedious. The match-history
screens (Summary / Teams / Personal) use the same layout the pipeline already reads, so a
whole session can be screenshotted afterwards and uploaded in one go. The PS App → Photos
path doesn't preserve order, names or dates, so the app has to work out which screenshot
belongs to which match from what's ON them.

**Decisions (user, 7 Oct 2026).** No per-match questions in bulk mode (columns left NULL;
earlier answers stay in analytics). Returned leavers and throwers can't be seen on a
screenshot and are accepted as lost; PERMANENT leavers are detected from the Teams page.
No per-slot hero review this season — replaced by an automatic 5v5 team-shape check. A
grouping preview before anything is processed. Unsure digits don't hold a match. The
per-match upload, its questions and review stay exactly as they were.

**Flow.** `/upload` → "Or upload a whole session" → pick any number of screenshots → one
storage folder `pending/session-<ts>/` (`metadata.json` `{ kind: 'session', upload_complete,
photo_count, uploaded_count }`; written first as incomplete, rewritten complete at the end;
each photo keeps its own number so a retry can't overwrite one that uploaded). `/process`
lists sessions separately → **Open session**:
1. **Read** every screenshot once (`session-fingerprint.ts`) — no hero portrait matching:
   - page type from the ACTIVE NAV TAB (`classifyByTabs`): the active box reads
     11,000–15,800 bright-blue px, the others ≤ 34. Needs no red enemy block, so a Teams
     page whose enemy rows all left still classifies.
   - **Summary:** map, result, score, date/time, length, E/A/D (existing `ocrSummaryPage`), and
     each filled hero slot's % played + play time — the Summary slots use the SAME tile
     layout as the Personal page's hero tile (identical offsets from the portrait), so the
     proven hero-info reader reads both (`readHeroTiles`, `summaryHeroTileOrigin`).
   - **Personal:** % played + play time, and the left **sidebar**: every hero played that
     match (OCR of each button with text, matched to `HEROES`), the highlighted one being
     this page's hero. Measured: buttons x 100–740, first at y 534, every 150 px; the
     highlighted button ≥ 94 % bright blue, others 0 %; a one-hero match shows an empty
     second button; the list ends at ALL HEROES.
   - **Teams:** `measureTeamsPage` — rows per side counted from ROLE ICONS (one white icon per
     row, team from the row's own colour at x=1800), so any number of rows works, including
     none; the user's row is the ally row with the brighter E/A/D cell background; its E/A/D
     read with the existing three-cut-off cell reader.
2. **Group** (`session-grouper.ts`, pure): Summary anchors a match (date/time); Teams page joins
   by the user's E/A/D; Personal pages join by % played + play time against Summary slots,
   then the rest through identical sidebars. Exact agreement or a **leftover** with a reason —
   never a guess (two matches with the same E/A/D → leftover). Repeats are detected.
   Format and leavers from row counts: a side with fewer rows than the format had a
   permanent leaver (the history board drops the row entirely).
3. **Preview** (`SessionPreview.tsx`): one card per match with thumbnails, format, leaver
   badge, red "will be held" reasons, amber notes; leftovers and repeats can be placed into a
   match or ignored (re-runs the grouping with `ManualPlacements`). Matches whose date/time is
   already saved are skipped (`matchQuery`, so the alpha rule applies).
4. **Process** each match with the unchanged `processMatchPhotos`, format passed in; a leaver
   game's Teams page is left out (scoreboard not used, as for any permanent leaver).
   `applyMatchDateRoles` (now shared with `onAuditComplete`) sets each row's role for the
   match date. `sessionMatchMetadata` builds what the wizard used to supply (role from the
   heroes played at the date; leavers; no questions).
5. **Auto-save gate** (`sessionMatchExceptions`): saved without review unless — grouping issue
   (no Teams page, format unclear, date/map/result unread), map/result/date unread after
   processing, no heroes, 5v5 heroes spanning two roles, the user's scoreboard row
   unresolved, or **5v5 team shape not 1-2-2 on both sides**. Held matches go through the
   existing review with "Held for checking" reasons shown. On the beta season's 93 matches
   the 1-2-2 rule would have held 7 of the 10 matches with hero errors (15 of 18 errors).
6. **Clean-up**: each saved match's screenshots are deleted by `saveMatch` as before. What's
   left (leftovers, repeats, unsaved) stays for next time unless the user presses
   "Delete remaining"; an empty session folder is closed automatically.

`/testing` gains a **Session mode (order-free)** checkbox that groups with the same reader and
grouper and shows held reasons, notes and leftovers — nothing is written.

**Validated.** Grouper: 19 Node tests (shuffled session, 4-hero match placed via sidebar,
5-v-3 leaver, 6v6 with/without leavers, E/A/D tie → leftover, repeats, hand placement,
ignore). Reader + grouper on real screenshots (`/testing` session mode): the 5 Season 5
matches, HDR on, 16 screenshots shuffled and renamed `IMG_9000…` — every screenshot placed
in the right match, no leftovers; every sidebar hero, % played, play time, user row and E/A/D
read correctly; the quick-play Gibraltar game held (no date — expected). PROCESS ALL on the
groups: all recognised, 1-2-2 both sides, breakdown values unchanged.
Two reader fixes came out of that run: the highlighted sidebar button (white on bright blue)
didn't OCR — every sidebar label is now recoloured black-on-white first
(`ocrImageRegion(…, whiteText)`); and the Summary date key stores only the
`MM/DD/YY - HH:MM` pattern (a Summary with no FINAL SCORE line reads "GAME MODE: …" there,
which two different matches could share).

**Files.** New: `src/lib/session-fingerprint.ts`, `src/lib/session-grouper.ts`,
`src/lib/session-match.ts`, `src/app/process/SessionPreview.tsx`. Changed: `upload/page.tsx`
(session screens + link), `process/page.tsx` (sessions, preview, run loop, held reasons,
summary; file listing limit 100 → 1000), `testing/page.tsx` (session mode),
`image-processor.ts` (`classifyByTabs`, `summarySlotsFilled`), `breakdown-ocr.ts`
(`readHeroTiles`, hero-tile origins), `ocr-extractor.ts` (`ocrImageRegion`),
`scoreboard-extractor.ts` (`measureTeamsPage`). **DB change? No** — storage only.

### 9. ⭐ The 40-game test — results, and the fixes it produced

The user captured **40 competitive games, HDR on: 10 each as tank, DPS, support and 6v6**
(150 screenshots). Each set was shuffled, run through `/testing` session mode, then
PROCESS ALL.

**Grouping — 40/40 matches, nothing misplaced.** Tank 43/43 screenshots placed (including a
4-hero and a 5-hero game joined via the sidebar); DPS 37/37; support 33 placed + 4 repeats
caught (a second copy of one match's pages); 6v6 37/37. Leavers detected from row counts:
5v4 and 4v5 (support), 5v6 and 6v0 (6v6). No leftovers, no format guesses — the 6v6 pitch
measured 116–121 px against 128–141 px for 5v5, so `SIXV6_MAX_PITCH = 124` holds.

**Processing.** Every non-leaver board read 1-2-2 (2-2-2 in 6v6, plus one real 2-1-3 enemy
team, confirmed from the icons); Sombra and Doctrine read as support; every breakdown read
all its stats. The ⚠ marks on some scoreboard heroes are low-confidence flags only — the
heroes checked were correct.

**Fix 1 — a "NEW CAREER BEST!" tile broke the breakdown label fallback.**
*Symptom:* 6v6 Midtown, Orisa: `UNKNOWN_TILE_R3C1 = 22` (7/8 stats). *Root cause:* the label
OCR failed on that tile, and the fallback names a tile by its POSITION in the hero's usual
order, but the game had moved the career-best tile first, so the positions no longer lined up.
*Fix:* `ocrBreakdownPage` now resolves label-failed tiles **by elimination**: if exactly one
expected stat is still unclaimed and its type fits the value (number / % / time), it takes
that name. *Result:* PLAYERS PROTECTED = 22, 8/8. *File:* `breakdown-ocr.ts`.

**Fix 2 — heroes beyond the top 3 weren't recorded.**
*Symptom:* tank Shambali (4 heroes) and Midtown (5 heroes): the extra Personal pages were
grouped correctly, but only 3 heroes were saved (Midtown's % played added up to 89).
*Root cause:* `processMatchPhotos` only assigns breakdowns to heroes found on the Summary,
which shows at most 3. *Fix:* new optional `extraHeroes` argument. Bulk mode passes the sidebar's
names for a 4+-hero match (`sessionExtraHeroes`); those become extra assignment candidates,
and each one whose breakdown is assigned is added to `heroes`, so it gets a
`hero_performances` row and its stats. It is only used for 4+ heroes, so a Summary misread
is never "corrected" by it. *Result:* Shambali 4/4 heroes, Midtown 5/5 (% now sums to 100).
The per-match upload is unchanged (it doesn't pass the argument).
*Files:* `image-processor.ts`, `session-match.ts`, `session-grouper.ts` (preview note),
`process/page.tsx`, `testing/page.tsx`.

**Fix 3 — Echo's "STICKY BOMBS KILLS" was never folded** (pre-existing).
*Symptom:* both Echo games flagged "new stat name". *Root cause:* the game prints STICKY
BOMB**S** KILL(S); the fold list only had STICKY BOMB KILL(S), so the stat never matched
Echo's breakdown display entry (`STICKY BOMB KILLS`). *Fix:* both forms folded in
`stat-meta.ts`, and the same fold added to `hero_stats_normalised` (§9b).

**Fix 4 — Genji's "ULTIMATE REFLECTED" at 1.** The game says ULTIMATE (singular) at 1, the
same as Ultimates Negated. The name lists already folded both forms, but the reader always
saved the plural. *Fix:* added to `PHRASE_FORMS` (`breakdown-ocr.ts`); DB fold added in
§9b if it was missing.

**Seen, not fixed (low impact).** The "AVG PER 10 MIN" sub-line misread on 3 of Orisa's
tiles (e.g. "6.11" → "4"). It is saved as raw text (`hero_stats.avg_per_10_min`) and no
analytics page reads it, since per-10 figures are worked out from value ÷ game length. Its
only use is the beta-confirmation cross-check, which isn't part of bulk mode.

**Still open:**
- **Held for "format unclear" / "date not read":** the review screen has no format or date
  control (`saveMatch` uses the grouper's guess / the process time). This didn't happen in
  the 40 games.
- **Gapped breakdown grids** (Doctrine leaves R2C3 empty). The elimination fallback (Fix 1)
  now covers a single label failure anywhere in the grid. A follow-up task was raised for the
  positional fallback itself.

### 9b. Database — Echo and Genji folds in `hero_stats_normalised`

Same pattern as §7b, one transaction. It reads the LIVE view definition, then adds
`STICKY BOMBS KILL(S) → STICKY BOMB KILLS` and (only if missing)
`ULTIMATE REFLECTED → ULTIMATES REFLECTED` just before its `ELSE`. Checks: row count
unchanged; only rows with those raw names change; every one of them now folds to the
canonical name. Anything unexpected → it stops and nothing changes.
**Outcome (run and confirmed):** all checks passed. The live view already folded
`ULTIMATE REFLECTED`, so only the Echo fold was added. **7 saved Echo rows** that had been
stored as `STICKY BOMBS KILL(S)` now count as `STICKY BOMB KILLS`, so they show on Echo's
hero page for the first time.

**Cleanup.** The in-project test screenshot copies (`Season 5 test/`, `public/_s5test/`,
`public/_bulktest/`) were deleted along with their `.gitignore` lines. The originals are
kept outside the repo.

### 9c. Feel and Builder retired (kept, not deleted)

Bulk upload has no questions, so from Season 5 the per-match questions are retired, along
with the two analytics pages built on them: **Feel** and **Builder**. Both still work for
past seasons. In the analytics bar along the top they move to the right-hand end, in a
dimmer shade. On the Analytics overview and Home they move to their own **Retired**
section at the end, in dimmer cards, with a one-line note on why. To retire another
page, set `retired: true` on it in `ANALYTICS_GROUPS`.
*Files:* `components/AnalyticsNav.tsx`, `analytics/page.tsx`. **DB change? No.**

---

## v1.1.5 — 19 August 2026

Fixes a 5v5 match that saved as 6v6 and took every row and column with it, the phone step
that refused to read a scoreboard it could see, and a summary stat that returned null
whenever it was a career best. One cause under the first three: **the ally block on the
scoreboard is now taller than any board the pixel windows were calibrated against.**
**DB change? No** — the one bad match was deleted in-app and re-uploaded.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Extraction | 5v5 match saved as 6v6; 12 rows read off a 10-row board, MIT/H clipped on every row | Enemy-block scan ceiling 1400 → 1500 | No |
| 2 | Extraction | Format derived from pixels could overrule the format the user picked | Wizard's answer passed in and used outright | No |
| 3 | Extraction | Ally-block scan had 34px of headroom left | Ceiling 1250 → 1350 | No |
| 4 | Extraction | A failed boundary scan silently substituted a constant that means 6v6 | Both fallbacks now `console.error` | No |
| 5 | Phone | "Can't read the scoreboard" on a valid board; standouts fell back to the numeric grid | Per-format gap probes; 6v6 row untouched | No |
| 6 | Phone | 5v5 ally crop sliced 38px off the user's own row | Lower bound 0.545 → 0.567 | No |
| 7 | Summary OCR | Assists stored null on a career-best game | Locate the numeral instead of assuming its offset | No |

---

### 1. ⭐ Two pixels made a 5v5 match save as 6v6

**Symptom.** A 5v5 Lijiang Tower win, with 5v5 explicitly selected on the phone, saved as
6v6. Comps came back `1-3-2` / `1-2-3` — impossible in either format. Four of the twelve
scoreboard slots held all-zero or punctuation-only stats, and every MIT value on the board
was truncated.

**Root cause.** `detectScoreboard()` locates the enemy block by scanning down x=1800 for the
first red pixel:

```ts
for (let y = 1250; y < 1400; y++) { ... }   // last y tested = 1399
if (enemyStartY === 0) enemyStartY = 1330   // fallback
```

Measured on the board in question, at x=1800:

| band | y range |
|---|---|
| ally blue | 478 – 1214 |
| VS gap | 1215 – 1400 |
| **enemy red** | **1401 – 2036** |

The first red pixel is at **y=1401**. The scan stops at 1399. It misses by two pixels, finds
nothing, and falls through to the 1330 constant — 71px above the real block.

**The fallback pair is not neutral.** `allyEndY` falls back to 1183 and `enemyStartY` to
1330, a gap of 147, which is ≤ the 173 threshold. A failed boundary scan therefore does not
produce "unknown" — it produces **6v6**, every time.

Everything downstream is arithmetic from there. `vsGapHeight` came out 114 instead of 185
(the true value, comfortably inside the 5v5 population of 177–186 — the v1.1.3 threshold move
is irrelevant here, because the number fed to the threshold was a constant, not a
measurement). `rowsPerTeam` became 6:

- Ally grid `478 + (738/6)·i` → centres 540, 663, 786, 909, 1032, 1155 against real centres
  553.5, 705.5, 858.8, 1011.8, 1151.5. Slots 3 and 4 **both landed inside real row 3**; slot 3
  sat 4px below that row's top edge and found no role icon.
- Enemy grid `1330 + (707/6)·i` → centres 1389, 1507, 1625, 1743, 1860, 1978. Slot 7 landed
  **12px above the red block, inside the VS gap** — a phantom row. The five real rows were
  offset +43, +35, +25, +14, +4px, and that monotonic decay is exactly why slot 8 read zeros,
  slot 9 read punctuation, slot 10 read partials, and 11/12 read clean.
- `SCOREBOARD_COLUMNS_6V6` was applied to a 5v5 table. MIT read window 2520–2690 instead of
  2580–2750. Measured ink extents prove the clip to the glyph:

| row | MIT truth | ink x-span | past the 2690 edge | read as |
|---|---|---|---|---|
| ally 1 | 14,018 | 2619–2721 | 31px | `"14.0"` → 14 |
| ally 5 | 2,015 | 2627–2711 | 21px | `".2.01"` → null |
| enemy 4 | 0 | 2660–2677 | fits | `"0"` → 0 ✓ |
| enemy 5 | 892 | 2641–2698 | 8px | `"89.."` → 89 |

**Fix.** Ceiling 1400 → 1500. The loop breaks at the first hit, so raising the ceiling
**cannot change any board that already found one** — every 6v6 board finds its edge at
~1312–1350 and returns byte-identical. Safe by construction, not by testing.

**Why it had never fired.** The v1.1.3 corpus records the ally block reaching y=1184 at
worst across 27 boards. This board ends at 1214 — 30px past that — which puts the enemy block
at 1401. Its ally rows measure 151 / 153 / 153.5 / 153px against the ~141px the corpus
implies, with the fifth clipped to 126.5px. The block is growing.

**Files.** `src/lib/scoreboard-extractor.ts`.

---

### 2. The format was being guessed when the answer was already known

**Symptom.** None on its own. It is what turned change 1 from a bad row grid into a
corrupted match record.

**Root cause.** The user picks 5v5 or 6v6 in step one of the upload wizard, before they
queue. That answer sat in `batch.metadata.match_format` and was used only as a *fallback*:

```ts
const matchFormat = processed.matchFormat || meta.match_format || '5v5'
```

A pixel measurement outranked a certain answer the user had typed in. The format decision
sets `rowsPerTeam` AND swaps every x-constant at once, so it is the highest-blast-radius
single decision in the pipeline — and it was being re-derived for no benefit. Re-deriving a
known value can only ever agree or be wrong.

**Fix.** The format now goes IN rather than being guessed back out.
`processMatchPhotos(urls, onStatus, role?, gamertag?, formatHint?)` passes it to
`classifyImage`, which passes it to `detectScoreboard(img, formatHint)`. When the hint is
present the VS-gap measurement **does not run at all**. Save-time precedence flipped to
`meta.match_format || processed.matchFormat || '5v5'`; the two now agree by construction on
the `/process` path, and the order is belt-and-braces for any future caller that forgets.

⚠️ **The derived path survives for `/testing` only**, which uploads bare files and has no
answer to pass — a detection harness should exercise detection. `/process` must always pass
the hint. Do not put the derivation back on the road to the database.

**Files.** `src/lib/scoreboard-extractor.ts`, `src/lib/image-processor.ts`,
`src/app/process/page.tsx`.

---

### 3. The ally-block scan had 34px of headroom left

**Root cause.** `for (let y = 1050; y < 1250; y++)`, ceiling set from a corpus whose worst
case was 1184. The board that triggered this patch ends at 1216.

**Fix.** Ceiling 1250 → 1350. Same break-on-first-hit argument as change 1: no board that
already found its edge can behave differently.

**Files.** `src/lib/scoreboard-extractor.ts`.

---

### 4. Both boundary fallbacks now fail loudly

**Root cause.** `if (allyEndY === 0) allyEndY = 1183` and `if (enemyStartY === 0)
enemyStartY = 1330` substituted a plausible number and carried on. Nothing in the log said a
measurement had been replaced by a guess — the run looked normal and the geometry line
printed a table position it had derived from the guess.

**Fix.** Explicit `allyEndFound` / `enemyStartFound` flags. A failure emits `console.error`
naming the search window and stating that every row position on the board is now unreliable,
and pushes a `⚠️ … NOT FOUND` entry into `signals` so `/testing` shows it.

**Files.** `src/lib/scoreboard-extractor.ts`.

---

### 5. The phone rejected a scoreboard it could see

**Symptom.** `/process` reported it could not read the scoreboard and fell back to the bare
numeric slot grid for the impressed-ally and enemy-struggle questions. `/testing` read the
same three photos without complaint.

**Root cause.** `phone-scoreboard-detect.ts` requires **3/3** dark pixels at
`GAP_Y = [1200, 1240, 1290]`. On this board the ally block runs to y=1214, so:

| probe | pixel | dark? |
|---|---|---|
| 1200 | `(0, 140, 193)` | ✗ — inside the ally block |
| 1240 | `(11, 17, 33)` | ✓ |
| 1290 | `(11, 17, 33)` | ✓ |

2/3 against a 3/3 rule → rejected. The extractor's own probes are `[1180, 1220, 1260]` and
need only **2/3**; it also scored 2 (1180 is likewise blue) and passed. One shifted layout,
two surfaces, opposite verdicts.

**Fix.** `GAP_Y` becomes per-format. **The 6v6 row is unchanged and must stay that way** —
1200/1240/1290 is the value that fixed the 9-of-27 failure in v1.1.3. 5v5 gets
`[1240, 1275, 1310]`. `detectScoreboardCrops` already receives the format, so the two boards
are now probed in their own places instead of in one shrinking overlap.

⚠️ **One 5v5 board has been measured at the new ally height.** Its gap is 1215–1400; the
corpus puts the earliest gap end at 1312, so the defensible intersection is 1215–1312 and the
three probes sit inside it with 25px at each end. Re-measure against a pre-19-Aug 5v5 board
before treating this row as settled.

**Files.** `src/lib/phone-scoreboard-detect.ts`.

---

### 6. The 5v5 ally crop sliced the user's own row

**Root cause.** `CROPS['5v5'].ally = [0.215, 0.545]`. 0.545 is y=1177 and the ally block now
reaches 1214, so the crop cut 38px off the last ally row — which is the user's own, and the
one the standout question most often concerns.

**Fix.** Lower bound 0.545 → 0.567 (y=1225), clearing the block by 11px. 6v6 untouched.

**Files.** `src/lib/phone-scoreboard-detect.ts`.

---

### 7. A green badge moved the summary digits

**Symptom.** `[ocr-extractor] assistDigits: value 415 out of range` → assists stored null,
on a board where eliminations and deaths read perfectly.

**Root cause.** The three summary stat cards are a fixed 470px tall (y=486–955, 968–1437,
1450–1919), but their CONTENTS are centred as a group inside the card. A card that earns a
green **NEW CAREER BEST!** badge gains a fourth line, the group grows, and everything above
the badge is pushed UP by half the growth.

| tile | badge | digits at | offset from card top |
|---|---|---|---|
| ELIMINATIONS | no | 643–690 | 157 |
| **ASSISTS** | **yes** | **1087–1134** | **119** |
| DEATHS | no | 1607–1654 | 157 |

The fixed crop `assistDigits: { y: 1124, h: 76 }` therefore contained the bottom 11px of
"18", then 35 rows of empty card, then the top of the "ASSISTS" label from y=1172. That mush
read as `415`, which failed the 0–150 sanity bound and stored null.

⚠️ **This was never an assists bug.** The badge lands on whichever stat the user set a career
best in; two badges break two stats. It only looked assists-specific because that is where
the career best was.

The region comment already noted `h=76` was chosen to cover "both layouts (with/without
avg-per-10 line)" and bought slack accordingly. The badge is a THIRD layout and needs 37px
more than that slack. **The height was never the problem — the top edge was.**

**Fix.** `y` is now a search ANCHOR, not a crop top. `findDigitBand()` scans −80/+140 around
it and crops the first band of bright pixels, which is always the numeral because the label
and avg line follow after a gap. Those windows stay well inside their own cards, so no stat
can pick up a neighbour's digits. A scan that finds nothing falls back to the old fixed crop
**and logs it**. All vertical distances are scaled by `imgH / REF_H`, matching
`scaleRegion()`.

This mirrors what `breakdown-ocr`'s hero-info scan already does — the breakdown page on this
same match carried FIVE badges and read 8/8 stats, because it finds text bands instead of
trusting fixed offsets. The problem was already solved one file over.

Verified against the real screenshot: crops move to y=637/1081/1601 (h=60), each fully
enclosing its numeral.

**Files.** `src/lib/ocr-extractor.ts`.

---

### What this one teaches

v1.1.3's lesson was *a verification whose outcome is guaranteed is not a verification*.
v1.1.4's was *a guard is scoped to a field, not to a cause*. This one:

**A calibrated window is a claim about a corpus, and corpora go stale.**

Every window in this patch was correct when it was measured and correct on every board it was
measured against. The scan ceilings, the gap probes, the crop fractions, the stat-tile
offsets — none of them were wrong. The game's layout moved out from under all four at once,
and each failed in the manner its own fallback dictated rather than in the manner that would
have been noticed. The enemy scan fell back to a constant that means 6v6, so a 5v5 board
became a 6v6 board. The phone probe failed closed, so a real scoreboard became "not a
scoreboard". The stat crop returned a number outside its sanity bound, so a career best
became null. Three different disguises, one shared cause.

The ally block was 30px outside a 27-board corpus, and nothing anywhere reported that a
window had been used near its edge.

*A window that has never been observed close to its limit has not been shown to have margin —
only that nothing has yet tested it.*

---

### Deploy checklist — v1.1.5

Files to ship: `src/lib/scoreboard-extractor.ts`, `src/lib/image-processor.ts`,
`src/lib/phone-scoreboard-detect.ts`, `src/lib/ocr-extractor.ts`,
`src/app/process/page.tsx`.
Docs updated: `PATCH-NOTES.md`, `FILE-MAP.md`.
No SQL, no DB, no `Supabase Map.md` change.

Before commit: `npm run build` (typecheck + lint clean), then commit + push (Vercel
auto-deploys).

Post-deploy:
1. `/process` a real 5v5 — confirm the format chip matches the phone selection, comps are
   1-2-2, ten slots, and the standouts step shows team crops rather than the numeric grid.
2. **`/process` a real 6v6** — the corpus staleness that caused this patch has not been
   checked against 6v6. If its ally block has grown the same way, it will misplace rows while
   still reporting the right format, because the fallback pair means 6v6. Nothing in the app
   will look wrong. Check the row stats against the screenshot by eye.
3. Confirm E/A/D on a game with a NEW CAREER BEST badge on any of the three tiles.

⚠️ Outstanding, not fixed here: the ally row grid still divides the block evenly, and the
fifth ally row is clipped 26.5px short, so centres drift to −17px by row 4 (portrait is 122px
in a 153px row). Survivable, measured, and needs more than one board to calibrate a fix.

---

## v1.1.4 — 18 August 2026

Closes a scoping bug in the permanent-leaver scoreboard discard: it nulled the board but not
the three values already derived from it. **DB change? Data only** — five historical rows
repaired by hand; no table, view, column or RLS touched.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | `/process` | Leaver games stored impossible team comps and let detection override the phone's format | Extend the discard to `allyComp`, `enemyComp`, `matchFormat` | Data only |

---

### 1. The leaver discard nulled the board but kept what the board had produced

**Symptom.** Match 296 (Midtown, 16 Aug, enemy permanent leaver) saved as 6v6 when 5v5 was
selected on the phone, and carried comps of `2-2-2` / `0-3-3` — a tankless enemy team of six,
in a game where an enemy had permanently left. Four older leaver matches (224, 213, 160, 103)
carried the same signature at 5v5: ally `1-2-2`, enemy `0-3-2`.

**Root cause.** `/process` discards a permanent leaver's scoreboard because the missing row
makes the board asymmetric and the VS-gap grid can no longer say which slot is which:

```ts
const result = isLeaverGame ? { ...rawResult, scoreboard: null } : rawResult
```

`allyComp`, `enemyComp` and `matchFormat` are declared **alongside** `scoreboard` on
`ProcessedMatch`, not inside it — but all three are assigned in the same Step 8 block that
builds the board, from the same pixels. Nulling one field left the other three to survive the
spread, and `saveMatch` wrote them verbatim.

`computeTeamComp` counts only slots whose role classified, so a tankless team at *full size*
means the leaver's row was still on the board and its role icon failed to classify. The
derivation was faithful; the board should never have been read.

⚠️ **`matchFormat` is the one that did damage.** `saveMatch` reads
`processed.matchFormat || meta.match_format`, so pixel detection outranked the user's own
selection on exactly the games where the board is asymmetric and the format discriminator
cannot be trusted. Whether that is what flipped 296 is **not established** — the stored comp
shows six classified enemy slots, which fits both a misdetected 5v5 board and a real 6v6 board
with the leaver's row still rendered. The database cannot separate them and no guess is
recorded here.

**Fix.** The discard now covers all four fields, with `matchFormat` falling back to
`batch.metadata.match_format` rather than null — the phone becomes authoritative on leaver
games, and the review card keeps its format chip.

**Returned leavers are untouched.** `discardsScoreboard()` already returns false for
`'returned'`, and match 294's stored comps were verified against its own scoreboard rows
(`1-2-2` / `1-2-2` both teams, zero unclassified slots, ten slots) before the exemption was
allowed to stand.

**Files.** `src/app/process/page.tsx`.

**Data repair.** 296 corrected by hand to `5v5` with both comps nulled; 224, 213, 160 and 103
had comps nulled. Recorded here because a manual edit leaves no trace in git.

```sql
update matches set ally_team_comp = null, enemy_team_comp = null
where id in (224, 213, 160, 103)
  and (ally_team_comp is not null or enemy_team_comp is not null);
```

**Also established while investigating.** Across every non-alpha match that *has* a
scoreboard, the stored comp matches what its own rows derive — zero disagreements. Comp
derivation is sound; the defect was entirely upstream of it. ⚠️ That check inner-joins
`scoreboard_players`, so the five leaver matches have no rows, never enter the join, and are
**invisible to it by construction**. It says nothing about the population this patch changed.

### What this one teaches

v1.1.3's lesson was *a verification whose outcome is guaranteed is not a verification*. This
one is its structural cousin:

**A guard is scoped to a field, not to a cause.**

The discard was written against `scoreboard` because that is where the untrustworthy data
lived when the line was authored. Three values were later lifted out of the board into
sibling fields — each individually reasonable — and every one of them stepped outside the
guard's reach without stepping outside its intent. The comment above the line even claimed
the win: *"everything downstream … correctly see 'no scoreboard' without any further
special-casing."* True of the object. False of what the object had produced.

*When something is discarded for being untrustworthy, ask what was already computed from it.*

---

## v1.1.3 — 16 August 2026

Fixes the scoreboard extraction geometry for **5v5**, which had been drifting silently and
had begun writing wrong heroes into saved matches. Also repairs two tile-ceiling defects,
two `/testing` instruments that were reporting nothing, and reworks the phone's standout and
leaver steps. **DB change? No** — one optional repair script for historical rows.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Extraction | 5v5 boards with short gamertags read almost every hero wrong | Derive all x-constants from the measured table edge, both formats | No |
| 2 | Extraction | `ORB HEALTH` counters read 0 on every run, healthy or dead | Emit the line — it never existed | No |
| 3 | Extraction | Icon-classifier accuracy unmeasurable by construction | Capture `iconRole` before the override | No |
| 4 | Extraction | Format threshold left 2px of margin on 5v5 | 175 → 173 | No |
| 5 | Audit | Team comps kept describing heroes the audit had corrected | Recompute in `onAuditComplete` | Script (optional) |
| 6 | Audit | No check that a competitive 5v5 comp is 1-2-2 | Non-blocking warning banner | No |
| 7 | Tile check | Question fired on sightings 1, 4, 7 instead of 3, 6, 9 | Pass the sighting NUMBER, walk the watched list | No |
| 8 | Tile check | Asked about a breakdown screen it never showed | Pass the image; withhold the question if absent | No |
| 9 | `/testing` | Score column pooled two incompatible scales | Explicit `Scale` column, per-scale means | No |
| 10 | Phone | Standout picks: no image, multi-select, manual UPLOAD | Two screens, one pick each, team crop shown | No |
| 11 | Phone | Issue steps always needed NEXT | "NOTHING" auto-advances; a real issue still needs NEXT | No |

---

### 1. ⭐ The 5v5 table moved 37px and nothing was watching

**Symptom.** Three consecutive matches at the start of Season 4 came back with the majority
of the ten scoreboard slots misidentified — most reading as the same wrong hero. The owner
hand-corrected ten of ten on one board.

**Root cause.** The scoreboard table is centre-anchored at x≈1919.5 and its WIDTH varies with
content, so its left edge moves. v1.1.1 established this and derived the 6v6 x-constants from
the measured edge. It exempted 5v5, on evidence:

> *"5v5's edge moves 4px, its constants are exact… deriving it would risk the one format that
> demonstrably works. `resolveFormatConfig` returns early unless the format is 6v6, so 5v5 is
> unaffected BY CONSTRUCTION, not by luck."*

**Every sentence of that was true, and the conclusion was wrong.** The 4px figure came from
seven boards that all happened to have long gamertags — therefore wide tables, therefore a
left edge sitting exactly on the hardcoded constants. Re-measured over 25 boards:

| set | n | table width | left edge | spread |
|---|---|---|---|---|
| 5v5 test corpus | 10 | 1698–1699 | 1070–1071 | **1px** |
| **5v5 real matches** | 3 | **1623–1698** | **1071–1108** | **37px** |
| 6v6 (all) | 12 | 1462–1563 | 1138–1188 | 50px |

At `tableLeft = 1108` the portrait sits ~36px right of the hardcoded `cropX = 1130`, so the
crop ate the role-icon box and clipped the face. Confirmed by reproducing the exact crop
rectangles from the failing board — pixel-identical to that match's audit thumbnails.

**Fix.** `TABLE_LEFT_BASELINE_6V6` → `TABLE_LEFT_BASELINE = { '5v5': 1070, '6v6': 1161 }`;
`resolveFormatConfig` shifts both formats. Kept in delta form rather than storing offsets:
identical arithmetic, but a board sitting ON its baseline stays byte-identical, which is what
makes a `/testing` diff readable.

**Verified.** 23 boards, flags off. Exactly three shared boards changed — precisely the three
at `tableLeft` 1071 — and every board at 1070 was byte-identical, both formats. **Zero hero
changes on any board that was already correct. 30/30 correct on the three that were broken.
250/250 overall**, audited slot by slot against the images rather than trusting the report.

⚠️ **The 5v5 test corpus spans ONE PIXEL and cannot reproduce this bug.** A geometry change
verified against it returns a no-diff and proves nothing — which is exactly what v1.1.1's
"all seven boards byte-identical" check measured. **A verification whose outcome is
guaranteed is not a verification.** The three real boards are now in the corpus as 5v5 Test
11–13; narrow-table boards must stay in it.

**Also in this file.** `ICON_X_START`/`ICON_X_END` deleted — they duplicated the 5v5 format
config AND served as default arguments, so a caller who forgot to pass silently got 5v5
constants on a 6v6 board. `classifyRoleIcon`'s unused 4th parameter removed; its presence
implied the window bounded the classification scan, which it does not, and that produced a
wrong diagnosis during this patch. Stale "51 heroes" comments → 53. A width-floor warning
below a 5v5 width of 1600 (see #12).

**Files.** `src/lib/scoreboard-extractor.ts`, `src/lib/types.ts`.

### 2. The ORB health check had never worked

**Symptom.** Every `/testing` run reported `ORB calls 0 / 0`, 0 fallbacks, 0 restarts,
0 degraded matches — on runs where ORB was demonstrably working.

**Root cause.** `FILE-MAP.md` line 1362 stated that `identifyHeroes` "emits the `ORB HEALTH`
summary line after Pass 2 and calls `resetOrbFailureCount()`". **It did neither.** Nothing in
the codebase emitted that line, so `/testing`'s `ORB_HEALTH_RE` never matched and every
counter defaulted to zero.

**Fix.** Emitter and per-match reset added. Verified live: **13,926 ok / 0 failed.**

**Files.** `src/lib/scoreboard-extractor.ts`.

### 3. Icon-classifier accuracy could not be measured, by construction

**Symptom.** The role classifier has been unreliable for a long time with no way to quantify
it.

**Root cause.** `overrideRolesFromHeroes()` rewrites every role to the identified hero's own
role. Its comment claimed this "ensures roles are always correct regardless of icon
classifier accuracy." It does not — it ensures they are always *consistent*, which is much
weaker. `identifyHeroes` is role-FILTERED, so a wrong icon role restricts the pool to the
wrong ~15 heroes, the matcher returns the best wrong hero, and the override rewrites the role
to match it. Self-consistent, wrong, and no trace that the icon ever failed.

This is why icon-derived and hero-derived team comps agreed on all 20 test boards: by the
time anything reads them they are the same quantity. **The agreement is guaranteed by
construction and proves nothing** — §12's rule again.

**Fix.** `iconRole` captured before the override, carried onto `ScoreboardPlayerStats` (which
reaches the audit and `saveMatch`; `roles` does not), and summarised as one
`ICON ROLE ACCURACY: n/m agreed, k overridden, j no-icon` line per run, rolled up by
`/testing`.

⚠️ It cannot separate "icon wrong" from "portrait wrong" — an override means one of the two.
But a rising count means one of them is degrading, which is more than existed before.

**Files.** `src/lib/scoreboard-extractor.ts`, `src/lib/types.ts`,
`src/app/review/HeroAuditPanel.tsx`, `src/app/testing/page.tsx`.

### 4. Format threshold sat 2px from a misread

**Symptom.** None observed — found while measuring.

**Root cause.** `vsGapHeight <= 175 ? '6v6' : '5v5'`. Measured across 25 boards, 6v6 runs
159–170 and 5v5 runs 177–186. The populations are 7px apart and 175 was not in the middle:
5px of margin on the 6v6 side, **2px** on the 5v5 side. One real board came in at 177.

A misread flips `rowsPerTeam` AND every x-constant at once, making it the
highest-blast-radius single decision in the pipeline — and it rests on one subtraction of two
single-column pixel scans.

**Fix.** Threshold 173, giving 3px and 4px. ⚠️ A second independent signal (row count, or
block-height ratio) is still owed.

**Files.** `src/lib/scoreboard-extractor.ts`.

### 5. Team comps kept describing the heroes you had just corrected

**Symptom.** None visible — a comp string looks plausible whichever heroes produced it.

**Root cause.** `allyComp` / `enemyComp` are computed in `image-processor.ts` from pre-audit
roles and are **not** among the four scoreboard arrays `onAuditComplete` corrects.
`saveMatch` wrote them verbatim, so every hero the audit fixed left the comp describing the
wrong one.

**Fix.** Recomputed in `onAuditComplete` from the corrected stats, before `saveMatch`. Only
overwritten when every slot on that side resolves — a partial recount would look real while
under-counting. No trigger or generated column is needed: the recompute runs before the
insert, so the first value written is already correct.

⚠️ **Historical rows are affected and the blast radius is probably not three matches.** The
3 Aug 2026 repair corrected `hero_name` and `role` on 324 slots across 27 6v6 beta matches
and noted that "everything downstream is a VIEW, so the fix propagated automatically." True
of `matchup_pairs` and the rest — but `ally_team_comp` / `enemy_team_comp` are **text columns
on `matches`, not views**, and nothing propagated to them.

**Optional repair script** provided: a read-only diagnostic, then an idempotent UPDATE that
rebuilds both comps from `scoreboard_players.role`. Guarded to complete boards only, so
leaver games (zero scoreboard rows) are never overwritten with `0-0-0`.

**Files.** `src/app/process/page.tsx`, `v1_1_3-team-comp-repair.sql`.

### 6. A free 5v5 correctness check that did not exist

**Symptom.** The first match of the season had three ally slots labelled TANK, two of them
Reaper and Cassidy. Nothing flagged it.

**Root cause.** `flagRows()` deliberately carries no role-shape rule, correctly: 6v6 is open
queue, so 2-3-1 is legal and a shape rule would manufacture errors. But **competitive 5v5 is
role queue and is always 1-2-2**, and that check was never added.

**Fix.** New `roleShapeWarnings()`, rendered as a non-blocking orange banner.

⚠️ **Deliberately NOT a row flag.** A flag disables bulk-confirm until resolved, and shape is
a property of a TEAM — there is no way to know which of the five is wrong — so flagging all
five would block the audit on a five-way guess.

⚠️ **5v5 Test 8 in the corpus is a permanent expected warning.** It is a genuine quick-play
1-3-1 on both teams, verified against the board's own role icons and portraits. Do not chase
it, and do not loosen the rule to silence it.

**Files.** `src/app/review/HeroAuditPanel.tsx`.

### 7. The tile-ceiling question fired on the wrong sighting, twice over

**Symptom.** Asked about a watched hero on the second sighting, not the third.

**Root cause, part one.** `shouldAskTileCheck(n)` is `n % 3 === 0`, which is correct — it
wants the sighting NUMBER. It was being passed `countTileCheckSightings()`, the count of
sightings BEFORE this match, which is one less. The first sighting ever arrived as 0,
satisfied `0 % 3 === 0`, and fired. The cadence ran 1, 4, 7.

**Root cause, part two.** `logTileCheck` writes **one row per watched hero played**, but the
caller only ever considered `watched[0]`. Playing three watched heroes in one match stepped
the counter 0 → 3 and **jumped clean over the third sighting** without asking.

**Fix.** Walk `watched` and ask about the hero whose own sighting number lands on the
multiple. Parameter renamed `priorCount` → `sightingNumber`; the old name was the bug.

⚠️ The ask loop and the `logTileCheck` loop both iterate `watched` and must stay in the same
order, or the hero asked about and the hero counted diverge.

**Files.** `src/app/process/page.tsx`, `src/lib/beta-issue-log.ts`.

### 8. It asked about a screen it never showed you

**Symptom.** "On Hazard's breakdown screen, is PLAYERS PROTECTED showing?" — with no
breakdown screen on the page.

**Root cause.** `TileCheckPrompt` had no image field. `/process` has built
`liveImages.byHero[heroName]` — a fresh signed URL to exactly that screenshot — the entire
time, and passed `scoreboardImageUrl` but not this.

**Fix.** Image field added and passed, with tap-to-enlarge.

⚠️ **If that hero's breakdown is not in the batch, the question is no longer asked at all.**
A guessed "not seen" poisons the observation log the whole tile-ceiling decision rests on
(§13). The effect now also depends on `liveImages`, because URLs are re-signed
asynchronously after the match changes — without it the check reads the PREVIOUS match's
images, the same stale-read shape that cost `starting_side` 100% of its data.

**Files.** `src/app/review/HeroAuditPanel.tsx`, `src/app/process/page.tsx`.

### 9. The Score column pooled two incompatible scales

**Symptom.** Between two runs three slots appeared to collapse — margin 0.29 → 0.06,
0.29 → 0.07, 0.23 → 0.03.

**Root cause.** Nothing had degraded. Pass 1 scores `0.6*structural + 0.4*colour`; Pass 2
rescores the same slot on `0.5*orb + 0.3*structural + 0.2*colour` and overwrites confidence
and margin. The extractor states outright that the two must never be pooled — and the report
put them in one column with only a ✓ to tell them apart. A 1px table shift nudged each
slot's Pass-1 score just over `ORB_THRESHOLD`, so it skipped Pass 2 and printed on the other
ruler.

**Fix.** Explicit `Scale` column (`P1` / `ORB`), separate mean per scale in Overall, and a
warning under the table.

⚠️ **`isFragile`'s 0.35 threshold is still Pass-1-calibrated and applied to both scales**, so
the headline fragile count remains a mixture. Left alone deliberately: inventing a second
threshold with nothing to calibrate against is how `AUTO_CORRECT_MIN_LEAD` shipped at 0.05
and had to be re-derived from 87 logged decisions. The mixture is now visible; calibrate from
logged data before touching it.

**Files.** `src/app/testing/page.tsx`.

### 10. Standout picks — the question you could not answer

**Symptom.** One screen, two multi-select grids, no image, and a manual UPLOAD button. You
picked a slot NUMBER from memory, minutes after the match, with nothing on screen to check
against.

**Root cause.** The image was never shown because the phone could not tell which uploaded
photo was the scoreboard — documented in the file as a known gap rather than solved.

**Fix.** Two screens, one pick each, the relevant team's crop above the buttons, tap to
advance after 250ms, back button on both, tap-to-enlarge. **Only the team being asked about
is shown** — the old screen put both up at once and invited picking from the wrong half.

New `src/lib/phone-scoreboard-detect.ts` closes the gap in **nine pixel reads**: ally rows
blue, enemy rows red, dark VS gap between, plus a table-width check. Free next to
`detectMapFromPhotos`, which runs a full Tesseract pass per photo.

⚠️ **The wire format is unchanged** — still `impressed_ally_slots: [n]` or `[]` — because
`/process` reads `number[]` and dedupes. No process-side change, and batches already in
`pending/` still parse.

⚠️ Buttons READ 1–5 on both screens but RETURN the real slot, so the enemy screen shows 1–5
and stores 6–10. Intentional; do not "fix" the labels.

⚠️ **Gap probes are y = 1200/1240/1290, not the extractor's 1180/1220/1260.** The first draft
reused the extractor's and **9 of 27 boards failed** — the ally block reaches y=1184 on tall
6v6 boards. Do not move them without re-measuring.

**Files.** `src/app/upload/page.tsx`, `src/lib/phone-scoreboard-detect.ts` (new).

### 11. "Nothing went wrong" still needed a NEXT press

**Symptom.** Every match required a NEXT tap on both issue steps, even the majority with
nothing to report.

**Fix.** Tapping **NOTHING** auto-advances; any real issue still requires NEXT.

`IssuePicker` stays multi-select — a match can have both a leaver and a thrower, and
auto-advancing on those would make that combination unrecordable. The deliberate press is the
feature: when something did go wrong, that is the moment to think twice. Advances only on
SELECT, never on deselect. `'none'` still writes `[]`, not a new `TeamIssue` member.

⚠️ Three stale-closure sites in this change, all handled by passing the value explicitly
rather than reading state back: the new `enemyPickOverride` on `commitUpload` (with an
`!== undefined` sentinel, since `null` means NONE and must stay distinct from "not passed"),
the ally pick, and `autoAdvanceIssues`. `resetForm` must also clear `sbCrops` — without it
the next match's standout screens open showing the previous match's scoreboard.

**Files.** `src/app/upload/page.tsx`.

### 12. Behind flags — default OFF, not shipped active

Three changes alter boards that are **already correct**, so they ship as independent switches
in `EXPERIMENTS`, all `false`. Flip ONE, re-run `/testing`, compare — flipping two makes a
regression unattributable (§6, rule 1).

| Flag | What it changes | Evidence |
|---|---|---|
| `ICON_WINDOW_V2` | Anchor + widen the icon window to `tableLeft +5..+50` | Glyph measured at +9..+13 / +40..+48 over 294 rows. The current 6v6 window ends at +59 and **overlaps the portrait** (starts +54), so `findIconBounds` can take `midY` from portrait pixels |
| `UNIFY_ROW_PITCH` | One row pitch for both teams | Ally and enemy pitch disagree by up to 10.2px on the same board and the sign flips, so at least one block's extent is wrong |
| `SQUARE_PORTRAIT_CROP` | `cropH = cropW` | The portrait is 122×122 (§5d) and `cropW` is already 122 — so `cropH = rowHeight − 8` was never right. Test 3 makes 122×128 ally crops and 122×135 enemy crops, two different distortions on one board |

Flipping is a source edit and rebuild, deliberately: a UI toggle can be left on and silently
change what production writes.

⚠️ **A flag that shows "no change" against the 5v5 corpus has not been tested** — that corpus
spans one pixel.

**Not yet run.** The three real boards score materially worse than the corpus even with the
anchor fixed (mean 35.4% vs 42.5%, 43% fragile vs 9%, primary crop winning 67% vs 98%), so
something beyond the horizontal anchor is still off on them. `|cropH − 122|` correlates −0.43
with score across 26 team-blocks. `SQUARE_PORTRAIT_CROP` is the one to try first.

### 13. Also fixed

- **Stat-column width floor.** `extractStats` reads `grid.columns` from unshifted constants —
  the one consumer still not anchored. Measured on the widest (1698) and narrowest (1623)
  5v5 boards, every digit still lands inside its cell, worst case 27px clearance on H. But
  the table is centred, so those columns march left as it narrows and the clearance runs out
  near width 1569. A warning now fires below 1600. The 6v6 floor is deliberately unset — its
  cells differ and have not been measured. **Guessing one would be the same mistake this
  patch exists to fix.**
- **`logGeometryReport` advice corrected.** It told you to watch the 5v5 *spread* as "the
  signal to derive that format too". Both halves are now wrong; it says watch **width**.
- **Document corrections.** `FILE-MAP.md` had `HeroAuditPanel.tsx` under `src/components/`
  (it is `src/app/review/`) and asserted the ORB emitter existed. `KNOWN-FAILURE-MODES.md`
  §14.1 (5v5 spread), §14.3 (implemented, both formats), §14.4 (protocol superseded), §7a
  (the check that always said "dead") and §5f (pooled scales) all updated.

### What this one teaches

v1.1.1's lesson was *two things agreed and one could not have disagreed*. v1.1.2's was
*nothing agreed and nothing was checking*. This one is the sharper form of the first:

**A verification whose outcome is guaranteed is not a verification.**

v1.1.1 checked its 5v5 exemption by confirming all seven boards came back byte-identical, and
correctly noted the result was "guaranteed by construction, not by luck." Both halves were
true. But a no-op verified against the same boards that set the constants can only ever
return byte-identical. It tested that nothing changed — not that the constants were right.
The exemption survived a check that was structurally incapable of failing.

The same shape appears twice more in this patch. The ORB counters "agreed" with a healthy run
because they were hardcoded to zero. Icon roles and hero roles agree on every slot because
one is overwritten from the other. In all three cases the instrument was reading itself.

*Before trusting a check, ask what result would have made it fail.*

---

## v1.1.2 — released 15 August 2026

Restores two Issue Log sections that were silently lost in `cf440cc` (the v1.0.2 hero-audit
rework) and stayed missing through v1.1.0 and v1.1.1. **DB change? No** — one file.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Issue Log | **Start New Season** reset absent — no way to archive and clear the log | Danger-zone section restored from `1e3a03d` | No |
| 2 | Issue Log | **Processing failures** section absent — failed batches invisible on the page | Section restored from `1e3a03d` | No |

### 1. Start New Season — a destructive action with no entry point

**Symptom.** No way to archive and clear `beta_issue_log` from the app. Season 4 was started
by emptying the table by hand in Supabase.

**Root cause.** `cf440cc` replaced the page's sections for the per-slot hero audit and took
this one with it. `clearIssueLog()` and `generateSeasonArchiveMarkdown()` **stayed exported
the whole time with zero call sites** — the capability existed, unreachable, for two patch
cycles.

⚠️ **`grep -rn 'clearIssueLog' src/` returned one hit: the definition.** An orphaned export
is not evidence a feature was retired — only that its entry point is gone. Nothing flagged
this, because dead code compiles.

**Why it matters more now than it did.** The season-end sweep, the tile-ceiling watch and the
table-geometry log all assume the log covers ONE season. There is no season column and
`match_id` cannot be joined to `matches`, so scoping depends entirely on the log being
cleared at a season boundary. With no caller, that never happens.

**Fix.** Restored from `1e3a03d` — structure, copy and two-step flow verbatim; only the
colour classes were mapped from raw `slate-*` to the current theme tokens, since the original
predates the theming work and would have broken light mode.

**The safety order is the original's:** the archive downloads FIRST and a throw aborts before
anything is deleted; a failed clear reports *"No rows were removed — your data is intact"*;
step 2 tells you to verify the file on disk before confirming. The reset touches
`beta_issue_log` and nothing else.

**Files.** `src/app/issue-log/page.tsx`.

### 2. Processing failures — computed, reported, never displayed

**Symptom.** A batch that failed to process was invisible on the page.

**Root cause.** Same commit. But unlike the reset, this one was only half-removed:
`aggregate()` never stopped computing `totalProcessingErrors` / `processingErrors`,
`logProcessingError()` is live and called from `/process`, and
`generateIssueReportMarkdown()` never stopped rendering the section. **Only the on-page
display went** — so the data was there the whole time, visible solely by downloading the .md.

**Fix.** Section restored, same treatment.

**Files.** `src/app/issue-log/page.tsx`.

### What this one teaches

v1.1.1's lesson was *two things agreed and one could not have disagreed*. This is its
sibling: **nothing agreed, and nothing was checking.** Two exports with no callers, a
`SeasonStats` field with no reader, and a destructive action with no button — none of it
breaks a build, fails a test, or shows a symptom. It surfaced only because the owner went
looking for a button he remembered.

*An export with no call site is a question, not a leftover.*

---

## v1.1.1 — released 15 August 2026

Adds **D.Mon** (hero 53). Gathering evidence for that hero surfaced four pre-existing
defects, none of which were caused by the hero addition; all are fixed here. **DB change?
Yes** — two view rebuilds (`hero_role_ref`, `hero_stats_normalised`), no tables or columns.

⚠️ **Two heroes' worth of stats stop accruing.** The season that added D.Mon also added a
`PLAYERS PROTECTED` tile to every tank, and the breakdown screen holds a hard maximum of
eight tiles. Five tanks were already at eight, so the game **dropped their ultimate tile**
to fit: Domina `PANOPTICON HITS`, Junker Queen `RAMPAGE KILLS`, Reinhardt `EARTHSHATTER
KILLS`, Sigma `GRAVITIC FLUX KILLS`, Wrecking Ball `MINEFIELD KILLS`. Historical values
remain readable — those charts simply flatten from this season onward. **This is not a
regression.**

⚠️ **`PLAYERS PROTECTED` is blank on all 192 historical matches, permanently.** The tile
did not exist before ~31 July 2026 and no backfill is possible.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | New hero | D.Mon absent everywhere | Added across reference, role map, portrait, stat-meta, catalog, and both hardcoded views | **Yes** (2 views) |
| 2 | New role tile | `PLAYERS PROTECTED` on every tank's screen, nowhere in the app | Registered on all 15 tanks + both Heroes pages; five tanks swapped an ultimate tile for it | **Yes** (view) |
| 3 | Stat folding | `FINAL BLOW(S)`, `SOLO KILL(S)`, `PLAYER(S) SAVED` unregistered in code — every foldable ROLE tile | Four pairs added to `STAT_NORMALISE`; the SQL view already had them | No |
| 4 | Match result | Two of ten test matches stored as a LOSS when the banner read VICTORY | Deleted a duplicate score-derived rule that overrode the banner | No |
| 5 | 6v6 scoreboard | Roles read 5-0-1 on both teams; portrait scores 13.8% with 12/12 rows flagged | Root cause: the table is centred and its width varies, so every fixed x-coordinate drifts. 6v6 coordinates now derived from the measured table edge | No |
| 6 | Stat catalog | A hero's stat order is positional and eight tank entries were out of order | Reordered to true screen order; a mis-ordered entry silently mislabels a recovered tile | No |
| 7 | Matchups | Only surface still opening on All Time now that a second season exists | Seeds the current season once, like every other season-aware page | No |
| 8 | Monitoring | Two hypotheses now under watch with no way to confirm them | Tile-ceiling check every 3rd sighting; table geometry logged on every scoreboard | No |

### 1. D.Mon — hero 53

`D.Mon` / tank / stalwart. Plain-ASCII plus a dot, so one portrait file and no
`HERO_FILENAME_MAP` entry — the same class as `D.Va`. Five breakdown stats: Fusion Repeater
Accuracy (percent, per-10 shown), Fusion Repeater Kills, Knockback Kills, Limit Break Kills,
Damage Amplified.

`FUSION REPEATER KILL(S)` and `LIMIT BREAK KILL(S)` are new stat names and are registered in
both fold layers. `FUSION REPEATER ACCURACY` needs no fold — percentages have no plural.

**Files.** `src/data/reference.ts`, `src/lib/scoreboard-extractor.ts`,
`public/heroes/D.Mon.png` (128×128), `src/data/stat-meta.ts`,
`src/data/hero-stat-catalog.ts`. **DB:** `hero_role_ref` + `hero_stats_normalised`.

### 2. `PLAYERS PROTECTED` — a new tank role tile

**Symptom.** Visible on every tank's breakdown screen; absent from `STAT_NORMALISE`, from
every format set, and from all 14 tank catalog entries.

**Root cause.** Not an extraction fault. Tank breakdowns captured **exactly** their expected
tile counts on 31 July — Winston 5, Zarya 6, Orisa 7, Sigma 8, Domina 8 — and Sigma and
Domina proved an eight-tile capture was possible. The tile simply did not exist yet; it
arrived between 31 July and 12 August.

**Fix.** Added to all 15 tanks and to the role-stat list on both Heroes pages. Nine tanks had
room and went +1; five were at the eight-tile ceiling and swapped out their ultimate tile.

⚠️ **The five retired tiles stay in `HERO_BREAKDOWN_ORDER` and `STAT_NORMALISE` on purpose.**
Historical matches hold their values and must stay readable.

**Files.** `src/data/hero-stat-catalog.ts`, `src/data/stat-meta.ts`,
`src/app/analytics/heroes/page.tsx`, `src/app/analytics/heroes/[name]/page.tsx`. **DB:**
`hero_stats_normalised`.

### 3. Role tiles were never folded in code

**Symptom.** Of 161 distinct stat names in `hero_stats`, 34 appear in more than one spelling.
Thirty-one are correctly folded. The three that are not are **exactly the foldable role
tiles**: `FINAL BLOW`/`FINAL BLOWS` (25/115 rows), `SOLO KILL`/`SOLO KILLS` (45/96),
`PLAYER SAVED`/`PLAYERS SAVED` (12/89).

**Root cause.** `STAT_NORMALISE` was generated from the per-hero stat list, and role tiles are
deliberately excluded from `HERO_BREAKDOWN_ORDER` — so they were never in the source. The
correlation is total in both directions.

⚠️ **Analytics were never wrong.** `hero_stats_normalised` folded all three correctly the
whole time; only the code map had drifted. The one live consequence was
`new-content-readiness.ts`, which folds raw OCR rather than view output and so reported role
tiles as unrecognised new stats on `/testing`.

**Fix.** Four pairs added, including `PLAYER(S) PROTECTED` pre-emptively. The game pluralises
on **value** — singular at exactly 1, plural otherwise including 0 — proven by a clean
partition: all 12 `PLAYER SAVED` rows sit at value 1 and none of the 89 plural rows do. OCR
also drops trailing characters independently, so both spellings are required regardless.

**Files.** `src/data/stat-meta.ts`, with a header warning that a regenerate will drop these
again.

### 4. The score overrode the VICTORY banner

**Symptom.** Test 1 (a win) stored as `DEFEAT`. Two of ten test matches affected — precisely
the two where banner and score disagreed.

**Root cause.** `image-processor.ts` re-derived the result from the score and used the banner
only as a fallback, inverting the rule `ocr-extractor.ts` documents and applies. It was a
**second implementation of the same rule**, and the copies disagreed.

The score cannot decide this: Test 1 is a VICTORY at 0-2 and Test 8 a DEFEAT at 0-2.

**Fix.** Deleted `resultFromScore()` and its call site. `ocrSummaryPage()` already resolves
banner-then-score internally, so the assignment is now a straight copy. The conflict flag
still fires for confirmation.

**Files.** `src/lib/image-processor.ts`.

### 5. ⭐ The scoreboard table is centred and its width varies

**Symptom.** Two faults that looked unrelated. Test 9's roles read **5-0-1 on both teams**
against a real 1-3-2 / 2-2-2, which role-filtered every ally slot against tanks only. And
6v6 portrait scores sat at 13.8–16.9% against 36–42% on 5v5, with **12 of 12 rows flagged
fragile** on two boards.

**Root cause — one cause, both faults.** The table is centred at x≈1919.5 on every board of
both formats, but its **width varies with content**, so the left edge moves by half the
change and every absolute x-coordinate drifts with it.

| | table width | left edge | drift |
|---|---|---|---|
| 5v5 (7 boards) | 1690–1699 | 1070–1074 | **4px** — ⚠️ SUPERSEDED, see v1.1.3 #1 |
| 6v6 (3 boards) | 1462–1517 | 1161–1188 | **27px** — breaks two things at once |

The role-icon window clipped the DPS glyph's third bar, so `classifyRoleIcon` saw two bright
segments instead of three and returned `tank`. The portrait crop variants spanned 15px and
could not reach an origin 25px away.

⚠️ **Tests 8 and 10 had been "passing" by about one pixel.** Nothing was ever robust.

**Fix.** `detectTableEdges()` finds the table's extent on three sampled rows and takes the
median. All 6v6 x-coordinates — icon window, portrait origin, all four crop variants, and the
gamertag crops — are shifted by the measured delta from a calibration baseline.

**5v5 is deliberately NOT derived.** Its edge moves 4px, its constants are exact (portrait
origin measured 1130 on six of seven boards against a hardcoded 1130), and variant 1 wins
66/70 slots. Changing geometry there would risk the one format that demonstrably works.

**Verified:** all seven 5v5 boards came back **byte-identical** — same heroes, same scores to
one decimal, same fragile counts. That is guaranteed by construction, not by luck: the
resolver returns early unless the format is 6v6.

> ⚠️ **SUPERSEDED BY v1.1.3 #1 — READ THIS BEFORE CITING THE TWO PARAGRAPHS ABOVE.**
> The 4px figure was a sampling artefact: all seven boards had long gamertags, hence wide
> tables, hence a left edge sitting exactly on the constants. Real 5v5 matches span
> **1071–1108 (37px)** and the exemption was actively writing wrong heroes. Both formats
> derive as of v1.1.3.
>
> The byte-identical verification is the sharper lesson. Every word of it is accurate —
> and a no-op verified against the same boards that set the constants can only ever return
> byte-identical. It tested that nothing changed, not that the constants were right.
> **A verification whose outcome is guaranteed is not a verification.**

| | before | after |
|---|---|---|
| Test 8 | 16.9%, 12 fragile | **39.5%, 2 fragile** |
| Test 9 | 13.8%, 12 fragile | **29.6%, 7 fragile** |
| Test 10 | 38.8%, 3 fragile | **40.2%, 2 fragile** |
| Whole set | 43 fragile | **27 fragile** |

**Files.** `src/lib/types.ts`, `src/lib/scoreboard-extractor.ts`.

### 6. Catalog stat order is positional

**Symptom.** Ramattra returned 7/8 stats with `UNKNOWN_TILE_R3C2`, and its `PUMMEL ACCURACY`
tile was labelled `PUMMEL KILLS`.

**Root cause.** When a tile's label fails OCR, `breakdown-ocr` falls back to `catalog[index]`
by grid position. Echo's entry happens to be in true screen order so its tiles resolve
correctly; eight tank entries were not, so the recovery mechanism supplied the wrong name.
A mis-ordered entry **fails silently rather than loudly**.

**Fix.** Eight tank entries reordered to screen order, verified against screenshots, with a
header stating that the order is positional.

⚠️ **The other 44 heroes have not been verified.** The old ordering looks like a consistent
rotation, so more entries are likely affected. Latent — it only bites on an OCR failure.

**Files.** `src/data/hero-stat-catalog.ts`.

### 7. Matchups defaulted to All Time

**Symptom.** With Season 4 created, Matchups became the only season-aware surface still
opening on pooled seasons. Logged in v1.1.0 Phase 2 as "revisit when Season 4 starts".

**Fix.** Seeds the current season once via a `seasonDefaulted` ref, matching every other
page. The seeding is guarded on a **successful** seasons read, not just the ref — the read is
deliberately non-fatal, and seeding from a failed one would silently mean All Time forever
with the ref blocking any correction.

**Files.** `src/app/analytics/matchups/page.tsx`.

### 8. Two hypotheses put under watch

Both of these are claims about how the *game* behaves, not about our code, so they are
monitored rather than assumed.

**Tile-ceiling check.** Every third time one of the five affected tanks appears on a
breakdown, `/process` asks whether the retired tile has come back. **Every sighting is
logged, including the ones not asked about** — a season of "still gone" means nothing without
the number of chances it had to be otherwise, and the sighting count also drives the cadence.

**Table geometry.** Every scoreboard logs its measured left edge and width, **both formats**.
5v5 is logged precisely because it is *not* derived: leaving it on hardcoded constants is only
defensible if drift would be noticed. The Issue Log flags 5v5 red past a 15px spread and names
the fix.

Neither is an error event — both are excluded from error-rate and signal-precision maths. A
fact about the game is not a pipeline mistake.

**Files.** `src/lib/beta-issue-log.ts`, `src/app/review/HeroAuditPanel.tsx`,
`src/app/process/page.tsx`, `src/app/issue-log/page.tsx`, `src/data/hero-stat-catalog.ts`.

### What this patch keeps teaching

Every fault above hid the same way: **two things agreed, and one of them was incapable of
disagreeing.** Catalog tile counts matched captured counts — both predated the new tile. Code
and database "mirrored" each other — the correct side was the only one being read. Two 6v6
boards passed the role-icon check — by one pixel. The 5v5 constants look verified — they are
verified, but only against boards whose width never moved.

*Where two things agree, ask whether they were capable of disagreeing.*

---

## v1.1.0 — released 11 August 2026

The "mega patch". Six phases, one push. A redesigned feel-question set on new columns, a
filter system converted from scalars to arrays, three-state leaver tracking, post-match
standout picks, and a correctness pass. **DB change? Yes** — one enum, one new table, six new
columns across three tables, and two view rebuilds.

⚠️ **The version-2 question set only applies from Season 4 onward.** Season 3 and earlier
read the version-1 set. `seasons.question_scale_version` is the sole authority for which set a
match belongs to, and **the two scales are never pooled or averaged together.**

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Feel questions | Tempo/coordination unanswerable for multi-round games and being clicked through without thought | Both retired; five-question v2 set on NEW columns, old enums frozen | **Yes** (3 columns + version flag) |
| 2 | Leaver tracking | A leaver who reconnects was indistinguishable from one who never returned | `leaver_type` enum, three states; permanent discards the scoreboard, returned keeps it | **Yes** (enum + 2 columns) |
| 3 | Standout picks | No record of which hero stood out in a match | `match_standouts` child table + post-match slot picks + Matchups tiles | **Yes** (new table) |
| 4 | Filters | Mode/map/hero were single-select with three different "no filter" sentinels | Converted to arrays; empty array = no filter, everywhere; season became a dropdown | No |
| 5 | Match detail | A version-2 match showed NO fun rating and none of the new fields | Renders one question set chosen by the match's SEASON, as labels not numbers | No |
| 6 | `heroes_played` | Nine matches returned `{NULL}` — a one-element array containing null | `array_remove` on the view's aggregate; they now return `{}` | **Yes** (view) |
| 7 | Correctness pass | Combat chart vanished on a hero filter; Outcomes side panel permanently blank; Time drew zero-width bars for never-played buckets | Four independent fixes | No |
| 8 | Cosmetic pass | Stale menu copy promising retired fields; raw DB enum rendered to the user; minutes shown where h:mm was used elsewhere | Six files | No |

### 1. Feel questions — retired two, moved the rest to new columns

**Symptom.** `team_tempo` and `team_coordination` (and their enemy twins) were unanswerable by
construction and contaminated in practice. A control match can have a contested first point, a
collapse, and another collapse; any single value for a multi-round game is a lie. The owner
also reports clicking through these questions quickly without thought when not in the mood — a
rushed field is worthless regardless of how healthy its histogram looks.

**Root cause.** Not a bug. A question-design error carried since the original schema.

**Fix.** Tempo and coordination retired outright. The surviving set is five questions plus two
slot picks: `matchup_feel` (5-point, midpoint kept, closeness folded in), `performance_rating`
(5-point), `fun_rating_6` (**6-point, no midpoint, behaviourally anchored** — the missing
middle is deliberate, to remove the lazy centre answer).

⚠️ **NEW COLUMNS, NOT ALTERED ENUMS.** Old and new answers are never compared or pooled, so
there was no reason to mutate the existing types. `match_feel`, `performance_feel`,
`fun_rating`, `tilt_mood`, `team_tempo`, `team_coordination` and the enemy twins are **frozen
as-is**. `seasons.question_scale_version` decides which set a match reads. The Builder
**refuses** any v1×v2 variable pairing via `VarDef.scaleVersion` in `pairValidity`.

**Files.** `src/lib/types.ts`, `src/app/review/*`, `src/app/matches/new/page.tsx`
(`StarRating` → `ScaleSelect`), `feel-lib.ts`, `builder-lib.ts`. **DB:**
`seasons.question_scale_version` (smallint, default 1), plus three columns on `matches`.

### 2. Leaver tracking — three states, not a boolean

**Symptom.** `team_leaver` / `enemy_leaver` were booleans. A player who left and **reconnected**
was recorded identically to one who never came back — but the two cases have opposite
implications for the scoreboard, which is valid in one and meaningless in the other.

**Fix.** A `leaver_type` enum with three states. **Permanent leavers discard the scoreboard;
returned leavers keep it and are filtered at read time.** Both booleans retained and seeded
from the new columns, so nothing downstream broke on the day.

**Files.** `src/lib/types.ts`, `alpha.ts`, the review flow, Home's leaver grids. **DB:** the
`leaver_type` enum, `matches.team_leaver_type` / `enemy_leaver_type`, plus `team_thrower` /
`enemy_thrower`; `combat_facts` rebuilt to expose them.

**Verified live 9 Aug 2026:** 192 non-alpha matches · 13 permanent leavers (8 enemy, 4 team,
1 both) · 4 thrower matches, 3 carrying no leaver · 0 returned leavers, since none can exist
until new matches are played. Every boolean matches its seeded `leaver_type`.

### 3. Standout picks — capture, storage, and ten tiles

**Fix.** A `match_standouts` child table plus post-match slot picks, surfaced as ten tiles on
the Matchups page. Self-picks are excluded and null `hero_name` rows are skipped.

⚠️ **The denominator is the whole argument.** A standout rate is only meaningful against the
number of matches where that hero *could* have been picked, not against total matches.

**Files.** review flow, `matchups/page.tsx`. **DB:** new `match_standouts` table.

⚠️ **Both guards are synthetic-tested only** — the table is empty and neither has seen a real
slot→hero resolution. First thing to eyeball in beta. (Open item #26.)

### 4. Filter system — scalars to arrays

**Symptom.** Mode, map and hero were single-select, with **three different sentinels for "no
filter"** (`''` for map and hero, `'all'` for mode) that had to be translated between
surfaces. That mismatch caused the v1.0.1 empty-page bug.

**Fix.** `AnalyticsFilterState` converted to arrays. **The fields were RENAMED deliberately**
(`mode`→`modes`, `map`→`maps`, `hero`→`heroes`) so every consumer became a hard compile error
rather than a silent type change. **Empty array = no filter, everywhere** — there is no longer
anything to translate. Queue stays single-select, since 5v5 and 6v6 never mix. Season became a
dropdown; mode/map/hero became multi-select with type-ahead.

**Files.** NEW `src/components/MultiSelect.tsx` (separate from `Select.tsx`, which is
untouched); `AnalyticsFilters.tsx`; `matchups-lib.ts`; `hero-pairings-lib.ts`; `builder-lib.ts`;
the outcomes, time, feel, combat, heroes and hero-detail pages. **DELETED:** the duplicate
`src/lib/builder-lib.ts`, plus both dead filter-application paths (`applyMatchQueryFilters`,
`applyFilters`). No SQL, no DB.

### 5. Match detail — the real version-2 blank

**Symptom.** A version-2 match showed **no fun rating at all**, and `matchup_feel` /
`performance_rating` appeared nowhere.

**Root cause.** The Summary block rendered only `fun_rating`, as five stars, behind an
`!= null` guard. A version-2 match has `fun_rating` null and `fun_rating_6` set, so the guard
failed and the row **vanished with no indication anything was missing**.

⚠️ **The spec blamed `match_overview` for this and was wrong.** Nothing read those columns off
the view — Home selects `id, result, map, played_at`; `/matches` selects `id, heroes_played`.
Confirmed by grep across `src/` before changing anything.

**Fix.** Renders exactly one question set, chosen by the match's **season** via
`scaleVersionOf()` — never by sniffing which columns are populated. Values render as **labels,
not numbers**: "4" means different things on a 5-point and a 6-point scale, and a single match
has no axis for the number to order against. **Version-1 fun keeps its five stars**, because
that scale was *captured* as stars; version 2 drops them deliberately.

**Files.** `src/app/matches/[id]/page.tsx`, `feel-lib.ts`. No SQL, no DB.

### 6. `heroes_played` returned `{NULL}` for nine matches

**Symptom.** Nine matches returned a one-element array containing null rather than an empty
array.

**Root cause.** `array_agg` over a LEFT JOIN produces one phantom null element when the joined
side has no rows. Those nine matches have zero `hero_performances` rows.

**Fix.** `array_remove(array_agg(...), NULL)` in the `match_overview` definition. The nine now
return `{}`. Verified: `null_array_matches = 0`, `empty_array_matches = 9`, `total_rows = 192`
unchanged, and a cardinality spot-check confirming no match with a breakdown lost a hero.

⚠️ **This migration carried Phase 4's with it, because Phase 4's had never gone live.**
`pg_get_viewdef` returned the pre-Phase-4 definition — 15 columns, none of the four the
documents recorded as applied 9 Aug. **A documented migration is not an applied one.** The
cause could not be determined and was not guessed at (open item #27).

⚠️ **Why the nine have no breakdown is still undetermined.** All nine fall between 25 and 31
July 2026 and seven are 6v6 — a six-day episode, not a background rate. `/process` now warns.

**DB:** `match_overview` rebuilt (the four appended columns plus the `array_remove`).

### 7. Correctness pass

Four independent fixes, no DB impact:

- **Combat** — `drillDimension` read `if (heroActive) return 'none'`, so picking a hero removed
  the damage/healing/mitigation chart entirely, even though "how does my Ana healing share vary
  by mode" is exactly what it could still answer. Now drills by the coarsest unfiltered
  dimension.
- **Outcomes** — the attack/defence panel rendered permanently blank; now hidden when no
  selected mode can have a starting side.
- **Time** — zero-game buckets drew a zero-width bar labelled "—" with n=0, which reads as "0%
  win rate here" rather than "no data here". Now dropped before render.
- **Home `topBy`** — recorded as outstanding; **had already shipped.** Verified by reading the
  code. No change.

### 8. Cosmetic pass

- **Menu copy** promised "tilt" and "tempo" — fields this patch retires. Reworded to describe
  what the page *asks about*, so it survives the next question change. ⚠️ Blurbs must never
  name a version-specific feel field.
- **A raw database enum was being rendered to the user.** The hero detail page's last-5 rows
  interpolated `starting_side` directly, which would have printed lowercase `defense` on the
  first Season 4 escort game. Fixed with a `sideLabel()` helper. ⚠️ **The column stays
  US-spelled** (`'attack'` / `'defense'`) — it is matched by `.eq()` in queries. Only rendered
  strings are British.
- **Session duration** on the Time month chart now reads h:mm, matching the stat card and
  tooltip that already did. Legend and tooltip series names unified.
- **Result mix** legend now carries `n=`.
- **Confidence legend** added to the Hero Pairings grid — the last surface applying the
  dimming convention without stating it.

**Files.** `AnalyticsNav.tsx`, `analytics/heroes/[name]/page.tsx`, `analytics/time/page.tsx`,
`analytics/heroes-overview/page.tsx`, `analytics/outcomes/page.tsx`, `matches/[id]/page.tsx`.
No SQL, no DB.

### Deploy checklist — v1.1.0

**All migrations are already applied** (Phase 1 on 9 Aug, `match_overview` on 10 Aug). Verify
before shipping code rather than after:

```sql
-- Phase 1 schema — expect all four present.
select
  (select count(*) from information_schema.columns
    where table_name='seasons' and column_name='question_scale_version')     as has_version,
  (select count(*) from information_schema.columns
    where table_name='matches' and column_name='team_leaver_type')           as has_leaver_type,
  (select count(*) from information_schema.columns
    where table_name='matches' and column_name='matchup_feel')               as has_v2_feel,
  (select count(*) from information_schema.tables
    where table_name='match_standouts')                                      as has_standouts;

-- match_overview — expect 0 / 9 / 192.
select
  count(*) filter (where heroes_played = array[null]::text[])  as null_array_matches,
  count(*) filter (where cardinality(heroes_played) = 0)       as empty_array_matches,
  count(*)                                                     as total_rows
from match_overview;
```

⚠️ **If the second query returns a non-zero `null_array_matches`, STOP** — the view has
reverted, and that has happened silently once already in this patch.

Files to ship: the full v1.1.0 working tree. This is a single push covering six phases; there
is no partial-deploy path, and the phases were verified in sequence on localhost rather than
staged to production.

Docs updated:
- `Supabase Map.md` — Parts F/H/I; the `leaver_type` enum, `match_standouts`, the v2 feel
  columns, `question_scale_version`, the `combat_facts` and `match_overview` rebuilds, and the
  correction recording that Phase 4's migration was never live.
- `FILE-MAP.md` — bumped to v1.1.0; entries for `MultiSelect`, the filter conversion, both
  standouts guards, the six cosmetic files, and a correction to the dimming convention (the
  Heroes list is a hard gate, not a dim).
- `PATCH-SPEC-v1_1_0.md` — phases 0–6 closed, Phase 7 deferred out of the release.
- Session logs for 8–9, 9, 10 and 11 August.

**Post-deploy:** hard-refresh and unregister the service worker. Then, in order:

1. **Create Season 4 through Settings, NOT SQL** — this is the single most consequential manual
   step in the release. Created by hand it will not be stamped `question_scale_version = 2`,
   and the v1/v2 separation breaks silently. **The badge should read Q2.**
2. Process one real match and confirm the version-2 questions appear, the standout slot picks
   save, and the match detail page renders labels rather than numbers.
3. Check any escort or hybrid game shows **"Started on: Attack/Defence"** on both the match
   detail and hero detail pages — see the watch note below.

**Watch after deploy.**

⚠️ **Four surfaces will be legitimately EMPTY until version-2 data exists**, and none of them
are broken: the returned-leaver row and column on Home's grids, the three v2 Builder variables,
and both standouts rows. The first real match through the pipeline is the actual test.

⚠️ **Two fixes in this patch have NEVER RENDERED.** `starting_side` is null on all 192
historical matches, so the attack/defence displays on `matches/[id]` and `heroes/[name]` are
code-complete but have never been seen on screen. The first Season 4 escort or hybrid game is
their first execution. **Where the code and the data agree, check whether the data is capable
of disagreeing** — absence of a symptom proves nothing where the column is empty by
construction.

---

## v1.0.2 — released 4 August 2026

Scoreboard hero identification: **21.9% wrong → 0%**. Two code fixes, one feature
replacement, one data repair. **DB change? Yes** — 4 nullable columns on `beta_issue_log`,
plus corrective UPDATEs to existing rows.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | OpenCV worker | 1 scoreboard hero in 5 wrong; worse the longer a session ran | Released the leaked `cv.ORB` / `cv.BFMatcher`; added worker restart + health telemetry | No |
| 2 | Hero matcher | 2 remaining errors, both auto-correct overrides | `AUTO_CORRECT_MIN_LEAD` calibrated 0.05 → 0.10 from logged data | No |
| 3 | Confirmation (6f) | Gate only asked about suspected errors — 60 of 71 real errors were never questioned | Beta confirmation sunset; replaced by a per-slot audit of every scoreboard row | **Yes** (4 columns) |
| 4 | Historical data | 71 wrong heroes, `role_played` stuck on `'dps'`, 9 bad `percent_played` | Corrective SQL from ground truth | **Yes** (data) |

### 1. OpenCV worker — ORB/BFMatcher heap leak

**Symptom.** The 6v6 scoreboard stored the wrong hero for **71 of 324 slots (21.9%)**, across
24 of 27 matches. Everything else in the same extraction was perfect: all 1,944 numeric cells,
all 324 `is_user` flags, all 116 map/result/score/game-length fields, all 47
`play_time_seconds`. Only the portrait→hero mapping was wrong. Accuracy also degraded the
longer a `/process` session ran, which looked like an unrelated build/deploy issue.

**Investigation (four prior test runs, all inconclusive).** Errors moved 27 → 37 → 16 → 49
across four configurations without resolving. Ruled out and verified healthy: image quality
(all 3840×2160, Laplacian 423–442, ally table top edge 470–472 px in every image), bank
portrait resolution (64 vs 128 flips 0 of 12 failing pairs), and `ORB_THRESHOLD` tuning.

**Root cause.** `orbMatch()` in `public/opencv-worker.js` constructed a `cv.ORB` and a
`cv.BFMatcher` on **every call** and deleted neither. Both are C++ objects on the Emscripten
heap that JavaScript GC cannot reclaim. After ~17,300 calls the heap was exhausted;
`cv.matFromImageData` then threw, `combinedScore()` caught it, logged a bare message with no
detail, and silently substituted `orb = 0` — so the matcher carried on scoring on
`0.6*structural + 0.4*colour` while still reporting results on the ORB scale. Secondary leak:
`kp1/kp2/des1/des2/mask` were deleted on the last line of the `try`, so any throw leaked them.

**Evidence.** With `orb = 0` a Pass-2 score is exactly half the no-ORB score of the same crop,
and `phase1Score` is ORB-independent, so the ratio is a direct test:

| Region of the 2 Aug run | mean `score / phase1Score` | errors |
|---|---|---|
| Tests 1–18 (ORB alive) | **1.312** | 2 of 204 — **0.98%** |
| Tests 19–29 (ORB dead) | **0.508** | 14 of 120 — **11.67%** |

9,146 `ORB match failed` warnings in the log, first appearing mid-match 18 of 27. Measured
budget: ~17,300 ORB calls, mean ~1,040 per match (range 224–2,176). The worker is
module-level in `opencv-loader.ts` and lives for the whole page session, so `/process`
accumulated the same leak across matches — roughly game 15–17 of a session, as early as 8–9
on heavy matches. Reloading reset it, which is why it was never noticed live.

**Fix.** `ORB_DETECTOR` / `BF_MATCHER` hoisted to module scope and constructed once; every Mat
and vector released in a `finally`. Worker terminate-and-restart after 3 consecutive failures
(freeing the whole WASM heap), hard stop after 3 restarts. The `catch` now logs its exception.
`/testing` parses a new `ORB HEALTH` line into the Overall table with a 🛑 banner when any
match ran degraded — a run where ORB dies partway is two algorithms reported as one.

**Result.** 16/324 → **2/324**. Tests 19–29 went from 11.67% to 0.00%; tests 1–18 unchanged at
0.98%. Verified no behavioural side effects: tests 1–5 came back **bit-identical** to the
previous run — same hero, same score to 4 dp, same margin, same crop pick on all 60 slots.

**Files.** `public/opencv-worker.js`, `src/lib/opencv-loader.ts`, `src/lib/hero-matcher.ts`,
`src/lib/scoreboard-extractor.ts`, `src/app/testing/page.tsx`. No SQL, no DB.

### 2. Hero matcher — AUTO_CORRECT_MIN_LEAD calibration

**Symptom.** With the leak fixed, 2 errors remained — both Soldier: 76 read as Zenyatta, both
auto-correct overrides where `matchHero` left the role-filtered candidate set.

**Root cause.** `AUTO_CORRECT_MIN_LEAD` was 0.05, an explicit placeholder ("uncalibrated —
both scores are logged so it can be tuned from real data").

**Evidence.** 87 logged decisions, 55 OVERRIDE. Restricting to Pass-1-final slots — the only
ones the override actually decides, since Pass 2 overwrites Pass 1 unconditionally:

| Outcome | Count | Lead range |
|---|---|---|
| Correct overrides | 6 | 0.2534 – 0.3570 |
| **Wrong overrides** | **2** | **0.0760, 0.0771** |

An empty 0.18 gap. Of the 13 overrides in the affected [0.05, 0.10) band, 11 sat on slots that
go to Pass 2 anyway (no effect — and blocking them cannot change *whether* they reach Pass 2,
since an override only fires when the full score exceeds the filtered score, so reverting
always lowers it and all 11 were already below `ORB_THRESHOLD`). None of the 26 Pass-2-internal
overrides fell in the band. **Net: exactly 2 slots could change, and both were wrong.**

**Fix.** `AUTO_CORRECT_MIN_LEAD` 0.05 → 0.10.

**Result.** 2/324 → **0/324**. Exactly the 2 predicted slots changed, both wrong → right; no
second-order effects through crop selection.

**Do not "fix" this by raising `ORB_THRESHOLD` instead.** Both errors sat at score 0.363, just
above the 0.35 gate, so pushing them into Pass 2 looks equivalent — but 0.35 → 0.40 pulls 56
slots into Pass 2 of which **54 are already correct**.

**Files.** `src/lib/hero-matcher.ts`. No SQL, no DB.

### 3. Beta confirmation sunset → per-slot hero audit

**Symptom.** The confirmation step asked only about slots a confidence threshold flagged. Of
the 71 real errors, **60 were never questioned** — the matcher was confident and wrong. The 11
that were questioned were all corrected correctly by the user, and **all 11 corrections were
discarded on save**: `hero_id` was the one confirmation field with no write-back.

**Root cause.** A confidence gate can measure *precision* (how often a flag was a real error)
but never *recall* (how many errors were never flagged). No threshold fixes that, because the
errors it misses are invisible by construction. Separately, the existing gate fires on
`confidence < 0.6` while every one of the 324 slots scores below 0.6 (range 0.143–0.559), so
it would have asked 3 questions per match — the cap — all false alarms.

**Fix.** Beta confirmation retired. New `HeroAuditPanel` confirms **every** scoreboard row
(10 for 5v5, 12 for 6v6) in strict scoreboard order, with a tappable portrait per row, a
type-ahead hero search over the full roster, and a bulk "confirm remaining" gated on any
coherence-flagged row being resolved first. No row is pre-accepted — a row nobody looked at
must not record identically to one checked carefully.

Two deterministic coherence checks flag rows in place: duplicate hero within **one** team
(cross-team duplicates are legal) and the user's hero absent from `heroes_played`. Measured
on the ground-truth set: 4 real errors, 0 false positives across 324 slots. No role-shape
check — 6v6 here is open queue (one test has a 2-3-1 enemy team) and a 2-2-2 rule would
manufacture errors.

`onAuditComplete` writes confirmed heroes back into all four arrays that carry `heroName`,
re-deriving `role` from the confirmed hero, before the unchanged `saveMatch`.

**DB impact.** `beta_issue_log` gains `slot int`, `margin numeric`, `runner_up text`,
`orb_applied boolean` — all nullable, `event` CHECK unchanged (the audit reuses
`confirmed_correct` / `corrected`). `logHeroAudit()` writes one batched row per slot,
confirmed **and** corrected: a confirmed row's `corrected_value` is the truth label, and
omitting it would discard the negative examples that make an error rate computable. At ~400
matches a season this is ~4,800 labelled slots.

`orb_applied` is the important one — Pass 1 and Pass 2 use different scoring formulas, so
`confidence` and `margin` must **never** be pooled across them. Pooling is what made the §1
leak invisible for four test runs.

`/issue-log` reworked for the new grain: error rate by scoring scale, by margin band,
confusion pairs, bulk-confirmed share. `precisionBySignal` retained but filtered to historical
signals only.

**Known regression, accepted.** The map and result write-backs went with beta confirmation, so
a missed map (which drives `starting_side` and `game_mode`) and an unreadable win/loss banner
are no longer correctable at save time. Both fire rarely. Detection SQL is the replacement:
periodic cross-checks for a map missing or not in the catalog, `game_mode` disagreeing with the
map, `starting_side` set on a symmetric map or missing on an asymmetric one, and `result`
disagreeing with `score`. The `unrecognized` new-content ledger is also now silent; the `/testing` readiness panel covers it, but only if run manually.

**Files.** `src/app/review/HeroAuditPanel.tsx` (new), `src/app/process/page.tsx`,
`src/lib/beta-issue-log.ts`, `src/lib/types.ts`, `src/lib/scoreboard-extractor.ts`,
`src/app/issue-log/page.tsx`. `beta-confirmation.ts` and `review/ConfirmationCard.tsx`
retained but referenced by nothing. **DB: yes** — run the migration before deploying.

### 4. Historical data repair

**Symptom.** Three fields wrong in stored data, none recoverable by re-processing (feel and
star ratings on `matches` are subjective and cannot be recalled).

**Fix.**
- `scoreboard_players.hero_name` + `role` — corrected for all 324 slots across the 27 6v6
  matches with a scoreboard. Numeric stat columns untouched (all 1,944 verified correct).
  Everything downstream is a **view**, so corrections propagated automatically.
- `matches.role_played` — was stuck on `'dps'`, firing `role_mismatch` on 25 of 29 matches and
  making every role-split analytic read a constant. Repopulated from `roles_played` for
  single-role matches.
- `hero_performances.percent_played` — wrong on 9 of 47 rows. Recomputed from
  `play_time_seconds` (correct on all 47), **guarded** to matches whose stored rows account for
  the full game length: 11 matches store fewer rows than were played, and recomputing there
  would inflate the survivors (one match kept only the 26% hero and would have become 100%).

**Gotchas recorded.** The `match_id = 263 + test_number` mapping is valid **only** with alpha
rows excluded — 9 alpha matches sort first and shift every index by nine. And
`matches.role_played` is an enum (`role_type`) while `scoreboard_players.role` is `text`;
comparing them directly raises `operator does not exist: role_type = text`, so cast both sides
to `::text`. Introspect column types before writing DDL — `Supabase Map.md` is for
orientation, not schema truth.

**DB: yes** — data only, no schema change from this item.

### Deploy checklist — v1.0.2

**Run the migration FIRST** — `beta_issue_log` + 4 columns. The new code writes them; without
the columns `logHeroAudit()` 400s on the first saved match. Verify:

```sql
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='beta_issue_log'
  and column_name in ('slot','margin','runner_up','orb_applied');
-- expect 4 rows
```

Files to ship:
1. `public/opencv-worker.js`
2. `src/lib/opencv-loader.ts`
3. `src/lib/hero-matcher.ts`
4. `src/lib/scoreboard-extractor.ts`
5. `src/lib/types.ts`
6. `src/lib/beta-issue-log.ts`
7. `src/app/review/HeroAuditPanel.tsx` (new)
8. `src/app/process/page.tsx`
9. `src/app/testing/page.tsx`
10. `src/app/issue-log/page.tsx`

Docs updated:
- `Supabase Map.md` — `beta_issue_log` +4 columns; repair records on `scoreboard_players` and
  `matches`; the enum-vs-text gotcha.
- `FILE-MAP.md` — bumped to v1.0.2; entries added or amended for opencv-worker, opencv-loader,
  hero-matcher, scoreboard-extractor, types, beta-issue-log, process, testing, issue-log and
  HeroAuditPanel, with SUNSET markers on beta-confirmation and ConfirmationCard.

Post-deploy: hard-refresh, unregister the service worker, then process **one real match** and
check (a) the audit panel renders all 10/12 rows, (b) the save succeeds — a 400 here means the
migration didn't run, (c) `/issue-log` shows slot-level rows with margins populated.

**Watch after deploy.** The ORB health line should show `failed=0`. If the Pass-2 share of
slots collapses toward zero in `/issue-log`, ORB has stopped running again — that is the leak
signature, not a matcher problem, and the fix is in the worker rather than the matcher.

---

## v1.0.1 — released

Four fixes. **No schema/SQL changes** — every fix is client/logic or an asset swap.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Hero portrait (Shion) | Stopgap portrait, weak matcher recognition | Swapped in the official dark bank-style portrait | No |
| 2 | Hero Matchups page | Empty on every queue despite 26 games | Filter-sentinel bridge (`''` vs `'all'`) fixed | No |
| 3 | Home / summary page | Leaver games distorting overall win-rate & totals | General surfaces now respect the leaver toggle; dedicated leaver displays still always show | No |
| 4 | Beta confirmation (6f) | avg/10 cross-check flagging almost every breakdown stat | Cross-check gated to countable stats only | No |

### 1. Shion — official portrait swap

**Symptom.** Shion ran on a low-quality stopgap portrait (flat pale-lilac background) that fought
the image matcher (pale-on-pale; ORB firing on nearly every slot; occasional `role→support`
flags). See `Shion_Portrait_Notes.md`.

**Change.** Replaced the stopgap with the official portrait, converted to bank format (square,
128×128 PNG, dark/transparent background matching the other 51 portraits).

**Result (same 6 test screenshots).** Scoreboard scores rose to ~36–52% (from ~22–41%);
`role→support` flag gone (was 2, now 0); fragile Shion slots 0 (was 3); ORB fires far less;
processing time 881s → 550s total; zero wrong-hero saves. Hits the "real asset" target column in
the portrait notes.

**Files.** `public/heroes/Shion.png` (replaced). No code, no `HERO_FILENAME_MAP` edit ("Shion" is
plain ASCII → one file). No DB impact (matches stored by hero name).

### 2. Hero Matchups — empty on every queue

**Symptom.** After ~26 Tank games, Matchups showed no data on any queue (including "All Queues");
picking a hero rendered the cards but every list read "no data" and the sparsity note said "0
games." No console error; correct data in the DB.

**Investigation (ruled out, all verified healthy).** `hero_role_ref` (Shion + all 52 present);
`keepVisible`/alpha gate; `user_role_played` values; RLS/session; season tagging; stale deploy;
front-end roster (`reference.ts`). The 207 pair rows reached the browser correctly.

**Root cause.** `toMatchupFilters` (in `analytics/matchups/page.tsx`) bridged the shared
`AnalyticsFilterState` to the lib's `MatchupFilters` using `??`. The shared `map` sentinel is `''`
(= "all maps"), but `matchups-lib`'s `passesFilters` uses `'all'` as the "no filter" sentinel and
treats any other string — including `''` — as a literal map name to match. `'' ?? 'all'` stays
`''` (nullish coalescing only replaces null/undefined), so the check became `r.map !== ''`, true
for every real row → **every row dropped, all queues empty.** The same line in `SparsityNote`
produced "0 games."

**Fix.** Changed the coalesce from `??` to `||` on all three bridged fields (queue/mode/map) so an
empty-string sentinel becomes `'all'`. Verified end-to-end against real rows: rows now pass under
All Queues and Tank, and real map/mode selections still filter correctly.

**Files.** `src/app/analytics/matchups/page.tsx` (`toMatchupFilters`, 3 lines). No lib, no SQL, no
DB.

**Known gap recorded (not a bug yet).** Matchups does not implement the season filter at all
(`MatchupFilters` has no `seasons` field; the filter bar renders without a season control), so it
is all-time only. Harmless while a single season exists; to add when a 2nd season starts: add
`seasons` to `MatchupFilters`, thread it through `toMatchupFilters`, check it in `passesFilters` +
`SparsityNote` (pair rows already carry `season_id`), enable the control. ~30-min job mirroring
the existing `matchesFilters` pattern.

### 3. Home / summary — leaver games in overall figures

**Symptom.** The Home page counted leaver games in the headline win-rate cards and games-played
totals, so a leaver loss dragged down "overall" stats. The Settings "show leaver games" toggle was
ignored on this page.

**Desired behaviour.** General surfaces should respect the toggle (exclude leaver games when off),
but the *dedicated* leaver displays — which exist specifically to report leavers — should always
show leaver data regardless of the toggle.

**Fix.** Added `scopedVisible` (the toggle-respecting set) alongside the existing unfiltered
`scoped`, mirroring the `overviewVisible` rule the #14 block already used:
- **General surfaces → `scopedVisible`:** four win-rate cards, games-played total + category
  counts, Last-5, recent-form pips. Leaver games excluded when the toggle is off.
- **Dedicated leaver displays → unfiltered `scoped`:** the big "Leaver Games" box
  (`leaverSplit(scoped)`) and each card's `LeaverLine`. `WinRateCard` gained an optional
  `leaverRows` prop (fed the unfiltered per-category set) so its win rate respects the toggle while
  its leaver line always shows.
- Empty-state notice stays on `scoped` (a leaver-only season shouldn't read "no matches").
- #14 current-season overview unchanged (already respected the toggle).

**Verified.** Toggle off: win rate/total shrink to non-leaver games while leaver box/line still
report real counts. Toggle on: everything includes leavers. (Traced numerically.)

**Files.** `src/app/page.tsx`. No SQL, no DB (reads existing columns).

### 4. Beta confirmation — avg/10 cross-check false flags

**Symptom.** On the `/process` 6f confirmation cards, almost every breakdown stat was flagged with
the "Doesn't add up" (`avg_crosscheck_fail`) signal — persistently, across most matches.

**Evidence (`beta_issue_log`).** 94 `avg_crosscheck_fail` rows, **all** resolved `confirmed_correct`
with no correction — every flag a false alarm. Failures clustered entirely on percentage stats
(WEAPON ACCURACY, ENERGY JAVELIN ACCURACY, PUMMEL ACCURACY…), the one time stat (OBJ CONTEST TIME),
and near-zero counts (SOLO KILLS 0, FINAL BLOW 1).

**Root cause.** `avgCrossCheckCandidates` (in `src/lib/beta-confirmation.ts`) ran the check
`value ≈ avg_per_10 × (playtime/600)` on **every** stat regardless of type. The time and formula
were already correct (uses the hero's `playTimeSeconds`, not game length — so "played 2 min of a
15-min game" was not the cause). The problem: percentages and durations have no `× playtime/10`
relationship, and `numericValue` mangles them (`"40%" → 40`, `"01:51" → 151`), so on any game that
wasn't exactly 10 minutes the expected value drifted from the read value and tripped the ±40% band.
Near-zero counts tripped on rounding.

**Fix.** Gated the cross-check to countable stats using metadata that already existed in
`stat-meta.ts`:
- `if (statFormat(normaliseStat(st.statName)) !== 'number') continue` — skip percent/time stats.
- `if (value < 2 && expected < 2) continue` — skip near-zero counts.
- Imports `statFormat`, `normaliseStat` from `@/data/stat-meta`.

The check is **kept**, not removed — it still fires for a genuine OCR error on a real count stat
(traced: value 20 with a misread avg/10 of 50 still flags at 67% deviation). All 94 logged false
flags now pass.

**Files.** `src/lib/beta-confirmation.ts`. No SQL, no DB.

**Future (out of scope for v1.0.1).** `avg_per_10` is still OCR'd off the screen (~60% reliable). A
later change could *compute* the displayed per-10 from the trusted per-game value + playtime and
stop showing the OCR'd number entirely — making the shown per-10 reliable, not just suppressing
false flags.

### Deploy checklist — v1.0.1

Files to ship:
1. `public/heroes/Shion.png`
2. `src/app/analytics/matchups/page.tsx`
3. `src/app/page.tsx`
4. `src/lib/beta-confirmation.ts`

Docs updated:
- `FILE-MAP.md` — title bumped to v1.0.1; version header + Home / Matchups / beta-confirmation
  entries updated. (Local-only / gitignored — re-upload next session.)
- `Supabase Map.md` — no change (no DB touched this patch).

Before commit: `npm run build` (typecheck + lint clean), then commit + push (Vercel auto-deploys).
Post-deploy: hard-refresh, unregister the service worker, and spot-check Matchups (pick a hero →
lists populate), Home (toggle leaver setting → general stats shift, leaver box constant), and a
`/process` run (avg/10 no longer over-flagging).

---

<!--
## vX.Y.Z — template for the next patch (copy this block up top)

One-line summary. DB change? Yes/No.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 |      |         |     |           |

### 1. <title>
**Symptom.**
**Root cause.**
**Fix.**
**Files.**  No SQL, no DB. (or: describe the DB change + which map entry was updated)

### Deploy checklist — vX.Y.Z
Files to ship: ...
Docs updated: ...
-->
