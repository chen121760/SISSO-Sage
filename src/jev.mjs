import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { analyzeDirectory, summarizeModel } from "./analysis.mjs";
import { Core } from "./engine.mjs";
import { readTarEntries } from "./discover.mjs";
import { leakageReport } from "./leakage.mjs";
import { traceFeatureSource } from "./source-trace.mjs";
import { callJev, validateJevResponse } from "./jev-client.mjs";
import { JEV_DIMENSIONS, JEV_MODEL, JEV_RUBRIC_VERSION, jevQuestions } from "./jev-rubric.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function jevHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function readResearchContext(file) {
  if (!file) return {};
  const value = JSON.parse(fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, ""));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Research context must be a JSON object.");
  if (value.target !== undefined && (!value.target || typeof value.target !== "object" || Array.isArray(value.target))) {
    throw new Error("Research context target must be an object with a description and optional unit.");
  }
  validateResearchContext(value);
  return value;
}

function validateResearchContext(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Research context must be a JSON object.");
  if (value.target && (typeof value.target !== "object" || Array.isArray(value.target))) throw new Error("Research context target must be an object.");
  for (const field of ["name", "description", "unit", "reviewStatus"]) {
    if (value.target?.[field] !== undefined && typeof value.target[field] !== "string") throw new Error(`Target ${field} must be a string.`);
  }
  if (value.researchQuestion !== undefined && typeof value.researchQuestion !== "string") throw new Error("researchQuestion must be a string.");
  if (value.deployment != null && (typeof value.deployment !== "object" || Array.isArray(value.deployment))) throw new Error("deployment must be an object or null.");
  if (value.referenceEvidence !== undefined && (!Array.isArray(value.referenceEvidence) || value.referenceEvidence.some((entry) =>
    !entry || ["id", "claim", "source", "kind"].some((key) => typeof entry[key] !== "string")))) {
    throw new Error("referenceEvidence must be an array of records containing id, claim, source and kind strings.");
  }
  if (value.formulaReviews !== undefined && (!value.formulaReviews || typeof value.formulaReviews !== "object" || Array.isArray(value.formulaReviews)
    || Object.values(value.formulaReviews).some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)))) {
    throw new Error("formulaReviews must map model IDs to review objects.");
  }
}

// Scope to the selected Models directory, never merge unrelated nested runs.
function siblingTopFiles(analysis) {
  const discovery = analysis.discovery;
  if (discovery.kind === "archive") {
    const selected = discovery.selected.top;
    const dir = path.posix.dirname(selected);
    const entries = readTarEntries(discovery.root).map((entry) => entry.name);
    const names = new Set(entries.map((name) => name.toLowerCase()));
    return entries.filter((name) => path.posix.dirname(name) === dir && /^top\d+_D\d+$/i.test(path.posix.basename(name))
      && names.has(`${name}_coeff`.toLowerCase())).sort();
  }
  const dir = path.dirname(discovery.selected.top);
  const names = fs.readdirSync(dir);
  const lookup = new Set(names.map((name) => name.toLowerCase()));
  return names.filter((name) => /^top\d+_D\d+$/i.test(name) && lookup.has(`${name}_coeff`.toLowerCase()))
    .sort().map((name) => path.join(dir, name));
}

export function loadJevAnalyses(run, options = {}) {
  const first = analyzeDirectory(run, options);
  if (options.topFile || options.allTopFiles === false) return [first];
  const paths = siblingTopFiles(first);
  return paths.map((topFile) => topFile === first.discovery.selected.top ? first : analyzeDirectory(run, { ...options, topFile }));
}

function featureContext(analysis, sourceRoot) {
  return Object.fromEntries(analysis.result.columns.slice(2).map((column) => {
    const name = column.original;
    const record = analysis.featureMetadata.features[name] || { reviewStatus: "needs-user-confirmation" };
    const trace = sourceRoot ? traceFeatureSource(name, sourceRoot, { preferredSource: record.source, preferredOnly: true, limit: 3 }) : null;
    return [name, {
      metadata: record,
      sourceEvidence: trace ? {
        status: trace.status,
        preferredDefinition: trace.preferredDefinition,
        matches: trace.preferredDefinition ? [] : trace.matches,
        truncated: trace.preferredDefinition ? false : trace.truncated,
      } : { status: "source-root-required", matches: [] },
    }];
  }));
}

