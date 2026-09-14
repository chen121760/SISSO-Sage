---
name: sisso-model-analysis
description: Inspect and analyze completed SISSO regression runs, compare candidate formulas, trace primitive-feature provenance, and select models using predictive and interpretability evidence. Use when a user provides SISSO output or asks which SISSO model to choose; do not use to run SISSO itself.
---

# SISSO model analysis

Use the SISSO-Sage MCP tools to turn a completed SISSO run into an auditable shortlist rather than a single unsupported winner.

## Workflow

1. Call `inspect_run` first. If it returns a health error, stop model selection and explain the failing checks.
2. Call `select_candidates` to obtain predictive, balanced, interpretable, robust, and Pareto alternatives. Prefer the default holdout evaluation when `verify.dat` is available.
3. Call `compare_models` for the finalists, then use `get_model` when one candidate needs its complete evidence record.
4. Before making physical claims, review every primitive feature's metadata. Call `feature_context` for ambiguous, incomplete, or especially important features when extraction source is available.
5. If a feature remains unresolved, request its original extraction script or a researcher-confirmed definition. Never infer its physical meaning solely from its identifier.

## Scientific reporting rules

- Present multiple candidates and give evidence both for and against every finalist.
- Separate calculated metrics, researcher-supplied metadata, and scientific inference.
- Treat `interpretabilityEvidence.score` as a disclosed heuristic, not proof of causality or a physical law.
- Prefer holdout metrics over training metrics. When no holdout exists, state that model ranking is not externally validated.
- For MT-SISSO, report per-task behavior together with SISSO's aggregate metric.
- Discuss detected singularities and domain restrictions such as division by zero, logarithms, square roots, exponentials, and negative powers.
- Do not accept a model physically until units, feature provenance, leakage risk, valid domains, and deployment-domain coverage have been reviewed.

Use `list_models` or `pareto_frontier` when the user asks to explore beyond the initial shortlist.
