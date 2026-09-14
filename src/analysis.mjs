import path from "node:path";
import { Core, HealthCheck } from "./engine.mjs";
import { discoverRun, pipelineFiles } from "./discover.mjs";
import { loadFeatureMetadata } from "./metadata.mjs";
import { interpretabilityEvidence } from "./interpretability.mjs";
import { VERSION } from "./version.mjs";

export const SCHEMA_VERSION = "1.0.0";

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function cleanMetrics(metrics) {
  if (!metrics) return null;
  return {
    rmse: finite(metrics.rmse),
    mae: finite(metrics.mae),
    maxae: finite(metrics.maxae),
    r2: finite(metrics.r2),
    rho: finite(metrics.rho),
  };
}

function datasetManifest(result) {
  return Core.availableDatasets(result).map((key) => {
    const data = Core.datasetData(result, key);
    return { key, samples: data?.n ?? 0, role: key === "verify" ? "holdout" : key === "train" ? "training-or-pooled" : "task" };
  });
}

function modelFeatures(result, model) {
  const names = result.columns.slice(2).map((column) => column.original);
  return Core.modelFeatureNames(model, names);
}

export function summarizeModel(result, model, metadata = {}) {
  const datasets = Core.availableDatasets(result);
  const metrics = Object.fromEntries(datasets.map((key) => [key, cleanMetrics(model.metrics?.[key])]));
  const formulas = model.formulasOriginalByTask?.length
    ? model.formulasOriginalByTask.map((formula, index) => ({ dataset: `t${index + 1}`, formula }))
    : [{ dataset: "all", formula: model.formulaOriginal }];
  const evidence = interpretabilityEvidence(model, result.columns.slice(2).map((column) => column.original), metadata);
  return {
    rank: model.rank,
    descriptorDimension: evidence.dimension,
    formulas,
    descriptors: (model.descriptors || []).map((item) => ({ id: item.id, expression: item.original })),
    features: modelFeatures(result, model),
    metrics,
    sissoReported: { rmse: finite(model.rmseSisso), maxae: finite(model.maxaeSisso) },
    interpretabilityEvidence: evidence,
  };
}

function metricValue(model, dataset, metric) {
  if (dataset === "sisso-overall") {
    if (metric === "rmse") return model.rmseSisso;
    if (metric === "maxae") return model.maxaeSisso;
    return NaN;
  }
  return Core.metricValue(model, dataset, metric);
}

function defaultEvaluation(result) {
  const datasets = Core.availableDatasets(result);
  if (datasets.includes("verify")) return { dataset: "verify", metric: "rmse", reason: "holdout data available" };
  if (result.meta.multiTask) return { dataset: "sisso-overall", metric: "rmse", reason: "multi-task SISSO aggregate" };
  return { dataset: "train", metric: "rmse", reason: "no holdout data available" };
}

function lowerIsBetter(metric) {
  return !["r2", "rho"].includes(metric);
}

