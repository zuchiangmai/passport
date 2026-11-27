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

## Quiz-gated registration

New accounts can be required to pass a short quiz from a private question bank first. The logic is the standalone module in `packages/quiz-gate/`. The Better Auth plugin in `src/quiz/` wires it into email codes, Google and GitHub.

| Variable | Meaning |
| --- | --- |
| `QUIZ_REGISTRATION` | `off` (default): unchanged. `on`: a new account by email code needs a quiz pass for that email; Google and GitHub sign-up keep working. `strict`: every new account needs a pass. |
| `QUIZ_QUESTIONS`, `QUIZ_PASS_SCORE` | Optional, default 3 and 2. |
| `QUIZ_LEARN_BASE_URL` | Optional base for the bank's relative "learn more" links, for example `https://topic-research.pages.dev/`. |

Apply `migrations/0002_quiz_registration.sql` before deploying this code, even with the flag off, because users now record `registrationMethod` and `quizPassedAt`.

The bank is never committed. Put it in `quiz/bank.local.json` or `quiz/bank.local.js` (git ignores everything in `quiz/` except the example) and run `node scripts/seed-quiz-bank.mjs quiz/bank.local.js`, adding `--remote` for production D1. See `quiz/README.md`.

API, under `/passport/api/auth`: `POST /quiz/start {email}` returns `{status:"quiz", attemptId, questions, passScore, expiresAt}` or `{status:"existing"}`. `POST /quiz/submit {email, attemptId, answers}` returns the score, the review, and on a pass sets an httpOnly `passport_quiz_pass` cookie (also returned as `pass.token` for clients without cookies, sent back as `X-Quiz-Pass` or `quiz_pass` on `/v1/auth/passcode/*`). Without a pass, sending a code to an unknown email returns 403 `QUIZ_REQUIRED` and sends no mail. OIDC userinfo and ID tokens carry `registration_method` and `quiz_passed_at`.

For local end-to-end runs, set `RESEND_API_URL=http://127.0.0.1:<port>/emails` in `.dev.vars` to send mail to a local capture server instead of Resend. Only loopback URLs are honored.
