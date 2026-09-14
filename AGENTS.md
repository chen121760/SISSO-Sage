# SISSO-Sage agent instructions

When using this project to analyze a SISSO run:

1. Start with the MCP `inspect_run` tool, or `node bin/sisso-sage.mjs inspect <run-dir>` when MCP is unavailable.
2. Do not continue model selection when the health result contains an error.
3. Use `select` to obtain a shortlist, then inspect finalists with `model` or
   `compare`; do not treat the shortlist as a physical conclusion.
4. Prefer holdout metrics over training metrics when `verify.dat` is available.
5. For MT-SISSO, report both per-task behavior and SISSO's aggregate metric.
6. Read `sage.features.json` and the referenced extraction code before making
   claims about units, causal meaning, physical trends, or measurability.
7. Clearly label calculated facts, researcher-supplied metadata, and your own
   scientific inference.
8. Present multiple candidates and include evidence against each finalist.

Run `npm test` after changing the parser adapter, evidence logic, selection
policy, schemas, or command interface.
