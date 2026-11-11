# Patch Notes (Simple) — Overwatch Ranked Tracker

> **What this is.** The short, plain-English version of every patch: what was added, changed,
> fixed and retired, as bullet points. Newest patch on top.
> For the full story of each change (what went wrong, why, how it was fixed, which files,
> and any database work), see the detailed notes in [PATCH-NOTES.md](PATCH-NOTES.md).
>
> **Both files are updated together.** Every patch gets an entry in each.
>
> **Headings used:** **Added** (new things) · **Changed** (works differently now) ·
> **Fixed** (bugs) · **Retired** (kept and still working for old data, but no longer used
> going forward; nothing is ever deleted) · **Database** (SQL run in Supabase, if any) ·
> **Known limits** (accepted gaps).

---

## v1.2.0 — 11 November 2026 — Season 5 and bulk upload

**Added**
- **Bulk session upload.** Upload a whole play session's screenshots at once, in any order,
  from your phone ("Or upload a whole session →" on the upload screen). On the laptop,
  Process reads every screenshot, sorts them into matches and shows a preview where you can
  fix anything. Then it saves the clean matches automatically. Anything it isn't sure
  about is held for the normal review.
- **Leaver detection from the scoreboard.** If a team has a missing row, someone left and
  never came back. That match is flagged as a leaver game and its scoreboard isn't used,
  the same as before.
- **Duplicate handling.** A screenshot uploaded twice is spotted and set aside, and a match
  that's already saved is skipped.
- **New hero: Doctrine** (support).
- **New map: Grímsvötn** (escort).
- **Season filter on hero pages** (defaults to the current season), and on each hero in
  Hero Compare, so you can compare a hero before and after a rework.
- **Current kit vs Retired stats on hero pages.** After a rework, stats the hero no longer has
  are shown separately, each with how many games it covers.
- **Session mode on the testing page**, to try bulk grouping on screenshots without saving
  anything.

**Changed**
- **Sombra is now a support hero** from the start of Season 5 (6 October 2026). Her older
  games stay DPS. Every page now works out a hero's role from the date of the match.
- **Roadhog's and Sombra's hero stats** updated for their reworked kits. Roadhog lost Whole
  Hog Kills and gained Average Trash Compacted.
- **Matches with 4 or 5 heroes** now record every hero through bulk upload, not just the
  top 3 shown on the summary screen.
- **Feel and Builder pages** are marked as retired (see below). They're shown in a dimmer
  shade at the right-hand end of the analytics bar, and in their own "Retired" section on
  the Analytics overview and Home.

**Fixed**
- **HDR screenshots.** The scoreboard was being read in slightly the wrong place, giving
  wrong heroes and roles.
- **HDR screenshots.** Role icons were misread (e.g. a DPS player read as tank).
- **HDR screenshots.** The % sign was read as a digit (41% → 410%). This also fixed an older
  bug where a hero's 87% played could be read as 8%.
- A **"NEW CAREER BEST!"** badge moves that stat to the front of the hero screen, which
  could leave one stat saved as "unknown". It now works out which stat is missing.
- **Singular and plural stat names** now count as one stat: Health Pack(s) Hacked,
  Ultimate(s) Negated and Ultimate(s) Reflected.
- **Echo's "Sticky Bombs Kills"** never showed on Echo's hero page because of a spelling
  difference. Fixed, and 7 past Echo games now count.

**Retired** (kept, not deleted)
- **The per-match questions:** matchup feel, performance, fun, standout picks, and the
  returned-leaver and thrower flags. Bulk upload doesn't ask them, and it's the way matches
  are logged from now on. The one-match-at-a-time upload still exists and still asks them.
- **Feel page** and **Builder page.** Both still work for past seasons but get no new data.

**Database**
- Season 5 update: Doctrine's role, Sombra's role history (DPS before Season 5, support
  after) and Matchups using the role at the time of each game.
- Stat name fixes: singular/plural and Echo.
- All run in Supabase and confirmed.

**Known limits**
- Bulk upload can't tell if a leaver came back, or if someone threw. Those matches are
  recorded as normal.
- The small "avg per 10 min" line on a hero's stat screen is occasionally misread. Nothing
  in the app uses it.

---

## v1.1.5 — 19 August 2026

**Fixed**
- A **5v5 match could be saved as 6v6** because the scoreboard was read 2 pixels off. This
  also cut off the Mitigation and Healing numbers.
- The **format you picked on your phone** (5v5/6v6) could be overruled by a guess from the
  screenshot. Your answer is now always used.
- More safety margin when finding your team's half of the scoreboard.
- If the scoreboard's edges can't be found, it now **reports an error** instead of quietly
  assuming 6v6.
- The phone said **"can't read the scoreboard"** on scoreboards that were fine, so standout
  picks fell back to a plain number grid.
