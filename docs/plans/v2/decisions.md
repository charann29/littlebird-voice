# v2 User Decisions (2026-07-21)
1. Hosting: LOCAL DEV ONLY for now — build against `wrangler dev`; no real Cloudflare deploy yet. Code must not depend on deployment (deploy-ready wrangler.jsonc, but D1/Queues/Vectorize run via wrangler dev local simulators; document any local-simulator gaps, esp. Vectorize).
2. Integrations: ALL FOUR with send actions (Google Calendar read + auto-create, Gmail send, Slack post, Notion push/import). Google app stays in Testing mode (unverified screens acceptable).
3. OAuth apps: user creates provider apps; *.workers.dev acceptable for redirect URIs. Client IDs/secrets provided as Worker secrets when ready.
4. Calendar: AUTO-CREATE sessions from events via Worker cron + dedup, in addition to the prep list.
5. Mobile nav: slide-over drawer below tablet breakpoint.
