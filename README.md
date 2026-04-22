# Gio Therapies Backend API

Express API for bookings, services CMS, settings, about content, footer content, uploads, and media proxy.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

API health check:

```bash
curl http://localhost:3001/health
```

## Environment variables

- `PORT` (default: `3001`)
- `SUPABASE_URL` (required)
- `SUPABASE_ANON_KEY` (required)
- `RESEND_API_KEY` (optional, for confirmation emails)

Compatibility fallbacks still supported:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Deploy notes

1. Run this API on your server (Node 20+ recommended).
2. Put it behind HTTPS reverse proxy (Nginx/Caddy).
3. Expose under a stable domain (example: `https://api.giotherapies.uk`).
4. Point frontend API base to that domain.