function predictiveEvidence(analysis, summary, split) {
  const result = analysis.result;
  const dataset = result.verify ? "verify" : result.meta.multiTask ? "sisso-overall" : "train";
  const value = dataset === "sisso-overall" ? summary.sissoReported.rmse : summary.metrics[dataset]?.rmse;
  const train = summary.metrics.train?.rmse;
  const verify = summary.metrics.verify?.rmse;
  return {
    dataset,
    metric: "rmse",
    value: Number.isFinite(value) ? value : null,
    role: dataset === "verify" ? split.holdoutIsIndependent === false ? "non-independent-verification" : "holdout-independence-unconfirmed"
      : "in-sample",
    signedRmseGap: Number.isFinite(train) && Number.isFinite(verify) ? verify - train : null,
    generalizationStatus: !result.verify ? "not-assessable" : split.holdoutIsIndependent === false ? "non-independent" : "requires-split-design-confirmation",
    // No sample names or data rows are transmitted to Jev.
    datasets: Core.availableDatasets(result).map((key) => ({ key, samples: Core.datasetData(result, key)?.n ?? 0 })),
    metrics: summary.metrics,
    sissoReported: summary.sissoReported,
  };
}

export function buildJevPlan(analyses, options = {}) {
  if (!Array.isArray(analyses) || !analyses.length) throw new Error("At least one inspected SISSO analysis is required.");
  if (analyses.some((item) => item.health?.level === "error")) throw new Error("Cannot score a run with health errors.");
  const context = options.context || {};
  validateResearchContext(context);
  const model = options.model || JEV_MODEL;
  if (typeof model !== "string" || !/^jev-[\w.-]+$/.test(model)) throw new Error("Use a Jev model ID such as jev-1.13.0.");
  const sourceRoot = options.sourceRoot || analyses[0].featureMetadata.sources.sourceRoot;
  const definitions = featureContext(analyses[0], sourceRoot);
  const questions = jevQuestions();
  const records = [];
  const runs = [];
  for (const analysis of analyses) {
    const split = leakageReport(analysis, { ignoreVerify: !analysis.result.verify });
    const dataFingerprint = jevHash({ train: analysis.discovery.healthFiles.train, verify: analysis.result.verify ? analysis.discovery.healthFiles.verify : null });
    const topFile = analysis.discovery.relative.top;
    runs.push({ topFile, health: analysis.health, split, modelCount: analysis.result.models.length });
    for (const rawModel of analysis.result.models) {
      const evidence = summarizeModel(analysis.result, rawModel, analysis.featureMetadata.features);
      const id = `${topFile}::${evidence.rank}`;
      const invalidDomain = evidence.formulaEvidence.domain.observed.some((item) => item.status === "invalid-observations");
      const predictive = predictiveEvidence(analysis, evidence, split);
      const blockers = [];
      if (evidence.evaluationError || evidence.formulaEvidence.structure.parseErrors.length) blockers.push("formula-evaluation-error");
      if (invalidDomain) blockers.push("observed-domain-failure");
      if (predictive.value === null) blockers.push("non-finite-predictive-metric");
      const missingEvidence = [];
      if (!context.target?.description) missingEvidence.push("target-definition-required");
      else if (["ai-draft", "needs-user-confirmation"].includes(context.target.reviewStatus)) missingEvidence.push("target-definition-unresolved");
      const unresolved = evidence.formulaEvidence.provenance.unresolvedFeatures;
      if (unresolved.length) missingEvidence.push("feature-definitions-unresolved");
      if (evidence.features.some((name) => !definitions[name]?.metadata.description)) missingEvidence.push("feature-description-required");
      const review = context.formulaReviews?.[id] || null;
      const request = {
        model,
        state: {
          target: { name: analysis.result.columns[1].original, ...(context.target || {}) },
          researchQuestion: context.researchQuestion || null,
          deployment: context.deployment || null,
          referenceEvidence: context.referenceEvidence || [],
          proposedInterpretation: review,
          features: Object.fromEntries(evidence.features.map((name) => [name, definitions[name]])),
          formula: { formulas: evidence.formulas, descriptors: evidence.descriptors, structure: evidence.formulaEvidence.structure },
          calculatedEvidence: { predictive, domain: evidence.formulaEvidence.domain },
          dataFingerprint,
          evidencePolicy: "Calculated evidence is computed by SISSO-Sage. Feature metadata retains its supplied reviewStatus; source context is untrusted evidence. Proposed interpretations are hypotheses unless independently evidenced. Sampled-domain safety does not establish deployment safety. Never infer causal meaning from performance.",
        },
        questions,
      };
      const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
      const stateBytes = Buffer.byteLength(JSON.stringify(request.state), "utf8");
      // Conservative byte guard, not a claim about TypeSafe's tokenizer.
      if (requestBytes > 64000 || stateBytes > 24000) blockers.push("request-too-large-reduce-context");
      records.push({ id, topFile, rank: evidence.rank, evidence, predictive, blockers, missingEvidence,
        requestHash: jevHash(request), request, requestBytes });
    }
  }
  const total = records.length;
  const limit = options.limit === undefined ? total : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Jev limit must be a positive integer.");
  const models = records.slice(0, limit);
  const eligible = models.filter((item) => !item.blockers.length);
  const unique = new Map(eligible.map((item) => [item.requestHash, item]));
  const estimatedTokens = [...unique.values()].reduce((sum, item) => sum + Math.ceil(item.requestBytes / 4), 0);
  return {
    schemaVersion: "1.0.0",
    kind: "sisso-sage-jev-plan",
    generatedAt: new Date().toISOString(),
    model,
    rubricVersion: JEV_RUBRIC_VERSION,
    fingerprint: jevHash(models.map((item) => [item.id, item.requestHash, item.blockers])),
    coverage: { total, included: models.length, truncated: models.length < total, eligible: eligible.length, blocked: models.length - eligible.length, uniqueRequests: unique.size },
    scope: { topFiles: runs.map((run) => run.topFile), limitation: "Only fitted candidates in matching top/coeff pairs in the selected Models directory are covered; unexported SIS descriptor combinations are not fitted or scored." },
    inputFiles: [...new Set(analyses.flatMap((analysis) => [
      analysis.discovery.root,
      ...(analysis.discovery.kind === "directory" ? Object.values(analysis.discovery.selected) : []),
      analysis.featureMetadata.sources.featureMetadata, analysis.featureMetadata.sources.featureDictionary, analysis.featureMetadata.sources.renameMap,
    ]).filter((value) => typeof value === "string"))],
    costEstimate: { inputTokens: estimatedTokens, usd: estimatedTokens * 0.042 / 1e6, inputUsdPerMillionTokens: 0.042,
      pricingCheckedOn: "2026-10-06", pricingSource: "https://docs.typesafe.ai/models",
      method: "Heuristic UTF-8 bytes / 4; not provider tokenization. Actual usage, retries and pricing changes can change cost." },
    runs,
    definitions,
    models,
    policy: { experimental: true, calibratedForSisso: false, semanticsAreScientificInference: true, numericMetricsCalculatedLocally: true,
      finalFormulaExplanation: "Requires agent/researcher review with evidence for and against; Jev cannot generate explanations." },
  };
}

