import path from "node:path";
import { Core, HealthCheck } from "./engine.mjs";
import { discoverRun, pipelineFiles } from "./discover.mjs";
import { loadFeatureMetadata } from "./metadata.mjs";
import { formulaEvidence } from "./interpretability.mjs";
import { VERSION } from "./version.mjs";

export const SCHEMA_VERSION = "2.0.0";

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

export function summarizeModel(result, model, metadata = {}, options = {}) {
  const datasets = Core.availableDatasets(result);
  const metrics = Object.fromEntries(datasets.map((key) => [key, cleanMetrics(model.metrics?.[key])]));
  const formulas = model.formulasOriginalByTask?.length
    ? model.formulasOriginalByTask.map((formula, index) => ({ dataset: `t${index + 1}`, formula }))
    : [{ dataset: "all", formula: model.formulaOriginal }];
  const evidence = formulaEvidence(model, result, metadata, options);
  return {
    rank: model.rank,
    descriptorDimension: evidence.structure.descriptorDimension,
    formulas,
    descriptors: (model.descriptors || []).map((item) => ({ id: item.id, expression: item.original })),
    features: modelFeatures(result, model),
    metrics,
    sissoReported: { rmse: finite(model.rmseSisso), maxae: finite(model.maxaeSisso) },
    evaluationError: model.error || null,
    formulaEvidence: evidence,
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

function targetScale(result) {
  const values = result?.train?.cols?.[result?.meta?.targetLetter];
  if (!values?.length) return null;
  const finiteValues = Array.from(values).filter(Number.isFinite);
  if (finiteValues.length < 2) return null;
  const mean = finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
  const variance = finiteValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finiteValues.length;
  const std = Math.sqrt(variance);
  return std > 0 ? std : null;
}

function generalizationGap(model, result, scale = targetScale(result)) {
  if (!Core.availableDatasets(result).includes("verify")) {
    return { status: "not-assessable", reason: "No hold-out dataset is available." };
  }
  const train = metricValue(model, "train", "rmse");
  const verify = metricValue(model, "verify", "rmse");
  if (!Number.isFinite(train) || !Number.isFinite(verify)) {
    return { status: "not-assessable", reason: "Train or verify RMSE is non-finite." };
  }
  const signed = verify - train;
  const absolute = Math.abs(signed);
  const relativeFloor = scale ? scale * 1e-12 : 1e-12;
  return {
    status: "available",
    trainRmse: train,
    verifyRmse: verify,
    signed,
    absolute,
    relative: Math.abs(train) > relativeFloor ? absolute / Math.abs(train) : null,
    relativeStatus: Math.abs(train) > relativeFloor ? "available" : "unstable-denominator",
    targetScale: scale,
    targetNormalized: scale ? absolute / scale : null,
    interpretation: "generalization-gap-diagnostic-not-robustness",
  };
}

function structuralComplexity(summary) {
  return summary?.formulaEvidence?.structure?.astNodeCount ?? Number.POSITIVE_INFINITY;
}

function paretoLayersFor(items, objectives) {
  if (objectives.length !== 2) throw new Error("Pareto layering currently requires exactly two objectives.");
  const normalized = items.map((point) => ({
    point,
    x: objectives[0].minimize ? objectives[0].get(point) : -objectives[0].get(point),
    y: objectives[1].minimize ? objectives[1].get(point) : -objectives[1].get(point),
  })).sort((a, b) => a.x - b.x || a.y - b.y || a.point.rank - b.point.rank);
  const yValues = [...new Set(normalized.map((entry) => entry.y))].sort((a, b) => a - b);
  const yIndex = new Map(yValues.map((value, index) => [value, index + 1]));
  const tree = new Int32Array(yValues.length + 1);
  const query = (index) => {
    let best = 0;
    for (let cursor = index; cursor > 0; cursor -= cursor & -cursor) best = Math.max(best, tree[cursor]);
    return best;
  };
  const update = (index, value) => {
    for (let cursor = index; cursor < tree.length; cursor += cursor & -cursor) tree[cursor] = Math.max(tree[cursor], value);
  };

  for (let start = 0; start < normalized.length;) {
    let end = start;
    while (end < normalized.length && normalized[end].x === normalized[start].x) end += 1;
    let sameXLowerYBest = 0;
    for (let cursor = start; cursor < end;) {
      let equalEnd = cursor;
      while (equalEnd < end && normalized[equalEnd].y === normalized[cursor].y) equalEnd += 1;
      const index = yIndex.get(normalized[cursor].y);
      const rank = 1 + Math.max(query(index), sameXLowerYBest);
      for (let item = cursor; item < equalEnd; item++) normalized[item].point.paretoRank = rank;
      sameXLowerYBest = Math.max(sameXLowerYBest, rank);
      cursor = equalEnd;
    }
    for (let cursor = start; cursor < end; cursor++) {
      update(yIndex.get(normalized[cursor].y), normalized[cursor].point.paretoRank);
    }
    start = end;
  }
  const layers = [];
  items.forEach((point) => {
    const index = point.paretoRank - 1;
    if (!layers[index]) layers[index] = [];
    layers[index].push(point);
  });
  return layers;
}

function validateEvaluation(result, evaluation) {
  const datasets = new Set([...Core.availableDatasets(result), ...(result.meta.multiTask ? ["sisso-overall"] : [])]);
  if (!datasets.has(evaluation.dataset)) throw new Error(`Dataset is not available: ${evaluation.dataset}`);
  if (!result.models.some((model) => Number.isFinite(metricValue(model, evaluation.dataset, evaluation.metric)))) {
    throw new Error(`Metric is unavailable or non-finite for every model: ${evaluation.dataset}.${evaluation.metric}`);
  }
}

function paretoObjectives(result, evaluation) {
  const hasHoldout = Core.availableDatasets(result).includes("verify");
  const objectives = [{
    key: `${evaluation.dataset}.${evaluation.metric}`,
    label: "predictive performance",
    minimize: lowerIsBetter(evaluation.metric),
    get: (point) => point.value,
  }];
  if (hasHoldout) {
    objectives.push({
      key: "generalizationGap.targetNormalizedAbsoluteRmse",
      label: "target-normalized absolute train/verify RMSE gap",
      minimize: true,
      get: (point) => point.generalizationGap.targetNormalized,
    });
  } else {
    objectives.push({
      key: "structure.astNodeCount",
      label: "syntactic AST node count",
      minimize: true,
      get: (point) => point.structuralComplexity,
    });
  }
  return objectives;
}

function objectivePoint(model, summary, result, evaluation, scale) {
  return {
    rank: model.rank,
    value: finite(metricValue(model, evaluation.dataset, evaluation.metric)),
    generalizationGap: generalizationGap(model, result, scale),
    structuralComplexity: structuralComplexity(summary),
    descriptorDimension: summary?.descriptorDimension
      ?? Math.max(1, model.descriptors?.length || model.featureIds?.length || 1),
  };
}

function publicObjective(objective) {
  return { key: objective.key, label: objective.label, direction: objective.minimize ? "minimize" : "maximize" };
}

function crowdingOrder(layer, objectives, compare) {
  if (layer.length <= 2) return [...layer].sort(compare);
  const distance = new Map(layer.map((point) => [point, 0]));
  for (const objective of objectives) {
    const sorted = [...layer].sort((a, b) => objective.get(a) - objective.get(b) || a.rank - b.rank);
    const minimum = objective.get(sorted[0]);
    const maximum = objective.get(sorted[sorted.length - 1]);
    distance.set(sorted[0], Number.POSITIVE_INFINITY);
    distance.set(sorted[sorted.length - 1], Number.POSITIVE_INFINITY);
    if (maximum === minimum) continue;
    for (let index = 1; index < sorted.length - 1; index++) {
      if (!Number.isFinite(distance.get(sorted[index]))) continue;
      const local = (objective.get(sorted[index + 1]) - objective.get(sorted[index - 1])) / (maximum - minimum);
      distance.set(sorted[index], distance.get(sorted[index]) + local);
    }
  }
  layer.forEach((point) => { point.crowdingDistance = distance.get(point); });
  return [...layer].sort((a, b) => distance.get(b) - distance.get(a) || compare(a, b));
}

export function paretoModels(result, options = {}, summaries = null) {
  const defaults = defaultEvaluation(result);
  const evaluation = {
    ...defaults,
    dataset: options.dataset || defaults.dataset,
    metric: options.metric || defaults.metric,
  };
  validateEvaluation(result, evaluation);
  const summaryByRank = new Map((summaries || result.models.map((model) => ({
    rank: model.rank,
    descriptorDimension: Math.max(1, model.descriptors?.length || model.featureIds?.length || 1),
    formulaEvidence: formulaEvidence(model, result, {}),
  }))).map((summary) => [summary.rank, summary]));
  const scale = targetScale(result);
  const points = result.models
    .map((model) => objectivePoint(model, summaryByRank.get(model.rank), result, evaluation, scale))
    .filter((point) => point.value !== null);
  const objectives = paretoObjectives(result, evaluation);
  const eligible = points.filter((point) => objectives.every((objective) => Number.isFinite(objective.get(point))));
  const layers = paretoLayersFor(eligible, objectives);
  const order = (a, b) => lowerIsBetter(evaluation.metric) ? a.value - b.value : b.value - a.value;
  layers.forEach((layer) => layer.sort((a, b) => order(a, b) || a.rank - b.rank));
  return {
    evaluation,
    objectives: objectives.map(publicObjective),
    front: layers[0] || [],
    layers: layers.map((layer, index) => ({ rank: index + 1, models: layer })),
    eligibleModels: eligible.length,
    excludedModels: points.length - eligible.length,
    scope: {
      rankedModelFile: "single-selected-top-file",
      descriptorDimensionFixed: new Set(points.map((point) => point.descriptorDimension)).size <= 1,
      limitation: "SISSO-Sage currently analyses one selected top*_D* file. Pareto layers do not compare models across different descriptor-dimension files.",
    },
  };
}

function candidateCautions(item, summary, best) {
  const cautions = [];
  if (item.value !== best) cautions.push({
    code: "not-best-predictive-value",
    evidence: { candidate: item.value, best },
  });
  if (item.generalizationGap.status !== "available") cautions.push({
    code: "generalization-not-assessable",
    evidence: item.generalizationGap.reason,
  });
  const unresolved = summary?.formulaEvidence?.provenance?.unresolvedFeatures || [];
  if (unresolved.length) cautions.push({ code: "unresolved-feature-provenance", evidence: unresolved });
  const invalidDatasets = (summary?.formulaEvidence?.domain?.observed || [])
    .filter((dataset) => dataset.status === "invalid-observations").map((dataset) => dataset.dataset);
  if (invalidDatasets.length) cautions.push({ code: "observed-domain-failure", evidence: invalidDatasets });
  if (summary?.formulaEvidence?.domain?.observedStatus === "deferred-until-finalist-inspection"
      && summary.formulaEvidence.domain.staticRequirements.length) {
    cautions.push({
      code: "observed-domain-audit-deferred",
      evidence: summary.formulaEvidence.domain.staticRequirements.map((requirement) => requirement.code),
    });
  }
  cautions.push({ code: "semantic-meaning-not-yet-assessed", evidence: "Requires the structured LLM/researcher review." });
  return cautions;
}

export function selectModels(result, summaries, options = {}) {
  const defaults = defaultEvaluation(result);
  const evaluation = { ...defaults, dataset: options.dataset || defaults.dataset, metric: options.metric || defaults.metric };
  validateEvaluation(result, evaluation);
  const summaryByRank = new Map(summaries.map((summary) => [summary.rank, summary]));
  const targetStd = targetScale(result);
  const points = result.models
    .map((model) => objectivePoint(model, summaryByRank.get(model.rank), result, evaluation, targetStd))
    .filter((point) => point.value !== null);
  const compare = (a, b) => {
    const delta = lowerIsBetter(evaluation.metric) ? a.value - b.value : b.value - a.value;
    return delta || a.rank - b.rank;
  };
  points.sort(compare);
  const best = points[0]?.value;
  const parsedTolerance = Number(options.nearOptimalTolerance);
  const tolerance = Number.isFinite(parsedTolerance) ? Math.max(0, Math.min(1, parsedTolerance)) : 0.10;
  const scale = Math.max(Math.abs(best), 1e-12);
  const competitive = points.filter((item) => lowerIsBetter(evaluation.metric)
    ? item.value <= best + scale * tolerance
    : item.value >= best - scale * tolerance);
  const objectives = paretoObjectives(result, evaluation);
  const paretoEligible = competitive.filter((point) => objectives.every((objective) => Number.isFinite(objective.get(point))));
  const layers = paretoLayersFor(paretoEligible, objectives);

  const limit = Math.max(1, Math.min(10, Math.floor(Number(options.limit) || 5)));
  const predictive = points[0];
  const ordered = [];
  const seen = new Set();
  const add = (item) => {
    if (item && !seen.has(item.rank)) { ordered.push(item); seen.add(item.rank); }
  };
  add(predictive);
  layers.forEach((layer) => crowdingOrder(layer, objectives, compare).forEach(add));
  [...competitive].sort(compare).forEach(add);
  const candidates = ordered.slice(0, limit).map((item) => {
    const roles = [];
    if (item.rank === predictive?.rank) roles.push("predictive-best");
    if (item.paretoRank === 1) roles.push("pareto-layer-1");
    if (item.rank !== predictive?.rank) roles.push("near-optimal-alternative");
    const summary = summaryByRank.get(item.rank);
    return {
      rank: item.rank,
      value: item.value,
      roles,
      paretoRank: item.paretoRank ?? null,
      crowdingDistance: Number.isFinite(item.crowdingDistance) ? item.crowdingDistance
        : item.crowdingDistance === Number.POSITIVE_INFINITY ? "boundary" : null,
      predictiveEvidence: {
        evaluation: { dataset: evaluation.dataset, metric: evaluation.metric, value: item.value },
        metrics: summary?.metrics || null,
        sissoReported: summary?.sissoReported || null,
      },
      generalizationGap: item.generalizationGap,
      structuralComplexity: item.structuralComplexity,
      evidenceAgainst: candidateCautions(item, summary, best),
    };
  });
  return {
    evaluation,
    methodology: {
      policy: "objective-evidence-shortlist-before-semantic-review",
      nearOptimalTolerance: tolerance,
      performanceEnvelope: lowerIsBetter(evaluation.metric)
        ? { maximum: best + scale * tolerance }
        : { minimum: best - scale * tolerance },
      competitivePool: competitive.length,
      paretoObjectives: objectives.map(publicObjective),
      candidateOrdering: "predictive best, then objective-space coverage by Pareto layer and crowding distance",
      interpretabilityUsedInSelection: false,
      robustnessClaimed: false,
      note: "Candidates are retained using predictive evidence and Pareto rank only. Syntactic complexity, provenance, and semantic assessment are evidence for finalist review, not pre-selection scores.",
    },
    reviewProtocol: {
      requiredJudgments: ["supported", "mixed", "concern", "unresolved", "not-assessable"],
      dimensions: ["structural-coherence", "scientific-plausibility", "limiting-behavior", "redundancy-or-cancellation", "feature-interaction-meaning"],
      requirements: [
        "Cite calculated evidence, researcher metadata, and source context separately.",
        "Include evidence for and against every candidate.",
        "Do not convert semantic review into a 0-100 elegance score.",
      ],
    },
    candidates,
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
  const summaries = result.models.map((model) => summarizeModel(result, model, featureMetadata.features, { evaluateObservedDomain: false }));
  return { discovery, health, result, featureMetadata, summaries };
}

export function buildBundle(analysis, options = {}) {
  const { discovery, health, result, featureMetadata } = analysis;
  const detailedSummaries = result.models.map((model) => summarizeModel(result, model, featureMetadata.features));
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
    models: detailedSummaries,
    selection: selectModels(result, detailedSummaries, options),
    provenance: {
      generator: "SISSO-Sage",
      generatorVersion: VERSION,
      numericalEngine: "SISSO-Analyzer sisso-core",
    },
  };
}
