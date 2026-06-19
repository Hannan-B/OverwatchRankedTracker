# New Season Runbook — Adding a New Hero or Map

> **What this is.** A plain-language, step-by-step checklist you follow every 2–3
> months when a new competitive season adds a new hero (and sometimes a new map).
> Follow the steps in order. Each step says exactly what file to open, what to type,
> and how to check you did it right. You do **not** need to understand the code — just
> match the patterns already in each file.
>
> **The golden tool.** After you make the edits, run the app and open **`/testing`**.
> Upload the new hero's/map's screenshots (Summary, Scoreboard, Hero Breakdown) and
> process them as normal. Each processed match now shows a **readiness panel**: a green
> "✓ ALL HEROES & MAPS RECOGNISED" banner, or an amber "⚠ NEW CONTENT DETECTED" banner
> that lists exactly which parts are missing for the new hero/map — with the file to fix
> and the Supabase SQL ready to copy. It also shows each source screenshot beside the
> data pulled from it (click to enlarge) so you can eyeball that the read is correct.
> **Trust the panel over your memory.**

---

## ⭐ RECOMMENDED WORKFLOW — three phases, in this order every time

The session this runbook was rewritten from settled the shape: **set absolutely
everything up first, in one block, and only then start testing.** Don't interleave
"edit one file, test it, edit the next" — do all the edits, all the SQL, and the
portrait as a single setup phase, then validate the finished whole. It's faster and
it makes the validation phase meaningful (you're testing the real end state, not a
half-built one).

**PHASE A — Set up the HERO (all of it, upfront).** Every code edit, the portrait, the
breakdown stats *and* the catalog (you have the breakdown screenshots — see below), and
both Supabase SQL steps. Nothing here is deferred "until you've played." When Phase A is
done the hero is completely built.