- On the phone, the **5v5 team image cut off part of your own row**.
- **Assists were saved as blank** on games where a career-best badge appeared.

---

## v1.1.4 — 18 August 2026

**Fixed**
- **Leaver games** still saved team line-ups and a format read from the scoreboard that
  was meant to be thrown away. Those are now thrown away too.

---

## v1.1.3 — 16 August 2026

**Added**
- A **warning when a competitive 5v5 team isn't 1 tank, 2 DPS, 2 support**. That usually
  means a hero was misread.
- **Standout picks redesigned**: two screens, one pick each, with the team's scoreboard image
  shown.
- A warning if the scoreboard table is unusually narrow.
- Three experimental switches for scoreboard reading, all **off** until tested.

**Changed**
- Choosing **"Nothing"** on the issue steps now moves on automatically.

**Fixed**
- **5v5 scoreboards with short gamertags read almost every hero wrong** (the table had moved
  37 pixels). Positions are now measured from the table's edge in both formats.
- The **hero-matcher health check** had never actually worked.
- **Role-icon accuracy** couldn't be measured. Now it can.
- The 5v5/6v6 cut-off had only 2 pixels of margin.
- **Team line-ups didn't update** after you corrected a hero in the review.
- The **tile check question** was asked at the wrong times, and about a screen it didn't show
  you.
- The testing page's **Score column** mixed two different scales.

---

## v1.1.2 — 15 August 2026

**Fixed**
- **Issue Log: "Start New Season" reset** had gone missing. It's restored.
- **Issue Log: "Processing failures"** section had gone missing. It's restored.

---

## v1.1.1 — 15 August 2026

**Added**
- **New hero: D.Mon** (hero 53).
- **New tank stat: Players Protected**, on every tank.
- Monitoring for two suspected issues (a hero-screen check every third time it's seen, and
  scoreboard measurements logged).

**Changed**
- **Hero Matchups** now opens on the current season, like every other page.

**Fixed**
- **Two matches saved as a loss** when the screen said VICTORY.
- **6v6 scoreboards** read roles as 5-0-1 and got most heroes wrong. Positions are now
  measured from the table's edge.
- Singular/plural **Final Blow(s), Solo Kill(s), Player(s) Saved** weren't treated as the
  same stat in the app.
- **Eight tanks' stat lists were in the wrong order**, which could put a stat under the
  wrong name.

**Database**
- D.Mon added to the two hero lists; Players Protected added.

---

## v1.1.0 — 11 August 2026

**Added**
- **Standout picks**: after a match, choose which ally impressed you and which enemy
  struggled. Shown on Hero Matchups.
- **Leaver types**: someone who left for good is now separate from someone who left and came
  back. A permanent leaver's scoreboard isn't used; a returned leaver's is kept.

**Changed**
- **New question set (Q2)**: five questions, with fun on a 1–6 scale. Old answers are kept and
  shown with their own season.
- **Filters**: Mode, Map and Hero can each pick several at once, and Season is a dropdown.

**Fixed**
- The **match detail page** showed no fun rating for matches on the new questions.
- **Nine matches** had a broken heroes list.
- The **Combat chart** disappeared with a hero filter, the **Outcomes** side panel was
  always blank, and **Time** drew empty bars.
- Menus promised charts that no longer existed, some raw database values showed on screen,
  and times were shown inconsistently.

**Retired**
- The **tempo** and **coordination** questions.

**Database**
- New columns for the new questions and leaver types; new standout-picks table; heroes-list
  fix.

---

## v1.0.2 — 4 August 2026

**Changed**
- Before saving, **every scoreboard row is now shown next to its image** for you to check,
  instead of only the rows the app suspected.

**Fixed**
- **About 1 in 5 scoreboard heroes were wrong**, getting worse the longer a session ran (a
  memory leak in the hero matcher). Fixed, and the matcher now restarts itself if it
  struggles.
- The **auto-correct swapped correct heroes** for wrong ones. Its threshold is now tuned on
  real results.
- **Past data repaired**: 71 wrong heroes, role stuck on DPS, and 9 wrong "% played" values.

**Retired**
- **Beta confirmation step** (it missed 60 of 71 real errors). Replaced by the full check
  above.

**Database**
- Four new columns for the review; past data corrected.

---

## v1.0.1

**Fixed**
- **Shion** now uses the official portrait, so the hero is recognised reliably.
- **Hero Matchups** was empty on every queue.
- **Leaver games** skewed the Home page's win rate and totals. They now follow your leaver
  setting.
- The **beta confirmation step** flagged almost every hero stat. It now only checks counts.

---

## vX.Y.Z — template for the next patch (copy this block up top)

**Added**
-

**Changed**
-

**Fixed**
-

**Retired** (kept, not deleted)
-

**Database**
- None.

**Known limits**
-
