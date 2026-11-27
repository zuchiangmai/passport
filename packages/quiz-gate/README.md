# @4seas/quiz-gate

Quiz-gated registration as a small, framework-free module. It needs only Web Crypto, so it runs on Cloudflare Workers, Node 20+, Deno and Bun.

It decides who passed. It does not send mail, create users, set sessions or decide which app needs a pass. The host does those (Passport does it with Better Auth in `src/quiz/`, per OAuth client).

```ts
import { createQuizGate, MemoryQuizStore } from "@4seas/quiz-gate";

const gate = createQuizGate({
  secret,               // ≥ 32 chars; keys email HMACs, IP keys and pass tokens
  bank: () => loadBank(), // or an array; see validateBank()
  store,                // QuizStore: D1, KV+DO, Redis, MemoryQuizStore for tests
  policy: { questions: 3, passScore: 2 },
});

await gate.start({ email, ip, language });            // questions without answers, or cooldown / limits
await gate.submit({ email, attemptId, answers, language }); // score once; pass → { token, expiresAt }
await gate.checkPass(token, email);                    // valid, unexpired, unused, same email
await gate.consumePass(token, email);                  // single use; one concurrent caller wins
```

| Policy | Default |
| --- | --- |
| `questions` / `passScore` | 3 / 2 |
| `attemptTtlMs` | 15 min, one submission per attempt |
| `passTtlMs` | 30 min, single use |
| `nearMissCooldownMs` (score = passScore − 1) | 24 h |
| `failCooldownMs` (lower) | 7 days |
| `startsPerEmailPerDay` / `startsPerIpPerDay` / `startsPerDay` | 3 / 10 / 1000 (UTC days) |
| `shuffleOptions` / `revealAnswers` | true / true |

Questions are picked one per topic first, then from the rest, with crypto randomness. Options are shuffled per attempt and the permutation stays on the server. Emails and IPs are stored only as HMACs. Pass tokens are `qp1.<jti>.<expiry>.<HMAC(jti, expiry, email)>` and also need an unconsumed store row, so they are bound to one email, expire, and cannot be replayed.

`isLikelyBot(userAgent)` flags common crawlers and AI agents.

Run the tests with `node --test src/*.test.ts`.
