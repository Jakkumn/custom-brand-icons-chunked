const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ICONS_DIR = path.join(__dirname, "icon-svg");
const DIST_DIR = path.join(__dirname, "dist");
const DOCS_DIR = path.join(__dirname, "docs-dist");
const ENTRY_NAME = "custom-brand-icons.js";

// -------------------- Chunking parameters --------------------
// Icons are packed alphabetically into chunks of at most total/CHUNK_COUNT
// bytes, so CHUNK_COUNT is a target rather than an exact count; the build
// prints what it actually produced. Changing it moves every boundary and so
// invalidates every chunk for every user, which is a one-time cost.
const CHUNK_COUNT = 32;
const HASH_LENGTH = 8;

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR);

function extractPath(svgContent) {
  const m = svgContent.match(/<path[^>]*d="([^"]+)"/);
  return m ? m[1] : "";
}

function extractViewBox(svgContent) {
  const m = svgContent.match(/<svg.+?viewBox="([^"]+)"/);
  if (m) {
    const parts = m[1].split(" ").map(Number);
    if (parts.length === 4) {
      return parts;
    } else {
      throw new Error("Invalid viewBox format: " + m[1]);
    }
  }
  // Fallback to default viewBox if not found
  return [0, 0, 24, 24];
}

// Escape non-ASCII so the entry decodes the same whether it is served as a
// module (always UTF-8) or as a classic script (charset follows the document).
function asciiJSON(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

const files = fs.readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg")).sort();

// Read every icon into a [x, y, w, h, path] tuple.
const entries = [];
files.forEach((file) => {
  try {
    const name = path.basename(file, ".svg");
    const svgContent = fs.readFileSync(path.join(ICONS_DIR, file), "utf8");
    const pathData = extractPath(svgContent);
    const viewBox = extractViewBox(svgContent);
    const line = `  ${JSON.stringify(name)}:[${viewBox.join(",")},${JSON.stringify(pathData)}],\n`;
    entries.push({ name, line, bytes: Buffer.byteLength(line, "utf8") });
  } catch (err) {
    console.log(`❌ Failed to process ${file}: ${err.message}`);
  }
});

// Pack alphabetically to a byte budget. This keeps chunk sizes even and gives
// each chunk a run of neighbouring names, which compresses better than a
// scattered set; it also isolates the handful of very large icons into chunks
// that a page is unlikely to ask for.
const budget = entries.reduce((sum, e) => sum + e.bytes, 0) / CHUNK_COUNT;
const chunks = [[]];
let used = 0;
for (const entry of entries) {
  if (used + entry.bytes > budget && chunks[chunks.length - 1].length) {
    chunks.push([]);
    used = 0;
  }
  chunks[chunks.length - 1].push(entry);
  used += entry.bytes;
}

// Stable filenames with the content hash in the import query. HACS only clears
// the install directory on uninstall, so hashed filenames would accumulate there.
const manifest = {};
const chunkSpecifiers = [];
const chunkSizes = [];
chunks.forEach((chunk, index) => {
  const body = Buffer.from(
    "export default {\n" + chunk.map((e) => e.line).join("") + "};\n",
    "utf8"
  );
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, HASH_LENGTH);
  const filename = `cbi-${index}.js`;
  fs.writeFileSync(path.join(DIST_DIR, filename), body);
  chunkSpecifiers.push(`${filename}?v=${hash}`);
  chunkSizes.push(body.length);
  chunk.forEach((e) => {
    manifest[e.name] = index;
  });
});