**PHASE B — Set up the MAP (only if a new map launched — often there isn't one).** Two
code edits, no SQL. Skip this whole phase in seasons that add only a hero.

**PHASE C — Validate, then push.** Only after A (and B if it applied) are completely
done:
1. **`/testing` page** — run the screenshots through, confirm the readiness panel is all
   green, and eyeball each source-image-vs-data pairing. This proves the **code**.
2. **localhost (the real app)** — click around the new hero, and **specifically open
   Matchups** (the only surface that depends on the `hero_role_ref` SQL — if the role is
   there, the SQL took). For a map, confirm it detects and asks attack/defend. This
   proves the **integration** (database + every surface).
3. **Push to `main`.** Vercel auto-deploys. Because the SQL was already run in Phase A,
   production is complete the moment the deploy lands.

> **Why this shape.** Setting up everything first means Phase C tests the finished state
> in one pass — no "this row is ✗ but that's fine for now" ambiguity. The `/testing`
> page proves the code; localhost proves the database wired through. Running the SQL in
> Phase A (before localhost) means there's never a window where production is broken, and
> the localhost Matchups check is the safety net for the one thing `/testing` can't see —
> the Supabase SQL.

> **Two habits that made this go smoothly:**
> 1. **Verify against the actual files, not your memory or these notes.** Before editing,
>    open the file and confirm the real shape — count what's there, check the exact
>    existing spelling of a stat or hero you're copying. The codebase is the source of
>    truth; this runbook is a guide.
> 2. **Treat `/testing` as a loop, not a one-shot.** Run it, read what it surfaces, fix,
>    run it again. That loop is what catches the subtle stuff.

---

## Before you start — three things that are always true

**1. Heroes and maps are NOT database entries.** You don't "add a row" to a database.
A hero or map is an entry in a list inside the app's code (`reference.ts`). You edit
that list, save, and redeploy. The actual *match data* (your games on the new hero)
lands in the database automatically when you process screenshots, just like always.

**2. "Shows up in the filters" and "has data" are different things.** The moment you
add a hero to the list and redeploy, it appears in **every** dropdown and filter across
the app — Home, Heroes, Matchups, everywhere. You do **not** edit the filters
separately; they read the same list. But the hero will show **no stats** until you've
actually played games on it and processed those screenshots. An empty-but-present hero
is normal and correct.

**3. Testing never saves anything to your database.** The `/testing` page processes
screenshots and shows the results on screen, but it does **not** write them to Supabase.
The screenshots you upload are held only in your browser tab's memory while you look at
them, and are discarded when you start a new test or close the tab — nothing is uploaded
or stored. So you can test a new hero/map as many times as you like with zero residue in
your database.

---

## How the repo works (quick reminder)

- **Repo location (your Mac):**
  `~/Documents/Personal Projects/Overwatch Ranked Tracker`
  (the folder name has spaces — when typing terminal commands, wrap the path in quotes).
- **To edit a file:** open it in your code editor, make the change, save.
- **To check your work builds:** in Terminal, from the repo folder, run:
  ```
  npm run build && npx tsc --noEmit
  ```
  Both must finish with **no errors** before you push. (This is the real test — the
  preview server is more forgiving than the live build.)
- **To deploy:** commit and push to `main`. Vercel auto-deploys.
- **Supabase:** a new **map** needs no Supabase change. A new **hero** needs one quick
  copy-paste SQL step (updating `hero_role_ref`), plus a second SQL step only if it has
  a brand-new stat name. These are spelled out in the hero steps below and are safe,
  reversible `create or replace view` snippets — they change no data.

---

# PART 1 (PHASE A) — SETTING UP A NEW HERO

Do **all** of the steps below in one go, before any testing. There used to be a
"do steps 1–4 now, 5–7 after you've played" split — that's gone. The breakdown
screenshots (Summary, Scoreboard, and the per-hero Breakdown) are **always provided
when a hero is added**, so the steps that need them are done upfront with the rest. When
you finish this part, the hero is fully built: identified in screenshots, in every
filter, portrait showing, role in Matchups, and breakdown stats mapped.

The steps and the files they touch:

1. `reference.ts` — add to the `HEROES` list
2. `scoreboard-extractor.ts` — add to the scoreboard role map
3. `public/heroes/` — add the portrait
4. `stat-meta.ts` — add the breakdown stats (needs the breakdown screenshots)
5. `hero-stat-catalog.ts` — add the validation catalog entry (needs the breakdown screenshots)
6. **Supabase SQL** — `hero_role_ref` (always), and `hero_stats_normalised` (only if the hero has a brand-new stat name)

> ⚠️ The two SQL steps are part of this setup phase — run them now, not later. They're
> copy-paste `create or replace view` snippets (spelled out below), they change no data,
> and they're reversible. Running them here means localhost validation in Phase C
> exercises the finished state. (A new *map* needs no database change.)

---

## STEP 1 — Add the hero to the master list  *(required, do first)*

**File:** `src/data/reference.ts`

Find the big `HEROES` list. Each hero looks like this:

```ts
{ name: 'Reinhardt', role: 'tank', subRole: 'stalwart' },
```

Add a new line for your hero, inside the right role section, copying that exact shape.
You need three things:

- **`name`** — the hero's display name, spelled and capitalised **exactly** as
  Overwatch shows it (including any accent, dot, or colon — e.g. `'Lúcio'`,
  `'D.Va'`, `'Soldier: 76'`).
- **`role`** — one of: `'tank'`, `'dps'`, or `'support'`.
- **`subRole`** — must be one of the allowed values **for that role**:

  | Role | Allowed `subRole` values |
  |---|---|
  | `tank` | `'initiator'`, `'bruiser'`, `'stalwart'` |
  | `dps` | `'sharpshooter'`, `'flanker'`, `'specialist'`, `'recon'` |
  | `support` | `'tactician'`, `'medic'`, `'survivor'` |

  (Blizzard publishes each new hero's sub-role; if unsure, pick the closest existing
  hero's sub-role. It only affects grouping, not correctness.)

**Worked example** — adding a new DPS flanker called "Venom":
```ts
{ name: 'Venom', role: 'dps', subRole: 'flanker' },
```

> ⚠️ The value must be one of the listed words **exactly** (lowercase, in quotes), or
> the build will fail with a type error. The error message will name the bad value.

**Check:** save the file. The hero is now in the master list — it will appear in every
filter/dropdown after you deploy, and the portrait matcher will try to load its image.

---

## STEP 2 — Add the hero to the scoreboard role map  *(required)*

**File:** `src/lib/scoreboard-extractor.ts`

Find `HERO_ROLE_MAP` (near the top, around line 47). It's a list like:
```ts
'Reinhardt': 'tank', 'Roadhog': 'tank', 'Sigma': 'tank', ...
```

Add your hero in the section for its role, copying the same `'Name': 'role',` shape:
```ts
'Venom': 'dps',
```

**Why:** this is what makes the hero's role correct on the **scoreboard** (the 10/12-player
screen). Without it, the scoreboard can mis-classify the hero's role.

> The name here must match the `name` from Step 1 **character-for-character** (same
> accent/colon/spelling).

**Check:** save. Build will confirm later.

---

## STEP 3 — Add the hero's portrait image  *(required)*

**Folder:** `public/heroes/`

This is the step with one sharp edge, so read carefully. There are three cases.

### Case A — the hero's name has NO special characters

(Plain letters, spaces, and dots are fine — e.g. "Venom", "Junker Queen", "D.Va".)

Drop a single PNG into `public/heroes/` named **exactly the display name** + `.png`:
```
public/heroes/Venom.png
```
That's it. One file. Done.

### Case B — the hero's name has an accent, umlaut, or colon

(e.g. like "Lúcio", "Torbjörn", "Soldier: 76".)

These need **two** image files **and** one small code edit, because the app looks for
the portrait under two slightly different filenames in two different places:

1. **The "display" filename** — accents stripped, colon removed, spaces kept.
   Examples: `Lúcio` → `Lucio.png`; `Torbjörn` → `Torbjorn.png`;
   `Soldier: 76` → `Soldier 76.png`.

2. **The "matcher" filename** — open `src/lib/hero-matcher.ts`, find
   `HERO_FILENAME_MAP` (near the top), and you'll see:
   ```ts
   const HERO_FILENAME_MAP: Record<string, string> = {
     'Soldier: 76': 'Soldier_76',
     'Torbjörn': 'Torbjorn_safe',
     'Lúcio': 'Lucio_safe',
   }
   ```
   Add a line mapping your hero's exact name to a safe filename (letters, numbers,
   underscores only), e.g.:
   ```ts
   'Nïght': 'Night_safe',
   ```
   Then put a **second** copy of the portrait in `public/heroes/` under that exact
   safe name + `.png` (e.g. `Night_safe.png`).

