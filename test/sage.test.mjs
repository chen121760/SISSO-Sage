import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  analyzeDirectory,
  buildBundle,
  listModelsResult,
  modelResult,
  paretoModels,
  readTarEntries,
  resolveModelLimit,
  selectModels,
  traceFeatureSource,
  MODEL_LIST_HARD_CAP,
} from "../src/index.mjs";
import { leakageReport, sampleKeys } from "../src/leakage.mjs";
import { createSissoSageMcpServer } from "../mcp/server.mjs";

function tinyTar(name, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header[156] = "0".charCodeAt(0);
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sisso-sage-"));
  fs.mkdirSync(path.join(root, "Models"));
  fs.mkdirSync(path.join(root, "SIS_subspaces"));
  // Names carry an id and a composition, as real SISSO exports do, so the
  // leakage hierarchy (name -> id -> formula) is actually exercised.
  fs.writeFileSync(path.join(root, "train.dat"), "name target f1 f2\naaa_CA1 1 1 4\naaa_CA1b 2 2 3\nbbb_CA2 3 3 2\nccc_CA3 4 4 1\n");
  fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\nxxx_CA9 5 5 0\nyyy_CA8 6 6 -1\n");
  fs.writeFileSync(path.join(root, "Models", "top0003_D001"), "Rank RMSE MaxAE Feature_ID\n1 0.0 0.0 ( 1)\n2 1.0 2.0 ( 2)\n3 0.5 1.0 ( 3)\n");
  fs.writeFileSync(path.join(root, "Models", "top0003_D001_coeff"), "Model_ID c0 c1\n1 0 1\n2 5 -1\n3 0 0.8\n");
  fs.writeFileSync(path.join(root, "SIS_subspaces", "Uspace.expressions"), "(f1) SIS_score = 1\n(f2) SIS_score = 0.8\n(f1/f2) SIS_score = 0.7\n");
  fs.writeFileSync(path.join(root, "sage.features.json"), JSON.stringify({ schemaVersion: "1.0.0", features: {
    f1: { description: "Primary measurement", unit: "eV", reviewStatus: "confirmed", source: { file: "features.py", function: "compute_f1" } },
    f2: { description: "Secondary measurement", unit: "eV", reviewStatus: "confirmed", source: { file: "features.py", function: "compute_f2" } }
  }}));
  fs.writeFileSync(path.join(root, "features.py"), "def compute_f1(structure):\n    return structure.value  # f1\n");
  return root;
}

// A run large enough that a silent list cap would be observable.
function manyModelFixture(count = 25) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sisso-sage-many-"));
  fs.mkdirSync(path.join(root, "Models"));
  fs.mkdirSync(path.join(root, "SIS_subspaces"));
  const train = ["name target f1 f2"];
  const verify = ["name target f1 f2"];
  for (let i = 1; i <= 5; i++) {
    train.push(`t${i} ${i} ${i} ${6 - i}`);
    verify.push(`v${i} ${i + 10} ${i + 5} ${i}`);
  }
  fs.writeFileSync(path.join(root, "train.dat"), `${train.join("\n")}\n`);
  fs.writeFileSync(path.join(root, "verify.dat"), `${verify.join("\n")}\n`);
  const top = ["Rank RMSE MaxAE Feature_ID"];
  const coeff = ["Model_ID c0 c1"];
  for (let r = 1; r <= count; r++) {
    const descriptor = (r % 2) + 1;
    const rmse = (0.1 + r * 0.01).toFixed(3);
    top.push(`${r} ${rmse} 1.0 ( ${descriptor})`);
    coeff.push(`${r} 0 ${(1 / r).toExponential(6)}`);
  }
  fs.writeFileSync(path.join(root, "Models", "top9999_D001"), `${top.join("\n")}\n`);
  fs.writeFileSync(path.join(root, "Models", "top9999_D001_coeff"), `${coeff.join("\n")}\n`);
  fs.writeFileSync(path.join(root, "SIS_subspaces", "Uspace.expressions"), "(f1) SIS_score = 1\n(f2) SIS_score = 0.9\n");
  return root;
}

