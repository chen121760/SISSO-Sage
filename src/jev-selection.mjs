import { JEV_DIMENSIONS } from "./jev-rubric.mjs";

function structureKey(item) {
  return item.evidence.descriptors.map((descriptor) => descriptor.expression.replace(/\s+/g, "")).sort().join(";");
}

export function selectJevCandidates(report, options = {}) {
  if (report.kind !== "sisso-sage-jev-scores" || !Array.isArray(report.models)) throw new Error("Expected a Jev scores report.");
  const limit = options.limit === undefined ? 5 : Number(options.limit);
  const tolerance = options.nearOptimalTolerance === undefined ? 0.1 : Number(options.nearOptimalTolerance);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Candidate limit must be an integer from 1 to 10.");
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new Error("nearOptimalTolerance must be between 0 and 1.");
  const valid = report.models.filter((item) => !item.blockers.length && Number.isFinite(item.predictive.value));
  const datasets = new Set(valid.map((item) => item.predictive.dataset));
  if (datasets.size > 1) throw new Error("Cannot compare candidates evaluated on different datasets.");
  const predictiveOrder = (a, b) => a.predictive.value - b.predictive.value || a.id.localeCompare(b.id);
  valid.sort(predictiveOrder);
  const best = valid[0]?.predictive.value ?? null;
  const ceiling = best === null ? null : best + Math.max(Math.abs(best), 1e-12) * tolerance;
  const competitive = valid.filter((item) => item.predictive.value <= ceiling);
  const chosen = new Map();
  const structures = new Map();
  function add(item, role) {
    if (!item) return;
    const key = structureKey(item);
    const existing = structures.get(key);
    if (existing) { chosen.get(existing).roles.push(role); return; }
    if (chosen.size >= limit) return;
    structures.set(key, item.id);
    chosen.set(item.id, { ...item, roles: [role] });
  }
  add(competitive[0], "predictive-best");
  // Each dimension remains a separate criterion; no universal elegance score.
  for (const dimension of Object.keys(JEV_DIMENSIONS)) {
    const assessed = competitive.filter((item) => item.semanticAssessment?.[dimension]?.status === "assessed");
    const order = assessed.sort((a, b) => b.semanticAssessment[dimension].normalizedScore - a.semanticAssessment[dimension].normalizedScore
      || predictiveOrder(a, b));
    const diverse = order.find((item) => !structures.has(structureKey(item)));
    add(diverse || order[0], `${dimension}-review-candidate`);
  }
  add([...competitive].sort((a, b) => a.evidence.formulaEvidence.structure.astNodeCount - b.evidence.formulaEvidence.structure.astNodeCount
    || predictiveOrder(a, b)).find((item) => !structures.has(structureKey(item))), "syntactically-simple");
  for (const item of competitive) add(item, "competitive-alternative");
  const candidates = [...chosen.values()].map((item) => {
    const against = ["Physical interpretation and deployment-domain validity require agent/researcher review."];
    if (item.predictive.value > best) against.push(`RMSE ${item.predictive.value} exceeds the predictive best ${best}.`);
    if (item.predictive.generalizationStatus !== "requires-split-design-confirmation") against.push(`Generalization: ${item.predictive.generalizationStatus}.`);
    else against.push("Split independence still requires confirmation from the data collection and split design.");
    if (item.status !== "scored") against.push("Jev review is missing because the request failed; predictive evidence is retained.");
    if (item.missingEvidence.length) against.push(`Missing evidence: ${item.missingEvidence.join(", ")}.`);
    for (const [dimension, assessment] of Object.entries(item.semanticAssessment || {})) {
      if (assessment.status !== "assessed" && assessment.status !== "not-applicable") against.push(`${dimension}: ${assessment.status}.`);
      else if (assessment.normalizedScore !== null && assessment.normalizedScore < 0.5) against.push(`${dimension}: low provisional semantic grade; inspect raw evidence.`);
    }
    return { ...item, roles: [...new Set(item.roles)], evidenceFor: [
      { kind: "calculated", dataset: item.predictive.dataset, metric: "rmse", value: item.predictive.value, nearOptimalCeiling: ceiling },
      ...Object.entries(item.semanticAssessment || {}).filter(([, assessment]) => assessment.status === "assessed" && assessment.normalizedScore >= 0.5)
        .map(([dimension, assessment]) => ({ kind: "scientific-inference", dimension, normalizedScore: assessment.normalizedScore,
          confidence: assessment.confidence, requestHash: item.requestHash })),
    ], evidenceAgainst: against };
  });
  return {
    kind: "sisso-sage-jev-selection", schemaVersion: "1.0.0", coverage: report.coverage,
    evaluation: { dataset: valid[0]?.predictive.dataset ?? null, metric: "rmse", best, nearOptimalCeiling: ceiling },
    methodology: { limit, nearOptimalTolerance: tolerance, competitivePool: competitive.length,
      compositeEleganceScore: false, interpretation: "Experimental review-priority shortlist, not physical acceptance.",
      ordering: "Predictive best, then distinct descriptor structures favored by separately assessed semantic dimensions, then simpler and competitive alternatives.",
      duplicateRule: "Identical descriptor expressions after whitespace removal and descriptor reordering; algebraic equivalence is not established.",
      performanceSelectionUsesValidation: valid[0]?.predictive.dataset === "verify",
      generalizationCaution: "A verify dataset used to choose among many formulas is a selection dataset. Confirm final generalization on untouched test data or an appropriate nested evaluation." },
    candidates,
    reviewRequired: true,
  };
}

