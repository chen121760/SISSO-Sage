import path from "node:path";
import { analyzeDirectory, paretoModels, selectModels } from "./analysis.mjs";
import { traceFeatureSource } from "./source-trace.mjs";

const ANALYSIS_OPTION_KEYS = [
  "featuresFile",
  "topFile",
  "verifyFile",
  "sourceRoot",
  "dictionaryFile",
  "renameMapFile",
];

export function analysisOptions(input = {}) {
  return Object.fromEntries(
    ANALYSIS_OPTION_KEYS
      .filter((key) => typeof input[key] === "string" && input[key].trim())
      .map((key) => [key, path.resolve(input[key])]),
  );
}

export function inspectionResult(analysis) {
  return {
    schemaVersion: "1.0.0",
    kind: "sisso-sage-inspection",
    source: {
      directory: analysis.discovery.root,
      files: analysis.discovery.relative,
      warnings: [...analysis.discovery.warnings, ...analysis.featureMetadata.warnings],
    },
    run: analysis.result.meta,
    datasets: analysis.result.meta.tasks
      ? ["train", ...analysis.result.meta.tasks.map((task) => task.key)]
      : analysis.result.verify
        ? ["train", "verify"]
        : ["train"],
    health: analysis.health,
    featureMetadata: {
      sources: analysis.featureMetadata.sources,
      resolvedFeatures: analysis.featureMetadata.resolvedFeatures,
      totalFeatures: analysis.featureMetadata.totalFeatures,
    },
  };
}

function sortValue(summary, spec) {
  if (spec === "rank") return summary.rank;
  if (spec === "interpretability") return -summary.interpretabilityEvidence.score;
  const [dataset, metric] = String(spec || "rank").split(".");
  const value = summary.metrics?.[dataset]?.[metric];
  return Number.isFinite(value)
    ? (["r2", "rho"].includes(metric) ? -value : value)
    : Number.POSITIVE_INFINITY;
}

export function listModelsResult(analysis, options = {}) {
  let models = [...analysis.summaries];
  if (options.feature) models = models.filter((model) => model.features.includes(String(options.feature)));
  const sort = options.sort || "rank";
  models.sort((a, b) => sortValue(a, sort) - sortValue(b, sort) || a.rank - b.rank);
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  return {
    kind: "sisso-sage-model-list",
    total: models.length,
    returned: Math.min(limit, models.length),
    sort,
    models: models.slice(0, limit),
  };
}

export function modelResult(analysis, rank) {
  const numericRank = Number(rank);
  const model = analysis.summaries.find((item) => item.rank === numericRank);
  if (!model) throw new Error(`Model rank not found: ${rank}`);
  return { kind: "sisso-sage-model", model };
}

export function comparisonResult(analysis, ranks) {
  const normalized = [...new Set((ranks || []).map(Number).filter(Number.isFinite))];
  if (normalized.length < 2) throw new Error("At least two distinct model ranks are required.");
  const models = normalized.map((rank) => analysis.summaries.find((item) => item.rank === rank)).filter(Boolean);
  if (models.length !== normalized.length) throw new Error("One or more requested model ranks were not found.");
  return { kind: "sisso-sage-comparison", ranks: normalized, models };
}

export function paretoResult(analysis, options = {}) {
  return {
    kind: "sisso-sage-pareto",
    ...paretoModels(analysis.result, { dataset: options.dataset, metric: options.metric }),
  };
}

export function selectionResult(analysis, options = {}) {
  return {
    kind: "sisso-sage-selection",
    ...selectModels(analysis.result, analysis.summaries, {
      dataset: options.dataset,
      metric: options.metric,
      limit: options.limit,
      nearOptimalTolerance: options.nearOptimalTolerance,
    }),
  };
}

export function featureContextResult(analysis, feature, options = {}) {
  const name = String(feature || "");
  const exists = analysis.result.columns.slice(2).some((column) => column.original === name);
  if (!exists) throw new Error(`Feature is not present in this SISSO run: ${name}`);
  const sourceRoot = options.sourceRoot || analysis.featureMetadata.sources.sourceRoot;
  const trace = traceFeatureSource(name, sourceRoot, { limit: options.limit });
  return {
    kind: "sisso-sage-feature-context",
    metadata: analysis.featureMetadata.features[name],
    ...trace,
  };
}

export class AnalysisCache {
  constructor(limit = 4) {
    this.limit = Math.max(1, Number(limit) || 4);
    this.entries = new Map();
  }

  load(run, input = {}) {
    if (typeof run !== "string" || !run.trim()) throw new Error("A SISSO run path is required.");
    const root = path.resolve(run);
    const options = analysisOptions(input);
    const key = JSON.stringify({ root, options });
    if (!input.refresh && this.entries.has(key)) {
      const cached = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const analysis = analyzeDirectory(root, options);
    this.entries.set(key, analysis);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return analysis;
  }

  clear() {
    this.entries.clear();
  }
}
