# 4Seas Passport

Better Auth on Cloudflare Workers and D1. CoLiving and the canteen are clients. They keep their own sessions and store only `sub`.

The previous FastAPI service is in `archive/fastapi/`. The live service at `https://4seas.xyz/passport` runs on the `passport-auth` Worker.

## Local development

Run `pnpm install --frozen-lockfile`. Copy `.dev.vars.example` to `.dev.vars`, set `BETTER_AUTH_URL=http://127.0.0.1:8788` and a private `BETTER_AUTH_SECRET`, then run:

```sh
pnpm exec wrangler d1 migrations apply passport-auth --local
pnpm exec wrangler dev --port 8788
```

Run `pnpm typecheck` and `pnpm test` (`node --test src/*.test.ts src/*/*.test.ts packages/*/src/*.test.ts`) for the automated checks.

Login and consent use the [Homepage shared page header and footer](https://github.com/4seas-community/homepage/tree/main/site-chrome). Wrangler copies the pinned package assets into the Worker’s static assets during its build. Use `/passport/en/login`, `/passport/zh/login`, or `/passport/th/login` to open a specific language.

## Google and GitHub sign-in

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` as encrypted secrets on the `passport-auth` Worker. Register these exact callback URLs in the corresponding provider settings:

| Provider | Production callback |
| --- | --- |
| Google | `https://4seas.xyz/passport/api/auth/callback/google` |
| GitHub | `https://4seas.xyz/passport/api/auth/callback/github` |

For local provider testing, use OAuth clients with callbacks at `http://127.0.0.1:8788/api/auth/callback/google` and `http://127.0.0.1:8788/api/auth/callback/github`. Both sign-in methods require a verified account email.

## Quiz gate for selected apps

Some apps (topic-research) want new members to pass a short quiz before they can use the app. Passport supports this per OAuth/OIDC client. It is off by default.

**With the switch off, nothing changes.** The quiz plugin is not registered, no `/quiz` page or endpoint exists, and no quiz table or new column is read or written. This code runs on the current production schema without migration `0002`. User rows, sessions, OIDC claims, the login and consent pages, CoLiving, canteen and the legacy passcode/connect APIs behave exactly as on `main` (see `src/quiz/flow.test.ts`, which runs these flows against `main`'s schema).

**With the switch on**, anyone can still create an account by email code, Google, GitHub or passkey. When a signed-in user authorizes a client listed in `QUIZ_CLIENTS` and has not passed yet, Better Auth's `postLogin` step sends them to `/passport/quiz`. Once they pass, the authorization continues and the app gets its code. The pass is stored in the `quiz_registration` table (user, first sign-in method, time, score) and is asked for only once. Other clients never see the quiz. No OIDC claims are added: an authorization for a quiz client means the user passed.

| Variable | Meaning |
| --- | --- |
| `QUIZ_REGISTRATION` | Master switch. Only `on` enables the quiz. Anything else, or unset, is off. |
| `QUIZ_CLIENTS` | Comma-separated OAuth client IDs that require a pass, e.g. the topic-research client ID. Empty means no client is gated. |
| `QUIZ_QUESTIONS`, `QUIZ_PASS_SCORE` | Optional, default 3 and 2. |
| `QUIZ_LEARN_BASE_URL` | Optional base for the bank's relative "learn more" links, for example `https://topic-research.pages.dev/`. |

The quiz logic is the standalone module in `packages/quiz-gate/`. `src/quiz/` holds the Better Auth plugin (`/quiz/status`, `/quiz/start`, `/quiz/submit`, all requiring a session) and the `postLogin` check.

### Rollout

1. Deploying this code with the switch off needs nothing: no migration, no secrets, no seed.
2. To enable it: apply `migrations/0002_quiz_registration.sql` to the D1 database (it only creates new `quiz_*` tables), seed the bank, then set `QUIZ_REGISTRATION=on` and `QUIZ_CLIENTS=<client id>`.
3. Optional: mark the app's existing members as passed with `node scripts/import-quiz-preapproved.mjs members.txt --source <app> --remote` (emails file kept outside git). They go straight through on their first visit.
4. Register the app as an OAuth client (with `skipConsent` for first-party apps) and point it at Passport's OIDC discovery document.

The bank is never committed. Put it in `quiz/bank.local.json` or `quiz/bank.local.js` (git ignores everything in `quiz/` except the example) and run `node scripts/seed-quiz-bank.mjs quiz/bank.local.js`, adding `--remote` for production D1. See `quiz/README.md`.

For local end-to-end runs, set `RESEND_API_URL=http://127.0.0.1:<port>/emails` in `.dev.vars` to send mail to a local capture server instead of Resend. Only loopback URLs are honored. Never set it in production.
