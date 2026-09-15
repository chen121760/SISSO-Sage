# AI usage protocol

SISSO-Sage gives an AI compact, deterministic evidence about a SISSO run. It
does not authorize the AI to declare a formula physically meaningful from its
shape alone.

Prefer query commands over loading a complete bundle into the context window.
A bundle with 1,000 models is an archival interchange artifact and can be
several megabytes even in compact JSON.

Recommended sequence (MCP tool first, equivalent CLI command in parentheses):

1. Call `inspect_run` (`inspect`) and stop if validation reports an error.
2. Read `select_candidates` (`select`) as an objective-evidence shortlist, not a
   final verdict. Candidate generation uses raw predictive evidence, a declared
   near-optimal envelope, and Pareto rank; it does not use an interpretability
   score.
3. Use `get_model` or `compare_models` (`model` or `compare`) for the shortlisted ranks.
4. Trace every primitive feature through `sage.features.json` and the referenced
   feature-extraction source, using `feature_context` when source code is available.
   If a name remains ambiguous, mark it `needs-user-confirmation`; never infer a
   physical definition from the identifier alone. An AI-authored explanation
   must be marked `ai-draft` until the researcher confirms it.
5. Read `formulaEvidence.domain.observed` as a check on sampled rows only. A
   division, log, square root, or exponential creates a constraint to inspect,
   not an automatic penalty. Separately check the intended deployment domain.
6. Assess each finalist using the supplied semantic-review dimensions and the
   categorical judgments `supported`, `mixed`, `concern`, `unresolved`, or
   `not-assessable`. Report at least one reason for and one reason against every
   finalist; do not invent a 0-100 elegance score.
7. Clearly separate calculated evidence, metadata supplied by the researcher,
   and the AI's scientific inference.

`formulaEvidence` deliberately keeps four things separate:

- reproducible syntactic structure;
- observed-domain checks and unresolved deployment-domain requirements;
- provenance confidence, including `reviewStatus`;
- semantic assessment, which remains `not-assessed` until an LLM-guided
  researcher review cites evidence and counterevidence.

None of these is compressed into a scalar interpretability or elegance score.