export function jevReviewMarkdown(selection) {
  const clean = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = ["# SISSO-Sage / Jev 候选公式审查", "", "> Jev 多维评分为实验性科学推断；不是物理规律认证。详细机理解释仍需 agent 根据原始证据审查。", "",
    `覆盖：${selection.coverage.included}/${selection.coverage.total} 条；已评分 ${selection.coverage.scored} 条；失败 ${selection.coverage.errors} 条；截断：${selection.coverage.truncated}。`, "",
    `筛选：${selection.evaluation.dataset || "无可用数据"}.RMSE，最佳值 ${selection.evaluation.best ?? "不可用"}，近优上限 ${selection.evaluation.nearOptimalCeiling ?? "不可用"}。`, ""];
  for (const candidate of selection.candidates) {
    lines.push(`## ${clean(candidate.id)}`, "", `候选角色：${candidate.roles.join(", ")}`, "", "### 完整公式", "");
    for (const formula of candidate.evidence.formulas) lines.push(`**${clean(formula.dataset)}**`, "", "```text", String(formula.formula).replace(/```/g, "'''"), "```", "");
    lines.push("### 预测表现（程序计算）", "", "| 数据集 | RMSE | MAE | 最大绝对误差 | R² | 相关系数 |", "|---|---|---|---|---|---|");
    for (const [dataset, metrics] of Object.entries(candidate.evidence.metrics)) lines.push(`| ${clean(dataset)} | ${metrics?.rmse ?? "NA"} | ${metrics?.mae ?? "NA"} | ${metrics?.maxae ?? "NA"} | ${metrics?.r2 ?? "NA"} | ${metrics?.rho ?? "NA"} |`);
    lines.push("", `SISSO 总体报告：RMSE=${candidate.evidence.sissoReported.rmse ?? "NA"}；MaxAE=${candidate.evidence.sissoReported.maxae ?? "NA"}。`, "",
      "### 特征定义（提供的元数据）", "", "| 特征 | 含义 | 单位 | 审查状态 |", "|---|---|---|---|");
    for (const feature of candidate.evidence.formulaEvidence.provenance.features) {
      lines.push(`| ${clean(feature.name)} | ${clean(feature.metadata.description || "待确认")} | ${clean(feature.metadata.unit || "待确认")} | ${clean(feature.reviewStatus)} |`);
    }
    lines.push("", "### Jev 语义评价（科学推断）", "", "| 维度 | 状态 | 原始分数 | 置信度 |", "|---|---|---|---|");
    for (const [dimension, result] of Object.entries(candidate.semanticAssessment || {})) lines.push(`| ${dimension} | ${result.status} | ${result.score ?? "不适用/无法评价"} | ${result.confidence} |`);
    lines.push("", `证据请求 SHA-256：${candidate.requestHash}`, "", "### 支持与反证", "",
      `- 预测 RMSE=${candidate.predictive.value}，位于声明的近优范围内。`,
      ...candidate.evidenceAgainst.map((reason) => `- ${clean(reason)}`), "", "### 逐项解释与后续验证", "");
    const assessment = Object.values(candidate.semanticAssessment || {})[0];
    const interpretation = assessment?.evidenceReferences.proposedInterpretation;
    if (interpretation) lines.push("提供的解释假设（不是 Jev 生成的解释）：", "", "```json", JSON.stringify(interpretation, null, 2).replace(/```/g, "'''"), "```", "");
    lines.push("Agent 应逐项说明描述符操作的科学含义、与目标的联系、成立条件，并引用原始元数据/源码/文献；给出至少一条支持证据和一条反证。缺少机理证据时保留为经验关系，不补写推导。", "");
  }
  lines.push("## 评价限制", "", selection.methodology.generalizationCaution, "", "不能用高语义分抵消非有限预测或观测定义域失败。置信度阈值尚未针对 SISSO 校准。", "");
  return lines.join("\n");
}
