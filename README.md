# 4Seas Passport

Better Auth on Cloudflare Workers and D1. CoLiving and the canteen are clients. They keep their own sessions and store only `sub`.

The previous FastAPI service is in `archive/fastapi/`. Roll back the code with `git checkout sub-login`. The existing Worker named `passport` is left in place. This branch deploys as `passport-auth`.

Local: `pnpm install`, put secrets in `.dev.vars` (see `.dev.vars.example`), then `pnpm exec wrangler dev --port 8788`.