// Entry: manifest plus the on-demand loader.
const entrySource = `var CHUNKS = ${JSON.stringify(chunkSpecifiers)};

// Classic scripts expose their URL here; modules get null and resolve the
// relative specifier themselves. import.meta would not parse in a classic script.
var BASE_URL = (typeof document !== "undefined" && document.currentScript)
  ? document.currentScript.src
  : "";

var MANIFEST = ${asciiJSON(manifest)};

// Chunk index -> promise of its icon data; the settled promise is the cache.
var chunkPromises = new Map();
var chunkAttempts = new Map();

function loadChunk(index) {
  var pending = chunkPromises.get(index);
  if (!pending) {
    // A URL that failed to load stays failed in the browser's module map, so a
    // retry has to ask for a different URL to get a fresh fetch.
    var attempt = chunkAttempts.get(index) || 0;
    var query = CHUNKS[index] + (attempt ? "&r=" + attempt : "");
    var specifier = BASE_URL ? new URL(query, BASE_URL).href : "./" + query;
    pending = import(specifier)
      .then(function (module) {
        return module.default;
      })
      .catch(function (err) {
        chunkAttempts.set(index, attempt + 1);
        chunkPromises.delete(index);
        throw err;
      });
    chunkPromises.set(index, pending);
  }
  return pending;
}

async function getIcon(name) {
  if (!Object.prototype.hasOwnProperty.call(MANIFEST, name)) {
    console.log(\`Icon "\${name}" not available\`);
    return '';
  }

  var svgDef;
  try {
    var icons = await loadChunk(MANIFEST[name]);
    svgDef = icons[name];
  } catch (err) {
    console.error(\`Icon "\${name}" could not be loaded\`, err);
    return '';
  }

  if (!svgDef) {
    // Manifest and chunks are emitted together, so the files are mismatched.
    console.error(\`Icon "\${name}" is missing from its chunk; the icon pack files are out of sync\`);
    return '';
  }

  var primaryPath = svgDef[4];
  return {
    path: primaryPath,
    viewBox: svgDef[0] + " " + svgDef[1] + " " + svgDef[2] + " " + svgDef[3]
  }
}

async function getIconList() {
  return Object.keys(MANIFEST).map((icon) => ({
    name: icon
  }));
}

window.customIconsets = window.customIconsets || {};
window.customIconsets["phu"] = getIcon;

window.customIcons = window.customIcons || {};
window.customIcons["phu"] = { getIcon, getIconList };
`;

fs.writeFileSync(path.join(DIST_DIR, ENTRY_NAME), entrySource);

// The icon finder reads the `icons` global synchronously from a classic script,
// so it needs the whole set in one file. Built outside dist/ to keep it out of
// the release assets; sync-icons.yml publishes it to docs/ on the iconfinder branch.
const docsSource = `var icons = {
${entries.map((e) => e.line).join("")}};


async function getIcon(name) {
  if (!(name in icons)) {
    console.log(\`Icon "\${name}" not available\`);
    return '';
  }

  var svgDef = icons[name];
  var primaryPath = svgDef[4];
  return {
    path: primaryPath,
    viewBox: svgDef[0] + " " + svgDef[1] + " " + svgDef[2] + " " + svgDef[3]
  }
}

async function getIconList() {
  return Object.entries(icons).map(([icon]) => ({
    name: icon
  }));
}

window.customIconsets = window.customIconsets || {};
window.customIconsets["phu"] = getIcon;

window.customIcons = window.customIcons || {};
window.customIcons["phu"] = { getIcon, getIconList };
`;

fs.mkdirSync(DOCS_DIR, { recursive: true });
fs.writeFileSync(path.join(DOCS_DIR, ENTRY_NAME), docsSource);

// Drop chunks this build did not write, so a lower CHUNK_COUNT never leaves
// orphans to be committed and shipped. Other files in dist/ are left alone.
const written = new Set(chunkSpecifiers.map((s) => s.split("?")[0]));
const orphans = fs
  .readdirSync(DIST_DIR)
  .filter((f) => /^cbi-\d+\.js$/.test(f) && !written.has(f));
orphans.forEach((f) => fs.unlinkSync(path.join(DIST_DIR, f)));

const kb = (n) => (n / 1024).toFixed(1) + " KB";
const sorted = [...chunkSizes].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];

console.log("✅ Build completed");
console.log(`📁 Generated: dist/${ENTRY_NAME} + ${chunkSpecifiers.length} chunks`);
console.log("🔢 Total icons:", entries.length);
console.log("📦 Chunks:", chunkSpecifiers.length, `(target ${CHUNK_COUNT})`);
console.log("📐 Chunk size: min", kb(sorted[0]), "· median", kb(median), "· max", kb(sorted[sorted.length - 1]));
console.log("🪶 Entry size:", kb(Buffer.byteLength(entrySource, "utf8")));
console.log("🧱 Chunk total:", (chunkSizes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(2), "MB");
console.log(`🔎 Icon finder bundle: docs-dist/${ENTRY_NAME}`, kb(Buffer.byteLength(docsSource, "utf8")));
if (orphans.length) console.log("🧹 Removed stale chunks:", orphans.join(", "));
