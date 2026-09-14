import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const output = path.resolve("dist", "sisso-sage-mcp.mjs");
fs.mkdirSync(path.dirname(output), { recursive: true });

await build({
  entryPoints: [path.resolve("mcp", "server.mjs")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});

process.stdout.write(`Built ${output}\n`);
