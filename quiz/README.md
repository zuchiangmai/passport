# Quiz bank

This repository is public, so only `bank.example.json` is committed. Everything else in this folder is ignored by git.

Put the real bank at `quiz/bank.local.json` or `quiz/bank.local.js` (a module exporting `QUIZ_BANK`), then load it into D1:

```sh
node scripts/seed-quiz-bank.mjs quiz/bank.local.js            # local D1
node scripts/seed-quiz-bank.mjs quiz/bank.local.js --remote   # production D1
```

Each question is `{ id, topic, q, options, answer, explain?, context?, source?, learn?, i18n? }`. `answer` indexes `options`. `i18n.en`, `i18n.th` and so on may override `topic`, `q`, `options`, `explain` and `context`. `learn[].u` may be relative to `QUIZ_LEARN_BASE_URL`.
