const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ICONS_DIR = path.join(__dirname, "icon-svg");
const DIST_DIR = path.join(__dirname, "dist");

// --- Tunables -------------------------------------------------------------
// Icons are split across several chunk files that are imported on demand.
// This budget sets the average chunk size, and so the number of chunks:
// chunkCount = ceil(total icon bytes / CHUNK_TARGET_BYTES).
// Lower it for more, smaller chunks. At ~4.5 MB of icon data:
//   100 KB -> ~46 chunks    150 KB -> ~32 chunks    250 KB -> ~19 chunks
const CHUNK_TARGET_BYTES = 150 * 1024;
// Length of the content hash embedded in each chunk filename.
const HASH_LENGTH = 8;
// --------------------------------------------------------------------------

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

// Remove chunks from previous builds, including any left by the older
// hash-in-filename scheme, so dist/ only ever holds the current set.
fs.readdirSync(DIST_DIR)
  .filter((f) => /^cbi-\d+(\.[0-9a-f]+)?\.js$/.test(f))
  .forEach((f) => fs.unlinkSync(path.join(DIST_DIR, f)));

const files = fs.readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg")).sort();

// 1. Read every icon into a [x, y, w, h, path] tuple.
const entries = [];
files.forEach((file) => {
  try {
    const name = path.basename(file, ".svg");
    const svgContent = fs.readFileSync(path.join(ICONS_DIR, file), "utf8");
    const pathData = extractPath(svgContent);
    const viewBox = extractViewBox(svgContent);
    const line = `  ${JSON.stringify(name)}:[${viewBox.join(",")},${JSON.stringify(pathData)}],\n`;
    entries.push({ name, line });
  } catch (err) {
    console.log(`❌ Failed to process ${file}: ${err.message}`);
  }
});

// 2. Assign icons to chunks.
//
//    The byte budget decides HOW MANY chunks there are; a hash of the icon
//    name decides WHICH chunk each icon lands in. Packing them positionally
//    instead (fill a chunk, start the next) would be more evenly sized, but
//    inserting one icon shifts every boundary after it and re-hashes almost
//    every chunk -- which defeats the point of hashed filenames. Hashing the
//    name keeps an icon in the same chunk across releases, so adding icons
//    only invalidates the chunks they actually land in.
const totalBytes = entries.reduce((sum, e) => sum + Buffer.byteLength(e.line, "utf8"), 0);
const chunkCount = Math.max(1, Math.ceil(totalBytes / CHUNK_TARGET_BYTES));

const chunks = Array.from({ length: chunkCount }, () => []);
for (const entry of entries) {
  const digest = crypto.createHash("sha256").update(entry.name).digest();
  chunks[digest.readUInt32BE(0) % chunkCount].push(entry);
}

// 3. Write each chunk under a STABLE filename, with its content hash carried
//    in the query string the entry imports it with.
//
//    Putting the hash in the filename instead would leave every superseded
//    chunk on disk forever: HACS writes release assets over the existing
//    install directory and only clears it on uninstall (see download_content /
//    remove_local_directory in hacs/repositories/base.py), so renamed files
//    accumulate across releases. A stable name is overwritten in place, and
//    `?v=<content hash>` still busts the cache for exactly the chunks whose
//    contents changed -- unchanged chunks keep their query and stay cached.
const manifest = {};
const chunkFiles = [];   // import specifiers, with the cache-busting query
const chunkNames = [];   // the actual filenames on disk
chunks.forEach((chunk, index) => {
  const body = "export default {\n" + chunk.map((e) => e.line).join("") + "};\n";
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, HASH_LENGTH);
  const filename = `cbi-${index}.js`;
  fs.writeFileSync(path.join(DIST_DIR, filename), body);
  chunkNames.push(filename);
  chunkFiles.push(`${filename}?v=${hash}`);
  chunk.forEach((e) => {
    manifest[e.name] = index;
  });
});

// 4. Write the entry: manifest + on-demand loader. Chunk names below are the
//    exact hashed filenames produced by this same build.
const entry = `var CHUNKS = ${JSON.stringify(chunkFiles)};

var MANIFEST = ${JSON.stringify(manifest)};

// Resolved chunk data, keyed by chunk index.
var chunkData = new Map();
// In-flight imports, keyed by chunk index, so concurrent getIcon() calls for
// icons in the same chunk share a single import.
var chunkPromises = new Map();

function loadChunk(index) {
  if (chunkData.has(index)) {
    return Promise.resolve(chunkData.get(index));
  }
  var pending = chunkPromises.get(index);
  if (pending) {
    return pending;
  }
  // Resolve against this module's own URL so the chunks are found wherever
  // the entry is served from (/hacsfiles/..., /local/..., anywhere else).
  var url = new URL(CHUNKS[index], import.meta.url).href;
  pending = import(url)
    .then(function (module) {
      var data = module.default;
      chunkData.set(index, data);
      chunkPromises.delete(index);
      return data;
    })
    .catch(function (err) {
      // Do not cache a failed import, so a later call can retry.
      chunkPromises.delete(index);
      throw err;
    });
  chunkPromises.set(index, pending);
  return pending;
}

async function getIcon(name) {
  var index = MANIFEST[name];

  if (index === undefined) {
    console.log(\`Icon "\${name}" not available\`);
    return '';
  }

  var icons;
  try {
    icons = await loadChunk(index);
  } catch (err) {
    console.error(\`Icon "\${name}" could not be loaded\`, err);
    return '';
  }

  var svgDef = icons[name];

  if (!svgDef) {
    console.log(\`Icon "\${name}" not available\`);
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

fs.writeFileSync(path.join(DIST_DIR, "custom-brand-icons.js"), entry);

const entryBytes = Buffer.byteLength(entry, "utf8");
const chunkBytes = chunkNames.reduce(
  (sum, f) => sum + fs.statSync(path.join(DIST_DIR, f)).size,
  0
);

console.log("✅ Build completed");
console.log("📁 Generated file: dist/custom-brand-icons.js");
console.log("🔢 Total icons:", entries.length);
console.log("📦 Chunks:", chunkFiles.length, `(target ${Math.round(CHUNK_TARGET_BYTES / 1024)} KB each)`);
console.log("🪶 Entry size:", (entryBytes / 1024).toFixed(1), "KB");
console.log("🧱 Chunk total:", (chunkBytes / 1024 / 1024).toFixed(2), "MB");