function syntheticSelection(values, { holdout = true, interpretability = [] } = {}) {
  const models = values.map((value, index) => ({
    rank: index + 1,
    descriptors: [{ original: "f1" }],
    featureIds: [1],
    metrics: {
      train: { rmse: value.train },
      ...(holdout ? { verify: { rmse: value.verify } } : {}),
    },
    rmseSisso: value.train,
  }));
  const result = {
    models,
    meta: { multiTask: false, tasks: null, targetLetter: "b" },
    columns: [
      { letter: "a", original: "name", role: "name" },
      { letter: "b", original: "target", role: "target" },
      { letter: "c", original: "f1", role: "feature" },
    ],
    train: { n: 3, cols: { b: Float64Array.from([0, 1, 2]), c: Float64Array.from([1, 2, 3]) } },
    verify: holdout ? { n: 2, cols: { b: Float64Array.from([3, 4]), c: Float64Array.from([4, 5]) } } : null,
  };
  const summaries = models.map((model, index) => ({
    rank: model.rank,
    descriptorDimension: 1,
    // Deliberately include a fake legacy score. Selection must ignore it.
    interpretabilityEvidence: { score: interpretability[index] ?? 50 },
    formulaEvidence: {
      structure: { astNodeCount: 1 },
      provenance: { unresolvedFeatures: [] },
      domain: { observed: [] },
    },
  }));
  return { result, summaries };
}

function writeDictionary(root, name, text) {
  fs.writeFileSync(path.join(root, name), text);
  return path.join(root, name);
}

