# 4Seas Passport

Better Auth on Cloudflare Workers and D1. CoLiving and the canteen are clients. They keep their own sessions and store only `sub`.

The previous FastAPI service is in `archive/fastapi/`. The live service at `https://4seas.xyz/passport` runs on the `passport-auth` Worker.

## Local development

Run `pnpm install --frozen-lockfile`. Copy `.dev.vars.example` to `.dev.vars`, set `BETTER_AUTH_URL=http://127.0.0.1:8788` and a private `BETTER_AUTH_SECRET`, then run:

```sh
pnpm exec wrangler d1 migrations apply passport-auth --local
pnpm exec wrangler dev --port 8788
```

Run `pnpm typecheck` and `node --test src/*.test.ts src/*/*.test.ts` for the automated checks.

Login and consent use the [Homepage shared page header and footer](https://github.com/4seas-community/homepage/tree/main/site-chrome). Wrangler copies the pinned package assets into the Worker’s static assets during its build. Use `/passport/en/login`, `/passport/zh/login`, or `/passport/th/login` to open a specific language.

## Google and GitHub sign-in

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` as encrypted secrets on the `passport-auth` Worker. Register these exact callback URLs in the corresponding provider settings:

| Provider | Production callback |
| --- | --- |
| Google | `https://4seas.xyz/passport/api/auth/callback/google` |
| GitHub | `https://4seas.xyz/passport/api/auth/callback/github` |

For local provider testing, use OAuth clients with callbacks at `http://127.0.0.1:8788/api/auth/callback/google` and `http://127.0.0.1:8788/api/auth/callback/github`. Both sign-in methods require a verified account email.
