---
name: sisso-model-analysis
description: Inspect completed SISSO regression runs, generate an objective-evidence shortlist, trace feature provenance and source code, and conduct a structured semantic review of finalist formulas. Use when a user provides SISSO output or asks which SISSO model to choose; do not use to run SISSO itself.
---

# SISSO model analysis

Use the SISSO-Sage MCP tools to turn a completed SISSO run into an auditable shortlist rather than a single unsupported winner.

## Workflow

1. Call `inspect_run` first. If it returns a health error, stop model selection and explain the failing checks.
2. When `verify.dat` exists, call `check_leakage` before selection. If it reports non-independent rows, do not present verify metrics as external generalization evidence.
3. Call `select_candidates` to obtain a strict-size shortlist based on raw predictive evidence, a declared near-optimal envelope, and Pareto rank. Prefer the default holdout evaluation when it passed the leakage audit. Do not treat shortlist membership as evidence of physical meaning.
4. Call `compare_models` for the finalists, then use `get_model` when one candidate needs its complete evidence record.
5. Before making physical claims, review every primitive feature's metadata and `reviewStatus`. Call `feature_context` for ambiguous, incomplete, or especially important features; read the returned function body and bounded context when available.
6. If a feature remains unresolved, request its original extraction script or a researcher-confirmed definition. Never infer its physical meaning solely from its identifier.

## Scientific reporting rules

- Present multiple candidates and give evidence both for and against every finalist.
- Separate calculated metrics, researcher-supplied metadata, and scientific inference.
- Never invent or request a scalar interpretability/elegance score. Keep syntactic structure, observed-domain validity, provenance confidence, and semantic interpretation separate.
- Prefer holdout metrics over training metrics. When no holdout exists, state that model ranking is not externally validated.
- For MT-SISSO, report per-task behavior together with SISSO's aggregate metric.
- Treat division, logarithms, square roots, exponentials, and negative powers as constraints to check, not automatic defects. Report sampled-data checks separately from deployment-domain conclusions.
- Do not accept a model physically until units, feature provenance, leakage risk, valid domains, and deployment-domain coverage have been reviewed.
- Assess `structural-coherence`, `scientific-plausibility`, `limiting-behavior`, `redundancy-or-cancellation`, and `feature-interaction-meaning` using only `supported`, `mixed`, `concern`, `unresolved`, or `not-assessable`. Cite evidence and counterevidence for each finalist.

Use `list_models` or `pareto_frontier` when the user asks to explore beyond the initial shortlist.

## Optional Jev screening

When the user requests Jev, use the CLI workflow in `docs/JEV.zh-CN.md` after
inspection and feature-source review. Prepare `sage.research.json`, run
`jev-plan`, and check full coverage before `jev-score`. The score command sends
formula evidence to the TypeSafe API; read the key from `TYPESAFE_API_KEY` and
never write credentials into a plan or report. Preserve checkpoints and use
`--resume` to reuse unchanged evidence.

Jev returns separate experimental semantic grades with explicit missing-evidence
and uncertainty states. These are provisional scientific judgments, not a
universal elegance score or physical acceptance. Use `jev-select`/`jev-report`,
then inspect each finalist against the correct `--top-file` and its extraction
sources. Explain every formula with supporting evidence, counterevidence and
conditions. Jev cannot generate that explanation. Calibrate against researcher
examples before trusting its ordering; retain the original objective shortlist
as a comparison. Existing MCP tools stay local and read-only.
