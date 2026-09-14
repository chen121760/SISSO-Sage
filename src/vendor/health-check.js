/*
 * health-check.js — lightweight Analysis Health Check.
 *
 * Runs on the uploaded SISSO result texts BEFORE the heavy pipeline, so data /
 * parsing problems are caught with a compact Passed / Warning / Error report
 * instead of an obscure crash mid-analysis. Pure and DOM-free (UMD): the same
 * file runs in the browser and under Node for automated tests.
 *
 * Design rules:
 *  - It reuses SissoCore's parsers (readHeaderNames, parseDataFile, parseTopFile,
 *    parseCoeffFile, parseUspace, buildRenamer, compileFormula, ...) so the
 *    checks agree exactly with what the pipeline will do — normal projects are
 *    neither re-interpreted nor changed.
 *  - Only problems that would make the pipeline unable to compute are
 *    "error" (blocking). Everything else is a "warning": analysis continues and
 *    the UI shows the warning. A broken verify.dat is downgraded to train-only
 *    (dropVerify) instead of blocking the whole run.
 *  - Every executed check produces an entry, so the UI can render a simple
 *    list of Passed / Warning / Error rows with short explanations.
 *
 * Public API:
 *   check(files) -> { level: "pass"|"warning"|"error",
 *                     dropVerify: boolean,
 *                     checks: [{ id, level: "pass"|"warning"|"error", message }] }
 *   where files = { train, verify?, top, coeff, uspace, sissoIn?, sissoOut? }
 *   (raw texts). SISSO.in / SISSO.out are optional for a single-task run but are
 *   what lets a multi-task (MT-SISSO) run be split back into its tasks, so the
 *   check asks for them by name when the coefficient file shows a task layout.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./sisso-core.js"));
  } else {
    root.HealthCheck = factory(root.SissoCore);
  }
})(typeof self !== "undefined" ? self : this, function (Core) {
  "use strict";

  function newReport() {
    return { checks: [], dropVerify: false };
  }

  function add(report, level, id, message, extra) {
    var entry = { id: id, level: level, message: message };
    if (extra && extra.dropVerify) {
      entry.dropVerify = true;
      report.dropVerify = true;
    }
    report.checks.push(entry);
  }

  function addPass(report, id, message) { add(report, "pass", id, message, {}); }
  function addWarn(report, id, message, extra) { add(report, "warning", id, message, extra || {}); }
  function addErr(report, id, message) { add(report, "error", id, message, {}); }

  // Recompute the overall level from the entries (error > warning > pass).
  function finalize(report) {
    var level = "pass";
    for (var i = 0; i < report.checks.length; i++) {
      if (report.checks[i].level === "error") { level = "error"; break; }
      if (report.checks[i].level === "warning") level = "warning";
    }
    report.level = level;
    return report;
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function shortExpr(expr, max) {
    var s = String(expr).replace(/\s+/g, " ").trim();
    max = max || 48;
    if (s.length > max) s = s.slice(0, max - 1) + "…";
    return s;
  }

  function firstFew(arr, k) {
    k = k || 3;
    var out = [];
    for (var i = 0; i < arr.length && out.length < k; i++) out.push(arr[i]);
    return out;
  }

  // Attach per-column letters + original names to a parsed data file so the
  // integrity helpers never rebuild the name map.
  function attachMeta(data, nameMap) {
    data._letters = {};
    data._originals = {};
    for (var c = 1; c < nameMap.length; c++) {
      data._letters[c] = nameMap[c].new_name;
      data._originals[c] = nameMap[c].original_name;
    }
    data._nCols = nameMap.length;
  }

  // Returns the duplicate names (empty when the file is clean).
  function findDuplicateNames(data) {
    var seen = {};
    var dups = [];
    for (var i = 0; i < data.n; i++) {
      var name = data.names[i];
      if (seen[name] === undefined) {
        seen[name] = [i];
      } else {
        if (seen[name].length === 1) dups.push(name);
        seen[name].push(i);
      }
    }
    return dups;
  }

  // Returns the number of bad cells (0 when clean).
  function findBadCells(data) {
    var bad = 0;
    for (var r = 0; r < data.n; r++) {
      for (var c = 1; c < data._nCols; c++) {
        var v = data.cols[data._letters[c]][r];
        if (!Number.isFinite(v)) bad++;
      }
    }
    return bad;
  }

  function firstBadCellSamples(data, k) {
    var out = [];
    for (var r = 0; r < data.n && out.length < k; r++) {
      for (var c = 1; c < data._nCols && out.length < k; c++) {
        if (!Number.isFinite(data.cols[data._letters[c]][r])) {
          out.push('row "' + data.names[r] + '" / "' + data._originals[c] + '"');
        }
      }
    }
    return out;
  }

  function dataIntegrityChecks(data, fileLabel, report, prefix) {
    var dups = findDuplicateNames(data);
    if (dups.length) {
      addWarn(report, prefix + "-duplicates",
        fileLabel + " has duplicate sample name(s): " + firstFew(dups).join(", ") +
        (dups.length > 3 ? " …" : "") + " (rows may be ambiguous in plots).");
    } else {
      addPass(report, prefix + "-duplicates", "No duplicate sample names in " + fileLabel + ".");
    }

    var bad = findBadCells(data);
    if (bad > 0) {
      addWarn(report, prefix + "-numeric",
        fileLabel + " contains " + bad + " non-numeric / NaN / Inf value(s) (first: " +
        firstBadCellSamples(data, 3).join(", ") +
        ") — affected models may evaluate to non-finite predictions.");
    } else {
      addPass(report, prefix + "-numeric",
        "All numeric values in " + fileLabel + " are finite.");
    }
  }

  // Header / width check between train.dat and verify.dat. Because parseDataFile
  // parses verify against the train header, any difference (count, names, order)
  // silently misaligns columns — such a verify file is flagged and dropped rather
  // than blocking or corrupting the run.
  function checkVerify(verifyText, trainHeader, report) {
    var verifyHeader = Core.readHeaderNames(verifyText);
    var reason = null;

    if (verifyHeader.length !== trainHeader.length) {
      reason = "verify.dat has " + verifyHeader.length + " column(s) but train.dat has " +
        trainHeader.length + " — their feature sets do not line up.";
    } else {
      for (var i = 0; i < trainHeader.length; i++) {
        if (verifyHeader[i] !== trainHeader[i] && reason === null) {
          reason = "verify.dat columns differ from train.dat (first at column " + (i + 1) +
            ': "' + trainHeader[i] + '" vs "' + verifyHeader[i] + '").';
        }
      }
      if (reason === null) {
        var verifyData = null;
        try {
          verifyData = Core.parseDataFile(verifyText, Core.makeNameMap(trainHeader));
        } catch (err) {
          reason = "verify.dat could not be parsed: " + (err && err.message ? err.message : err);
        }
        if (reason === null) {
          attachMeta(verifyData, Core.makeNameMap(trainHeader));
          addPass(report, "verify-consistency",
            "verify.dat header matches train.dat (name + target + feature columns in the same order).");
          dataIntegrityChecks(verifyData, "verify.dat", report, "verify");
          return;
        }
      }
    }

    addWarn(report, "verify-consistency",
      reason + " verify.dat will be ignored for this analysis (train-only mode).",
      { dropVerify: true });
  }

  // top / coeff / Uspace cross-checks + descriptor probes.
  // `trainData` is the pooled train.dat (all task blocks for an MT-SISSO run).
  function checkModels(F, nameMap, report, trainData) {
    var top = Core.parseTopFile(F.top);
    var coeffs = Core.parseCoeffFile(F.coeff);

    if (top.ranks.length !== coeffs.length) {
      addErr(report, "models",
        "Row-count mismatch: " + top.ranks.length + " models in the top file but " +
        coeffs.length + " rows in the coefficient file.");
      return;
    }
    if (top.ranks.length === 0) {
      addWarn(report, "models", "The top-ranked file contains no models — nothing to analyse.");
      return;
    }

    // --- coefficient layout (single-task vs multi-task) ----------------------
    // Resolved by the SAME function the pipeline uses (non-strict here so we can
    // report every problem at once). Sharing the resolver is what guarantees the
    // health check can never green-light a file set the pipeline then refuses.
    // The health check names its inputs differently (F.sissoIn / F.sissoOut), so
    // map them onto the pipeline's keys explicitly rather than teaching the core
    // two spellings for the same thing.
    var layoutFiles = { sissoInText: F.sissoIn, sissoOutText: F.sissoOut };
    var mt = Core.resolveLayout(layoutFiles, top, coeffs, trainData, { strict: false });
    var layoutError = false;
    for (var li = 0; li < mt.issues.length; li++) {
      var issue = mt.issues[li];
      if (issue.level === "error") { addErr(report, "models", issue.message); layoutError = true; }
      else addWarn(report, "models", issue.message);
    }
    if (layoutError) return;

    // Every feature id referenced by the top models must exist in Uspace.
    var needed = new Set();
    top.featureLists.forEach(function (ids) {
      ids.forEach(function (id) { needed.add(id); });
    });

    var uspace;
    try {
      uspace = Core.parseUspace(F.uspace, Core.buildRenamer(nameMap), needed);
    } catch (err) {
      addErr(report, "models",
        "Feature-name / Uspace setup failed: " + (err && err.message ? err.message : err));
      return;
    }

    var missingIds = [];
    var present = [];
    var neededList = Array.from(needed).sort(function (a, b) { return a - b; });
    for (var i = 0; i < neededList.length; i++) {
      var fid = neededList[i];
      if (uspace.idToRenamed.has(fid)) {
        present.push({
          id: fid,
          renamed: uspace.idToRenamed.get(fid),
          orig: uspace.idToOrig.get(fid),
        });
      } else {
        missingIds.push(fid);
      }
    }
    if (missingIds.length) {
      addErr(report, "models",
        "Descriptor reference(s) " + firstFew(missingIds).join(", ") +
        (missingIds.length > 3 ? " …" : "") + " point to features missing from Uspace.expressions " +
        "(file defines " + uspace.totalFeatures + ").");
      return;
    }

    if (mt.multiTask) reportTaskSplit(F, mt, trainData, report);

    probeDescriptors(present, trainData, nameMap, report);
    if (mt.multiTask && mt.nsamples) {
      probeTaskAggregate(top, coeffs, present, mt, trainData, nameMap, report);
      probeTaskHeterogeneity(mt, trainData, nameMap, report);
    }
    addPass(report, "models",
      top.ranks.length + " model(s) read; coefficient rows match and every referenced " +
      "descriptor exists in Uspace.expressions.");
  }

  // Pass row describing the resolved multi-task split, plus the two facts a user
  // has to know about an MT-SISSO run: there is no verify.dat, and one that was
  // dropped anyway.
  function reportTaskSplit(F, mt, trainData, report) {
    addPass(report, "mt-tasks",
      "Multi-task (MT-SISSO) run: " + mt.ntask + " task(s) of " + mt.nsamples.join(" + ") +
      " = " + trainData.n + " sample(s), read from " + mt.taskSizeSource +
      " · task_weighting=" + mt.taskWeighting + ". verify.dat is not part of an MT-SISSO run, " +
      "so no hold-out metrics are expected.");
    if (F.verify !== undefined && F.verify !== null && String(F.verify).trim()) {
      addWarn(report, "mt-verify",
        "A verify.dat was loaded alongside this multi-task run, but a hold-out row carries no " +
        "task identity (only train.dat is split into tasks), so it cannot be scored and has " +
        "been ignored.");
    }
  }

  // Are the tasks plausibly the SAME property, so that the pooled ("all samples")
  // R² / ρ mean anything?
  //
  // R² and ρ are computed around the pooled mean, so between-task variance lands
  // in SS_tot: if the task targets sit far apart relative to how much they vary
  // internally, the pooled R² is inflated — it measures "can I tell the tasks
  // apart", not "does the model fit". Per-task R² / ρ are unaffected and are the
  // numbers to read. A cheap between/within spread comparison is enough to warn.
  function probeTaskHeterogeneity(mt, trainData, nameMap, report) {
    var target = nameMap[1].new_name;
    var col = trainData.cols[target];
    if (!col) return;
    var means = [], stds = [];
    for (var t = 0; t < mt.tasks.length; t++) {
      var tk = mt.tasks[t];
      var sum = 0, sum2 = 0, n = tk.n;
      for (var i = tk.start; i < tk.start + n; i++) { sum += col[i]; sum2 += col[i] * col[i]; }
      var mean = sum / n;
      means.push(mean);
      stds.push(Math.sqrt(Math.max(0, sum2 / n - mean * mean)));
    }
    var between = Math.max.apply(null, means) - Math.min.apply(null, means);
    var within = stds.reduce(function (a, v) { return a + v; }, 0) / stds.length;
    if (!(within > 0)) return;
    if (between > within) {
      addWarn(report, "mt-pooled",
        "The task targets sit further apart than they vary internally (between-task mean spread " +
        between.toPrecision(4) + " vs average within-task std " + within.toPrecision(4) +
        "), so the tasks look like different properties or scales. The pooled R² / ρ are then " +
        "inflated by the between-task spread and should not be read as a fit quality — use the " +
        "per-task R² / ρ and SISSO's task-aggregated RMSE instead.");
    } else {
      addPass(report, "mt-pooled",
        "The task targets overlap (between-task mean spread " + between.toPrecision(4) +
        " vs average within-task std " + within.toPrecision(4) +
        "), so the pooled R² / ρ remain comparable across tasks.");
    }
  }

  // Re-compute SISSO's own overall score for a few ranked models straight from
  // the coefficient blocks, and compare it with the RMSE / MaxAE columns of the
  // ranked-model file. This is the decisive check on the multi-task layout: the
  // top file's scores are the task-aggregated ones, so a misread block order (or
  // a wrong task split) shows up immediately as a mismatch.
  //
  // Two things make the verdict trustworthy rather than brittle:
  //  * the tolerance is relative (1e-5 of the value), because the ranked-model
  //    file only prints a fixed number of decimals — an absolute tolerance would
  //    be either too tight for large scores or too loose for small ones;
  //  * the two metrics are read separately. MaxAE = maxᵢ MaxAEᵢ is unambiguous in
  //    every weighting scheme, while RMSE depends on the aggregation convention.
  //    So "MaxAE matches, RMSE does not" means the aggregation convention differs
  //    (per-task numbers still fine → Warning), whereas "MaxAE also differs"
  //    means the task blocks themselves were read wrongly (→ Error).
  function probeTaskAggregate(top, coeffs, present, mt, trainData, nameMap, report) {
    var target = nameMap[1].new_name;
    var y = trainData.cols[target];
    var featureSet = {};
    for (var fi = 2; fi < nameMap.length; fi++) featureSet[nameMap[fi].new_name] = true;

    var fnById = {};
    for (var p = 0; p < present.length; p++) {
      try {
        fnById[present[p].id] = Core.compileFormula(present[p].renamed);
      } catch (err) { /* the descriptor probe already reported this */ }
    }

    var nModels = top.ranks.length;
    var probes = [0, Math.floor(nModels / 2), nModels - 1].filter(function (v, i, a) {
      return v >= 0 && v < nModels && a.indexOf(v) === i;
    });

    // Relative differences (floor 1 so a score near 0 is still compared
    // meaningfully). A misread layout is off by whole percent, not by 1e-5, so
    // this keeps full detection power while tolerating however many decimals the
    // ranked-model file happens to print.
    var worstRmse = 0, worstMaxae = 0, worstRank = null, checked = 0;
    for (var pi = 0; pi < probes.length; pi++) {
      var mi = probes[pi];
      var ids = top.featureLists[mi];
      var blocks = Core.taskCoeffBlocks(coeffs[mi], mt.ntask);
      if (!blocks || blocks[0].length !== ids.length + 1) continue;
      var perTask = [];
      var start = 0, usable = true;
      for (var t = 0; t < mt.ntask && usable; t++) {
        var n = mt.nsamples[t];
        var sse = 0, maxAbs = -Infinity;
        for (var r = start; r < start + n; r++) {
          var v = blocks[t][0];
          for (var k = 0; k < ids.length; k++) {
            var fn = fnById[ids[k]];
            if (!fn) { usable = false; break; }
            v += blocks[t][k + 1] * fn(Core.makeFeatureGetter(trainData.cols, featureSet, r));
          }
          if (!usable) break;
          var e = v - y[r];
          sse += e * e;
          if (Math.abs(e) > maxAbs) maxAbs = Math.abs(e);
        }
        if (!usable) break;
        perTask.push({ rmse: Math.sqrt(sse / n), maxae: maxAbs });
        start += n;
      }
      if (!usable || perTask.length !== mt.ntask) continue;
      var agg = Core.aggregateTaskMetrics(perTask, mt.nsamples, mt.taskWeighting);
      if (!Number.isFinite(agg.rmse)) continue;
      checked++;
      var dR = Math.abs(agg.rmse - top.rmses[mi]) / Math.max(1, Math.abs(top.rmses[mi]));
      var dM = Math.abs(agg.maxae - top.maxaes[mi]) / Math.max(1, Math.abs(top.maxaes[mi]));
      if (dR > worstRmse || dM > worstMaxae) worstRank = top.ranks[mi];
      if (dR > worstRmse) worstRmse = dR;
      if (dM > worstMaxae) worstMaxae = dM;
    }

    if (!checked) {
      addWarn(report, "mt-aggregate",
        "Could not recompute SISSO's overall RMSE for any sampled model — the per-task split " +
        "could not be verified.");
      return;
    }
    var FLOOR = 1e-5; // matches tol() at |value| <= 1
    if (worstRmse <= FLOOR && worstMaxae <= FLOOR) {
      addPass(report, "mt-aggregate",
        "Task aggregation verified on " + checked + " sampled model(s): the recomputed overall " +
        "RMSE / MaxAE reproduce the ranked-model file to " +
        Math.max(worstRmse, worstMaxae).toExponential(1) + " (relative; task_weighting=" +
        mt.taskWeighting + ").");
      return;
    }
    var where = worstRank !== null ? " (e.g. model " + worstRank + ")" : "";
    if (worstMaxae <= FLOOR) {
      // MaxAE = maxᵢ MaxAEᵢ is weighting-independent, so the task blocks were read
      // correctly; only the RMSE aggregation convention disagrees.
      addWarn(report, "mt-aggregate",
        "The task blocks read correctly — recomputed MaxAE = maxᵢ MaxAEᵢ matches the ranked-model " +
        "file" + where + " — but the recomputed overall RMSE differs by " +
        worstRmse.toExponential(2) + " (relative). SISSO's aggregation convention for " +
        "task_weighting=" + mt.taskWeighting + " therefore differs from the documented one " +
        "(sqrt(Σ wᵢ·RMSEᵢ²)); the per-task metrics below are unaffected and correct.");
      return;
    }
    addErr(report, "mt-aggregate",
      "The recomputed overall RMSE and MaxAE do not reproduce the ranked-model file (relative " +
      "differences " + worstRmse.toExponential(2) + " / " + worstMaxae.toExponential(2) + where +
      "). MaxAE is weighting-independent, so this points at the task split or the coefficient " +
      "block order rather than at the aggregation formula — the per-task metrics would be " +
      "misattributed. Check that SISSO.in's nsample list and the coefficient file belong to " +
      "this run.");
  }

  // Compile each needed descriptor and evaluate it over the train samples to
  // spot divide-by-zero / log / sqrt / overflow hazards (the same arithmetic the
  // pipeline uses, but per-feature and before model assembly).
  function probeDescriptors(present, trainData, nameMap, report) {
    if (!trainData || !present.length) return;
    var featureSet = {};
    for (var i = 2; i < nameMap.length; i++) featureSet[nameMap[i].new_name] = true;

    var offending = [];
    for (var p = 0; p < present.length; p++) {
      var e = present[p];
      var fn;
      try {
        fn = Core.compileFormula(e.renamed);
      } catch (err) {
        addWarn(report, "descriptors",
          'Descriptor #' + e.id + ' "' + shortExpr(e.orig) + '" is not a valid expression (' +
          (err && err.message ? err.message : "syntax error") + ").");
        continue;
      }
      var bad = 0;
      for (var r = 0; r < trainData.n; r++) {
        var v;
        try {
          v = fn(Core.makeFeatureGetter(trainData.cols, featureSet, r));
        } catch (err2) {
          v = NaN;
        }
        if (!Number.isFinite(v)) bad++;
      }
      if (bad > 0) {
        offending.push({ id: e.id, expr: e.orig, bad: bad, rows: trainData.n });
      }
    }

    if (offending.length) {
      var parts = firstFew(offending, 3).map(function (o) {
        return '#' + o.id + ' "' + shortExpr(o.expr) + '" (' + o.bad + "/" + o.rows + " rows)";
      });
      addWarn(report, "descriptors",
        offending.length + " descriptor(s) produce non-finite values on some train samples — " +
        "possible division by zero or log/sqrt outside their domain: " + parts.join("; ") +
        (offending.length > 3 ? "; …" : "") + ".");
    } else {
      addPass(report, "descriptors",
        "All " + present.length + " referenced descriptor(s) compiled and stay finite on the train samples.");
    }
  }

  // ---------------------------------------------------------------------------
  // Main entry
  // ---------------------------------------------------------------------------

  function check(files) {
    var report = newReport();
    var F = files || {};

    var required = [
      { key: "train", label: "train.dat" },
      { key: "uspace", label: "Uspace.expressions" },
      { key: "coeff", label: "coefficient file" },
      { key: "top", label: "top-ranked file" },
    ];
    var missing = [];
    for (var qi = 0; qi < required.length; qi++) {
      var text = F[required[qi].key];
      if (typeof text !== "string" || !text.trim()) missing.push(required[qi].label);
    }
    if (missing.length) {
      addErr(report, "required",
        "Missing required file(s): " + missing.join(", ") + " — analysis cannot run.");
      return finalize(report);
    }

    // --- train.dat structure -------------------------------------------------
    var headerNames = Core.readHeaderNames(F.train);
    if (headerNames.length < 3) {
      addErr(report, "train-columns",
        "train.dat header has only " + headerNames.length +
        " column(s); expected at least name + target + 1 feature.");
      return finalize(report);
    }
    var nameMap = Core.makeNameMap(headerNames);
    var trainData;
    try {
      trainData = Core.parseDataFile(F.train, nameMap);
    } catch (err) {
      addErr(report, "train-rows",
        "train.dat could not be parsed: " + (err && err.message ? err.message : err));
      return finalize(report);
    }
    attachMeta(trainData, nameMap);
    addPass(report, "train-parse",
      "train.dat parsed: " + trainData.n + " sample(s) × " + nameMap.length + " column(s).");

    // --- train integrity -----------------------------------------------------
    dataIntegrityChecks(trainData, "train.dat", report, "train");

    // --- verify.dat consistency (only when a verify file was uploaded) -------
    if (F.verify !== undefined && F.verify !== null && String(F.verify).trim()) {
      checkVerify(F.verify, headerNames, report);
    }

    // --- top / coeff / uspace consistency -----------------------------------
    checkModels(F, nameMap, report, trainData);

    return finalize(report);
  }

  return { check: check };
});
