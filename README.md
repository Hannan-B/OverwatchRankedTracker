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
   map, and works out the result. You get a quick confirmation pass to fix anything the
   read got wrong, then it saves to the database.
3. **Analyse (any device).** Browse your dashboard, hero analytics, matchups, and trends
   from anywhere.

All image recognition runs **in the browser** — screenshots are processed client-side
and aren't kept after a match is saved.

## Features

- **Automatic extraction** from post-match screenshots — heroes, scoreboard stats,
  per-hero breakdown stats, map, result, and team compositions, with no manual entry.
- **Confirmation pass** that surfaces only the low-confidence reads for a quick check,
  showing the exact region of the screenshot each value came from.
- **Hero analytics** — per-hero win rates, play time, eliminations/assists/deaths,
  damage/healing/mitigation shares, and detailed per-hero breakdown stats.
- **Matchup analysis** — how you perform with a given hero against specific enemy heroes.
- **Combat, outcomes, feel, and time analytics** — trends across your match history,
  including how a match *felt* alongside how it went.
- **Chart builder** — a flexible lab for plotting your own combinations of metrics.
- **5v5 and 6v6 support**, season tracking, and a "leaver game" mode that handles
  matches cut short.
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
