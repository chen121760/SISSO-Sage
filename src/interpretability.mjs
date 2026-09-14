import { Core } from "./engine.mjs";

function countOperations(text) {
  if (!text) return 0;
  const binary = (text.match(/[+*/^]/g) || []).length;
  const subtraction = (text.match(/(^|[^eE])-\s*(?=[A-Za-z_(\d])/g) || []).length;
  const functions = (text.match(/\b(?:log|exp|sqrt|cbrt|abs)\s*\(/g) || []).length;
  return binary + subtraction + functions;
}

function domainRisks(descriptorText) {
  const risks = [];
  if (/\blog\s*\(/i.test(descriptorText)) risks.push({ code: "log-domain", message: "Contains log(); its argument must remain positive." });
  if (/\bsqrt\s*\(/i.test(descriptorText)) risks.push({ code: "sqrt-domain", message: "Contains sqrt(); its argument must remain non-negative." });
  if (/\//.test(descriptorText) || /\^\s*\(?\s*-/.test(descriptorText)) risks.push({ code: "singularity", message: "Contains division or a negative power and may amplify values near zero." });
  if (/\bexp\s*\(/i.test(descriptorText)) risks.push({ code: "exponential", message: "Contains exp(); extrapolation can grow or underflow rapidly." });
  return risks;
}

function featureNamesFor(model, featureNames) {
  return Core.modelFeatureNames(model, featureNames);
}

export function interpretabilityEvidence(model, featureNames, metadata = {}) {
  const descriptors = (model.descriptors || []).map((item) => item.original || item.renamed || "");
  const usedFeatures = featureNamesFor(model, featureNames);
  const records = usedFeatures.map((name) => ({ name, metadata: metadata[name] || null }));
  const evidenceStrength = records.map((item) => {
    if (!item.metadata) return 0;
    const description = item.metadata.description ? 0.5 : 0;
    const units = item.metadata.unit ? 0.2 : 0;
    const sourceTrace = item.metadata.source?.file ? 0.3 : item.metadata.source?.root ? 0.15 : 0;
    return description + units + sourceTrace;
  });
  const metadataCoverage = usedFeatures.length ? evidenceStrength.reduce((a, b) => a + b, 0) / usedFeatures.length : 0;
  const operationCount = descriptors.reduce((sum, text) => sum + countOperations(text), 0);
  const risks = descriptors.flatMap(domainRisks).filter((risk, index, all) => all.findIndex((item) => item.code === risk.code) === index);
  const dimension = Math.max(1, descriptors.length || model.featureIds?.length || 1);

  const simplicity = Math.max(0, Math.round(100 - 14 * (dimension - 1) - 3 * operationCount));
  const domainSafety = Math.max(0, 100 - risks.length * 18);
  const provenance = Math.round(metadataCoverage * 100);
  const score = Math.round(0.50 * simplicity + 0.25 * domainSafety + 0.25 * provenance);
  const status = metadataCoverage >= 0.8 ? "evidence-supported" : metadataCoverage > 0 ? "partial-metadata" : "structure-only";

  return {
    score,
    status,
    components: { simplicity, domainSafety, provenance },
    dimension,
    operationCount,
    features: records,
    metadataCoverage,
    unresolvedFeatures: records.filter((item) => !item.metadata || ["needs-user-confirmation", "unit-manifest-only", "ai-draft"].includes(item.metadata.reviewStatus)).map((item) => item.name),
    risks,
    limitation: "This is a transparent evidence score, not proof that the model is physically meaningful.",
  };
}
