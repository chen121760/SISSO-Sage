# Changelog

## 0.3.0

Fixes and additions driven by using the toolkit on real SISSO runs. Nothing here
changes the numerical engine; the vendored parser and health checker are
untouched.

### Added

- **`leakage` command / `check_leakage` MCP tool / `leakageReport()`.**
  Reports whether held-out rows are genuinely unseen before a hold-out metric is
  trusted. Compares `verify.dat` against `train.dat` by exact sample name, then
  structure id, then composition, and separately flags rows that are the *same
  observation* (same sample name, target and condition) - unambiguous leakage.
  For MT-SISSO, which has no `verify.dat`, it compares the task partitions
  instead, which is how a run that folds held-out data into a training task is
  caught. `verdict: disjoint` means no overlap was found; `leaked-identical-rows`
  sets `holdoutIsIndependent: false`. Read-only and descriptive: it never mutates
  the run, drops a dataset, or edits rankings.

- `methodology.stability` in `select` output, stating whether the stability score
  is a train/verify gap or in-sample task consistency, and whether external
  validation applies.

- `expectedDictionaryColumns` and `dictionaryProblem` in feature-metadata output.

### Fixed

- **`models --limit` silently truncated at 100.** Asking for every model returned
  100 rows with no indication, which corrupts any rank computed over the list
  (for example "the best model by verify RMSE"). The cap is now 100000, and every
  response carries `total`, `returned`, `limit` and `truncated`.

- **A feature dictionary with unrecognised column names imported nothing, in
  silence.** It looked identical to supplying no dictionary at all. The column
  names are now validated and reported with the offending and expected headers.
  Common aliases (`feature_name`, `description`, `category`, `source_file`) are
  also accepted by the import loop, which previously disagreed with the
  documented aliases about what was readable.

- **Passing a CSV to `--features` produced an opaque JSON syntax error.** It now
  names the file and points at `--feature-dictionary` / `--source-root`.

- `--features` and `--feature-dictionary` are documented separately in `--help`,
  including the columns each expects.

### Changed

- The MT-SISSO stability role is reported as `task-consistent` instead of
  `robust` when no hold-out exists. No score or ranking changes; only the label,
  so a high task-consistency score is not mistaken for external validation.
- `capabilities` documents the dictionary columns, the new command, and two
  explicit decision-policy clarifications: a singularity risk is a textual
  heuristic that must be confirmed against the real data domain, and per-task
  coefficient differences are MT-SISSO's intended output rather than a defect.
- README documents hold-out independence, `--limit` semantics, the dictionary
  columns, and the limits of the singularity and coefficient heuristics.

### Tests

12 tests, up from 7. New coverage for `--limit` pagination and truncation
reporting, all four leakage verdicts, malformed dictionary columns, and the
`--features` CSV error.
