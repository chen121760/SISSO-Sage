import { VERSION } from "./version.mjs";

export const CAPABILITIES = {
  name: "SISSO-Sage",
  version: VERSION,
  purpose: "Transform SISSO results into compact, auditable evidence that an AI can query before recommending models.",
  commands: {
    inspect: "Validate a SISSO run and return its manifest.",
    models: "List compact model summaries with filtering and sorting.",
    model: "Return the full evidence record for one ranked model.",
    compare: "Return aligned evidence records for selected model ranks.",
    pareto: "Return the prediction-error versus descriptor-complexity Pareto front.",
    select: "Create a multi-role shortlist: predictive, balanced, interpretable, and robust.",
    bundle: "Write the complete AI-readable analysis bundle.",
    "metadata-template": "Create a feature-provenance template for the run.",
    "feature-doc": "Write a reviewable Markdown feature dictionary and flag unresolved names.",
    "feature-context": "Find exact references to one feature in the supplied extraction source tree.",
  },
  mcpTools: {
    get_capabilities: "Discover the MCP workflow and decision policy.",
    inspect_run: "Validate a run before analysis.",
    list_models: "Query a bounded, sortable model list.",
    get_model: "Retrieve the full evidence record for one rank.",
    compare_models: "Compare two to ten finalist ranks.",
    pareto_frontier: "Query the performance-complexity frontier.",
    select_candidates: "Create a multi-role candidate shortlist.",
    feature_context: "Trace one exact primitive feature into extraction sources.",
  },
  decisionPolicy: [
    "Use deterministic metrics and validation results as evidence.",
    "Treat interpretability scores as transparent heuristics, never proof of physical meaning.",
    "Prefer a shortlist over a single winner.",
    "Require human review of provenance, units, constraints, and extrapolation risks.",
    "Mark ambiguous feature meanings as unresolved instead of inferring them from names alone.",
  ],
};
