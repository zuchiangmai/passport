// Marks existing members of an app as having passed the quiz (table quiz_preapproved),
// e.g. topic-research members when the site moves to Passport. Emails come from a file
// outside git, one per line or comma separated; they are never printed.
//
//   node scripts/import-quiz-preapproved.mjs members.txt --source topic-research            # local D1
//   node scripts/import-quiz-preapproved.mjs members.txt --source topic-research --remote   # production
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const file = args.find((arg, i) => !arg.startsWith("--") && !["--source", "--database"].includes(args[i - 1]));
const source = value("--source");
const database = value("--database") ?? "passport-auth";
if (!file || !source || !/^[a-z0-9-]+$/.test(source)) {
  console.error("usage: node scripts/import-quiz-preapproved.mjs <emails.txt> --source <app> [--remote] [--database name]");
  process.exit(2);
}
const emails = [...new Set(readFileSync(file, "utf8").split(/[\s,;]+/).map((e) => e.trim().toLowerCase())
  .filter((e) => /^[^@\s'"]+@[^@\s'"]+\.[^@\s'"]+$/.test(e)))];
const now = Date.now();
const sql = emails.map((e) => `INSERT INTO quiz_preapproved (email, source, created_at) VALUES ('${e}', '${source}', ${now}) ON CONFLICT (email) DO NOTHING;`).join("\n");
if (!emails.length) { console.log("no emails found"); process.exit(0); }
const directory = mkdtempSync(join(tmpdir(), "quiz-preapproved-"));
try {
  const sqlFile = join(directory, "import.sql");
  writeFileSync(sqlFile, sql + "\n", { mode: 0o600 });
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", database, args.includes("--remote") ? "--remote" : "--local", "--file", sqlFile], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`imported ${emails.length} emails as preapproved for ${source}.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
