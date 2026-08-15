# Overwatch Ranked Tracker

A Progressive Web App for tracking and analysing your *Overwatch 2* competitive
matches. Take screenshots of the post-match screens on a console, upload them, and the
app reads the data straight off the images — then turns your match history into
dashboards, hero breakdowns, and matchup analysis.

It's built as a personal, single-user tool: there's no social layer and no shared data —
just your own ranked history, extracted automatically and explored in depth.

## How it works

The core idea is that you never type match data in by hand. The app extracts it from
your screenshots using client-side image recognition:

1. **Capture (phone).** After a game, photograph the post-match screens — the summary,
   the per-hero breakdown(s), and the scoreboard — and upload them through the app.
2. **Process (laptop).** The app reads each screenshot: it identifies the heroes by
   matching their portraits, reads the scoreboard and stat numbers with OCR, detects the
   map, and works out the result. You then audit every scoreboard row against the image
   before saving, and answer a short set of questions about how the match felt.
3. **Analyse (any device).** Browse your dashboard, hero analytics, matchups, and trends
   from anywhere.

All image recognition runs **in the browser** — no image is ever sent to a recognition
service. Screenshots are held in your own Supabase Storage between the phone upload and
the laptop processing step, and are deleted once the match is saved; unprocessed uploads
are cleared automatically after 21 days.

## Features

- **Automatic extraction** from post-match screenshots — heroes, scoreboard stats,
  per-hero breakdown stats, map, result, and team compositions, with no manual entry.
- **Per-slot audit** before saving: every scoreboard row is shown for review, in the same
  order as the screenshot, with the region each value was read from. Low-confidence reads
  are flagged, but nothing is hidden — an earlier version only surfaced suspected errors,
  which meant the ones it was confident and wrong about went unchecked.
- **Hero analytics** — per-hero win rates, play time, eliminations/assists/deaths,
  damage/healing/mitigation shares, and detailed per-hero breakdown stats.
- **Matchup analysis** — how you perform with a given hero against specific enemy heroes,
  plus which heroes you pair well with and side-by-side hero comparison.
- **Combat, outcomes, feel, and time analytics** — trends across your match history,
  including how a match *felt* alongside how it went.
- **Standout picks** — mark the hero that stood out after a match, and see which heroes
  stand out most often relative to how often you could have picked them.
- **Chart builder** — a flexible lab for plotting your own combinations of metrics.
- **5v5 and 6v6 support**, season tracking, and leaver handling that distinguishes a
  player who left permanently from one who reconnected — the scoreboard is unusable in
  the first case and fine in the second.
- **Light / dark / system theming**, and installable as a PWA on phone and desktop.

## Tech stack

- **Frontend:** Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS
- **Backend:** Supabase — PostgreSQL, Auth, and Storage
- **Image recognition:** OpenCV.js for hero-portrait template matching (in a Web Worker)
- **OCR:** Tesseract.js for reading stat numbers and text
- **Hosting:** Vercel

Screenshots are expected at a consistent console resolution; the extraction is
calibrated to fixed screen regions.

## Getting started

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

### Environment variables

Copy `.env.example` to `.env.local` and fill in your own Supabase project credentials:

```
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

You'll need a Supabase project with the app's schema in place (tables for matches,
hero performances, scoreboard rows, and the analytics views the pages read from).

## Development notes

- A built-in **`/testing` page** lets you run real screenshots through the full
  extraction pipeline and inspect what was read, without saving anything to the
  database — useful for validating extraction accuracy.
- Each competitive season usually adds a new hero (and sometimes a new map). There's a
  documented process for adding these, since a handful of reference files and database
  views need updating when the roster changes.

## Status

Actively developed as a personal project. Built and tested against console screenshots
at a fixed resolution; extraction accuracy depends on that consistency.
