import fs from "node:fs";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([".py", ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".toml"]);
const IGNORED = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

export function traceFeatureSource(feature, sourceRoot, options = {}) {
  if (!feature) throw new Error("A feature name is required.");
  if (!sourceRoot) return { feature, sourceRoot: null, status: "source-root-required", matches: [] };
  const root = path.resolve(sourceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Feature source directory does not exist: ${root}`);
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const maxFileBytes = Math.max(1024, Number(options.maxFileBytes) || 5_000_000);
  const matches = [];
  const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactIdentifier = new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`);
  const stack = [root];
  while (stack.length && matches.length < limit) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > maxFileBytes) continue;
      let lines;
      try { lines = fs.readFileSync(full, "utf8").split(/\r?\n/); } catch { continue; }
      lines.forEach((line, index) => {
        if (matches.length >= limit || !exactIdentifier.test(line)) return;
        matches.push({ file: path.relative(root, full).split(path.sep).join("/"), line: index + 1, text: line.trim().slice(0, 500) });
      });
      if (matches.length >= limit) break;
    }
  }
  return { feature, sourceRoot: root, status: matches.length ? "matches-found" : "no-match", matches, truncated: matches.length >= limit };
}
