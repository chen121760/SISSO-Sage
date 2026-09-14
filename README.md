# SISSO-Sage

**AI-ready SISSO analysis and evidence-driven model selection.**

SISSO-Sage turns a completed SISSO run into compact, structured evidence that an
AI agent can query: file discovery, validation, model records, feature
provenance, transparent interpretability evidence, Pareto analysis, hold-out
independence checks, and multi-role model shortlisting.

## Quick start

```bash
git clone https://github.com/chen121760/SISSO-Sage.git
cd SISSO-Sage
```

That is the whole setup. There is no install step.

```bash
# Validate a run and read its health, layout, and metadata coverage.
node bin/sisso-sage.mjs inspect /path/to/sisso-run

# With a hold-out set: check it is genuinely unseen, then use it to rank models.
node bin/sisso-sage.mjs leakage run.tar.gz --verify verify.dat
node bin/sisso-sage.mjs select  run.tar.gz --verify verify.dat --limit 5

# Inspect finalists and write the full evidence bundle.
node bin/sisso-sage.mjs compare run.tar.gz --ranks 1,4,12
node bin/sisso-sage.mjs bundle  run.tar.gz --output analysis.bundle.json
```

Every command prints JSON. Add `--compact` for a token-efficient single line.

## Requirements

**Node.js 18 or newer. Nothing else.**

`npm install` is only needed to run the test suite or rebuild the MCP bundle. The
CLI has no runtime dependency, and `dist/sisso-sage-mcp.mjs` is prebuilt and
self-contained, so neither users of the CLI nor users of the MCP plugin install
anything.

Input is a SISSO regression result directory, or a `.tar` / `.tar.gz` / `.tgz`
archive of one, containing:

- `train.dat`
- `SIS_subspaces/Uspace.expressions`
- a matching `Models/top*_D*` and `Models/top*_D*_coeff` pair

`verify.dat` is optional. MT-SISSO additionally needs task information from
`SISSO.in` or `SISSO.out`.

## Commands

| Command | Result |
|---|---|
| `inspect` | Files, task layout, datasets, health checks, and metadata coverage |
| `leakage` | Whether held-out rows are genuinely unseen, before you trust a hold-out metric |
| `models` | Sortable/filterable compact model records; reports truncation explicitly |
| `model` | One model's formulas, descriptors, metrics, risks, and provenance |
| `compare` | Aligned evidence for two or more ranks |
| `pareto` | Prediction metric versus descriptor-dimension Pareto front |
| `select` | Predictive, balanced, interpretable, and stable candidates |
| `bundle` | Complete versioned JSON artifact for an AI workflow |
| `metadata-template` | A provenance template covering all primitive features |
| `feature-doc` | A Markdown feature dictionary with unresolved names clearly flagged |
| `feature-context` | Exact references to one feature in the supplied extraction source tree |
| `capabilities` | Machine-readable command and decision policy description |

```bash
node bin/sisso-sage.mjs models RUN --sort verify.rmse --limit 10
node bin/sisso-sage.mjs models RUN --feature band_gap
node bin/sisso-sage.mjs pareto RUN --dataset verify --metric rmse
node bin/sisso-sage.mjs model  RUN --rank 7 --features RUN/sage.features.json
node bin/sisso-sage.mjs feature-context run.tar.gz --feature packing_fraction \
  --source-root /path/to/feature-extraction
```

### Reading `--limit`

`models --limit N` accepts any positive integer (hard cap 100000) and reports
`total`, `returned`, `limit` and `truncated`. A truncated list always says so, so
"the best model by verify RMSE" cannot be computed from a silently shortened
ranking.

## Hold-out independence

A hold-out metric is only evidence if the held-out rows are genuinely unseen.
`leakage` compares `verify.dat` against `train.dat` in three widening steps -
exact sample name, then structure id, then composition - and separately flags
rows that are the *same observation* (same sample name, target and condition),
which is unambiguous leakage.

```bash
node bin/sisso-sage.mjs leakage run.tar.gz --verify verify.dat
```

| Verdict | Meaning |
|---|---|
| `disjoint` | No overlap found. The hold-out is clean. |
| `leaked-identical-rows` | The hold-out repeats fitted rows. `holdoutIsIndependent` is `false`: report those metrics as in-sample. |
| `shared-structure-ids` | Same structure at another condition. The split measures interpolation on known structures. |
| `shared-compositions` | The split measures interpolation within known composition families. |

For MT-SISSO, which has no `verify.dat`, the check compares the task partitions
instead. This catches a run that accidentally folds held-out data into a training
task - a common and silent mistake, because two runs can look like two
independent experiments while actually sharing one split.

