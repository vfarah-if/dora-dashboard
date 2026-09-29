#!/usr/bin/env node
/**
 * Fails when a name you must not publish appears in any tracked file.
 *
 * The names live in `.private-names` (one per line, `#` comments allowed), which is gitignored, so
 * the list itself is never published. With no such file the check passes with a notice, which is the
 * right answer for a contributor who has nothing private to protect.
 *
 *   node scripts/check-private-names.mjs            scan tracked and staged files
 *   node scripts/check-private-names.mjs --self-test prove the matcher still bites
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const LIST = ".private-names";

export function loadNames(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

export function findHits(names, files) {
  const patterns = names.map((name) => ({ name, re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") }));
  const hits = [];
  for (const [path, content] of files) {
    content.split("\n").forEach((line, i) => {
      for (const { name, re } of patterns) if (re.test(line) || re.test(path)) hits.push({ path, line: i + 1, name });
    });
  }
  return hits;
}

if (process.argv.includes("--self-test")) {
  const hits = findHits(
    ["secretco"],
    [
      ["a.md", "made for SecretCo"],
      ["b.md", "secretcoastal is fine"],
    ],
  );
  if (hits.length !== 1 || hits[0].path !== "a.md") {
    console.error("check-private-names self-test failed: the matcher no longer bites");
    process.exit(1);
  }
  console.log("check-private-names self-test passed");
  process.exit(0);
}

if (!existsSync(LIST)) {
  console.log(`check-private-names: no ${LIST} file, nothing to check`);
  process.exit(0);
}

const names = loadNames(readFileSync(LIST, "utf8"));
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((p) => p && p !== LIST && existsSync(p));
const files = tracked.map((p) => [p, readFileSync(p, "utf8")]);
const hits = findHits(names, files);

if (hits.length) {
  // Name the file and line only; printing the matched name would publish it in CI logs.
  console.error(`check-private-names: ${hits.length} private name(s) found`);
  for (const hit of hits) console.error(`  ${hit.path}:${hit.line}`);
  process.exit(1);
}
console.log(`check-private-names: ${files.length} files clean against ${names.length} name(s)`);
