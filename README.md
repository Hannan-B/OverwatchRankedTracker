# Overwatch Ranked Tracker

A Progressive Web App for tracking and analysing your Overwatch 2 competitive matches.

## Architecture

- **Frontend:** Next.js 14 + React 18 + Tailwind CSS
- **Database:** Supabase (PostgreSQL)
- **File Storage:** Supabase Storage (temporary match photos)
- **Image Recognition:** OpenCV.js (client-side, coming soon)
- **OCR:** Tesseract.js (client-side, coming soon)
- **Hosting:** Vercel

## Workflow

1. **Phone:** Take match result photos → upload via the app
2. **Laptop:** Process photos → review extracted data → save to database
3. **Any device:** View dashboard, stats, hero analytics

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```
