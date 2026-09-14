/**
 * Leakage and split-integrity checks.
 *
 * SISSO-Sage reports hold-out metrics when `verify.dat` exists, but a lower
 * hold-out RMSE is only meaningful if the hold-out samples are genuinely
 * unseen. The very common real-world failure is a `verify.dat` whose sample
 * names also appear in `train.dat` (often the *same structure at the same
 * temperature*), which silently turns "hold-out" into "in-sample".
 *
 * This module answers one question with evidence rather than opinion: do the
 * evaluation rows share samples with the rows the model was fitted on?
 *
 * It is deliberately descriptive. It never mutates the run, never drops a
 * dataset, and never edits model rankings. It reports what it found and lets
 * the researcher decide.
 */

const KEY_SEPARATORS = /[_\s|,;]+/;

/**
 * Split a raw sample name into comparison keys, strongest first.
 *
 * Names in the wild look like `14120eb0_B4Li20O64S16` (structure id + formula)
 * or `mp-1234` (a plain id). We build a small hierarchy so a caller can tell
 * "the identical row" apart from "the same chemistry" apart from "the same
 * structure family":
 *
 *   name    - the exact string
 *   id      - the part before the first separator
 *   formula - the second part, when the name has one
 */
export function sampleKeys(rawName) {
  const name = String(rawName ?? "").trim();
  if (!name) return [];
  const keys = [{ kind: "name", value: name }];
  const parts = name.split(KEY_SEPARATORS).filter(Boolean);
  if (parts.length > 1) {
    keys.push({ kind: "id", value: parts[0] });
    keys.push({ kind: "formula", value: parts[1] });
  }
  return keys;
}

function indexByKey(names, kind) {
  const index = new Map();
  names.forEach((raw, position) => {
    const key = sampleKeys(raw).find((entry) => entry.kind === kind);
    if (!key) return;
    if (!index.has(key.value)) index.set(key.value, []);
    index.get(key.value).push(position);
  });
  return index;
}

function firstFew(items, count = 5) {
  return items.slice(0, count);
}

function summarizeDataset(label, names, temperatures) {
  const distinct = new Set(names);
  const byTemperature = new Map();
  if (temperatures) {
    temperatures.forEach((value, position) => {
      if (value === null || value === undefined || value === "") return;
      const key = String(value);
      if (!byTemperature.has(key)) byTemperature.set(key, new Set());
      byTemperature.get(key).add(names[position]);
    });
  }
  return {
    label,
    rows: names.length,
    distinctSamples: distinct.size,
    repeatedRows: names.length - distinct.size,
    temperatures: [...byTemperature.keys()].sort((a, b) => Number(a) - Number(b)),
  };
}

/**
 * Compare a candidate ("held-out") row set against a reference ("fitted") row
 * set across the key hierarchy.
 */
function compareSets(candidate, reference) {
  const referenceNames = reference.names;
  const candidateNames = candidate.names;
  const referenceNameSet = new Set(referenceNames);
  const findings = [];

  // Guard against trivially "comparing" a set with itself.
  const identicalObject = referenceNames === candidateNames;

  for (const kind of ["name", "id", "formula"]) {
    const referenceIndex = indexByKey(referenceNames, kind);
    const candidateIndex = indexByKey(candidateNames, kind);
    const shared = [...candidateIndex.keys()].filter((key) => referenceIndex.has(key));
    if (!shared.length) continue;
    const candidateHits = shared.reduce((total, key) => total + candidateIndex.get(key).length, 0);
    const examples = firstFew(shared.map((key) => ({
      key,
      candidateRows: candidateIndex.get(key).length,
      referenceRows: referenceIndex.get(key).length,
    })), 5);
    findings.push({
      key: kind,
      sharedKeys: shared.length,
      candidateRowsAffected: candidateHits,
      candidateRowFraction: candidateNames.length ? candidateHits / candidateNames.length : 0,
      examples,
    });
  }

  // The strongest form: the very same observation - same sample name, same
  // target, and same condition when a condition column exists.
  const signature = (name, target, temperature) =>
    `${name}\u0000${target}\u0000${temperature === null || temperature === undefined ? "" : temperature}`;
  const referenceSignatures = new Set(referenceNames.map((name, position) =>
    signature(name, reference.targets[position], reference.temperatures[position])));
  const duplicateObservations = [];
  candidateNames.forEach((name, position) => {
    if (referenceSignatures.has(signature(name, candidate.targets[position], candidate.temperatures[position]))) {
      duplicateObservations.push(name);
    }
  });

  let verdict = "disjoint";
  if (identicalObject) verdict = "same-dataset";
  else if (duplicateObservations.length) verdict = "leaked-identical-rows";
  else if (findings.some((entry) => entry.key === "name")) verdict = "leaked-same-sample";
  else if (findings.some((entry) => entry.key === "id")) verdict = "shared-structure-ids";
  else if (findings.some((entry) => entry.key === "formula")) verdict = "shared-compositions";

  return {
    candidate: candidate.label,
    reference: reference.label,
    verdict,
    duplicateObservations: {
      count: duplicateObservations.length,
      fraction: candidateNames.length ? duplicateObservations.length / candidateNames.length : 0,
      examples: firstFew([...new Set(duplicateObservations)], 5),
    },
    findings,
  };
}