> **Don't try to memorise this rule.** When you run the app, the `/testing` readiness panel
> tells you precisely which file(s) are missing and what to name them. If your hero is
> Case A and you only need one file, the page will confirm one ✓. If it's Case B, the
> page will show two checks and tell you the second filename to add.

### Case C — you only have a low-quality or wrong-background stopgap image

This is common and worth planning for: the proper, bank-matching portrait often isn't
available when the hero launches. You may be working with a **stopgap** — a small crop, a
non-square image, or one on a coloured/flat background — for the **first week of the
season, sometimes longer**. A stopgap is fine to ship; it just needs preparing, and you
should know how it behaves.

**Prepare the stopgap (always do these two):**
1. **Square it and size it.** Crop to a square centred on the face/head and save at
   128×128. A non-square image gets squashed when the matcher resizes it, distorting the
   face.
2. **Make it a PNG.** The matcher loads `public/heroes/{Name}.png` — a `.jpg` literally
   won't load. Convert.

**If detection is weak (low scores, or the matcher keeps disagreeing with itself):** the
usual culprit is the **background**. The bank portraits sit on dark, hero-themed
backdrops; a stopgap on a flat/pale background drags down the colour and structural parts
of the match (and can pull the matcher toward similarly-backgrounded heroes). The reliable
fix is to **darken the background toward the bank's dark tone** — using a wide, soft mask
that never traces the hair tightly (a tight cutout risks halos or eaten hair, which hurt
matching *more* than the flat background did).