## AI plugin and local MCP

SISSO-Sage is also a local, read-only MCP plugin exposing focused tools for
inspection, leakage checks, model queries, comparison, Pareto analysis, candidate
selection, and feature-source tracing. Its bundled Skill tells the AI to begin
with health checks, retain multiple candidates, and avoid guessing physical
meaning from ambiguous names. All tools are read-only; analysis stays on your
computer and nothing is uploaded.

An MCP client can launch the prebuilt server directly:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/SISSO-Sage/dist/sisso-sage-mcp.mjs"]
}
```

The plugin manifest is `.codex-plugin/plugin.json`, the local server
configuration is `.mcp.json`, and the workflow is under
`skills/sisso-model-analysis/SKILL.md`.

The current package targets local/repository distribution. Publishing it in a
public plugin directory would additionally require a hosted HTTPS MCP endpoint;
that is a separate deployment mode from the privacy-preserving local server.

## Feature provenance

Run this once and fill in the generated fields, ideally from the feature
extraction code:

```bash
node bin/sisso-sage.mjs metadata-template RUN
```

Each feature can record its description, symbol, unit, category, source file and
function, and known constraints. See `examples/sage.features.example.json` and
`schemas/feature-metadata.schema.json`.

If the extraction project already contains `assb_features_feature_dictionary.csv`
and `train_dat_rename_map.csv`, pass its root once and SISSO-Sage will find and
merge them with an archived `unit_manifest.txt`:

```bash
node bin/sisso-sage.mjs inspect RUN --source-root /path/to/feature-extraction
```

The dictionary is read with these columns (common aliases such as `feature_name`,
`description`, `category` and `source_file` are also accepted):

| Column | Meaning |
|---|---|
| `feature` | Primitive feature name, matching the run's columns |
| `note` | What the feature measures |
| `unit` | Physical unit |
| `group` | Category used for grouping and reporting |
| `source` | File and function that computes it |

A dictionary whose columns cannot be used is reported as a warning rather than
being read as an empty dictionary, so a naming mistake never looks like
"no provenance supplied".

Metadata has an explicit review state. Ambiguous names stay
`needs-user-confirmation`; AI-authored definitions should use `ai-draft`; only a
researcher-reviewed entry should become `confirmed`. The original extraction
source remains part of the evidence chain and is never replaced by a plausible
guess based only on the feature name.

## Selection policy

The default shortlist uses the holdout RMSE when `verify.dat` exists, the SISSO
task aggregate for MT-SISSO, and training RMSE only as a stated fallback. It
returns several roles rather than presenting one unquestionable winner:

- predictive best;
- balanced Pareto candidate;
- most interpretable candidate on the Pareto front;
- most stable candidate — `robust` when a hold-out exists (small train/verify
  gap), or `task-consistent` for MT-SISSO (even fit across tasks, all in-sample);
- additional Pareto alternatives.

The distinction matters: for MT-SISSO every number is in-sample, so a high
task-consistency score says the model fits each task about equally well and
nothing about generalisation. `methodology.stability` states the basis, whether
external validation applies, and that caveat in the output itself.

The balanced score is fully disclosed in the JSON. Physical interpretation still
requires checking feature provenance, units, constraints, data leakage, and the
scientific domain.

Two heuristics are deliberately narrow and should not be over-read:

- A `singularity` risk is raised by the *presence of division or a negative power
  in the descriptor text*, not by inspecting data values. The scoring code cannot
  see the numbers, so a denominator that is physically or structurally bounded
  away from zero (a Kelvin temperature, or an integer count of coordination
  environments that is >= 1 by construction) is still flagged. Confirm the real
  domain in your data before rejecting a model over this flag.
- Coefficient differences between MT-SISSO tasks are the intended output of the
  method - they describe what distinguishes the task families - and are not used
  by any score here.

## Why

An AI should not infer metrics from raw SISSO text or equate a short formula with
physical truth. SISSO-Sage keeps numerical work deterministic and exposes the
result together with its limitations and provenance.

## Development

Install once, then run the tests and rebuild the bundled server after changing
the parser adapter, evidence logic, selection policy, schemas, or CLI:

```bash
npm install
npm test
npm run check:readme   # asserts this README still matches the CLI
npm run build:mcp
```

`npm run smoke` runs the CLI capability check.

The vendored parser and health checker originate from the sibling SISSO-Analyzer
project so both interfaces produce identical numerical results. After updating
that engine, refresh the vendored copy and rerun the tests:

```bash
npm run sync-engine
npm test
```

## License

SISSO-Sage is licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`.
The license permits commercial and academic use, modification, and redistribution
while retaining attribution and license notices.
