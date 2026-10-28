#!/usr/bin/env node
// custom-brand-icons/script/verify-dist.mjs
// Run:
//   node script/verify-dist.mjs [<dist_dir>]     (default: dist)
//
// Checks the build against the entry's own chunk list: every chunk present,
// every chunk's bytes matching the content hash in its import query, no
// unreferenced chunks left behind, and one icon per SVG source. Exits non-zero
// on any mismatch, so a stale or partial build fails here instead of shipping.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIST = process.argv[2] ?? "dist";
const DOCS_DIST = "docs-dist";
const ENTRY = "custom-brand-icons.js";
const ICONS_DIR = "icon-svg";

const problems = [];
const fail = (msg) => problems.push(msg);

const entryPath = path.join(DIST, ENTRY);
if (!fs.existsSync(entryPath)) {
  console.error(`❌ ${entryPath} not found. Run: node custom-icons-builder.cjs`);
  process.exit(1);
}
const entry = fs.readFileSync(entryPath, "utf8");

const chunkList = entry.match(/^var CHUNKS = (\[.*?\]);$/m);
if (!chunkList) {
  console.error(`❌ ${entryPath} has no CHUNKS list; it was not produced by the current builder.`);
  process.exit(1);
}
const specifiers = JSON.parse(chunkList[1]);
if (specifiers.length === 0) fail("the entry lists no chunks at all");

// Each specifier is "cbi-<n>.js?v=<hash>"; the hash must match the file's bytes.
const referenced = new Set();
for (const specifier of specifiers) {
  const [filename, query] = specifier.split("?");
  referenced.add(filename);
  const file = path.join(DIST, filename);
  if (!fs.existsSync(file)) {
    fail(`${filename} is referenced by the entry but missing`);
    continue;
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0) {
    fail(`${filename} is empty`);
    continue;
  }
  const expected = (query ?? "").replace(/^v=/, "");
  const actual = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, expected.length);
  if (!expected) {
    fail(`${filename} is referenced without a content hash`);
  } else if (actual !== expected) {
    fail(`${filename} does not match the hash the entry expects (${expected} vs ${actual}) — mismatched build`);
  }
}

// Unreferenced chunks would be published as release assets and never loaded.
for (const file of fs.readdirSync(DIST)) {
  if (/^cbi-\d+\.js$/.test(file) && !referenced.has(file)) {
    fail(`${file} is not referenced by the entry — stale chunk from an earlier build`);
  }
}

// Every SVG source must appear exactly once across the chunks. This is what
// catches a dist/ built from an older icon-svg/.
if (fs.existsSync(ICONS_DIR)) {
  const sources = fs.readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg")).length;
  const seen = new Set();
  let duplicates = 0;
  for (const filename of referenced) {
    const body = fs.readFileSync(path.join(DIST, filename), "utf8");
    for (const match of body.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)) {
      if (seen.has(match[1])) duplicates++;
      seen.add(match[1]);
    }
  }
  if (seen.size !== sources) {
    fail(`${seen.size} icons across the chunks but ${sources} SVG sources — dist/ is out of date`);
  }
  if (duplicates) fail(`${duplicates} icon name(s) appear in more than one chunk`);

  // The icon finder is served the whole set as one file; it ships from docs-dist/.
  const docsEntry = path.join(DOCS_DIST, ENTRY);
  if (!fs.existsSync(docsEntry)) {
    fail(`${docsEntry} not found — the icon finder bundle was not built`);
  } else {
    const docs = fs.readFileSync(docsEntry, "utf8");
    const count = [...docs.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].length;
    if (count !== sources) fail(`${docsEntry} holds ${count} icons but there are ${sources} SVG sources`);
    if (!/^var icons = \{/m.test(docs)) fail(`${docsEntry} does not define the "icons" global the icon finder reads`);
  }
}

if (problems.length) {
  console.error("❌ dist/ is not shippable:");
  for (const problem of problems) console.error(`   - ${problem}`);
  process.exit(1);
}

console.log(`✅ ${ENTRY} plus all ${specifiers.length} chunk(s) present, hashes match, ${fs.readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg")).length} icons`);