**What to expect from a stopgap — and why it's safe:**
- It will usually score **lower-confidence** than a real portrait. That's the *safe*
  failure mode: low-confidence reads are **flagged in the confirmation pass** for a
  one-tap fix, not silently saved wrong.
- The thing to watch for is the *dangerous* mode: the matcher confidently calling the new
  hero a **different** hero. If your test run shows that, the stopgap isn't good enough —
  prefer manual-select until a better image lands.
- When the real asset arrives, **swap the file**. There's **no data impact** — past
  matches stored the hero by *name* (free text), so nothing re-processes or breaks.

> ⚠️ **Hero-specific image quirks get their own document.** If a particular hero's art
> causes unusual matching trouble (unusual palette, low contrast against the bank, etc.),
> that diagnosis lives in a dedicated per-hero image note, **not here** — this Case C is
> the general, every-season method. (Example on file: the Shion image pack.)



**Check:** run the app and process a screenshot with this hero on the `/testing` page; the readiness panel shows the portrait loads (and, for a special-character name, tells you the exact second filename to add if one is missing). No need to push to production first — localhost is fine.

---

> ### ➡️ Keep going — Steps 4–6 are part of the same setup pass.
> The hero exists and shows its portrait, but you're **not** done yet and you do **not**
> stop to play first. Continue straight into the breakdown stats, the catalog, and the
> SQL below, using the **breakdown screenshots provided with the hero**. Everything gets
> built in one sitting; testing comes after.

---

## STEP 4 — Add the hero's breakdown stats  *(needs the breakdown screenshots)*

**File:** `src/data/stat-meta.ts`

> You need the hero's **Hero Breakdown screenshot(s)** for this step — they're provided
> with every new hero. Read the exact stat names and order straight off the screenshot.

This drives the per-hero **breakdown** display (the deep-dive stats on the Hero Detail
page). Find `HERO_BREAKDOWN_ORDER`. Each hero has a block like:
```ts
"Ana": [
  { label: "Scoped Accuracy",  canonical: "SCOPED ACCURACY",  fmt: "percent", hasPer10: false },
  { label: "Enemies Slept",    canonical: "ENEMIES SLEPT",    fmt: "number",  hasPer10: true  },
  ...
],
```

Add a new block keyed by your hero's **exact display name**, with one line per stat
shown on that hero's in-game breakdown screen, **in the order you want them displayed**.

For **each stat**, fill in four things:

- **`label`** — the human-friendly name to show (Title Case, your choice of wording).
- **`canonical`** — the stat name in **ALL CAPS**, exactly as it appears on the
  breakdown screen (this is what the data is looked up by).
- **`fmt`** — how the value is displayed. **This is the part to get right:**

  | If the stat is… | Set `fmt` to | Example value shown |
  |---|---|---|
  | a **percentage** (accuracy, uptime %) | `"percent"` | `45.2%` |
  | a **time** (e.g. objective contest time) | `"number"` here, **and** see the note below | `2:34` |
  | a plain **count or amount** (kills, damage, healing) | `"number"` | `1,240` |

  > **Important nuance about `fmt`:** in *this* file's `HERO_BREAKDOWN_ORDER` blocks,
  > `fmt` can only be `"percent"` or `"number"` — there is no `"time"` option here.
  > The **time** formatting (like `2:34`) is decided separately by the `TIME_STATS`
  > set lower in the same file (see Step 4b). So for a time stat, put `"number"` in
  > the block here and add the stat name to `TIME_STATS` in Step 4b.

- **`hasPer10`** — this follows a **mechanical rule based on `fmt`, not on what the
  screenshot shows**: every `fmt: "number"` stat is `hasPer10: true`, and every
  `fmt: "percent"` stat is `hasPer10: false` (a per-10 of a percentage is meaningless).
  That's the whole rule — don't try to read it off the breakdown image. So in practice:
  set `true` for your number/count/amount stats, `false` for your percentage stats.
  (This is a display-policy flag, set once by format. Note it differs from the **catalog's**
  `hasAvgPer10` in Step 5, which *is* read from the screenshot — see that step.)

