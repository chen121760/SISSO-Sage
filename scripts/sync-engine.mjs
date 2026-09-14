import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const analyzer = path.resolve(process.argv[2] || path.join(project, ".."));
const pairs = [
  [path.join(analyzer, "js", "sisso-core.js"), path.join(project, "src", "vendor", "sisso-core.js")],
  [path.join(analyzer, "js", "health-check.js"), path.join(project, "src", "vendor", "health-check.js")],
];

for (const [source, destination] of pairs) {
  if (!fs.existsSync(source)) throw new Error(`SISSO-Analyzer engine not found: ${source}`);
  fs.copyFileSync(source, destination);
  process.stdout.write(`Synced ${path.basename(source)}\n`);
}
