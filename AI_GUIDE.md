# AI usage protocol

SISSO-Sage gives an AI compact, deterministic evidence about a SISSO run. It
does not authorize the AI to declare a formula physically meaningful from its
shape alone.

Prefer query commands over loading a complete bundle into the context window.
A bundle with 1,000 models is an archival interchange artifact and can be
several megabytes even in compact JSON.

Recommended sequence (MCP tool first, equivalent CLI command in parentheses):

1. Call `inspect_run` (`inspect`) and stop if validation reports an error.
2. Read `select_candidates` (`select`) as a shortlist, not a final verdict.
3. Use `get_model` or `compare_models` (`model` or `compare`) for the shortlisted ranks.
4. Trace every primitive feature through `sage.features.json` and the referenced
   feature-extraction source, using `feature_context` when source code is available.
   If a name remains ambiguous, mark it `needs-user-confirmation`; never infer a
   physical definition from the identifier alone. An AI-authored explanation
   must be marked `ai-draft` until the researcher confirms it.
5. Check units, valid domains, leakage, symmetry, expected trends, and whether
   the validation data represent the intended deployment domain.
6. Report at least one reason for and one reason against every finalist.
7. Clearly separate calculated evidence, metadata supplied by the researcher,
   and the AI's scientific inference.

The `interpretabilityEvidence.score` is deliberately transparent. It combines
formula simplicity, detectable numerical-domain risks, and feature-provenance
coverage. It is not a physical-law score.