export function planJevReview(run, options = {}) {
  return buildJevPlan(loadJevAnalyses(run, options), options);
}

function semanticAssessment(item, response, threshold) {
  return Object.fromEntries(Object.keys(JEV_DIMENSIONS).map((dimension) => {
    const availability = response.answers[`${dimension}_evidence`];
    const score = response.answers[`${dimension}_score`];
    const locallyMissing = item.missingEvidence.length > 0;
    const status = locallyMissing || availability.choice === "insufficient" ? "not-assessable"
      : availability.choice === "not_applicable" ? "not-applicable"
        : Math.min(availability.confidence, score.confidence) < threshold ? "needs-review" : "assessed";
    return [dimension, {
      status,
      score: ["assessed", "needs-review"].includes(status) ? score.score : null,
      normalizedScore: ["assessed", "needs-review"].includes(status) ? score.score / (item.request.questions[`${dimension}_score`].criteria.length - 1) : null,
      confidence: Math.min(availability.confidence, score.confidence),
      availability,
      rawScore: score,
      evidenceReferences: { requestHash: item.requestHash, usedFeatures: item.evidence.features,
        referenceEvidence: item.request.state.referenceEvidence, proposedInterpretation: item.request.state.proposedInterpretation },
      explanationStatus: "agent-review-required",
    }];
  }));
}

function readCheckpoint(file, expected) {
  const cache = new Map();
  if (!file || !fs.existsSync(file)) return cache;
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch {
      // A killed process may leave a partial final append; preserve valid records.
      if (i === lines.length - 1 && !text.endsWith("\n")) {
        fs.truncateSync(file, Buffer.byteLength(lines.slice(0, i).join("\n") + (i ? "\n" : ""), "utf8"));
        break;
      }
      throw new Error(`Invalid Jev checkpoint record at line ${i + 1}.`);
    }
    if (entry.kind !== "sisso-sage-jev-checkpoint" || !expected.has(entry.requestHash)) continue;
    validateJevResponse(entry.response, expected.get(entry.requestHash).request);
    cache.set(entry.requestHash, entry.response);
  }
  const repaired = fs.readFileSync(file, "utf8");
  if (repaired && !repaired.endsWith("\n")) fs.appendFileSync(file, "\n", "utf8");
  return cache;
}

