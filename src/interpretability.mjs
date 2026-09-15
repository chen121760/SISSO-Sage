import { Core } from "./engine.mjs";

const REVIEW_CONFIDENCE = {
  confirmed: "high",
  "imported-documentation": "medium",
  "ai-draft": "low",
  "unit-manifest-only": "low",
  "needs-user-confirmation": "unresolved",
};

function astStats(node) {
  if (!node) return { nodes: 0, operations: 0, depth: 0 };
  const children = node.k === "op" ? [node.a, node.b]
    : node.k === "neg" ? [node.a]
      : node.k === "call" ? node.args || [] : [];
  const nested = children.map(astStats);
  return {
    nodes: 1 + nested.reduce((sum, item) => sum + item.nodes, 0),
    operations: (node.k === "op" || node.k === "neg" || node.k === "call" ? 1 : 0)
      + nested.reduce((sum, item) => sum + item.operations, 0),
    depth: 1 + Math.max(0, ...nested.map((item) => item.depth)),
  };
}

function safeAst(text) {
  try {
    return { ast: Core.formulaAst(text), error: null };
  } catch (error) {
    return { ast: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function constantValue(node) {
  if (!node) return null;
  if (node.k === "num") return node.v;
  if (node.k === "neg") {
    const value = constantValue(node.a);
    return value === null ? null : -value;
  }
  if (node.k === "op") {
    const left = constantValue(node.a);
    const right = constantValue(node.b);
    if (left === null || right === null) return null;
    if (node.op === "+") return left + right;
    if (node.op === "-") return left - right;
    if (node.op === "*") return left * right;
    if (node.op === "/") return right === 0 ? null : left / right;
    return Math.pow(left, right);
  }
  return null;
}

function requirementCode(node) {
  if (node.k === "call" && node.name === "log") return "positive-log-argument";
  if (node.k === "call" && node.name === "sqrt") return "nonnegative-sqrt-argument";
  if (node.k === "call" && node.name === "exp") return "bounded-exp-argument";
  if (node.k === "op" && node.op === "/") return "nonzero-denominator";
  if (node.k === "op" && node.op === "^") {
    const exponent = constantValue(node.b);
    if (Number.isFinite(exponent) && exponent < 0) return "nonzero-negative-power-base";
    if (Number.isFinite(exponent) && !Number.isInteger(exponent)) return "nonnegative-fractional-power-base";
  }
  return null;
}

function collectRequirements(node, descriptor, path = "root", out = []) {
  if (!node) return out;
  const code = requirementCode(node);
  if (code) out.push({ code, descriptor, path, status: "requires-observed-and-deployment-domain-check" });
  if (node.k === "op") {
    collectRequirements(node.a, descriptor, `${path}.left`, out);
    collectRequirements(node.b, descriptor, `${path}.right`, out);
  } else if (node.k === "neg") {
    collectRequirements(node.a, descriptor, `${path}.argument`, out);
  } else if (node.k === "call") {
    (node.args || []).forEach((arg, index) => collectRequirements(arg, descriptor, `${path}.arg${index + 1}`, out));
  }
  return out;
}

function createCheck(code, descriptor, path) {
  return {
    code,
    descriptor,
    path,
    observations: 0,
    invalid: 0,
    nonFinite: 0,
    argumentMin: null,
    argumentMax: null,
    argumentMinAbs: null,
  };
}

function updateCheck(check, value, invalid) {
  check.observations += 1;
  if (!Number.isFinite(value)) check.nonFinite += 1;
  else {
    check.argumentMin = check.argumentMin === null ? value : Math.min(check.argumentMin, value);
    check.argumentMax = check.argumentMax === null ? value : Math.max(check.argumentMax, value);
    const abs = Math.abs(value);
    check.argumentMinAbs = check.argumentMinAbs === null ? abs : Math.min(check.argumentMinAbs, abs);
  }
  if (invalid) check.invalid += 1;
}

function evaluateNode(node, get, descriptor, path, checks) {
  if (node.k === "num") return node.v;
  if (node.k === "var") return get(node.name);
  if (node.k === "neg") return -evaluateNode(node.a, get, descriptor, `${path}.argument`, checks);
  if (node.k === "call") {
    const arg = evaluateNode(node.args[0], get, descriptor, `${path}.arg1`, checks);
    const code = requirementCode(node);
    if (code) {
      const key = `${descriptor}:${path}:${code}`;
      if (!checks.has(key)) checks.set(key, createCheck(code, descriptor, path));
      updateCheck(checks.get(key), arg,
        (node.name === "log" && !(arg > 0)) || (node.name === "sqrt" && !(arg >= 0)));
    }
    const fn = Core.FUNCS[node.name];
    return fn ? fn(arg) : NaN;
  }
  if (node.k === "op") {
    const left = evaluateNode(node.a, get, descriptor, `${path}.left`, checks);
    const right = evaluateNode(node.b, get, descriptor, `${path}.right`, checks);
    const code = requirementCode(node);
    if (code) {
      const argument = node.op === "/" ? right : left;
      const key = `${descriptor}:${path}:${code}`;
      if (!checks.has(key)) checks.set(key, createCheck(code, descriptor, path));
      const invalid = code === "nonnegative-fractional-power-base"
        ? !(argument >= 0)
        : argument === 0 || !Number.isFinite(argument);
      updateCheck(checks.get(key), argument, invalid);
    }
    if (node.op === "+") return left + right;
    if (node.op === "-") return left - right;
    if (node.op === "*") return left * right;
    if (node.op === "/") return left / right;
    return Math.pow(left, right);
  }
  return NaN;
}

function observedDomainEvidence(parsed, result) {
  if (!result?.columns) return [];
  const featureLetters = new Map(result.columns.slice(2).map((column) => [column.original, column.letter]));
  return Core.availableDatasets(result).map((dataset) => {
    const data = Core.datasetData(result, dataset);
    const checks = new Map();
    let nonFiniteDescriptorValues = 0;
    parsed.forEach((item, descriptorIndex) => {
      if (!item.ast || !data) return;
      for (let row = 0; row < data.n; row++) {
        const value = evaluateNode(item.ast, (name) => {
          const letter = featureLetters.get(name);
          return letter && data.cols[letter] ? data.cols[letter][row] : NaN;
        }, descriptorIndex + 1, "root", checks);
        if (!Number.isFinite(value)) nonFiniteDescriptorValues += 1;
      }
    });
    const constraints = [...checks.values()];
    const invalid = constraints.reduce((sum, check) => sum + check.invalid, 0);
    const status = nonFiniteDescriptorValues || invalid ? "invalid-observations"
      : constraints.length ? "observed-safe" : "no-constrained-operators";
    return {
      dataset,
      samples: data?.n ?? 0,
      status,
      nonFiniteDescriptorValues,
      constraints,
      limitation: "Observed-safe means only that sampled rows passed; it does not establish safety in an extrapolation or deployment domain.",
    };
  });
}

function provenanceEvidence(usedFeatures, metadata) {
  const features = usedFeatures.map((name) => {
    const record = metadata[name] || { name, reviewStatus: "needs-user-confirmation" };
    const reviewStatus = REVIEW_CONFIDENCE[record.reviewStatus]
      ? record.reviewStatus : "needs-user-confirmation";
    return {
      name,
      reviewStatus,
      confidence: REVIEW_CONFIDENCE[reviewStatus],
      availableFields: ["description", "unit", "category"].filter((field) => !!record[field]),
      source: record.source || null,
      evidence: record.evidence || [],
      constraints: record.constraints || null,
      metadata: record,
    };
  });
  const unresolvedFeatures = features
    .filter((item) => !["confirmed", "imported-documentation"].includes(item.reviewStatus))
    .map((item) => item.name);
  const confirmedFeatures = features.filter((item) => item.reviewStatus === "confirmed").map((item) => item.name);
  const status = features.length && confirmedFeatures.length === features.length ? "researcher-confirmed"
    : unresolvedFeatures.length ? "unresolved-or-draft" : "documented-not-fully-confirmed";
  return {
    status,
    features,
    confirmedFeatures,
    unresolvedFeatures,
    limitation: "Provenance confidence describes the evidence for feature definitions; it is not formula interpretability.",
  };
}

export function formulaEvidence(model, result, metadata = {}, options = {}) {
  const descriptors = (model.descriptors || []).map((item) => item.original || item.renamed || "");
  const featureNames = Array.isArray(result) ? result
    : result?.columns ? result.columns.slice(2).map((column) => column.original) : [];
  const pipelineResult = Array.isArray(result) ? null : result;
  const usedFeatures = Core.modelFeatureNames(model, featureNames);
  const parsed = descriptors.map((text) => ({ text, ...safeAst(text) }));
  const stats = parsed.map((item) => astStats(item.ast));
  const staticRequirements = parsed.flatMap((item, index) => collectRequirements(item.ast, index + 1));

  return {
    structure: {
      descriptorDimension: Math.max(1, descriptors.length || model.featureIds?.length || 1),
      primitiveFeatureCount: usedFeatures.length,
      astNodeCount: stats.reduce((sum, item) => sum + item.nodes, 0),
      operationCount: stats.reduce((sum, item) => sum + item.operations, 0),
      maxAstDepth: Math.max(0, ...stats.map((item) => item.depth)),
      parseErrors: parsed.filter((item) => item.error).map((item) => ({ expression: item.text, error: item.error })),
      interpretation: "syntactic-complexity-evidence-only",
      limitation: "Syntactic size is a reproducible description, not a score of scientific meaning or elegance.",
    },
    domain: {
      staticRequirements,
      observedStatus: options.evaluateObservedDomain === false ? "deferred-until-finalist-inspection" : "evaluated",
      observed: options.evaluateObservedDomain === false ? [] : observedDomainEvidence(parsed, pipelineResult),
      deploymentDomain: {
        status: "not-assessable-from-sampled-data-alone",
        requiredEvidence: "Researcher-confirmed feature constraints or an explicit deployment range.",
      },
    },
    provenance: provenanceEvidence(usedFeatures, metadata),
    semanticAssessment: {
      status: "not-assessed",
      assessorRequired: "LLM-guided researcher review",
      dimensions: [
        "structural-coherence",
        "scientific-plausibility",
        "limiting-behavior",
        "redundancy-or-cancellation",
        "feature-interaction-meaning",
      ],
      allowedJudgments: ["supported", "mixed", "concern", "unresolved", "not-assessable"],
      rule: "Every judgment must cite supplied evidence and include counterevidence; do not emit a 0-100 elegance score.",
    },
  };
}

// Compatibility name for API consumers. The returned object intentionally no
// longer contains an interpretability score.
export const interpretabilityEvidence = formulaEvidence;
