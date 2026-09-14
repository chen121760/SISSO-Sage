// Verify that the README's documented commands, flags, dictionary columns,
// leakage verdicts and "no install needed" claim still match the code.
//
// Run: node scripts/check-readme.mjs
import fs from "node:fs";
import path from "node:path";
import { CAPABILITIES } from "../src/capabilities.mjs";
import { MODEL_LIST_HARD_CAP } from "../src/service.mjs";

const root = path.resolve(import.meta.dirname, "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

const problems = [];
const ok = (label, condition, detail = "") => {
  console.log((condition ? "  PASS  " : "  FAIL  ") + label + (detail ? "  " + detail : ""));
  if (!condition) problems.push(label);
};

// --- 1) Commands table: scope to the section under "## Commands" ---
const commandsSection = readme.split("## Commands")[1].split("### Reading")[0];
const documented = [...commandsSection.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort();
const cliCommands = Object.keys(CAPABILITIES.commands).sort();
// `capabilities` is handled before the capabilities map is consulted and, like
// most self-describing commands, does not list itself in its own output.
const META_COMMANDS = ["capabilities"];
console.log("Commands table vs CLI:");
ok("every CLI command is documented", cliCommands.every((c) => documented.includes(c)),
  "missing: " + (cliCommands.filter((c) => !documented.includes(c)).join(", ") || "none"));
const undocumentedInCli = documented.filter((c) => !cliCommands.includes(c) && !META_COMMANDS.includes(c));
ok("no documented command is missing from the CLI", undocumentedInCli.length === 0,
  "extra: " + (undocumentedInCli.join(", ") || "none"));

// --- 2) Flags used in bash examples must be real options ---
const codeBlocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
const flags = [...new Set([...codeBlocks.matchAll(/--([a-zA-Z][a-zA-Z-]*)/g)].map((m) => m[1]))].sort();
const known = new Set([
  "verify", "features", "feature-dictionary", "rename-map", "source-root", "top-file",
  "limit", "sort", "feature", "rank", "ranks", "dataset", "metric", "output", "compact",
]);
console.log("\nFlags used in README examples:");
ok("all example flags are recognised", flags.every((f) => known.has(f)),
  "unknown: " + (flags.filter((f) => !known.has(f)).join(", ") || "none") + "   used: " + flags.join(", "));

// --- 3) Dictionary columns table must match the code ---
const dictSection = readme.split("The dictionary is read with these columns")[1].split("A dictionary whose columns")[0];
const dictCols = [...dictSection.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
const expected = CAPABILITIES.dictionaryColumns.featureDictionary;
console.log("\nDictionary columns:");
ok("README columns == capabilities.dictionaryColumns.featureDictionary",
  JSON.stringify(dictCols) === JSON.stringify(expected),
  "README [" + dictCols.join(", ") + "]  code [" + expected.join(", ") + "]");

// --- 4) Documented leakage verdicts must exist in the code ---
const leakSection = readme.split("## Hold-out independence")[1].split("For MT-SISSO")[0];
const verdicts = [...leakSection.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort();
const codeVerdicts = ["disjoint", "leaked-identical-rows", "leaked-same-sample",
  "shared-structure-ids", "shared-compositions", "same-dataset", "not-applicable"];
console.log("\nLeakage verdicts:");
ok("every documented verdict exists in the code", verdicts.every((v) => codeVerdicts.includes(v)),
  "documented: " + verdicts.join(", "));

// --- 5) --limit cap stated in README == code ---
const stated = readme.match(/hard cap (\d+)/);
console.log("\n--limit:");
ok("README cap matches MODEL_LIST_HARD_CAP", stated && Number(stated[1]) === MODEL_LIST_HARD_CAP,
  "README " + (stated ? stated[1] : "unstated") + " vs code " + MODEL_LIST_HARD_CAP);

// --- 6) The "no install step" claim ---
console.log("\nNo-install claim:");
const distPath = path.join(root, "dist", "sisso-sage-mcp.mjs");
const distExists = fs.existsSync(distPath);
ok("dist/sisso-sage-mcp.mjs is present in the tree", distExists);
if (distExists) {
  const specs = [...fs.readFileSync(distPath, "utf8").matchAll(/^\s*import\s.*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  const external = [...new Set(specs)].filter((s) => !s.startsWith("node:"));
  ok("the bundled server imports only Node builtins", external.length === 0,
    "external: " + (external.join(", ") || "none"));
}
// The CLI analysis core must stay dependency-free.
const externals = fs.readdirSync(path.join(root, "src"))
  .filter((f) => f.endsWith(".mjs"))
  .flatMap((f) => [...fs.readFileSync(path.join(root, "src", f), "utf8")
    .matchAll(/^\s*import\s.*?from\s*["']([^"']+)["']/gm)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith("node:") && !s.startsWith(".")));
ok("no src/ module imports an external package", externals.length === 0,
  "external: " + ([...new Set(externals)].join(", ") || "none"));

console.log("\n" + (problems.length
  ? "RESULT: " + problems.length + " PROBLEM(S) - README has drifted from the code"
  : "RESULT: all README claims verified against the code"));
process.exitCode = problems.length ? 1 : 0;