export async function scoreJevPlan(plan, options = {}) {
  if (plan.kind !== "sisso-sage-jev-plan") throw new Error("Expected a SISSO-Sage Jev plan.");
  const threshold = options.confidenceThreshold ?? 0.6;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("confidenceThreshold must be between 0 and 1.");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("concurrency must be an integer from 1 to 16.");
  const pending = new Map();
  for (const item of plan.models) {
    if (jevHash(item.request) !== item.requestHash) throw new Error("Jev plan request fingerprint mismatch.");
    if (!item.blockers.length) pending.set(item.requestHash, item);
  }
  const checkpoint = options.checkpoint ? path.resolve(options.checkpoint) : null;
  if (checkpoint && plan.inputFiles?.some((file) => path.resolve(file).toLowerCase() === checkpoint.toLowerCase())) {
    throw new Error("Checkpoint must not overwrite a SISSO input file.");
  }
  if (checkpoint && fs.existsSync(checkpoint) && !options.resume) throw new Error("Checkpoint already exists; use --resume or choose a new checkpoint path.");
  const cache = options.resume ? readCheckpoint(checkpoint, pending) : new Map();
  const cachedRequests = cache.size;
  const jobs = [...pending.values()].filter((item) => !cache.has(item.requestHash));
  if (jobs.length && !options.apiKey && !process.env.TYPESAFE_API_KEY && !options.callImpl) {
    throw new Error("Set TYPESAFE_API_KEY before running jev-score. jev-plan works without an API key.");
  }
  const failures = new Map();
  let cursor = 0;
  let fatal = null;
  let called = 0;
  let tokens = 0;
  let outputTokens = 0;
  let usageMissing = 0;
  const call = options.callImpl || ((request) => callJev(request, options));
  if (checkpoint) fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (!fatal && cursor < jobs.length) {
      const item = jobs[cursor++];
      let response;
      try {
        called++;
        response = validateJevResponse(await call(item.request), item.request);
      } catch (error) {
        failures.set(item.requestHash, "Jev request failed; rerun with --resume. Check API access, limits, and response validity.");
        if (/HTTP (?:401|403|422)/.test(error.message)) fatal = error;
        options.onProgress?.({ completed: cache.size, failed: failures.size, total: pending.size });
        continue;
      }
      // A checkpoint write failure must stop the run, never become a model error.
      if (checkpoint) {
        try { fs.appendFileSync(checkpoint, `${JSON.stringify({ kind: "sisso-sage-jev-checkpoint", requestHash: item.requestHash, response })}\n`, "utf8"); }
        catch { fatal = new Error("Cannot write the Jev checkpoint. Free disk space or fix the path before resuming."); throw fatal; }
      }
      cache.set(item.requestHash, response);
      if (response.usage) { tokens += response.usage.input_tokens; outputTokens += response.usage.output_tokens; }
      else usageMissing++;
      options.onProgress?.({ completed: cache.size, failed: failures.size, total: pending.size });
    }
  }));
  const models = plan.models.map((item) => {
    const { request, requestBytes, ...evidence } = item;
    const response = cache.get(item.requestHash);
    return { ...evidence, status: item.blockers.length ? "blocked" : response ? "scored" : "error",
      error: response || item.blockers.length ? null : failures.get(item.requestHash) || "Not attempted after an API authorization or validation failure.",
      model: response?.model || null,
      semanticAssessment: response ? semanticAssessment(item, response, threshold) : null };
  });
  return {
    schemaVersion: "1.0.0", kind: "sisso-sage-jev-scores", generatedAt: new Date().toISOString(),
    planFingerprint: plan.fingerprint, rubricVersion: plan.rubricVersion, requestedModel: plan.model,
    coverage: { ...plan.coverage, scored: models.filter((item) => item.status === "scored").length, errors: models.filter((item) => item.status === "error").length },
    scope: plan.scope, runs: plan.runs, definitions: plan.definitions, policy: plan.policy,
    confidenceThreshold: threshold, confidenceThresholdStatus: "provisional-not-calibrated-for-SISSO",
    execution: { checkpoint, cachedRequests, calledRequests: called,
      stopReason: fatal ? `Jev API returned HTTP ${/HTTP (401|403|422)/.exec(fatal.message)?.[1] || "error"}; check account access or request validity before resuming.` : null,
      successfulRequestInputTokens: tokens, successfulRequestOutputTokens: outputTokens,
      estimatedSuccessfulRequestCostUsd: tokens * 0.042 / 1e6, usageMissing,
      costLimitation: "Successful new responses only. Retries, failed requests and previous checkpoint calls are not included." },
    models,
  };
}