function symbolicComplexity(model) {
  const descriptors = model.descriptors || [];
  const operations = descriptors.reduce((sum, item) => {
    const text = item.original || item.renamed || "";
    return sum + (text.match(/[+*/^]|(^|[^eE])-/g) || []).length
      + (text.match(/\b(?:log|exp|sqrt|cbrt|abs)\s*\(/g) || []).length;
  }, 0);
  return Math.max(1, descriptors.length || model.featureIds?.length || 1) + operations;
}

function percentileScores(items, getter, minimize = true) {
  const finiteItems = items.map((item) => ({ item, value: getter(item) })).filter((entry) => Number.isFinite(entry.value));
  finiteItems.sort((a, b) => minimize ? a.value - b.value : b.value - a.value);
  const scores = new Map();
  const denominator = Math.max(1, finiteItems.length - 1);
  finiteItems.forEach((entry, index) => scores.set(entry.item.rank, 100 * (1 - index / denominator)));
  return scores;
}

function robustnessValue(model, result) {
  const datasets = Core.availableDatasets(result);
  if (datasets.includes("verify")) {
    const train = metricValue(model, "train", "rmse");
    const verify = metricValue(model, "verify", "rmse");
    return Number.isFinite(train) && Number.isFinite(verify) ? Math.abs(verify - train) / Math.max(Math.abs(train), 1e-12) : NaN;
  }
  const tasks = datasets.filter((key) => /^t\d+$/.test(key));
  if (tasks.length > 1) {
    const values = tasks.map((key) => metricValue(model, key, "rmse")).filter(Number.isFinite);
    if (values.length !== tasks.length) return NaN;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / Math.max(Math.abs(mean), 1e-12);
  }
  return NaN;
}

export function paretoModels(result, options = {}) {
  const defaults = defaultEvaluation(result);
  const evaluation = {
    ...defaults,
    dataset: options.dataset || defaults.dataset,
    metric: options.metric || defaults.metric,
  };
  const points = result.models.map((model) => ({
    rank: model.rank,
    error: metricValue(model, evaluation.dataset, evaluation.metric),
    complexity: symbolicComplexity(model),
    descriptorDimension: Math.max(1, model.descriptors?.length || model.featureIds?.length || 1),
  })).filter((point) => Number.isFinite(point.error));
  const minimizeMetric = lowerIsBetter(evaluation.metric);
  const front = points.filter((point) => !points.some((other) => {
    const metricNoWorse = minimizeMetric ? other.error <= point.error : other.error >= point.error;
    const metricBetter = minimizeMetric ? other.error < point.error : other.error > point.error;
    return metricNoWorse && other.complexity <= point.complexity && (metricBetter || other.complexity < point.complexity);
  })).sort((a, b) => a.complexity - b.complexity || (minimizeMetric ? a.error - b.error : b.error - a.error));
  return { evaluation, front, eligibleModels: points.length };
}

export function selectModels(result, summaries, options = {}) {
  const evaluation = { ...defaultEvaluation(result), dataset: options.dataset || defaultEvaluation(result).dataset, metric: options.metric || "rmse" };
  const performance = percentileScores(result.models, (model) => metricValue(model, evaluation.dataset, evaluation.metric), lowerIsBetter(evaluation.metric));
  const robustness = percentileScores(result.models, (model) => robustnessValue(model, result), true);
  const summaryByRank = new Map(summaries.map((summary) => [summary.rank, summary]));
  const scored = result.models.map((model) => {
    const summary = summaryByRank.get(model.rank);
    const performanceScore = performance.get(model.rank) ?? 0;
    const robustnessScore = robustness.has(model.rank) ? robustness.get(model.rank) : 50;
    const interpretationScore = summary.interpretabilityEvidence.score;
    return {
      rank: model.rank,
      value: finite(metricValue(model, evaluation.dataset, evaluation.metric)),
      _rawScores: { performance: performanceScore, robustness: robustnessScore, interpretabilityEvidence: interpretationScore,
        balanced: 0.50 * performanceScore + 0.20 * robustnessScore + 0.30 * interpretationScore },
      scores: {
        performance: Math.round(performanceScore),
        robustness: Math.round(robustnessScore),
        interpretabilityEvidence: interpretationScore,
        balanced: Math.round(0.50 * performanceScore + 0.20 * robustnessScore + 0.30 * interpretationScore),
      },
    };
  }).filter((item) => item.value !== null);

  const pareto = paretoModels(result, evaluation);
  const paretoRanks = new Set(pareto.front.map((point) => point.rank));
  const eligible = scored.filter((item) => paretoRanks.has(item.rank));
  const rankedByMetric = [...scored].sort((a, b) => {
    const delta = lowerIsBetter(evaluation.metric) ? a.value - b.value : b.value - a.value;
    return delta || a.rank - b.rank;
  });
  const predictive = rankedByMetric[0];
  const floorSize = Math.min(10, rankedByMetric.length);
  const best = predictive?.value;
  const tolerance = Number.isFinite(Number(options.nearOptimalTolerance)) ? Number(options.nearOptimalTolerance) : 0.10;
  const competitiveRanks = new Set(rankedByMetric.slice(0, floorSize).map((item) => item.rank));
  if (Number.isFinite(best)) {
    rankedByMetric.forEach((item) => {
      const near = lowerIsBetter(evaluation.metric)
        ? item.value <= best + Math.max(Math.abs(best), 1e-12) * tolerance
        : item.value >= best - Math.max(Math.abs(best), 1e-12) * tolerance;
      if (near && item._rawScores.performance >= 90) competitiveRanks.add(item.rank);
    });
  }
  const competitive = scored.filter((item) => competitiveRanks.has(item.rank));
  const by = (items, key) => [...items].sort((a, b) => b._rawScores[key] - a._rawScores[key] || a.rank - b.rank);
  // A "robustness" rank means two different things depending on the run, and
  // conflating them invites over-reading. With a hold-out it is the relative
  // train/verify gap. For MT-SISSO it is only how evenly the model fits across
  // tasks - every number is in-sample, so it says nothing about external
  // validity. Name the role for what it actually measures.
  const multiTask = !!(result.meta?.tasks && result.meta.tasks.length > 1);
  const hasHoldout = Core.availableDatasets(result).includes("verify");
  const stabilityRole = multiTask && !hasHoldout ? "task-consistent" : "robust";
  const roles = [
    ["predictive", predictive],
    ["balanced", by(competitive, "balanced")[0]],
    ["interpretable", by(competitive, "interpretabilityEvidence")[0]],
    [stabilityRole, by(competitive, "robustness")[0]],
  ];
  const recommendations = new Map();
  for (const [role, item] of roles) {
    if (!item) continue;
    const existing = recommendations.get(item.rank) || { rank: item.rank, value: item.value, scores: item.scores, roles: [] };
    existing.roles.push(role);
    recommendations.set(item.rank, existing);
  }
  const limit = Math.max(1, Number(options.limit) || 5);
  for (const item of [...by(eligible, "balanced"), ...by(competitive, "balanced")]) {
    if (recommendations.size >= limit) break;
    if (!recommendations.has(item.rank)) recommendations.set(item.rank, { rank: item.rank, value: item.value, scores: item.scores, roles: ["pareto-alternative"] });
  }
  return {
    evaluation,
    methodology: {
      balancedWeights: { performance: 0.50, robustness: 0.20, interpretabilityEvidence: 0.30 },
      nearOptimalTolerance: tolerance,
      competitivePool: competitive.length,
      // Expose what the stability score measures in this run, so a high score
      // is not mistaken for external validation.
      stability: {
        role: stabilityRole,
        basis: hasHoldout
          ? "relative train/verify RMSE gap"
          : "spread of per-task RMSE (all in-sample)",
        externalValidation: hasHoldout,
        note: hasHoldout
          ? "Robust means the hold-out error is close to the training error."
          : "No hold-out exists for this run. A high task-consistency score means the model fits every task about equally well; it is NOT evidence of generalisation.",
      },
      note: "Recommendations are an auditable shortlist, not an automatic claim of physical truth. Review feature provenance and domain constraints before acceptance.",
    },
    paretoFront: pareto.front,
    recommendations: [...recommendations.values()],
  };
}

export function analyzeDirectory(directory, options = {}) {
  const discovery = discoverRun(directory, options);
  const health = HealthCheck.check(discovery.healthFiles);
  if (health.level === "error") {
    const messages = health.checks.filter((check) => check.level === "error").map((check) => check.message).join("; ");
    const error = new Error(`SISSO run failed validation: ${messages}`);
    error.health = health;
    throw error;
  }
  const result = Core.runPipeline(pipelineFiles(discovery, health.dropVerify));
  const metadataRoot = discovery.kind === "archive" ? path.dirname(discovery.root) : discovery.root;
  const featureNames = result.columns.slice(2).map((column) => column.original);
  const featureMetadata = loadFeatureMetadata(metadataRoot, options.featuresFile, {
    sourceRoot: options.sourceRoot,
    dictionaryFile: options.dictionaryFile,
    renameMapFile: options.renameMapFile,
    unitManifestText: discovery.auxiliary?.unitManifestText,
    featureNames,
  });
  const summaries = result.models.map((model) => summarizeModel(result, model, featureMetadata.features));
  return { discovery, health, result, featureMetadata, summaries };
}

export function buildBundle(analysis, options = {}) {
  const { discovery, health, result, featureMetadata, summaries } = analysis;
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "sisso-sage-analysis",
    generatedAt: new Date().toISOString(),
    source: {
      directory: discovery.root,
      files: discovery.relative,
      warnings: [...discovery.warnings, ...featureMetadata.warnings],
      featureMetadata: featureMetadata.sources,
    },
    run: {
      ...result.meta,
      datasets: datasetManifest(result),
      supportedProblem: "regression",
    },
    health,
    models: summaries,
    selection: selectModels(result, summaries, options),
    provenance: {
      generator: "SISSO-Sage",
      generatorVersion: VERSION,
      numericalEngine: "SISSO-Analyzer sisso-core",
    },
  };
}