**Worked example** — a block for "Venom":
```ts
"Venom": [
  { label: "Weapon Accuracy",   canonical: "WEAPON ACCURACY",   fmt: "percent", hasPer10: false },
  { label: "Venom Mine Kills",  canonical: "VENOM MINE KILLS",  fmt: "number",  hasPer10: true  },
  { label: "Toxin Damage",      canonical: "TOXIN DAMAGE",      fmt: "number",  hasPer10: true  },
  { label: "Obj Contest Time",  canonical: "OBJ CONTEST TIME",  fmt: "number",  hasPer10: true  },
],
```

### STEP 4b — Register any NEW stat names  *(important, easy to forget)*

Still in `src/data/stat-meta.ts`, you may need to register **brand-new** stat names —
ones no existing hero has. There are three lists near the middle of the file:

1. **`STAT_NORMALISE`** — folds the singular and plural spelling of a stat to one
   canonical form. The OCR sometimes reads "KILL" and sometimes "KILLS", so each new
   stat that can be counted needs **both** spellings pointing at the plural. Pattern:
   ```ts
   "VENOM MINE KILL":  "VENOM MINE KILLS",
   "VENOM MINE KILLS": "VENOM MINE KILLS",
   ```
   > ⚠️ **If you skip this, the value may silently fail to match** and show as blank.
   > Only needed for stat names that don't already exist for another hero.

2. **`PERCENT_STATS`** — if your stat is a **percentage**, add its ALL-CAPS canonical
   name here (this is what actually makes it render as `45.2%`):
   ```ts
   "VENOM ACCURACY",
   ```

3. **`TIME_STATS`** — if your stat is a **time** (like objective contest time), add its
   ALL-CAPS name here so it renders as `m:ss`. (Most heroes only share `OBJ CONTEST
   TIME`, which is already here — you rarely add to this.)

> 🗄️ **Brand-new stat names also need a DATABASE change** — the `hero_stats_normalised`
> view, which keeps its own copy of this folding and must mirror `STAT_NORMALISE`. That's
> **Step 6b** in the SQL step below. Note now which stats are brand-new so you remember to
> add their `WHEN` clauses there.

**Check:** the `/testing` readiness panel will list the hero's breakdown stats with their
**resolved** format, so you can eyeball "Weapon Accuracy → % ✓, Venom Mine Kills →
number ✓". It also **warns** if a stat name isn't in `STAT_NORMALISE`.

> **Reality check on "avg per 10 min":** the app extracts the per-10 value with the
> older text-OCR, which is only ~60% reliable. The `hasPer10: true` flag controls
> whether the column is *shown*; don't be surprised if a per-10 number is occasionally
> blank or off. The primary stat value (the big number) is the reliable one.

---

## STEP 5 — Add the hero to the stat catalog  *(needs the breakdown screenshots)*

**File:** `src/data/hero-stat-catalog.ts`