const VERDICT_NOTES = {
  "same-dataset": "The two row sets are the identical object; this is a self-comparison, not a split.",
  "leaked-identical-rows":
    "The held-out rows repeat the same sample name, target and condition as fitted rows. These rows are the SAME observation, so their hold-out metrics are in-sample and must not be reported as generalisation.",
  "leaked-same-sample":
    "The held-out rows reuse sample names that were fitted (at a different condition or target). Hold-out metrics for those samples are in-sample measurements of a known material.",
  "shared-structure-ids":
    "No repeated observations, but the held-out set reuses structure ids that were fitted (typically the same structure at other temperatures). Metrics measure interpolation on known structures, not new chemistries.",
  "shared-compositions":
    "No shared ids, but the held-out set reuses chemical compositions. Metrics partly measure interpolation within known composition families.",
  disjoint: "No shared sample name, structure id, or composition was detected.",
};

function noteFor(verdict) {
  return VERDICT_NOTES[verdict] || "Split relationship not classified.";
}

/**
 * Extract (name, target, condition) triples from raw SISSO .dat text.
 * Column 0 is the sample name, column 1 the target. The condition column, when
 * one is present, disambiguates repeated measurements of the same sample.
 *
 * We deliberately key identical-observation detection on name + target +
 * condition rather than on the whole feature row: feature columns are not
 * guaranteed to be in the same order between two files (an external verify.dat
 * or a differently filtered run can reorder them), while name, target and the
 * condition variable are stable and sufficient to identify the same observation.
 */
function rowsFromText(text, label, temperatureColumn) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  const names = [];
  const targets = [];
  const temperatures = [];
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(/\s+/);
    if (!cells.length) continue;
    names.push(cells[0]);
    targets.push(cells.length > 1 ? cells[1] : "");
    temperatures.push(temperatureColumn !== null && temperatureColumn < cells.length ? cells[temperatureColumn] : null);
  }
  return { label, names, targets, temperatures };
}

/**
 * Resolve which column is the temperature-like condition variable, so the
 * identical-row test can distinguish "same sample, same condition" (true
 * leakage) from "same sample at a different condition" (a genuine new
 * observation of a known material).
 */
function resolveTemperatureColumn(headerNames) {
  if (!Array.isArray(headerNames)) return null;
  const index = headerNames.findIndex((name) => /^temperature/i.test(String(name || "").trim()));
  return index >= 0 ? index : null;
}

export function leakageReport(analysis, options = {}) {
  const files = analysis?.discovery?.healthFiles || {};
  const trainText = files.train;
  const verifyText = options.ignoreVerify ? undefined : files.verify;

  if (!trainText) throw new Error("Train data is unavailable; cannot run a leakage check.");

  const headerNames = analysis?.result?.columns?.map((column) => column.original) || [];
  const temperatureColumn = resolveTemperatureColumn(headerNames);

  const trainRows = rowsFromText(trainText, "train", temperatureColumn);
  const trainSummary = summarizeDataset("train", trainRows.names, trainRows.temperatures);

  const multiTask = !!(analysis?.result?.meta?.tasks && analysis.result.meta.tasks.length > 1);
  const comparisons = [];

  if (verifyText) {
    const verifyRows = rowsFromText(verifyText, "verify", temperatureColumn);
    const verifySummary = summarizeDataset("verify", verifyRows.names, verifyRows.temperatures);
    const comparison = compareSets(verifyRows, trainRows);
    comparison.note = noteFor(comparison.verdict);
    comparisons.push(comparison);
    return {
      kind: "sisso-sage-leakage",
      mode: "train-vs-verify",
      conditionColumn: temperatureColumn === null ? null : headerNames[temperatureColumn],
      datasets: [trainSummary, verifySummary],
      comparisons,
      verdict: comparison.verdict,
      holdoutIsIndependent: comparison.verdict === "disjoint" || comparison.verdict === "shared-compositions" ? null : false,
      guidance: "holdoutIsIndependent=false means hold-out metrics are not out-of-sample evidence. null means no identical rows were found but the split still reuses compositions, or no verify.dat is present.",
    };
  }

  // No verify.dat: for MT-SISSO the only split-like structure is the task
  // partition, so check whether tasks share samples with each other.
  if (multiTask) {
    const tasks = analysis.result.meta.tasks;
    const taskRows = tasks.map((task, position) => {
      const start = Number.isFinite(task.start) ? task.start : 0;
      const count = Number.isFinite(task.n) ? task.n : 0;
      const rows = { label: task.key || task.label || `task_${position + 1}`, names: trainRows.names.slice(start, start + count), targets: trainRows.targets.slice(start, start + count), temperatures: trainRows.temperatures.slice(start, start + count) };
      return rows;
    });
    for (let i = 0; i < taskRows.length; i++) {
      for (let j = 0; j < taskRows.length; j++) {
        if (i === j) continue;
        const comparison = compareSets(taskRows[i], taskRows[j]);
        comparison.note = noteFor(comparison.verdict);
        comparisons.push(comparison);
      }
    }
    const anyLeak = comparisons.some((entry) => entry.verdict.startsWith("leaked"));
    return {
      kind: "sisso-sage-leakage",
      mode: "task-vs-task",
      conditionColumn: temperatureColumn === null ? null : headerNames[temperatureColumn],
      datasets: [trainSummary, ...taskRows.map((task) => summarizeDataset(task.label, task.names, task.temperatures))],
      comparisons,
      verdict: anyLeak ? "leaked-same-sample" : "disjoint",
      holdoutIsIndependent: null,
      guidance: "This run has no verify.dat (MT-SISSO). Task comparisons are reported so you can see whether a task is a genuine partition; MT-SISSO has no hold-out, so no metric in this run is out-of-sample.",
    };
  }

  return {
    kind: "sisso-sage-leakage",
    mode: "train-only",
    conditionColumn: temperatureColumn === null ? null : headerNames[temperatureColumn],
    datasets: [trainSummary],
    comparisons,
    verdict: "not-applicable",
    holdoutIsIndependent: null,
    guidance: "No verify.dat and no task partition were found, so there is no split to check. Every metric in this run is in-sample.",
  };
}
