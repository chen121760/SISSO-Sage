import fs from "node:fs";
import path from "node:path";

const DEFAULT_NAMES = ["sage.features.json", "feature-metadata.json"];

function normalizeFeatureRecords(raw) {
  const source = raw?.features ?? raw ?? {};
  if (Array.isArray(source)) return Object.fromEntries(source.filter((item) => item?.name).map((item) => [item.name, { ...item }]));
  if (!source || typeof source !== "object") throw new Error("Feature metadata must contain an object or array of features.");
  return Object.fromEntries(Object.entries(source).map(([name, value]) => [name, { name, ...(value || {}) }]));
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

function dictionaryFeatures(dictionaryText, renameText, sourceRoot) {
  if (!dictionaryText) return {};
  const rename = new Map((renameText ? csvRows(renameText) : []).map((row) => [row.old, row.new]));
  const features = {};
  for (const row of csvRows(dictionaryText)) {
    if (!row.feature) continue;
    const name = rename.get(row.feature) || row.feature;
    features[name] = {
      name,
      aliases: name === row.feature ? [] : [row.feature],
      description: row.note || "",
      ...(row.unit ? { unit: row.unit } : {}),
      category: row.group || "",
      source: { label: row.source || "", root: sourceRoot || "" },
      reviewStatus: "imported-documentation",
      evidence: [{ kind: "feature-dictionary", feature: row.feature }],
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
  if (dictionaryFile) {
    features = mergeRecords(features, dictionaryFeatures(
      fs.readFileSync(dictionaryFile, "utf8"),
      renameMapFile ? fs.readFileSync(renameMapFile, "utf8") : null,
      sourceRoot,
    ));
  }
  let schemaVersion = null;
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    schemaVersion = raw.schemaVersion || null;
    features = mergeRecords(features, normalizeFeatureRecords(raw));
  }
  const runFeatures = options.featureNames || [];
  if (runFeatures.length) features = Object.fromEntries(runFeatures.map((name) => [name, features[name] || { name, reviewStatus: "needs-user-confirmation" }]));
  const resolvedStatuses = new Set(["confirmed", "imported-documentation"]);
  const resolved = runFeatures.filter((name) => resolvedStatuses.has(features[name]?.reviewStatus)).length;
  const warnings = [];
  if (!file && !dictionaryFile && !Object.keys(parseUnitManifest(options.unitManifestText)).length) warnings.push("No feature metadata was found; physical interpretation is structure-only.");
  else if (runFeatures.length && resolved < runFeatures.length) warnings.push(`${runFeatures.length - resolved} of ${runFeatures.length} feature(s) still need a user-confirmed explanation or source trace.`);
  return {
    file,
    sources: { featureMetadata: file, featureDictionary: dictionaryFile, renameMap: renameMapFile, sourceRoot, embeddedUnitManifest: !!options.unitManifestText },
    features,
    warnings,
    schemaVersion,
    resolvedFeatures: resolved,
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