This list is used to **check OCR accuracy** — it tells the breakdown tester "here are
the stats this hero is *expected* to have," so the tester can report "found 7/7." Find
`HERO_STAT_CATALOG` and add an entry copying the existing shape:
```ts
{
  hero: 'Venom',
  tileCount: 7,                       // how many stat tiles the breakdown screen shows
  stats: [
    { name: 'WEAPON ACCURACY' },
    { name: 'VENOM MINE KILLS', hasAvgPer10: true },
    { name: 'TOXIN DAMAGE',     hasAvgPer10: true },
    ...
  ],
},
```
- **`hero`** — exact display name.
- **`tileCount`** — number of stat tiles on the screen (not counting the hero-info tile).
- **`stats`** — one `{ name: 'ALL CAPS STAT' }` per tile, listing **every** tile on the
  breakdown screen — including the shared role tiles like `FINAL BLOWS` and `SOLO KILLS`
  (the catalog lists those even though `stat-meta.ts`'s `HERO_BREAKDOWN_ORDER` does not).
  Add `hasAvgPer10: true` to the ones that show a per-10 value.

> 📸 **`hasAvgPer10` here IS read from the screenshot** — unlike `hasPer10` in Step 4
> (which is a mechanical format rule). The catalog is a validation record of what the real
> breakdown screen actually shows, so set `hasAvgPer10: true` on exactly the tiles whose
> screenshot displays an "AVG PER 10 MIN" line, and omit it on the ones that don't
> (typically the percentage tiles).

**Check:** the `/testing` readiness panel confirms the catalog entry for the hero. The
`/test-breakdowns` page can then validate a real breakdown screenshot against it.

---

## STEP 6 — Run the database SQL  *(required — part of upfront setup)*

> This is **Step 6 of Phase A** — run it now, with the rest of the setup, before any
> testing. It has two parts: `hero_role_ref` (always) and `hero_stats_normalised` (only
> if Step 4 introduced a brand-new stat name). Both are in the **Supabase SQL Editor**
> (Dashboard → SQL Editor → New query), change no data, and are reversible.

### Step 6a — `hero_role_ref` (always)

**Why:** there's a saved query in the database called `hero_role_ref` that holds a
hardcoded list of every hero and its role. The **Matchups** feature uses it to know
each hero's role. If you skip this, your new hero will show up with an unknown/missing
role in Matchups.

**What to do:** you re-create the list with your new hero added. The safest way is to
copy the current list and add one line. Run this first to see the current list:
```sql
select pg_get_viewdef('hero_role_ref', true);
```
That prints the existing definition. Copy it, add your hero as one more
`('Name'::text,'role'::text)` entry inside the `VALUES (...)` list (matching the exact
name and role from Step 1), and run it back wrapped in `create or replace view`, like:
```sql
create or replace view hero_role_ref as
select hero_name, role
from ( values
  ('D.Va'::text,'tank'::text),
  -- ... all the existing heroes, unchanged ...
  ('Wuyang'::text,'support'::text),
  ('Venom'::text,'dps'::text)        -- ← your new hero, added at the end
) t(hero_name, role);
```

> ⚠️ The hero `name` and `role` must match Step 1 **exactly** (same spelling, accent,
> colon; role is `tank`/`dps`/`support`). Don't remove any existing lines — only add
> yours.

**Check:** after running, this should return your hero:
```sql
select * from hero_role_ref where hero_name = 'Venom';
```

> 🔧 **If the check returns "no rows" — don't re-hand-edit.** This is the one snag worth
> knowing about: hand-editing the long `VALUES` list is error-prone, and it's easy to
> run a `create or replace` that compiles fine but silently didn't include your new line
> (the verify query then comes back empty). When that happens, **don't keep fiddling with
> the big list by hand.** Re-run `pg_get_viewdef('hero_role_ref', true)`, take that exact
> output, and rebuild the *whole* statement fresh — prepend `create or replace view
> hero_role_ref as`, then add your one new line just before the closing
> `) t(hero_name, role);` (remember the previous last line needs a trailing comma once
> yours follows it). Re-run, re-verify. Rebuilding from the live definition beats trying
> to spot what went wrong in the version you already have.
> **How you confirm 6a took:** not on the `/testing` page — that page can't reach the
> database, so it shows the `hero_role_ref` SQL as a copy-and-run reminder, never a live
> ✓. You verify it in **Phase C on localhost**, by opening **Matchups** and seeing the
> hero carry its role. (The `select ... where hero_name` check above is your immediate
> proof the statement ran.)

### Step 6b — `hero_stats_normalised` (only for a brand-new stat name)

Only needed if Step 4 introduced a stat name **no existing hero has**. The database keeps
its **own** copy of the singular/plural stat-name folding, in a saved query called
`hero_stats_normalised`, and it must mirror `STAT_NORMALISE` in `stat-meta.ts`. If your
new stat isn't added here too, its value won't normalise on the database side and
breakdown averages for it may go blank.

In the Supabase SQL Editor:
```sql
select pg_get_viewdef('hero_stats_normalised', true);
```
Copy the definition, add a `WHEN` line for your stat following the existing pattern, and
run it back with `create or replace view hero_stats_normalised as …`:
```sql
when upper(trim(both from stat_name)) = any (array['VENOM MINE KILL','VENOM MINE KILLS'])
     then 'VENOM MINE KILLS'
```

> Only for a **genuinely new** stat. A stat that already exists for another hero (e.g.
> "WEAPON ACCURACY") is already handled — skip it.
>
> 🔧 **Same reassembly rule as 6a:** this `CASE` is even longer, so if anything looks off
> after running, don't hunt through your edited copy — re-run `pg_get_viewdef`, take the
> live output, and rebuild the whole `create or replace view` fresh with your one new
> `WHEN` added. Rebuilding from the live definition is the reliable path.

---
---

## STEP 7 — Add the hero to the breakdown tester filename map  *(optional)*

**File:** `src/app/test-breakdowns/page.tsx`

Only needed if you want to test the hero's breakdown OCR by uploading a screenshot
named after the hero. Find `FILENAME_TO_HERO` and add lines mapping likely filenames to
the exact display name:
```ts
'Venom': 'Venom',
```
(For special-character names, add the plain variant too, like the existing
`'Lucio': 'Lúcio'` lines.)

---

## ✅ END OF PHASE A — the hero is fully built.

Every hero step (1–6, plus 7 if you wanted it) is done in this one pass. Don't validate
yet and don't go play first — if a new **map** also launched, do **Phase B** next;
otherwise skip straight to **Phase C** (validate + push), which is shared and lives at the
end of this document.

> **Quick self-check before moving on:** code edits done (list, role map, breakdown stats,
> catalog), portrait dropped in, and **both SQL parts run** (`hero_role_ref` always;
> `hero_stats_normalised` if there was a brand-new stat). If all of that's true, Phase A is
> complete.

---

# PART 2 (PHASE B — OPTIONAL) — SETTING UP A NEW MAP

> **Only if a new map launched this season.** Many seasons add a hero but no map — when
> that's the case, **skip this entire part** and go to Phase C. A new map needs **no**
> database change, just two code edits, and like the hero it's set up upfront (before any
> testing).

