import fs from "node:fs";
import path from "node:path";

const DEFAULT_NAMES = ["sage.features.json", "feature-metadata.json"];

function normalizeFeatureRecords(raw) {
  const source = raw?.features ?? raw ?? {};
  const normalize = (name, value) => ({
    name,
    ...(value || {}),
    reviewStatus: value?.reviewStatus || "needs-user-confirmation",
  });
  if (Array.isArray(source)) return Object.fromEntries(source.filter((item) => item?.name).map((item) => [item.name, normalize(item.name, item)]));
  if (!source || typeof source !== "object") throw new Error("Feature metadata must contain an object or array of features.");
  return Object.fromEntries(Object.entries(source).map(([name, value]) => [name, normalize(name, value)]));
}

// Split one CSV line into trimmed fields (RFC4180 quoting, no embedded newlines).
function splitCsvLine(line) {
  const fields = [];
  let field = "", quoted = false;
  const text = String(line || "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { fields.push(field); field = ""; }
    else field += char;
  }
  fields.push(field.replace(/\r$/, ""));
  return fields.map((value) => value.trim());
}

function csvRows(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).filter((values) => values.some((value) => value.trim())).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, (values[index] || "").trim()])));
}

function findFile(root, basename) {
  if (!root || !fs.existsSync(root)) return null;
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if ([".git", "node_modules", "__pycache__"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) return full;
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return null;
}

export function parseUnitManifest(text) {
  if (!text) return {};
  const features = {};
  let assignments = false;
  String(text).split(/\r?\n/).forEach((line, index) => {
    if (/^Feature assignments:/i.test(line.trim())) { assignments = true; return; }
    if (!assignments || !/^\s*\d+\s+\S+/.test(line)) return;
    const tokens = line.trim().split(/\s+/);
    let vectorStart = -1;
    for (let i = 2; i < tokens.length; i++) {
      if (tokens.length - i >= 2 && tokens.slice(i).every((value) => /^-?\d+(?:\.\d+)?$/.test(value))) { vectorStart = i; break; }
    }
    if (vectorStart < 3) return;
    const name = tokens[1];
    features[name] = {
      name,
      unit: tokens.slice(2, vectorStart).join(" "),
      unitVector: tokens.slice(vectorStart).map(Number),
      reviewStatus: "unit-manifest-only",
      evidence: [{ kind: "unit-manifest", line: index + 1 }],
    };
  });
  return features;
}

// The columns a feature dictionary must use for SISSO-Sage to read it. A
// dictionary written with near-miss names (feature_name / description /
// category / source_file) previously parsed to zero features in total silence,
// which looked identical to "no dictionary supplied". Detect that explicitly.
const DICTIONARY_COLUMNS = ["feature", "note", "unit", "group", "source"];
const DICTIONARY_ALIASES = {
  feature: ["feature", "feature_name", "name", "feature_id"],
  note: ["note", "description", "desc", "meaning"],
  unit: ["unit", "units"],
  group: ["group", "category", "family", "class"],
  source: ["source", "source_file", "provenance", "file"],
};
function headerColumns(text) {
  const firstLine = String(text || "").split(/\r?\n/, 1)[0] || "";
  return splitCsvLine(firstLine).filter((value) => value.length > 0);
}

function dictionaryDiagnostics(dictionaryText) {
  if (!dictionaryText) return null;
  const headers = headerColumns(dictionaryText);
  if (!headers.length) return null;
  const lower = headers.map((value) => value.toLowerCase());
  // Report only columns that are genuinely unusable. A near-miss spelling is
  // usable (and should be renamed for clarity); a completely absent column is a
  // blocker. Reporting every non-exact header would be noisy and misleading.
  const blockers = [];
  const renamed = [];
  for (const column of DICTIONARY_COLUMNS) {
    const aliases = DICTIONARY_ALIASES[column];
    if (aliases.some((alias) => lower.includes(alias))) continue;
    const near = headers.filter((header) => aliases.some((alias) =>
      header.toLowerCase().includes(alias.slice(0, 4)) || alias.includes(header.toLowerCase().slice(0, 4))));
    if (near.length) renamed.push({ column, found: near });
    else blockers.push(column);
  }
  if (!blockers.length && !renamed.length) return null;
  const details = [
    ...renamed.map((entry) => `${entry.column} (found "${entry.found.join(' / ')}" - rename it to "${entry.column}")`),
    ...blockers.map((column) => `${column} (missing entirely)`),
  ];
  // Only the feature column decides whether anything imports; accept the same
  // spellings the import loop accepts. "fatal" therefore means the import
  // genuinely produced nothing, not merely that some column was absent.
  const importsFeatures = lower.some((header) => DICTIONARY_ALIASES.feature.includes(header));
  const fatal = !importsFeatures;
  return {
    headers,
    fatal,
    missing: [...renamed.map((entry) => entry.column), ...blockers],
    renamed,
    blockers,
    unexpected: headers.filter((header) =>
      !DICTIONARY_COLUMNS.some((column) => DICTIONARY_ALIASES[column].includes(header.toLowerCase()))),
    message: `Feature dictionary was found but its column(s) could not be used as written: ` +
      `${details.join(", ")}. Expected columns: ${DICTIONARY_COLUMNS.join(", ")}. File columns: ${headers.join(", ")}. ` +
      (importsFeatures
        ? "Features were imported; rename the column(s) above for clarity."
        : "No usable feature column was found, so 0 feature(s) could be imported."),
  };
}

// Pick the first populated cell among a column's accepted spellings. This keeps
// the import loop consistent with the aliases dictionaryDiagnostics() treats as
// acceptable, so a readable column is never reported as usable and then ignored.
function pickColumn(row, aliases) {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function dictionarySource(source, sourceRoot) {
  const label = String(source || "").trim();
  if (!label) return { label: "", root: sourceRoot || "" };
  const [file, functionName] = label.split(/\s*::\s*/, 2);
  return {
    label,
    root: sourceRoot || "",
    ...(file ? { file } : {}),
    ...(functionName ? { function: functionName } : {}),
  };
}

function dictionaryFeatures(dictionaryText, renameText, sourceRoot) {
  if (!dictionaryText) return {};
  const rename = new Map((renameText ? csvRows(renameText) : []).map((row) => [row.old, row.new]));
  const features = {};
  for (const row of csvRows(dictionaryText)) {
    const rawName = pickColumn(row, DICTIONARY_ALIASES.feature);
    if (!rawName) continue;
    const name = rename.get(rawName) || rawName;
    const unit = pickColumn(row, DICTIONARY_ALIASES.unit);
    const group = pickColumn(row, DICTIONARY_ALIASES.group);
    const source = pickColumn(row, DICTIONARY_ALIASES.source);
    features[name] = {
      name,
      aliases: name === rawName ? [] : [rawName],
      description: pickColumn(row, DICTIONARY_ALIASES.note),
      ...(unit ? { unit } : {}),
      category: group,
      source: dictionarySource(source, sourceRoot),
      reviewStatus: "imported-documentation",
      evidence: [{ kind: "feature-dictionary", feature: rawName }],
    };
  }
  return features;
}

function mergeRecords(base, overlay) {
  const out = { ...base };
  for (const [name, record] of Object.entries(overlay || {})) {
    out[name] = {
      ...(out[name] || {}), ...record,
      source: { ...(out[name]?.source || {}), ...(record.source || {}) },
      evidence: [...(out[name]?.evidence || []), ...(record.evidence || [])],
    };
  }
  return out;
}

export function loadFeatureMetadata(runDirectory, explicitPath, options = {}) {
  let file = explicitPath ? path.resolve(explicitPath) : null;
  if (!file) file = DEFAULT_NAMES.map((name) => path.join(runDirectory, name)).find((candidate) => fs.existsSync(candidate)) || null;
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : null;
  const dictionaryFile = options.dictionaryFile ? path.resolve(options.dictionaryFile) : findFile(sourceRoot, "assb_features_feature_dictionary.csv");
  const renameMapFile = options.renameMapFile ? path.resolve(options.renameMapFile) : findFile(sourceRoot, "train_dat_rename_map.csv");
  let features = parseUnitManifest(options.unitManifestText);
  let dictionaryProblem = null;
  if (dictionaryFile) {
    const dictionaryText = fs.readFileSync(dictionaryFile, "utf8");
    dictionaryProblem = dictionaryDiagnostics(dictionaryText);
    features = mergeRecords(features, dictionaryFeatures(
      dictionaryText,
      renameMapFile ? fs.readFileSync(renameMapFile, "utf8") : null,
      sourceRoot,
    ));
  }
  let schemaVersion = null;
  if (file) {
    const rawText = fs.readFileSync(file, "utf8");
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      // The single most common mistake here is pointing --features at the CSV
      // feature dictionary, which is read by --feature-dictionary instead.
      const looksLikeCsv = /^\s*[^[{\r\n]+,[^\r\n]*$/m.test(rawText.split(/\r?\n/, 1)[0] || "");
      const hint = looksLikeCsv
        ? ` The file looks like CSV, not JSON. Feature dictionaries are passed with --feature-dictionary (or discovered via --source-root), while --features expects sage.features.json.`
        : "";
      throw new Error(`Feature metadata file is not valid JSON: ${path.basename(file)} (${error.message}).${hint}`);
    }
    schemaVersion = raw.schemaVersion || null;
    features = mergeRecords(features, normalizeFeatureRecords(raw));
  }
  const runFeatures = options.featureNames || [];
  if (runFeatures.length) features = Object.fromEntries(runFeatures.map((name) => [name, features[name] || { name, reviewStatus: "needs-user-confirmation" }]));
  const resolvedStatuses = new Set(["confirmed"]);
  const resolved = runFeatures.filter((name) => resolvedStatuses.has(features[name]?.reviewStatus)).length;
  const documented = runFeatures.filter((name) => ["confirmed", "imported-documentation"].includes(features[name]?.reviewStatus)).length;
  const warnings = [];
  // A dictionary that was found but yielded nothing is far more likely to be a
  // column-naming mistake than a deliberate empty file, so say so explicitly.
  if (dictionaryProblem) warnings.push(dictionaryProblem.message);
  if (!file && !dictionaryFile && !Object.keys(parseUnitManifest(options.unitManifestText)).length) warnings.push("No feature metadata was found; physical interpretation is structure-only.");
  else if (!dictionaryProblem?.fatal && runFeatures.length && resolved < runFeatures.length) warnings.push(`${runFeatures.length - resolved} of ${runFeatures.length} feature(s) still need a user-confirmed explanation or source trace.`);
  return {
    file,
    sources: { featureMetadata: file, featureDictionary: dictionaryFile, renameMap: renameMapFile, sourceRoot, embeddedUnitManifest: !!options.unitManifestText },
    features,
    warnings,
    dictionaryProblem,
    expectedDictionaryColumns: DICTIONARY_COLUMNS,
    schemaVersion,
    resolvedFeatures: resolved,
    documentedFeatures: documented,
    totalFeatures: runFeatures.length,
  };
}

export function featureMetadataTemplate(featureNames, existing = {}) {
  return {
    schemaVersion: "1.0.0",
    generatedBy: "SISSO-Sage metadata-template",
    features: Object.fromEntries(featureNames.map((name) => [name, {
      description: existing[name]?.description || "",
      symbol: existing[name]?.symbol || name,
      unit: existing[name]?.unit || "",
      category: existing[name]?.category || "",
      aliases: existing[name]?.aliases || [],
      source: existing[name]?.source || { file: "", function: "", line: null },
      constraints: existing[name]?.constraints || { positive: null, bounded: null, monotonicExpectation: null },
      reviewStatus: existing[name]?.reviewStatus || "needs-user-confirmation",
      evidence: existing[name]?.evidence || [],
    }])),
  };
}
