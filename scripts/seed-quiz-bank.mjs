// Loads the quiz bank into D1 from a file kept outside git.
//
//   node scripts/seed-quiz-bank.mjs quiz/bank.local.json            # local D1 (default)
//   node scripts/seed-quiz-bank.mjs quiz/bank.local.js --remote     # production D1, explicit only
//   node scripts/seed-quiz-bank.mjs quiz/bank.local.json --sql out.sql   # write SQL, run nothing
//
// The file is JSON (an array) or a JS module exporting QUIZ_BANK or default.
// Questions not in the file are deactivated. Nothing about the answers is printed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bankSeedSql } from "../src/quiz/bank.ts";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--sql");
const remote = args.includes("--remote");
const sqlOut = args.includes("--sql") ? args[args.indexOf("--sql") + 1] : null;
const database = args.includes("--database") ? args[args.indexOf("--database") + 1] : "passport-auth";
if (!file) {
  console.error("usage: node scripts/seed-quiz-bank.mjs <bank.json|bank.js> [--remote] [--sql out.sql] [--database name]");
  process.exit(2);
}

const path = resolve(file);
const bank = path.endsWith(".json")
  ? JSON.parse(readFileSync(path, "utf8"))
  : await import(pathToFileURL(path).href).then((module) => module.QUIZ_BANK ?? module.default);
const sql = bankSeedSql(bank);
const count = Array.isArray(bank) ? bank.length : 0;

if (sqlOut) {
  writeFileSync(sqlOut, sql, { mode: 0o600 });
  console.log(`wrote ${count} questions to ${sqlOut}. Keep it out of git.`);
} else {
  const directory = mkdtempSync(join(tmpdir(), "quiz-seed-"));
  const sqlFile = join(directory, "seed.sql");
  try {
    writeFileSync(sqlFile, sql, { mode: 0o600 });
    execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", database, remote ? "--remote" : "--local", "--file", sqlFile], { stdio: ["ignore", "ignore", "inherit"] });
    console.log(`seeded ${count} questions into ${remote ? "remote" : "local"} D1 ${database}.`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