test("analyzes a directory into AI-readable model evidence", () => {
  const root = fixture();
  try {
    const analysis = analyzeDirectory(root);
    assert.equal(analysis.health.level, "pass");
    assert.equal(analysis.result.meta.nModels, 3);
    assert.deepEqual(analysis.summaries[0].features, ["f1"]);
    assert.equal(analysis.summaries[0].formulaEvidence.provenance.status, "researcher-confirmed");
    assert.equal(analysis.summaries[0].formulaEvidence.semanticAssessment.status, "not-assessed");
    assert.equal(analysis.summaries[2].formulaEvidence.domain.staticRequirements[0].code, "nonzero-denominator");
    assert.equal(analysis.summaries[2].formulaEvidence.domain.observedStatus, "deferred-until-finalist-inspection");
    const finalist = modelResult(analysis, 3).model;
    assert.equal(finalist.formulaEvidence.domain.observed.find((item) => item.dataset === "train").status, "observed-safe");
    assert.equal(finalist.formulaEvidence.domain.observed.find((item) => item.dataset === "verify").status, "invalid-observations");
    assert.equal("score" in analysis.summaries[0].formulaEvidence, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builds layered Pareto evidence and an objective shortlist", () => {
  const root = fixture();
  try {
    const analysis = analyzeDirectory(root);
    const pareto = paretoModels(analysis.result);
    assert.equal(pareto.evaluation.dataset, "verify");
    assert.ok(pareto.front.some((point) => point.rank === 1));
    const selection = selectModels(analysis.result, analysis.summaries, { limit: 4 });
    assert.ok(selection.candidates.length >= 1);
    assert.ok(selection.candidates.some((item) => item.roles.includes("predictive-best")));
    assert.equal(selection.methodology.interpretabilityUsedInSelection, false);
    assert.equal(selection.methodology.robustnessClaimed, false);
    assert.ok(selection.candidates.every((item) => Array.isArray(item.evidenceAgainst)));
    const bundle = buildBundle(analysis);
    assert.equal(bundle.schemaVersion, "2.0.0");
    assert.equal(bundle.models.length, 3);
    assert.equal(bundle.provenance.generator, "SISSO-Sage");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selection is tie-safe, strict-limit, and independent of legacy interpretability scores", () => {
  const tied = syntheticSelection([
    { train: 0.08, verify: 0.10 },
    { train: 0.08, verify: 0.10 },
  ], { interpretability: [0, 100] });
  const both = selectModels(tied.result, tied.summaries, { limit: 2 });
  assert.equal(both.candidates.length, 2);
  assert.equal(both.candidates[0].value, both.candidates[1].value);
  assert.equal(both.candidates[0].paretoRank, both.candidates[1].paretoRank);
  assert.equal(both.methodology.interpretabilityUsedInSelection, false);

  const limited = selectModels(tied.result, tied.summaries, { limit: 1 });
  assert.equal(limited.candidates.length, 1, "limit must apply after every candidate role is assigned");

  const separated = syntheticSelection(Array.from({ length: 10 }, (_, index) => ({
    train: (index + 1) / 10,
    verify: (index + 1) / 10,
  })), { interpretability: [0, 0, 0, 0, 0, 0, 0, 0, 0, 100] });
  const shortlist = selectModels(separated.result, separated.summaries, { limit: 10, nearOptimalTolerance: 0.10 });
  assert.deepEqual(shortlist.candidates.map((item) => item.rank), [1], "a ten-times-worse model must not enter through a semantic heuristic");
});

test("train-only selection reports generalization as not assessable and never claims robustness", () => {
  const trainOnly = syntheticSelection([
    { train: 0.1 },
    { train: 0.105 },
  ], { holdout: false });
  const selection = selectModels(trainOnly.result, trainOnly.summaries, { limit: 2 });
  assert.equal(selection.methodology.robustnessClaimed, false);
  assert.ok(selection.candidates.every((item) => item.generalizationGap.status === "not-assessable"));
  assert.ok(selection.candidates.every((item) => item.roles.every((role) => !/robust/i.test(role))));
});

test("metadata without reviewStatus remains unresolved even when descriptive fields exist", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "sage.features.json"), JSON.stringify({ schemaVersion: "1.0.0", features: {
      f1: { description: "Plausible but unreviewed", unit: "eV", source: { file: "features.py", function: "compute_f1" } },
      f2: { description: "Plausible but unreviewed", unit: "eV", source: { file: "features.py", function: "compute_f2" } },
    } }));
    const analysis = analyzeDirectory(root);
    assert.equal(analysis.featureMetadata.resolvedFeatures, 0);
    assert.equal(analysis.summaries[0].formulaEvidence.provenance.status, "unresolved-or-draft");
    assert.deepEqual(analysis.summaries[0].formulaEvidence.provenance.unresolvedFeatures, ["f1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI inspection, Pareto, and selection emit valid JSON", () => {
  const root = fixture();
  const cli = path.resolve("bin", "sisso-sage.mjs");
  try {
    for (const command of ["inspect", "pareto", "select", "leakage"]) {
      const run = spawnSync(process.execPath, [cli, command, root, "--compact"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const output = JSON.parse(run.stdout);
      assert.ok(output.kind.startsWith("sisso-sage-"));
      if (command === "pareto") {
        assert.equal(output.evaluation.dataset, "verify");
        assert.ok(output.front.length > 0);
      }
      if (command === "leakage") assert.equal(output.verdict, "disjoint");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("traces exact feature identifiers in extraction source", () => {
  const root = fixture();
  try {
    const trace = traceFeatureSource("f1", root);
    assert.equal(trace.status, "context-found");
    assert.ok(trace.matches.some((match) => match.file === "features.py"));
    assert.ok(trace.matches.every((match) => !match.text.includes("f10")));
    assert.ok(trace.matches.every((match) => match.context.text.includes("compute_f1")));

    const preferred = traceFeatureSource("f1", root, { preferredSource: { file: "features.py", function: "compute_f1" } });
    assert.equal(preferred.preferredDefinition.function, "compute_f1");
    assert.match(preferred.preferredDefinition.text, /return structure\.value/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reads gzip-compressed TAR entries without extracting them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sisso-sage-tar-"));
  const archive = path.join(root, "run.tgz");
  try {
    fs.writeFileSync(archive, zlib.gzipSync(tinyTar("run/train.dat", "name target f1\ns1 1 1\n")));
    const entries = readTarEntries(archive);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "run/train.dat");
    assert.match(entries[0].data.toString("utf8"), /s1 1 1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model list honours --limit and reports truncation instead of hiding it", () => {
  const root = manyModelFixture(25);
  try {
    const analysis = analyzeDirectory(root);

    const all = listModelsResult(analysis, { limit: 1000 });
    assert.equal(all.total, 25);
    assert.equal(all.returned, 25, "limit above the run size must return every model");
    assert.equal(all.truncated, false);

    const partial = listModelsResult(analysis, { limit: 10 });
    assert.equal(partial.returned, 10);
    assert.equal(partial.limit, 10);
    assert.equal(partial.truncated, true, "a partial list must be flagged");

    // The old implementation clamped to 100 and silently dropped the tail.
    assert.ok(resolveModelLimit(1000) > 100, "the 100-model cap must be gone");
    assert.equal(resolveModelLimit(1e12), MODEL_LIST_HARD_CAP);
    assert.equal(resolveModelLimit(undefined), 20, "default stays 20");
    assert.equal(resolveModelLimit(0), 1, "degenerate limits clamp to 1");

    // Sorting by a metric over the FULL list, which is what the cap corrupted.
    const sorted = listModelsResult(analysis, { limit: 1000, sort: "verify.rmse" });
    const rmse = sorted.models.map((model) => model.metrics.verify.rmse);
    assert.deepEqual(rmse, [...rmse].sort((a, b) => a - b), "the best model must be first over all 25");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detects a verify.dat that reuses training samples", () => {
  const root = fixture();
  try {
    // Identical row: the same sample name AND the same values as a fitted row.
    fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\naaa_CA1 1 1 4\nzzz_CA7 6 6 -1\n");
    const leaked = leakageReport(analyzeDirectory(root));
    assert.equal(leaked.verdict, "leaked-identical-rows");
    assert.equal(leaked.holdoutIsIndependent, false);
    assert.equal(leaked.comparisons[0].duplicateObservations.count, 1);
    assert.match(leaked.comparisons[0].note, /same sample name, target and condition/i);

    // Same structure id, different condition: a weaker but real warning.
    fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\naaa_CA4 7 7 2\nzzz_CA7 6 6 -1\n");
    const sharedId = leakageReport(analyzeDirectory(root));
    assert.equal(sharedId.verdict, "shared-structure-ids");
    assert.equal(sharedId.comparisons[0].duplicateObservations.count, 0);
    assert.match(sharedId.comparisons[0].note, /interpolation on known structures/);

    // Shared composition only.
    fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\nddd_CA1 7 7 2\nzzz_CA7 6 6 -1\n");
    const sharedFormula = leakageReport(analyzeDirectory(root));
    assert.equal(sharedFormula.verdict, "shared-compositions");
    assert.equal(sharedFormula.holdoutIsIndependent, null);

    // Disjoint: the clean case.
    fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\nxxx_CA9 5 5 0\nyyy_CA8 6 6 -1\n");
    const clean = leakageReport(analyzeDirectory(root));
    assert.equal(clean.verdict, "disjoint");
    assert.equal(clean.mode, "train-vs-verify");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sample keys fall back gracefully for names without a separator", () => {
  assert.deepEqual(sampleKeys("mp1234").map((key) => key.kind), ["name"]);
  assert.deepEqual(sampleKeys("14120eb0_B4Li20O64S16").map((key) => key.kind), ["name", "id", "formula"]);
  assert.deepEqual(sampleKeys(""), []);
});

test("an unrecognised feature-dictionary header is reported, not silently ignored", () => {
  const root = fixture();
  try {
    fs.rmSync(path.join(root, "sage.features.json"));
    // Common aliases import cleanly and produce no diagnostic.
    const aliased = writeDictionary(root, "aliased.csv",
      "feature_name,description,unit,category,source_file\nf1,Primary,eV,geometry,features.py\nf2,Secondary,eV,geometry,features.py\n");
    const aliasedResult = analyzeDirectory(root, { dictionaryFile: aliased });
    assert.equal(aliasedResult.featureMetadata.resolvedFeatures, 0, "imported documentation is not researcher confirmation");
    assert.equal(aliasedResult.featureMetadata.documentedFeatures, 2, "aliased columns must import as documentation");
    assert.equal(aliasedResult.featureMetadata.dictionaryProblem, null);
    assert.equal(aliasedResult.featureMetadata.features.f1.unit, "eV");
    assert.equal(aliasedResult.featureMetadata.features.f1.category, "geometry");
    assert.equal(aliasedResult.featureMetadata.features.f1.source.label, "features.py");

    // A missing optional column still imports, but the gap is reported.
    const partial = writeDictionary(root, "partial.csv", "feature,unit\nf1,eV\nf2,eV\n");
    const partialResult = analyzeDirectory(root, { dictionaryFile: partial });
    assert.equal(partialResult.featureMetadata.documentedFeatures, 2);
    assert.equal(partialResult.featureMetadata.dictionaryProblem.fatal, false);
    assert.match(partialResult.featureMetadata.dictionaryProblem.message, /Features were imported/);
    assert.match(partialResult.featureMetadata.dictionaryProblem.message, /note \(missing entirely\)/);

    // No feature-bearing column at all: nothing can be imported, and it is fatal.
    const broken = writeDictionary(root, "broken.csv",
      "name_x,description_x\nf1,Primary\nf2,Secondary\n");
    const brokenResult = analyzeDirectory(root, { dictionaryFile: broken });
    assert.equal(brokenResult.featureMetadata.resolvedFeatures, 0);
    assert.ok(brokenResult.featureMetadata.dictionaryProblem, "the column mismatch must be reported");
    assert.equal(brokenResult.featureMetadata.dictionaryProblem.fatal, true);
    assert.match(brokenResult.featureMetadata.warnings.join(" "), /Feature dictionary was found/);
    assert.match(brokenResult.featureMetadata.warnings.join(" "), /No usable feature column was found/);
    assert.match(brokenResult.featureMetadata.warnings.join(" "), /unit \(missing entirely\)/);

    // The documented column names produce no diagnostic at all.
    const good = writeDictionary(root, "assb_features_feature_dictionary.csv",
      "feature,note,unit,group,source\nf1,Primary measurement,eV,geometry,features.py :: compute_f1\nf2,Secondary measurement,eV,geometry,features.py :: compute_f2\n");
    const working = analyzeDirectory(root, { dictionaryFile: good });
    assert.equal(working.featureMetadata.dictionaryProblem, null);
    assert.equal(working.featureMetadata.documentedFeatures, 2);
    assert.equal(working.featureMetadata.features.f1.source.file, "features.py");
    assert.equal(working.featureMetadata.features.f1.source.function, "compute_f1");
    assert.deepEqual(working.featureMetadata.expectedDictionaryColumns, ["feature", "note", "unit", "group", "source"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a CSV passed to --features produces an actionable error", () => {
  const root = fixture();
  try {
    const dictionary = writeDictionary(root, "dict.csv", "feature,note\nf1,Primary\n");
    assert.throws(
      () => analyzeDirectory(root, { featuresFile: dictionary }),
      /not valid JSON[\s\S]*--feature-dictionary/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP client discovers and calls the read-only SISSO tools", async () => {
  const root = fixture();
  const server = createSissoSageMcpServer();
  const client = new Client({ name: "sisso-sage-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "get_capabilities",
      "inspect_run",
      "check_leakage",
      "list_models",
      "get_model",
      "compare_models",
      "pareto_frontier",
      "select_candidates",
      "feature_context",
    ]);
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));

    const inspected = await client.callTool({ name: "inspect_run", arguments: { run: root } });
    assert.equal(inspected.isError, undefined);
    assert.equal(inspected.structuredContent.result.health.level, "pass");
    assert.equal(inspected.structuredContent.result.run.nModels, 3);

    const leakage = await client.callTool({ name: "check_leakage", arguments: { run: root } });
    assert.equal(leakage.isError, undefined);
    assert.equal(leakage.structuredContent.result.verdict, "disjoint");

    const selected = await client.callTool({ name: "select_candidates", arguments: { run: root, limit: 4 } });
    assert.equal(selected.structuredContent.result.evaluation.dataset, "verify");
    assert.ok(selected.structuredContent.result.candidates.some((item) => item.roles.includes("predictive-best")));

    const missing = await client.callTool({ name: "get_model", arguments: { run: root, rank: 999 } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Model rank not found/);
  } finally {
    await client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled MCP stdio entrypoint completes a real handshake", async () => {
  const client = new Client({ name: "sisso-sage-stdio-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./dist/sisso-sage-mcp.mjs"],
    cwd: path.resolve("."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "inspect_run"));
    assert.ok(listed.tools.some((tool) => tool.name === "check_leakage"), "the bundle must include the new tool");
  } finally {
    await client.close();
  }
});