A new map is simpler — two places.

## STEP 1 — Add the map to the master list  *(required)*

**File:** `src/data/reference.ts`

Find the `MAPS` list. Each map looks like:
```ts
{ name: 'King\'s Row', mode: 'hybrid', location: 'England' },
```
Add a line in the right mode section:
- **`name`** — exact in-game map name (mind apostrophes — write `\'` inside single
  quotes, e.g. `'King\'s Row'`, or use double quotes: `"King's Row"`).
- **`mode`** — one of: `'escort'`, `'control'`, `'hybrid'`, `'push'`, `'flashpoint'`.
- **`location`** — the place it's set (free text, e.g. `'Japan'`).

**Worked example:**
```ts
{ name: 'Aurora', mode: 'control', location: 'Norway' },
```

> The **mode** decides whether the map asks the attack/defend question automatically
> (escort and hybrid do; control/push/flashpoint don't). Get the mode right and that's
> handled for you.

## STEP 2 — Add the map's detection keyword  *(required)*

**File:** `src/lib/ocr-extractor.ts`

Find `findMapName`. Inside it is a `partialMatches` list that maps an OCR keyword to a
map name:
```ts
'ANTARCTIC': 'Antarctic Peninsula',
'CIRCUIT': 'Circuit Royal',
...
```
Add a line for your map: pick a distinctive **ALL-CAPS** word from the map's name that
the OCR will reliably read:
```ts
'AURORA': 'Aurora',
```

**Why:** without this, the app may fail to auto-detect the map from a screenshot. (If
that happens, the laptop processing has a manual map-pick dropdown as a fallback — so a
missed keyword isn't catastrophic, just less smooth. Adding the keyword makes detection
automatic.)

> Choose a keyword that won't clash with an existing map (avoid common words). If the
> map name is one clean word, use that word.

---

# PHASE C — VALIDATE, THEN PUSH  *(shared — do this after Phase A, and Phase B if it applied)*

This is the single validation phase for everything you set up. Do it once, after all the
setup is complete.

**1. Build.** In Terminal, from the repo folder:
```
npm run build && npx tsc --noEmit
```
Both must finish with **no errors** before going further. The most common are a `subRole`
typo or a missing comma — the error names the file and line.

**2. `/testing` page — prove the CODE.** Run the app, open **`/testing`**, upload the new
hero's/map's screenshots, and process. In the readiness panel, confirm **every code-side
row is green ✓** — there's no "✗ is fine for now" anymore, because you set everything up
in one pass:
- Hero: in `HEROES` ✓, in scoreboard role map ✓, portrait(s) load ✓, breakdown stats
  present ✓, in stat catalog ✓.
- Map (if applicable): in `MAPS` ✓, detection keyword present ✓.

Eyeball each source-image-vs-data pairing too (click to enlarge). Treat this as a **loop**:
if the panel surfaces anything, fix it and re-run.

> The panel **can't reach the database**, so the two SQL parts show as copy-and-run
> reminders, never live ✓. You prove those in step 3.

**3. localhost (the real app) — prove the INTEGRATION.** localhost talks to the same
Supabase database as production, so this is where the SQL gets proven:
- **Hero:** open **Matchups** specifically and confirm the hero carries its role — that's
  the proof `hero_role_ref` took. Confirm it also appears normally on Home/Heroes.
- **Map:** confirm it's detected from a screenshot (or can be picked from the dropdown
  fallback) and that it asks the attack/defend question for escort/hybrid, saving with the
  right mode.

**4. Push to `main`.** Only once steps 1–3 are clean. Vercel auto-deploys; because the SQL
was already run in Phase A, production is complete the moment the deploy lands.

**5. Later, when you play real games** on the new hero/map, process them as usual and
confirm they appear with data on the Heroes page **and in Matchups**. (This is a sanity
check on live data, not a setup step.)

---

# QUICK REFERENCE — every place a hero/map touches

**New hero — all upfront in Phase A (in order):**
1. `src/data/reference.ts` → `HEROES` — name, role, subRole *(required, makes it exist + fills all filters)*
2. `src/lib/scoreboard-extractor.ts` → `HERO_ROLE_MAP` *(required, scoreboard role)*
3. `public/heroes/{Name}.png` *(required portrait; special-character names need a 2nd file + a `HERO_FILENAME_MAP` line in `src/lib/hero-matcher.ts`; low-quality/stopgap images — see Step 3 Case C)*
4. `src/data/stat-meta.ts` → `HERO_BREAKDOWN_ORDER` (+ `STAT_NORMALISE` / `PERCENT_STATS` / `TIME_STATS`) *(needs the breakdown screenshots)*
5. `src/data/hero-stat-catalog.ts` → `HERO_STAT_CATALOG` *(needs the breakdown screenshots)*
6. **Supabase SQL Editor** → `create or replace view hero_role_ref` with the hero added *(required — role in Matchups)*; **and** `hero_stats_normalised` *(only if a brand-new stat name)*
7. `src/app/test-breakdowns/page.tsx` → `FILENAME_TO_HERO` *(optional)*

**New map — Phase B, only if a map launched (in order):**
1. `src/data/reference.ts` → `MAPS` — name, mode, location *(required)*
2. `src/lib/ocr-extractor.ts` → `findMapName` `partialMatches` keyword *(required for auto-detect)*

**Database (Supabase) summary:** a new **map** needs **no** database change. A new
**hero** needs the `hero_role_ref` view updated (always), and the
`hero_stats_normalised` view updated **only** if it introduces a stat name no existing
hero has. No other Supabase change is ever needed, and no filter component is ever
edited (filters read the master lists automatically). See `SUPABASE-MAP.md` for the
full picture.

> 🔧 **SQL gotcha (both views):** if your post-run verify comes back empty, don't
> re-hand-edit the long statement — re-fetch `pg_get_viewdef`, and rebuild the whole
> `create or replace view` fresh from that live output with your one line added.

**Always finish with Phase C:** `npm run build && npx tsc --noEmit` → `/testing` panel all
green → localhost (Matchups for a hero; detect + attack/defend for a map) → **then** push
to `main`. The Supabase SQL was already run back in Phase A, before this validation.
