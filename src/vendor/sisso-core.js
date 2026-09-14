/*
 * sisso-core.js — pure computation engine for SISSO result analysis.
 *
 * A faithful JavaScript port of the logic in sisso_post.py, with three
 * additions: (1) Spearman's rho, (2) MAE next to the RMSE / MaxAE pair, and
 * (3) a safe recursive-descent formula evaluator that replaces Python's eval().
 *
 * It is environment-agnostic (UMD) so the same code runs in the browser and
 * under Node.js for automated testing against SISSO's own numbers.
 *
 * Public API:
 *   makeNameMap(headerNames) -> [{original_name, new_name, char_len}, ...]
 *   parseTopFile(text)        -> {ranks, rmses, maxaes, featureLists}
 *   parseCoeffFile(text)      -> number[][]
 *   runPipeline(files)        -> full analysis result (see below)
 *   …plus the usage/matching helpers used by the Units view (featureUsage,
 *   descriptorUsage, modelsWithFeature / modelsWithDescriptor, and the batch
 *   favourite/exclude writers batchSetModelStates / undoBatchModels).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SissoCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  var FUNCS = {
    log: Math.log,
    exp: Math.exp,
    sqrt: Math.sqrt,
    abs: Math.abs,
    cbrt: Math.cbrt,
  };

  function letterSeries(n) {
    var a = "abcdefghijklmnopqrstuvwxyz";
    if (n <= 26) return a.slice(0, n).split("");
    if (n > 702) {
      throw new Error("More than 702 columns are not supported by the letter scheme (a..zz).");
    }
    var out = a.split("");
    for (var i = 0; i < 26; i++) {
      for (var j = 0; j < 26; j++) {
        out.push(a[i] + a[j]);
        if (out.length >= n) return out;
      }
    }
    return out;
  }

  function readHeaderNames(text) {
    var first = text.split(/\r?\n/, 1)[0] || "";
    return first.trim().split(/\s+/);
  }

  function makeNameMap(names) {
    var letters = letterSeries(names.length);
    return names.map(function (n, i) {
      return { original_name: n, new_name: letters[i], char_len: n.length };
    });
  }

  // ---------------------------------------------------------------------------
  // Feature renamer — single compiled alternation, longest name first, with
  // identifier boundaries. Identical semantics to the Python FeatureRenamer.
  // ---------------------------------------------------------------------------

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildRenamer(nameMap) {
    var ordered = nameMap.slice().sort(function (a, b) {
      return b.char_len - a.char_len; // longest first
    });
    for (var i = 0; i < ordered.length; i++) {
      if (!/^[A-Za-z0-9_]+$/.test(ordered[i].original_name)) {
        throw new Error(
          "Feature name '" + ordered[i].original_name +
          "' is not a plain [A-Za-z0-9_]+ token."
        );
      }
    }
    var lookup = {};
    ordered.forEach(function (r) {
      lookup[r.original_name] = r.new_name;
    });
    var alternation = ordered
      .map(function (r) { return escapeRegExp(r.original_name); })
      .join("|");
    var pattern = new RegExp(
      "(?<![A-Za-z0-9_])(?:" + alternation + ")(?![A-Za-z0-9_])", "g"
    );
    return function rename(expr) {
      return expr.replace(pattern, function (m) { return lookup[m]; });
    };
  }

  // ---------------------------------------------------------------------------
  // Parser of SISSO output files
  // ---------------------------------------------------------------------------

  function parseTopFile(text) {
    var lines = text.split(/\r?\n/);
    var ranks = [], rmses = [], maxaes = [], featureLists = [];
    for (var i = 1; i < lines.length; i++) { // skip header
      var line = lines[i];
      if (!line || !line.trim()) continue;
      var parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      var rank = parseInt(parts[0], 10);
      var rmse = parseFloat(parts[1]);
      var maxae = parseFloat(parts[2]);
      var modelExpr = parts.slice(3).join(" ");
      var ids;
      var m = modelExpr.match(/\(\s*(.*?)\s*\)/);
      if (m) {
        ids = (m[1].match(/\d+/g) || []).map(Number);
      } else {
        ids = (modelExpr.match(/\d+/g) || []).map(Number);
        if (ids.length && ids[0] === rank) ids.shift();
      }
      ranks.push(rank);
      rmses.push(rmse);
      maxaes.push(maxae);
      featureLists.push(ids);
    }
    return { ranks: ranks, rmses: rmses, maxaes: maxaes, featureLists: featureLists };
  }

  // Coefficient rows, one per ranked model: the leading model index is dropped
  // and the remaining numbers are returned in file order.
  //
  // SISSO writes a single header line before the rows, but the exact spelling
  // changed between versions ("Model_ID c0 c1 …" for regression, and
  // "Model_ID, [(c_i,i=0,n)_j,j=1,ntask]" for multi-task) — so instead of
  // blindly skipping line 1 we skip every leading line that does not start with
  // an integer, which is exactly the shape of a data row in both layouts.
  function parseCoeffFile(text) {
    var lines = text.split(/\r?\n/);
    var coeffs = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.trim()) continue;
      var trimmed = line.trim();
      if (!/^\d+(\s|$)/.test(trimmed)) continue; // header / footer text
      var parts = trimmed.split(/\s+/);
      coeffs.push(parts.slice(1).map(Number)); // skip model index
    }
    return coeffs;
  }

  // ---------------------------------------------------------------------------
  // Run-settings and multi-task (MT-SISSO) parsing
  //
  // MT-SISSO (SISSO 3.5 with ntask > 1) reuses the single-task file names but
  // changes two things that matter for analysis:
  //   1. train.dat holds one header followed by the task blocks stacked
  //      vertically, in the order of SISSO.in's nsample=n1,n2,… list;
  //   2. the *_coeff file stores, per model row, ntask consecutive coefficient
  //      blocks of [c0, c1 … cn] — one block per task — while the descriptor set
  //      (the Uspace feature ids) is shared by every task.
  // Everything below is pure parsing so the browser and the Node tests agree.
  // ---------------------------------------------------------------------------

  // "key = value" pairs of a SISSO.in file without Fortran-style comments.
  function sissoInEntries(text) {
    var out = [];
    var lines = String(text == null ? "" : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cut = line.length;
      var b1 = line.indexOf("!");
      var b2 = line.indexOf("#");
      if (b1 >= 0 && b1 < cut) cut = b1;
      if (b2 >= 0 && b2 < cut) cut = b2;
      var core = line.slice(0, cut).trim();
      if (!core) continue;
      var eq = core.indexOf("=");
      if (eq < 1) continue;
      out.push({
        key: core.slice(0, eq).trim().toLowerCase().replace(/^[^a-z0-9]+/, ""),
        value: core.slice(eq + 1).trim(),
      });
    }
    return out;
  }

  // Numbers inside a value, tolerating Fortran exponents (1.0d-3), comma lists
  // ("42,33,28") and the parentheses used by the classification syntax.
  function numberOfList(value) {
    return (String(value).match(/[+-]?\d+(?:\.\d+)?(?:[de][+-]?\d+)?/gi) || [])
      .map(function (s) { return parseFloat(s.replace(/[de]/i, "e")); });
  }

  // SISSO.in settings used by the analyzer. `nsample` keeps its historical
  // meaning (the first number) while `nsamples` exposes the whole list, which is
  // what a multi-task run needs to slice train.dat into task blocks.
  function parseSissoIn(text) {
    var out = {
      nsample: null, nsamples: null, ntask: null, taskWeighting: null, scmt: null,
      nsf: null, descDim: null, fcomplexity: null, ptype: null,
    };
    var entries = sissoInEntries(text);
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i].key;
      var val = entries[i].value;
      // scmt carries no number, so it is handled before the numeric guard.
      if (key === "scmt" || key === "sign_constrained_mtl" || key === "sign_constrained") {
        out.scmt = /\.true\./i.test(val) || /^true$/i.test(val) || /^1$/.test(val);
        continue;
      }
      var nums = numberOfList(val);
      if (!nums.length) continue;
      // SISSO renamed its keywords over versions, so accept the common aliases.
      switch (key) {
        case "nsample": case "n_sample": case "nsamples": case "nsets":
          out.nsample = nums[0];
          out.nsamples = nums.slice();
          break;
        case "ntask": case "n_task": case "ntasks":
          out.ntask = nums[0];
          break;
        case "task_weighting": case "taskweighting":
          out.taskWeighting = nums[0];
          break;
        case "nsf": case "n_features": case "nsf_":
          out.nsf = nums[0]; break;
        case "desc_dim": case "dimension": case "descriptor_dim":
          out.descDim = nums[0]; break;
        case "fcomplexity": case "maxcomplexity": case "complexity": case "n_rung":
          out.fcomplexity = nums[0]; break;
        case "ptype":
          out.ptype = nums[0]; break;
      }
    }
    if (out.ntask === null && out.nsamples) out.ntask = out.nsamples.length;
    if (out.ntask !== null && out.ntask <= 1) out.ntask = 1;
    return out;
  }

  // The multi-task bookkeeping SISSO.out prints near the top: task count, the
  // per-task sample counts, the weighting scheme and the target standard
  // deviation of every task. Returns null when the file carries no task info.
  function parseSissoOutTasks(text) {
    var src = String(text == null ? "" : text);
    if (!src) return null;
    var out = { ntask: null, nsamples: null, taskWeighting: null, scmt: null, taskStd: [] };
    var m = src.match(/Number of tasks:\s*([0-9]+)/i);
    if (m) out.ntask = parseInt(m[1], 10);
    m = src.match(/Number of samples for the task(?:\(s\))?:\s*([0-9 \t,]+)/i);
    if (m) out.nsamples = numberOfList(m[1]).map(function (v) { return Math.round(v); });
    m = src.match(/Task_weighting:\s*([0-9]+)/i);
    if (m) out.taskWeighting = parseInt(m[1], 10);
    m = src.match(/Sign-constrained multi-task learning:\s*([TF])/i);
    if (m) out.scmt = m[1].toUpperCase() === "T";
    var re = /Standard Deviation[^\n]*?task\s*([0-9]+)\s*:\s*([0-9eEdD+\-.]+)/g;
    var mm;
    while ((mm = re.exec(src)) !== null) {
      out.taskStd[parseInt(mm[1], 10) - 1] = parseFloat(mm[2].replace(/[dD]/, "e"));
    }
    if (out.ntask === null && out.nsamples) out.ntask = out.nsamples.length;
    if (out.ntask === null && !out.taskStd.length) return null;
    return out;
  }

  // Split one coefficient row into ntask blocks of [c0, c1 … cn]. Returns null
  // when the row length is not a whole multiple of the task count.
  function taskCoeffBlocks(row, ntask) {
    if (!row || !(ntask > 0) || row.length % ntask !== 0) return null;
    var per = row.length / ntask;
    if (per < 2) return null;
    var out = [];
    for (var t = 0; t < ntask; t++) out.push(row.slice(t * per, (t + 1) * per));
    return out;
  }

  // A contiguous row slice of a parsed dataset (used for the task blocks of a
  // stacked train.dat).
  //
  // Contract: the returned column arrays are SUBARRAY VIEWS onto the parent's
  // buffers, not copies — cheap, and safe only because every consumer reads.
  // Writing into a slice would silently corrupt the pooled dataset and every
  // other slice, so any future code that wants to mutate a column must call
  // .slice() on it first.
  function sliceDataset(data, start, n) {
    if (!data) return null;
    var cols = {};
    Object.keys(data.cols).forEach(function (k) {
      cols[k] = data.cols[k].subarray(start, start + n);
    });
    return {
      n: n,
      names: data.names.slice(start, start + n),
      cols: cols,
      featureLetters: data.featureLetters,
      start: start,
    };
  }

  // Rebuild SISSO's own overall score of a multi-task model from its per-task
  // metrics. SISSO.out documents the convention:
  //   task_weighting = 1 -> RMSE = sqrt(sum_i RMSE_i^2 / ntask)  (every task counts the same)
  //   task_weighting = 2 -> RMSE = sqrt(sum_i w_i * RMSE_i^2) with w_i = n_i / sum(n),
  //                         which is exactly the RMSE pooled over all samples.
  //   MaxAE is max_i MaxAE_i in both schemes.
  //
  // The weighting=1 form is verified against the shipped MT-SISSO run: all 1000
  // ranked models reproduce the RMSE / MaxAE SISSO itself wrote (see
  // test/mt_sisso.test.mjs). The weighting=2 form is derived from the weighting
  // SISSO documents rather than observed — no weighting=2 run was available — so
  // the health check's mt-aggregate probe re-derives it at runtime and says so if
  // the two disagree. MaxAE is weighting-independent, which is what lets that
  // probe tell a wrong aggregation *convention* apart from a wrongly read task
  // *split*.
  function aggregateTaskMetrics(taskMetrics, nsamples, taskWeighting) {
    var n = taskMetrics ? taskMetrics.length : 0;
    if (!n) return { rmse: NaN, maxae: NaN };
    var weighted = taskWeighting === 2 && nsamples && nsamples.length === n;
    var total = 0, i;
    if (weighted) {
      for (i = 0; i < n; i++) total += nsamples[i];
    }
    var acc = 0, maxae = -Infinity;
    for (i = 0; i < n; i++) {
      var w = 1 / n;
      if (weighted && total > 0) w = nsamples[i] / total;
      var r = taskMetrics[i] ? taskMetrics[i].rmse : NaN;
      if (!Number.isFinite(r)) return { rmse: NaN, maxae: NaN };
      acc += w * r * r;
      var mx = taskMetrics[i].maxae;
      if (Number.isFinite(mx) && mx > maxae) maxae = mx;
    }
    return { rmse: Math.sqrt(acc), maxae: maxae };
  }

  // Scan Uspace.expressions and keep only the lines whose feature id is in
  // `neededIds` (a Set). Id == physical line number, matching the Python
  // build_feature_csv indexing.
  function parseUspace(text, renamer, neededIds) {
    var lines = text.split(/\r?\n/);
    var idToRenamed = new Map();
    var idToOrig = new Map();
    var totalFeatures = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      var id = i + 1;
      totalFeatures++;
      if (!neededIds.has(id)) continue;
      var idx = line.indexOf("SIS_score");
      var expr = (idx >= 0 ? line.slice(0, idx) : line).trim();
      idToOrig.set(id, expr);
      idToRenamed.set(id, renamer(expr));
    }
    return { idToRenamed: idToRenamed, idToOrig: idToOrig, totalFeatures: totalFeatures };
  }

  // ---------------------------------------------------------------------------
  // Formula evaluator (recursive descent; no eval)
  // ---------------------------------------------------------------------------

  function tokenize(src) {
    var re = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z][A-Za-z0-9]*|[()+\-*/^]/g;
    var toks = [];
    var m;
    while ((m = re.exec(src))) {
      if (/^\s+$/.test(m[0])) continue;
      toks.push(m[0]);
    }
    return toks;
  }

  function isNumberToken(t) {
    return t !== undefined && /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t);
  }
  function isIdentToken(t) {
    return t !== undefined && /^[A-Za-z][A-Za-z0-9]*$/.test(t);
  }

  // compileFormula(src) -> (get) => number, where get(letter) returns the value
  // of a variable. The parser builds an AST and evaluates it, so there is no
  // eval() and no closure-scoping surprises.
  function compileFormula(src) {
    var toks = tokenize(src);
    var p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function expect(t) {
      var v = next();
      if (v !== t) throw new Error("expected '" + t + "' but got '" + v + "'");
      return v;
    }

    function parseExpr() {
      var left = parseTerm();
      while (peek() === "+" || peek() === "-") {
        var op = next();
        var right = parseTerm();
        left = { type: "bin", op: op, left: left, right: right };
      }
      return left;
    }
    function parseTerm() {
      var left = parseUnary();
      while (peek() === "*" || peek() === "/") {
        var op = next();
        var right = parseUnary();
        left = { type: "bin", op: op, left: left, right: right };
      }
      return left;
    }
    function parseUnary() {
      if (peek() === "-") { next(); return { type: "unary", op: "-", arg: parseUnary() }; }
      if (peek() === "+") { next(); return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      var base = parseAtom();
      if (peek() === "^") {
        next();
        return { type: "pow", base: base, exp: parseUnary() };
      }
      return base;
    }
    function parseAtom() {
      var t = next();
      if (t === undefined) throw new Error("unexpected end of formula");
      if (t === "(") { var e = parseExpr(); expect(")"); return e; }
      if (isNumberToken(t)) return { type: "num", value: parseFloat(t) };
      if (isIdentToken(t)) {
        if (peek() === "(") {
          var fn = FUNCS[t];
          if (!fn) throw new Error("unknown function '" + t + "'");
          next(); // consume '('
          var arg = parseExpr();
          expect(")");
          return { type: "call", fn: fn, arg: arg };
        }
        return { type: "var", name: t };
      }
      throw new Error("unexpected token '" + t + "'");
    }

    var root = parseExpr();
    if (p < toks.length) throw new Error("trailing tokens after expression");

    function evalNode(node, get) {
      switch (node.type) {
        case "num": return node.value;
        case "var": return get(node.name);
        case "unary": return -evalNode(node.arg, get);
        case "bin":
          var l = evalNode(node.left, get);
          var r = evalNode(node.right, get);
          if (node.op === "+") return l + r;
          if (node.op === "-") return l - r;
          if (node.op === "*") return l * r;
          return l / r;
        case "pow": return Math.pow(evalNode(node.base, get), evalNode(node.exp, get));
        case "call": return node.fn(evalNode(node.arg, get));
        default: throw new Error("unknown AST node " + node.type);
      }
    }

    return function (get) { return evalNode(root, get); };
  }

  // ---------------------------------------------------------------------------
  // Formula text exporters — Plain / LaTeX / Microsoft Office UnicodeMath.
  //
  // SISSO stores model formulas as ASCII text, e.g.
  //   "(-7.042753903) + (0.1613175959)*((f_138))"
  //   "c0 + c1*sqrt((x1+x2)/x3) + c2*x1^2/x4 - abs(log(x5))"
  // These helpers parse such a string ONCE into a shared expression AST and
  // render the same AST to each target format, so precedence/parenthesisation
  // live in one place instead of per-format string replacement. Feature /
  // variable names are preserved verbatim.
  //
  // Public API:
  //   formulaAst(text)         -> AST (throws on unparsable input)
  //   formulaToPlain(text)     -> canonical ASCII (the evaluator's dialect)
  //   formulaToLatex(text)     -> LaTeX math fragment
  //   formulaToUnicodeMath(text)-> Office UnicodeMath linear format (Word /
  //                                PowerPoint equation, paste into Alt+= box)
  // ---------------------------------------------------------------------------

  var FORMULA_NUM_RE = /(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))(?:[eE][+-]?[0-9]+)?/y;
  var FORMULA_IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
  var FORMULA_SKIP_RE = /\s+/y;
  var FORMULA_OPERATORS = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 4 };
  var FORMULA_UNARY_PREC = 3; // unary minus: tighter than */, looser than ^
  var FORMULA_ATOM_PREC = 5;

  function formulaTokens(text) {
    var toks = [];
    var src = String(text == null ? "" : text);
    var i = 0, n = src.length;
    while (i < n) {
      FORMULA_SKIP_RE.lastIndex = i;
      var wm = FORMULA_SKIP_RE.exec(src);
      if (wm && wm.index === i) { i = wm.index + wm[0].length; continue; }
      var c = src[i];
      if (c === "(") { toks.push({ t: "(", raw: "(" }); i++; continue; }
      if (c === ")") { toks.push({ t: ")", raw: ")" }); i++; continue; }
      if (c === ",") { toks.push({ t: ",", raw: "," }); i++; continue; }
      if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^") {
        toks.push({ t: "op", op: c, raw: c }); i++; continue;
      }
      if (/[0-9.]/.test(c)) {
        FORMULA_NUM_RE.lastIndex = i;
        var nm = FORMULA_NUM_RE.exec(src);
        if (nm && nm.index === i) {
          toks.push({ t: "num", v: parseFloat(nm[0]), raw: nm[0] });
          i = nm.index + nm[0].length;
          continue;
        }
      }
      if (/[A-Za-z_]/.test(c)) {
        FORMULA_IDENT_RE.lastIndex = i;
        var im = FORMULA_IDENT_RE.exec(src);
        if (im && im.index === i) {
          toks.push({ t: "ident", name: im[0], raw: im[0] });
          i = im.index + im[0].length;
          continue;
        }
      }
      throw new Error("formula: unexpected character '" + c + "' at position " + i);
    }
    return toks;
  }

  // Parse formula text into the shared AST.
  //   node kinds:
  //     { k: "num", v }        number
  //     { k: "var", name }     variable / feature name
  //     { k: "neg", a }        unary minus
  //     { k: "op", op, a, b }  binary + - * / ^
  //     { k: "call", name, args:[..] }  function call (sqrt, log, exp, abs, …)
  function formulaAst(text) {
    var toks = formulaTokens(text);
    var p = 0;
    function cur() { return toks[p]; }
    function peekOp() { var t = cur(); return t && t.t === "op" ? t.op : null; }
    function next() { return toks[p++]; }
    function expect(t) {
      var x = next();
      if (!x || x.t !== t) throw new Error("formula: expected '" + t + "'");
      return x;
    }
    function parseAdd() {
      var l = parseMul();
      var o;
      while ((o = peekOp()) === "+" || o === "-") { next(); l = { k: "op", op: o, a: l, b: parseMul() }; }
      return l;
    }
    function parseMul() {
      var l = parseUnary();
      var o;
      while ((o = peekOp()) === "*" || o === "/") { next(); l = { k: "op", op: o, a: l, b: parseUnary() }; }
      return l;
    }
    function parseUnary() {
      var o = peekOp();
      if (o === "-" || o === "+") {
        next();
        var a = parseUnary();
        return o === "-" ? { k: "neg", a: a } : a;
      }
      return parsePower();
    }
    function parsePower() {
      var l = parsePrimary();
      if (peekOp() === "^") {
        next();
        return { k: "op", op: "^", a: l, b: parseUnary() };
      }
      return l;
    }
    function parseArgs(fnName) {
      var args = [];
      var t = cur();
      if (t && t.t === ")") { next(); return args; }
      args.push(parseAdd());
      while (cur() && cur().t === ",") { next(); args.push(parseAdd()); }
      expect(")");
      return args;
    }
    function parsePrimary() {
      var t = next();
      if (!t) throw new Error("formula: unexpected end of expression");
      if (t.t === "num") return { k: "num", v: t.v };
      if (t.t === "ident") {
        if (cur() && cur().t === "(") {
          next();
          return { k: "call", name: t.name, args: parseArgs(t.name) };
        }
        return { k: "var", name: t.name };
      }
      if (t.t === "(") {
        var e = parseAdd();
        expect(")");
        return e;
      }
      throw new Error("formula: unexpected token '" + (t.raw != null ? t.raw : t.t) + "'");
    }
    var root = parseAdd();
    if (p < toks.length) throw new Error("formula: trailing tokens after expression");
    return root;
  }

  function formulaNodePrec(node) {
    if (!node) return FORMULA_ATOM_PREC;
    if (node.k === "op") return FORMULA_OPERATORS[node.op] != null ? FORMULA_OPERATORS[node.op] : FORMULA_ATOM_PREC;
    if (node.k === "neg") return FORMULA_UNARY_PREC;
    return FORMULA_ATOM_PREC; // num / var / call
  }

  // Decide whether `child` needs surrounding parentheses when printed as the
  // left/right operand of `parentOp`. Based purely on precedence + associativity
  // (^ is right-associative; +,-,*,/ are left-associative in this dialect).
  function formulaChildNeedsParens(child, parentOp, side) {
    if (!parentOp) return false;
    if (child && child.k === "neg") return true; // group unary minus under binary ops
    var childOp = child && child.k === "op" ? child.op : null;
    var pc = formulaNodePrec(child);
    var pp = FORMULA_OPERATORS[parentOp] != null ? FORMULA_OPERATORS[parentOp] : FORMULA_ATOM_PREC;
    if (pc < pp) return true;
    if (pc > pp) return false;
    // Equal precedence:
    if (side === "left") return parentOp === "^";          // (a^b)^c
    if (parentOp === "-" || parentOp === "/") return true;  // a-(b-c), a/(b*c)
    if (parentOp === "^") return false;                     // a^b^c = a^(b^c)
    // + and * are associative on the right: group only when the operator differs
    return childOp !== parentOp;                            // a+(b-c), a*(b/c)
  }

  // A unary minus must parenthesise its operand when the operand is a lower /
  // equal-precedence binary expression or another unary minus: -(a+b), -(a*b).
  function formulaNegArgNeedsParens(arg) {
    if (!arg) return false;
    if (arg.k === "neg") return true;
    if (arg.k === "op") return arg.op !== "^"; // -x^2 is -(x^2) by convention
    return false;
  }

  function fmtPlainNumber(v) {
    if (v === 0) return "0"; // also normalises -0
    return String(v);
  }

  function fmtLatexNumber(v) {
    if (v === 0) return "0";
    var s = String(v);
    var m = /^([+-]?[0-9.]+)[eE]([+-]?[0-9]+)$/.exec(s);
    if (!m) return s;
    var mant = m[1];
    if (mant.charAt(0) === "+") mant = mant.slice(1);
    return mant + "\\times 10^{" + parseInt(m[2], 10) + "}";
  }

  function fmtUmathNumber(v) {
    if (v === 0) return "0";
    var s = String(v);
    var m = /^([+-]?[0-9.]+)[eE]([+-]?[0-9]+)$/.exec(s);
    if (!m) return s;
    var mant = m[1];
    if (mant.charAt(0) === "+") mant = mant.slice(1);
    return mant + "×10^(" + parseInt(m[2], 10) + ")";
  }

  function latexEscapeName(name) {
    // feature names are [A-Za-z0-9_]+ by construction; escape the few LaTeX
    // specials that could appear anyway.
    return String(name).replace(/([\\{}_%$&#^])/g, "\\$1");
  }

  // A "word-like" identifier (multi-character or contains digits) is typeset
  // upright via \mathrm so "f_138"/"NValence" don't read as f·1·3·8.
  function latexVarName(name) {
    var s = String(name);
    return /^[A-Za-z]$/.test(s) ? s : "\\mathrm{" + latexEscapeName(s) + "}";
  }

  // ------------------------------------------------------------------ Plain --

  function formulaPlainNode(node) {
    if (!node) return "";
    switch (node.k) {
      case "num": return fmtPlainNumber(node.v);
      case "var": return node.name;
      case "call": return node.name + "(" + node.args.map(formulaPlainNode).join(",") + ")";
      case "neg": {
        var inner = formulaNegArgNeedsParens(node.a) ? "(" + formulaPlainNode(node.a) + ")" : formulaPlainNode(node.a);
        return "-" + inner;
      }
      case "op": {
        if (node.op === "^") {
          var baseP = formulaChildNeedsParens(node.a, "^", "left") ? "(" + formulaPlainNode(node.a) + ")" : formulaPlainNode(node.a);
          var exp = node.b;
          var expStr = formulaPlainNode(exp);
          if (exp.k === "op" && exp.op !== "^" || exp.k === "neg") expStr = "(" + expStr + ")";
          return baseP + "^" + expStr;
        }
        var la = formulaChildNeedsParens(node.a, node.op, "left") ? "(" + formulaPlainNode(node.a) + ")" : formulaPlainNode(node.a);
        var rb = formulaChildNeedsParens(node.b, node.op, "right") ? "(" + formulaPlainNode(node.b) + ")" : formulaPlainNode(node.b);
        return la + node.op + rb;
      }
    }
    return "";
  }

  // ----------------------------------------------------------------- LaTeX --

  var LATEX_FN = {
    sqrt: 1, cbrt: 1, log: 1, exp: 1, abs: 1,
  };

  function formulaLatexNode(node, parentOp, side) {
    if (!node) return "";
    var wrap = formulaChildNeedsParens(node, parentOp, side);
    var body;
    switch (node.k) {
      case "num": body = fmtLatexNumber(node.v); break;
      case "var": body = latexVarName(node.name); break;
      case "neg":
        body = "-" + (formulaNegArgNeedsParens(node.a)
          ? "(" + formulaLatexNode(node.a) + ")"
          : formulaLatexNode(node.a));
        break;
      case "call": {
        var origName = String(node.name);
        var name = origName.toLowerCase();
        var arg = node.args && node.args[0] ? formulaLatexNode(node.args[0]) : "";
        var rest = (node.args || []).slice(1).map(function (a) { return formulaLatexNode(a); }).join(",");
        if (name === "sqrt") body = "\\sqrt{" + arg + "}";
        else if (name === "cbrt") body = "\\sqrt[3]{" + arg + "}";
        else if (name === "exp") body = "e^{" + arg + "}";
        else if (name === "abs") body = "\\left|" + arg + "\\right|";
        else if (name === "log") body = "\\log(" + arg + (rest ? "," + rest : "") + ")";
        else body = "\\mathrm{" + latexEscapeName(origName) + "}(" + arg + (rest ? "," + rest : "") + ")";
        break;
      }
      case "op": {
        if (node.op === "^") {
          var bp = formulaChildNeedsParens(node.a, "^", "left") ? "(" + formulaLatexNode(node.a) + ")" : formulaLatexNode(node.a);
          body = bp + "^{" + formulaLatexNode(node.b) + "}";
          break;
        }
        if (node.op === "/") {
          body = "\\frac{" + formulaLatexNode(node.a) + "}{" + formulaLatexNode(node.b) + "}";
          break;
        }
        var sep = node.op === "*" ? " \\cdot " : " " + node.op + " ";
        var la = formulaChildNeedsParens(node.a, node.op, "left") ? "(" + formulaLatexNode(node.a) + ")" : formulaLatexNode(node.a);
        var rb = formulaChildNeedsParens(node.b, node.op, "right") ? "(" + formulaLatexNode(node.b) + ")" : formulaLatexNode(node.b);
        body = la + sep + rb;
        break;
      }
      default: body = "";
    }
    return wrap ? "(" + body + ")" : body;
  }

  // ------------------------------------------------------------- UnicodeMath --

  // Word / PowerPoint equation linear format (UnicodeMath). Math blocks built
  // from the same AST; paste the result into an equation box (Alt + =).
  function umathIsUnit(node) {
    if (!node) return false;
    return node.k === "num" || node.k === "var";
  }

  function formulaUmathNode(node, parentOp, side) {
    if (!node) return "";
    var wrap = formulaChildNeedsParens(node, parentOp, side);
    var body;
    switch (node.k) {
      case "num": body = fmtUmathNumber(node.v); break;
      case "var": body = node.name; break;
      case "neg":
        body = "-" + (formulaNegArgNeedsParens(node.a)
          ? "(" + formulaUmathNode(node.a) + ")"
          : formulaUmathNode(node.a));
        break;
      case "call": {
        var origName = String(node.name);
        var name = origName.toLowerCase();
        var arg = node.args && node.args[0] ? formulaUmathNode(node.args[0]) : "";
        var rest = (node.args || []).slice(1).map(function (a) { return formulaUmathNode(a); }).join(",");
        if (name === "sqrt") body = "\\sqrt(" + arg + ")";
        else if (name === "cbrt") body = "\\sqrt(3&" + arg + ")";
        else if (name === "exp") body = "e" + (umathIsUnit(node.args[0]) ? "^" + arg : "^(" + arg + ")");
        else if (name === "abs") body = "|" + arg + "|";
        else body = origName + "(" + arg + (rest ? "," + rest : "") + ")"; // log & unknown fns keep their name
        break;
      }
      case "op": {
        if (node.op === "^") {
          var bp = formulaChildNeedsParens(node.a, "^", "left") ? "(" + formulaUmathNode(node.a) + ")" : formulaUmathNode(node.a);
          var ex = node.b;
          body = bp + "^" + (umathIsUnit(ex) ? formulaUmathNode(ex) : "(" + formulaUmathNode(ex) + ")");
          break;
        }
        if (node.op === "/") {
          // UnicodeMath fraction: a/(b+c) builds a stacked fraction in Word.
          var numS = umathIsUnit(node.a) ? formulaUmathNode(node.a) : "(" + formulaUmathNode(node.a) + ")";
          var denS = umathIsUnit(node.b) ? formulaUmathNode(node.b) : "(" + formulaUmathNode(node.b) + ")";
          body = numS + "/" + denS;
          break;
        }
        var sep = node.op === "*" ? "*" : node.op;
        var la = formulaChildNeedsParens(node.a, node.op, "left") ? "(" + formulaUmathNode(node.a) + ")" : formulaUmathNode(node.a);
        var rb = formulaChildNeedsParens(node.b, node.op, "right") ? "(" + formulaUmathNode(node.b) + ")" : formulaUmathNode(node.b);
        body = la + sep + rb;
        break;
      }
      default: body = "";
    }
    return wrap ? "(" + body + ")" : body;
  }

  function formulaToPlain(text) { return formulaPlainNode(formulaAst(text)); }
  function formulaToLatex(text) { return formulaLatexNode(formulaAst(text)); }
  function formulaToUnicodeMath(text) { return formulaUmathNode(formulaAst(text)); }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  function rank(arr) {
    var n = arr.length;
    var idx = new Array(n);
    for (var i = 0; i < n; i++) idx[i] = i;
    idx.sort(function (a, b) {
      return (arr[a] - arr[b]) || (a - b);
    });
    var r = new Array(n);
    for (var i = 0; i < n; ) {
      var j = i + 1;
      while (j < n && arr[idx[j]] === arr[idx[i]]) j++;
      var avg = (i + j - 1) / 2; // average (0-based) rank for ties
      for (var k = i; k < j; k++) r[idx[k]] = avg;
      i = j;
    }
    return r;
  }

  function pearson(x, y) {
    var n = x.length;
    if (n === 0) return NaN;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var cov = 0, vx = 0, vy = 0;
    for (var j = 0; j < n; j++) {
      var dx = x[j] - mx, dy = y[j] - my;
      cov += dx * dy; vx += dx * dx; vy += dy * dy;
    }
    if (vx === 0 || vy === 0) return NaN;
    return cov / Math.sqrt(vx * vy);
  }

  function spearman(x, y) {
    return pearson(rank(x), rank(y));
  }

  // Per-model quality metrics of one prediction series against the target.
  //   rmse   sqrt(mean(e²))     — mean error, quadratic (outlier-sensitive)
  //   mae    mean(|e|)          — mean error, linear (outlier-robust)
  //   maxae  max(|e|)           — worst single deviation
  //   r2     1 − SSres/SStot    — explained variance (NaN for a constant target)
  //   rho    Spearman(pred,true)— rank correlation
  // with e = predicted − true. rmse / mae / maxae are all "smaller is better"
  // and obey mae ≤ rmse ≤ maxae; a non-finite residual voids the three error
  // metrics together (ok = false).
  function computeMetrics(yTrue, yPred) {
    var n = yTrue.length;
    if (n === 0) return { rmse: NaN, mae: NaN, maxae: NaN, r2: NaN, rho: NaN, ok: false };
    var s2 = 0, sAbs = 0, maxAbs = -Infinity, allFinite = true;
    var my = 0;
    for (var i = 0; i < n; i++) my += yTrue[i];
    my /= n;
    var ssTot = 0;
    for (var j = 0; j < n; j++) {
      var e = yPred[j] - yTrue[j];
      if (!Number.isFinite(e)) allFinite = false;
      s2 += e * e;
      var a = Math.abs(e);
      sAbs += a;
      if (a > maxAbs) maxAbs = a;
      var d = yTrue[j] - my;
      ssTot += d * d;
    }
    var rmse = Math.sqrt(s2 / n);
    var mae = sAbs / n;
    var r2 = ssTot === 0 ? NaN : 1 - s2 / ssTot;
    var rho = spearman(yTrue, yPred);
    var ok = allFinite && Number.isFinite(rmse) && Number.isFinite(maxAbs);
    return {
      rmse: ok ? rmse : NaN,
      mae: ok ? mae : NaN,
      maxae: ok ? maxAbs : NaN,
      r2: Number.isFinite(r2) ? r2 : NaN,
      rho: Number.isFinite(rho) ? rho : NaN,
      ok: ok,
    };
  }

  // ---------------------------------------------------------------------------
  // Prediction residuals + error histogram helpers.
  //
  // error = predicted - true. Kept as pure functions (no DOM / chart types) so
  // the detail-dialog histogram, statistics and the Node test suite all share
  // exactly one implementation. The chart code only formats their output.
  // ---------------------------------------------------------------------------

  // errorSeries(pred, yTrue) -> Float64Array of residuals aligned 1:1 with the
  // inputs (error = predicted - true). Pairs where either side is non-finite
  // produce NaN — callers filter with finiteResiduals, mirroring how the
  // scatter chart skips non-finite points.
  function errorSeries(pred, yTrue) {
    var n = pred && yTrue ? Math.min(pred.length, yTrue.length) : 0;
    var out = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var p = pred[i];
      var t = yTrue[i];
      out[i] = Number.isFinite(p) && Number.isFinite(t) ? p - t : NaN;
    }
    return out;
  }

  // Copy the finite residuals out of a series that may contain NaN / ±Inf
  // (from errorSeries) so downstream statistics and binning never see junk.
  function finiteResiduals(errors) {
    var out = [];
    if (!errors) return out;
    for (var i = 0; i < errors.length; i++) {
      if (Number.isFinite(errors[i])) out.push(errors[i]);
    }
    return out;
  }

  // Descriptive statistics of a residual series (finite values only).
  //   n       — number of finite residuals
  //   mean    — mean error (sum / n)
  //   median  — median error (average of the two middle values for even n)
  //   std     — population standard deviation (÷ n), describing exactly the
  //             distribution shown in the histogram; matches np.std(errors)
  //   ok      — false when there is nothing finite to describe
  function residualStats(errors) {
    var vals = finiteResiduals(errors);
    var n = vals.length;
    if (n === 0) return { n: 0, mean: NaN, median: NaN, std: NaN, ok: false };
    var sum = 0;
    for (var i = 0; i < n; i++) sum += vals[i];
    var mean = sum / n;
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var median = n % 2 === 1
      ? sorted[(n - 1) / 2]
      : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    var ss = 0;
    for (var j = 0; j < n; j++) {
      var d = vals[j] - mean;
      ss += d * d;
    }
    var std = Math.sqrt(ss / n); // population SD (÷ n)
    return { n: n, mean: mean, median: median, std: std, ok: true };
  }

  // Default bin count for a residual histogram: sqrt-based, clamped to a
  // sensible [5, 60] window so tiny runs still get readable bins.
  function autoBinCount(n) {
    if (!(n > 0)) return 0;
    var b = Math.ceil(Math.sqrt(n));
    if (b < 5) b = 5;
    if (b > 60) b = 60;
    return b;
  }

  // Equal-width binning of finite residuals over [min, max] of the data.
  //
  //   opts.bins   optional fixed bin count (default: autoBinCount(n))
  //
  // Returns:
  //   n            finite residual count
  //   excluded     non-finite residuals dropped from the input
  //   min, max     data extent (after resolving an all-equal degenerate case)
  //   binCount     number of bins
  //   binWidth     (max - min) / binCount
  //   start        left edge of the first bin (== min)
  //   edges        binCount + 1 boundaries: bin i covers [edges[i], edges[i+1])
  //   counts       count per bin; the last bin also accepts values == edges[binCount]
  //   bins         [{ start, end, center, count }] convenience form
  //   zeroBin      index of the bin whose half-open range contains 0, or -1
  //   containsZero whether 0 falls inside [min, max]
  //   ok           false when there are no finite residuals to bin
  //
  // Binning rule (unit-testable contract): every finite value is counted
  // exactly once; a value exactly on an interior edge belongs to the bin to its
  // right; the observed maximum (which equals the last edge) lands in the last
  // bin.
  function errorHistogram(errors, opts) {
    var vals = finiteResiduals(errors);
    var n = vals.length;
    var excluded = errors ? errors.length - n : 0;
    var empty = { n: 0, excluded: excluded, min: NaN, max: NaN, binCount: 0, binWidth: 0, start: NaN, edges: [], counts: [], bins: [], zeroBin: -1, containsZero: false, ok: false };
    if (n === 0) return empty;

    var mn = Math.min.apply(null, vals);
    var mx = Math.max.apply(null, vals);
    // Degenerate case: every residual identical. Expand symmetrically around
    // the value so bins still have positive width and stay readable.
    if (mn === mx) {
      var v = mn;
      var half = v === 0 ? 0.5 : Math.max(Math.abs(v) * 0.05, 1e-9);
      mn = v - half;
      mx = v + half;
    }

    var bins = opts && opts.bins > 0 ? Math.floor(opts.bins) : autoBinCount(n);
    if (bins < 1) return empty;
    var binWidth = (mx - mn) / bins;

    var edges = new Array(bins + 1);
    for (var e = 0; e <= bins; e++) edges[e] = mn + e * binWidth;

    var counts = new Array(bins);
    for (var c = 0; c < bins; c++) counts[c] = 0;
    for (var i = 0; i < n; i++) {
      var idx = Math.floor((vals[i] - mn) / binWidth);
      if (idx < 0) idx = 0;
      if (idx >= bins) idx = bins - 1; // float edge → observed max goes last
      counts[idx]++;
    }

    var zeroBin = -1;
    for (var z = 0; z < bins; z++) {
      var zLo = edges[z];
      var zHi = edges[z + 1];
      var inside = z === bins - 1 ? (0 >= zLo && 0 <= zHi) : (0 >= zLo && 0 < zHi);
      if (inside) { zeroBin = z; break; }
    }

    var binList = new Array(bins);
    for (var b = 0; b < bins; b++) {
      binList[b] = { start: edges[b], end: edges[b + 1], center: (edges[b] + edges[b + 1]) / 2, count: counts[b] };
    }

    return {
      n: n,
      excluded: excluded,
      min: mn,
      max: mx,
      binCount: bins,
      binWidth: binWidth,
      start: mn,
      edges: edges,
      counts: counts,
      bins: binList,
      zeroBin: zeroBin,
      containsZero: zeroBin >= 0,
      ok: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Pareto front (2D/3D) + CSV export rows.
  //
  // The front helpers are pure: given the point list and which axes are
  // "smaller is better" (minimize) or "larger is better", they return the
  // non-dominated subset. Both the 2D and 3D Pareto charts in the UI consume
  // these helpers, and the CSV export is built from the *same* point/front
  // arrays the chart was rendered from (see paretoExportRows below) — so the
  // exported rows, metric values and is_pareto flags always match the plot
  // without re-implementing any Pareto logic.
  // ---------------------------------------------------------------------------

  // Convert an axis value into a "better is smaller" score: minimize keeps the
  // value, maximize negates it, so dominance can always be tested with <=.
  function paretoScore(minimize, v) {
    return minimize ? v : -v;
  }

  function paretoFront2D(points, minimizeX, minimizeY) {
    function nx(p) { return paretoScore(minimizeX, p.x); }
    function ny(p) { return paretoScore(minimizeY, p.y); }
    var nonDom = points.filter(function (p) {
      return !points.some(function (q) {
        if (q.rank === p.rank) return false;
        return nx(q) <= nx(p) && ny(q) <= ny(p) && (nx(q) < nx(p) || ny(q) < ny(p));
      });
    });
    // Sorted along the x axis (ties broken by rank) — same as the UI front.
    return nonDom.slice().sort(function (a, b) {
      return (nx(a) - nx(b)) || (a.rank - b.rank);
    });
  }

  function paretoFront3D(points, minimizeX, minimizeY, minimizeZ) {
    function nx(p) { return paretoScore(minimizeX, p.x); }
    function ny(p) { return paretoScore(minimizeY, p.y); }
    function nz(p) { return paretoScore(minimizeZ, p.z); }
    return points.filter(function (p) {
      return !points.some(function (q) {
        if (q.rank === p.rank) return false;
        return nx(q) <= nx(p) && ny(q) <= ny(p) && nz(q) <= nz(p) &&
               (nx(q) < nx(p) || ny(q) < ny(p) || nz(q) < nz(p));
      });
    });
  }

  // Formula text of a point, taken from the point's own string when present,
  // else from the model object the point carries (p.m.formulaOriginal).
  function paretoFormula(p) {
    if (p && typeof p.formulaOriginal === "string") return p.formulaOriginal;
    if (p && p.m && typeof p.m.formulaOriginal === "string") return p.m.formulaOriginal;
    return "";
  }

  // Build the CSV row matrix that reproduces the *current* Pareto chart.
  //
  // `points` are the front-eligible plotted points, `ghosts` the models the
  // active filter excluded from the front computation (still drawn faintly),
  // and `front` the exact output of paretoFront2D/paretoFront3D over `points`.
  // Passing in those chart arrays — rather than recomputing anything — is what
  // guarantees the export matches the plot 1:1. One implementation covers both
  // the 2D chart (two axes) and the 3D chart (three axes).
  //
  //   axes:  [{ code: "x", dataset: "train", metric: "rmse" }, ...]  // 2 or 3
  //   point: { rank, x, y(, z), m?: { formulaOriginal } }
  //
  // Returns an array of arrays (rows[0] = header) ready for rowsToCsv().
  function paretoExportRows(points, ghosts, front, axes) {
    var onFront = {};
    var i;
    for (i = 0; i < front.length; i++) onFront[front[i].rank] = true;
    var eligible = {};
    for (i = 0; i < points.length; i++) eligible[points[i].rank] = true;

    var header = ["rank", "formula"];
    for (i = 0; i < axes.length; i++) {
      var ax = axes[i];
      header.push(ax.code + "_dataset", ax.code + "_metric", ax.code + "_value");
    }
    header.push("is_pareto", "excluded");

    var rows = [header];
    // Same order the chart plots them: eligible points first, ghosts after.
    var all = points.concat(ghosts);
    for (i = 0; i < all.length; i++) {
      var p = all[i];
      var row = [p.rank, paretoFormula(p)];
      for (var a = 0; a < axes.length; a++) {
        var axis = axes[a];
        row.push(axis.dataset, axis.metric, p[axis.code]);
      }
      row.push(onFront[p.rank] ? 1 : 0, eligible[p.rank] ? 0 : 1);
      rows.push(row);
    }
    return rows;
  }

  // RFC 4180-style field escaping (fields containing commas, quotes or line
  // breaks are quoted; embedded quotes are doubled). Numbers are serialized
  // with String(), so full floating-point precision is preserved for replots.
  function csvField(value) {
    var s = value === undefined || value === null ? "" : String(value);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function rowsToCsv(rows) {
    if (!rows || !rows.length) return "";
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var line = [];
      for (var j = 0; j < rows[i].length; j++) line.push(csvField(rows[i][j]));
      out.push(line.join(","));
    }
    return out.join("\r\n") + "\r\n";
  }

  // ---------------------------------------------------------------------------
  // Pareto axes + metrics — (dataset, metric) addressing.
  //
  // The engine keeps its metricsTrain / metricsVerify fields (no mass rename);
  // this small API is the single place that maps a dataset token onto them, so
  // the UI and the export never add per-dataset branches themselves. Datasets
  // are derived from the loaded run, which lets a train-only run still build a
  // meaningful Pareto view (e.g. Train RMSE × Train MaxAE).
  //
  // Besides "train" / "verify" there is the pseudo-dataset "delta" — the
  // train → validation generalization gap. All delta values are defined so that
  // POSITIVE means validation performed worse than training, i.e. every delta
  // metric is "smaller = better":
  //     ΔRMSE  = RMSE_validation − RMSE_train
  //     ΔMAE   = MAE_validation − MAE_train
  //     ΔMaxAE = MaxAE_validation − MaxAE_train
  //     ΔR²    = R²_train − R²_validation
  //     Δρ     = ρ_train − ρ_validation
  // The single implementation below is what the table, the numeric filter, the
  // sorters and the Pareto axes all read through Core.metricValue.
  // ---------------------------------------------------------------------------

  // Which metric keys support the train→validation delta and whether the metric
  // is "smaller is better" in its own dataset (those keys flip the sign in the
  // delta definition above).
  function deltaDirection(metricKey) {
    return metricKey === "r2" || metricKey === "rho" ? -1 : 1; // -1 ⇒ invert (train − validation)
  }

  function deltaMetricValue(model, metricKey) {
    if (!model) return NaN;
    var t = model.metricsTrain;
    var v = model.metricsVerify;
    if (!t || !v) return NaN; // train-only model (or no verify) → no gap defined
    var tv = t[metricKey];
    var vv = v[metricKey];
    if (typeof tv !== "number" || typeof vv !== "number") return NaN;
    return deltaDirection(metricKey) === -1 ? tv - vv : vv - tv;
  }

  // Deterministic NaN endpoint used when sorting on a metric column, so missing
  // values never poison the comparator: endpoints sit on the metric's "worse"
  // side under ascending sort (rmse/mae/maxae → +Infinity, r2 → −Infinity, rho → 0).
  // Delta is smaller-better for every metric, so a missing gap sorts as worst
  // (+Infinity) no matter which underlying metric it belongs to.
  function metricSortEndpoint(metricKey, dataset) {
    if (dataset === "delta") return Infinity;
    if (metricKey === "r2") return -Infinity;
    if (metricKey === "rho") return 0;
    return Infinity; // rmse / mae / maxae
  }

  // Unified metric accessor for a model.
  //   dataset:   "train" | "verify" | "delta" | "t1"…"tN" (multi-task tasks)
  // "train" is the run's primary dataset: the training set of a single-task run,
  // or the whole (pooled) stacked train.dat of a multi-task run. "t1"…"tN" are
  // the per-task blocks of a multi-task run.
  // Returns NaN when the model has no such dataset/metric, or when delta is
  // requested for a model/run without validation data.
  function metricValue(model, dataset, metricKey) {
    if (dataset === "delta") return deltaMetricValue(model, metricKey);
    if (!model) return NaN;
    // Preferred path: the per-dataset metric map built by runPipeline makes
    // every dataset (train / verify / task) a plain key lookup, so the UI never
    // grows per-dataset branches.
    if (model.metrics && Object.prototype.hasOwnProperty.call(model.metrics, dataset)) {
      var mapped = model.metrics[dataset];
      return mapped && typeof mapped[metricKey] === "number" ? mapped[metricKey] : NaN;
    }
    var set = dataset === "verify" ? model.metricsVerify : model.metricsTrain;
    return set && typeof set[metricKey] === "number" ? set[metricKey] : NaN;
  }

  // Prediction series of a model for one dataset token (null when absent).
  function modelPrediction(model, dataset) {
    if (!model) return null;
    if (model.pred && Object.prototype.hasOwnProperty.call(model.pred, dataset)) {
      return model.pred[dataset] || null;
    }
    if (dataset === "verify") return model.predVerify || null;
    if (dataset === "train") return model.predTrain || null;
    return null;
  }

  // Datasets present in a pipeline result, in display order: "train" always;
  // "verify" when a verify file was analysed; then the task blocks "t1"…"tN" of
  // a multi-task run. Keeping the order here is what makes the table columns,
  // the Pareto axis groups and the Compare rows agree without extra sorting.
  function availableDatasets(result) {
    var out = ["train"];
    if (result && result.verify) out.push("verify");
    if (result && result.tasks) {
      for (var i = 0; i < result.tasks.length; i++) out.push(result.tasks[i].key);
    }
    return out;
  }

  // The dataset object behind a token: the row-aligned view the scatter, the
  // residual histogram and the point inspector read (n / names / cols).
  function datasetData(result, key) {
    if (!result) return null;
    if (key === "train") return result.train || null;
    if (key === "verify") return result.verify || null;
    if (result.tasks) {
      for (var i = 0; i < result.tasks.length; i++) {
        if (result.tasks[i].key === key) return result.tasks[i].data;
      }
    }
    return null;
  }

  // Task descriptor behind a token ("t1" -> { key, index, label, n, start, std }).
  function datasetTask(result, key) {
    if (!result || !result.tasks) return null;
    for (var i = 0; i < result.tasks.length; i++) {
      if (result.tasks[i].key === key) return result.tasks[i];
    }
    return null;
  }

  // Two axes are the "same" only when dataset AND metric match.
  function paretoAxesEqual(a, b) {
    return !!(a && b && a.dataset === b.dataset && a.metric === b.metric);
  }

  // True when no two axes in the list share the same (dataset, metric).
  function paretoAxesDistinct(axes) {
    for (var i = 0; i < axes.length; i++) {
      for (var j = i + 1; j < axes.length; j++) {
        if (paretoAxesEqual(axes[i], axes[j])) return false;
      }
    }
    return true;
  }

  // Deterministic default axes for a run with `datasets` (tokens from
  // availableDatasets) and `dim` objectives (2 or 3). Picks metrics in the
  // usual order (rmse, maxae, r2, rho, then mae), interleaving datasets, and
  // never returns a duplicated (dataset, metric) pair.
  // MAE is deliberately last in the priority list: it is fully selectable on
  // any axis, but it never displaces the historical defaults (so a restored
  // session or a fresh run keeps exactly the axes it had before MAE existed).
  function paretoDefaultAxes(datasets, dim) {
    var ds = datasets && datasets.length ? datasets.slice() : ["train"];
    var order = ["rmse", "maxae", "r2", "rho", "mae"];
    var axes = [];
    for (var i = 0; i < order.length && axes.length < dim; i++) {
      for (var j = 0; j < ds.length && axes.length < dim; j++) {
        axes.push({ dataset: ds[j], metric: order[i] });
      }
    }
    return axes;
  }

  // ---------------------------------------------------------------------------
  // Model bookkeeping (favorite / excluded) + Compare data builders.
  //
  // Model states live in ONE map (rank -> { favorite?, excluded? }) that rides
  // on the pipeline result, so the table, detail dialog, Pareto view and the
  // Compare view all read the same object. Only the flags a caller actually
  // touched are serialized, keeping saved projects small — and older projects
  // without a state section simply deserialize to "nothing favourite /
  // excluded".
  // ---------------------------------------------------------------------------

  // Accepts a persisted map (or null) and returns a clean map keyed by numeric
  // rank with boolean flags. Unknown ranks / non-boolean junk are dropped;
  // `validRanks` (optional Set) prunes entries whose models no longer exist
  // (e.g. after the project files changed between saves).
  function normalizeModelStates(raw, validRanks) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach(function (rankKey) {
      var rank = Number(rankKey);
      var s = raw[rankKey];
      if (!isFinite(rank) || rank <= 0 || !s || typeof s !== "object") return;
      if (validRanks && !validRanks.has(rank)) return;
      out[rank] = {
        favorite: !!(s.favorite || s.fav),
        excluded: !!(s.excluded || s.hidden),
      };
    });
    return out;
  }

  // Compact serializable copy: entries with any enabled flag only.
  function modelStatesToJSON(states) {
    var out = {};
    if (!states || typeof states !== "object") return out;
    Object.keys(states).forEach(function (rankKey) {
      var rank = Number(rankKey);
      var s = states[rankKey];
      if (!s) return;
      var rec = {};
      if (s.favorite) rec.favorite = true;
      if (s.excluded) rec.excluded = true;
      if (rec.favorite || rec.excluded) out[rank] = rec;
    });
    return out;
  }

  // True when a model is excluded (takes part in nothing by default).
  function modelExcluded(states, model) {
    var s = states && model ? states[model.rank] : null;
    return !!(s && s.excluded);
  }

  // True when a model is marked as a favourite.
  function modelFavorite(states, model) {
    var s = states && model ? states[model.rank] : null;
    return !!(s && s.favorite);
  }

  // Stable metric row order for the Compare view.
  var COMPARE_METRIC_ORDER = ["rmse", "mae", "maxae", "r2", "rho"];

  // Metric matrix shared by the Compare view: one row per dataset x metric in a
  // stable order, one value per model (NaN when a model lacks that metric).
  // `result` (optional) supplies the dataset list, so a multi-task run compares
  // on "train" + "t1"…"tN"; without it the legacy train/verify pair is used.
  function compareMetricRows(models, result) {
    var datasets;
    if (result) {
      datasets = availableDatasets(result);
    } else {
      datasets = ["train"];
      if (models.some(function (m) { return !!m.metricsVerify; })) datasets.push("verify");
    }
    var rows = [];
    datasets.forEach(function (ds) {
      COMPARE_METRIC_ORDER.forEach(function (metric) {
        rows.push({
          dataset: ds,
          metric: metric,
          values: models.map(function (m) { return metricValue(m, ds, metric); }),
        });
      });
    });
    return rows;
  }

  // Per-sample prediction matrix for the Compare view.
  //   result:  runPipeline output (train/verify/task datasets + models carrying
  //            a pred map keyed by the same dataset tokens)
  //   models:  compared model objects (column order kept)
  //   dataset: "train" | "verify" | "t1"…"tN"
  // Returns { dataset, rows } where rows[i] = { sample, target, preds } and
  // preds is aligned with models: preds[k] = { rank, pred, error } for
  // models[k] (NaN when that model has no prediction array for this dataset,
  // e.g. a train-only run compared on verify). Returns null when the dataset
  // is not available in the result.
  function compareSampleMatrix(result, models, dataset) {
    if (!result) return null;
    var data = datasetData(result, dataset);
    if (!data) return null;
    var y = Array.from(data.cols[result.meta.targetLetter]);
    var rows = [];
    for (var i = 0; i < data.n; i++) {
      var preds = [];
      for (var mi = 0; mi < models.length; mi++) {
        var m = models[mi];
        var pa = modelPrediction(m, dataset);
        var pred = (pa && pa.length === data.n) ? pa[i] : NaN;
        var err = (Number.isFinite(pred) && Number.isFinite(y[i])) ? pred - y[i] : NaN;
        preds.push({ rank: m.rank, pred: pred, error: err });
      }
      rows.push({ sample: data.names[i], target: y[i], preds: preds });
    }
    return { dataset: dataset, rows: rows };
  }

  // ---------------------------------------------------------------------------
  // Feature & descriptor usage — counting and "model contains X" matching.
  //
  // These helpers answer two questions over a run's candidate models:
  //   1. how often is each primary feature / each descriptor (expression) used?
  //   2. which models contain a given feature or descriptor?
  //
  // Matching NEVER scans the formatted coefficient string. Feature hits are
  // identifier-boundary token matches against a known feature-name set, so a
  // feature named "A" can never match inside "AA" or "A1". Descriptors are
  // compared through a canonical normalised expression (whitespace / redundant
  // parentheses removed via the shared formula AST), so a descriptor searched
  // for as "(A+B)" matches the same expression written "A + B".
  //
  // Both rely on the per-term records the pipeline attaches to every model
  // (model.descriptors[i].original), which is exactly the Uspace expression
  // text SISSO selected for that term.
  // ---------------------------------------------------------------------------

  var IDENT_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

  // Unique identifier tokens of an expression (feature names, function names…)
  // with real identifier boundaries — no substring false positives.
  function uniqueIdentifiers(text) {
    var out = [];
    if (!text) return out;
    var seen = {};
    IDENT_TOKEN_RE.lastIndex = 0;
    var m;
    while ((m = IDENT_TOKEN_RE.exec(String(text))) !== null) {
      if (!seen[m[0]]) { seen[m[0]] = true; out.push(m[0]); }
    }
    return out;
  }

  // Canonical key of a descriptor expression. Prefers the shared formula AST
  // (whitespace / redundant parentheses removed); expressions outside the
  // formula dialect fall back to a whitespace-minified form.
  function normalizeDescriptorText(text) {
    var s = String(text == null ? "" : text).trim();
    if (!s) return "";
    try { return formulaToPlain(s); }
    catch (err) { return s.replace(/\s+/g, ""); }
  }

  // Original descriptor-expression texts of a model (from the pipeline's
  // per-term records). Unknown-shaped models simply yield [].
  function descriptorTextsOf(model) {
    if (!model) return [];
    var ds = model.descriptors;
    if (!Array.isArray(ds) || !ds.length) return [];
    var out = [];
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i];
      if (d == null) continue;
      var t = typeof d === "string" ? d : (d.original != null ? d.original : "");
      if (t) out.push(String(t));
    }
    return out;
  }

  function descriptorKeysOf(model) {
    return descriptorTextsOf(model).map(normalizeDescriptorText);
  }

  function toNameSet(featureNames) {
    if (featureNames instanceof Set) return featureNames;
    var set = new Set();
    if (featureNames) {
      var list = Array.isArray(featureNames) ? featureNames : [featureNames];
      for (var i = 0; i < list.length; i++) if (list[i] != null) set.add(list[i]);
    }
    return set;
  }

  // Distinct feature names (restricted to the known `featureNames` set) that a
  // model's descriptors reference.
  function modelFeatureNames(model, featureNames) {
    var set = toNameSet(featureNames);
    var out = [];
    var texts = descriptorTextsOf(model);
    if (!texts.length && model && model.formulaOriginal) texts = [model.formulaOriginal];
    for (var t = 0; t < texts.length; t++) {
      var toks = uniqueIdentifiers(texts[t]);
      for (var i = 0; i < toks.length; i++) {
        var tok = toks[i];
        if (set.has(tok) && out.indexOf(tok) < 0) out.push(tok);
      }
    }
    return out;
  }

  function modelUsesFeature(model, name) {
    if (!name) return false;
    var toks = uniqueIdentifiers(descriptorTextsOf(model).join(" "));
    for (var i = 0; i < toks.length; i++) if (toks[i] === name) return true;
    return false;
  }

  function modelsWithFeature(models, name) {
    var out = [];
    if (!models) return out;
    for (var i = 0; i < models.length; i++) {
      if (modelUsesFeature(models[i], name)) out.push(models[i]);
    }
    return out;
  }

  // True when a model carries a descriptor whose normalised expression equals
  // the (normalised) `descriptorExpr`.
  function modelUsesDescriptor(model, descriptorExpr) {
    var key = normalizeDescriptorText(descriptorExpr);
    if (!key) return false;
    var keys = descriptorKeysOf(model);
    return keys.indexOf(key) >= 0;
  }

  function modelsWithDescriptor(models, descriptorExpr) {
    var out = [];
    if (!models) return out;
    for (var i = 0; i < models.length; i++) {
      if (modelUsesDescriptor(models[i], descriptorExpr)) out.push(models[i]);
    }
    return out;
  }

  // Usage counts across a model list, newest-style descending rows. Each model
  // counts at most once per feature / per descriptor key.
  function featureUsage(models, featureNames) {
    var n = models ? models.length : 0;
    var counts = new Map();
    for (var i = 0; i < n; i++) {
      var names = modelFeatureNames(models[i], featureNames);
      for (var k = 0; k < names.length; k++) {
        var nm = names[k];
        counts.set(nm, (counts.get(nm) || 0) + 1);
      }
    }
    var rows = [];
    counts.forEach(function (count, name) {
      rows.push({ name: name, count: count, ratio: n ? count / n : 0 });
    });
    rows.sort(function (a, b) {
      return b.count - a.count ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    return rows;
  }

  function descriptorUsage(models) {
    var n = models ? models.length : 0;
    var byKey = new Map(); // key -> { key, count, texts }
    for (var i = 0; i < n; i++) {
      var texts = descriptorTextsOf(models[i]);
      for (var k = 0; k < texts.length; k++) {
        var raw = texts[k];
        var key = normalizeDescriptorText(raw);
        var rec = byKey.get(key);
        if (!rec) {
          rec = { key: key, count: 0, texts: {} };
          byKey.set(key, rec);
        }
        rec.count++;
        rec.texts[raw] = (rec.texts[raw] || 0) + 1;
      }
    }
    var rows = [];
    byKey.forEach(function (rec, key) {
      // display the most common original spelling of this canonical key
      var best = key, bestN = -1;
      for (var spelling in rec.texts) {
        if (Object.prototype.hasOwnProperty.call(rec.texts, spelling) && rec.texts[spelling] > bestN) {
          best = spelling; bestN = rec.texts[spelling];
        }
      }
      rows.push({ expr: best, key: key, count: rec.count, ratio: n ? rec.count / n : 0 });
    });
    rows.sort(function (a, b) {
      return b.count - a.count ||
        (a.expr < b.expr ? -1 : a.expr > b.expr ? 1 : 0);
    });
    return rows;
  }

  // One-stop summary used by the UI (and tests): feature + descriptor usage
  // over a pipeline result, with the feature-name set read from result.columns.
  function usageReport(result) {
    if (!result || !Array.isArray(result.models)) return null;
    var names = [];
    if (Array.isArray(result.columns)) {
      for (var i = 0; i < result.columns.length; i++) {
        var c = result.columns[i];
        if (c && c.role === "feature") names.push(c.original);
      }
    }
    return {
      totalModels: result.models.length,
      featureNames: names,
      features: featureUsage(result.models, names),
      descriptors: descriptorUsage(result.models),
    };
  }

  // ---------------------------------------------------------------------------
  // Batch favourite / exclude + undo — pure writers on the shared state map.
  //
  // The UI keeps ONE map (rank -> {favorite, excluded}) on the result; batch
  // operations write to exactly that map via these helpers, so undo is a pure
  // inverse and there is no second state system to desynchronise.
  //   batchSetModelStates(states, ranks, patch) -> undo entries
  //     ranks: ranks to touch; patch: {favorite?: bool, excluded?: bool}.
  //     An entry is recorded only when the patch actually flips a flag.
  //   undoBatchModels(states, entries) -> # of ranks restored
  //     Reverts flags that still carry the batch-applied value; a flag the
  //     user changed since the batch is left alone.
  // ---------------------------------------------------------------------------

  function batchSetModelStates(states, ranks, patch) {
    var entries = [];
    if (!states || !ranks) return entries;
    var wantFav = patch && patch.favorite !== undefined ? !!patch.favorite : null;
    var wantExcl = patch && patch.excluded !== undefined ? !!patch.excluded : null;
    if (wantFav === null && wantExcl === null) return entries;
    for (var i = 0; i < ranks.length; i++) {
      var rank = ranks[i];
      var cur = states[rank] || { favorite: false, excluded: false };
      var favBefore = !!cur.favorite;
      var exclBefore = !!cur.excluded;
      var nextFav = wantFav === null ? favBefore : wantFav;
      var nextExcl = wantExcl === null ? exclBefore : wantExcl;
      if (nextFav === favBefore && nextExcl === exclBefore) continue;
      states[rank] = { favorite: nextFav, excluded: nextExcl };
      entries.push({
        rank: rank,
        setFavorite: wantFav === true,
        setExcluded: wantExcl === true,
        favBefore: favBefore,
        exclBefore: exclBefore,
      });
    }
    return entries;
  }

  function undoBatchModels(states, entries) {
    var restored = 0;
    if (!states || !entries) return 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var cur = states[e.rank];
      if (!cur) continue;
      var touched = false;
      if (e.setFavorite && cur.favorite === true) { cur.favorite = !!e.favBefore; touched = true; }
      if (e.setExcluded && cur.excluded === true) { cur.excluded = !!e.exclBefore; touched = true; }
      if (touched) restored++;
    }
    return restored;
  }

  // ---------------------------------------------------------------------------
  // Unit (dimension) matrix — parsed from SISSO.out
  //
  // SISSO.out prints a block titled "Unit of input primary feature, each
  // represented by a row vector:" followed by one row per input feature (in
  // train.dat column order). Each row is a unit vector over the user-defined
  // unit basis declared via funit= in SISSO.in. Features sharing the same
  // vector share the same dimension ("the same class"); an all-zero vector
  // means dimensionless.
  // ---------------------------------------------------------------------------

  var UNIT_BLOCK_RE = /Unit of input primary feature[\s\S]*?each represented by a row vector:\s*\n([\s\S]*?)(?=\n\s*[A-Za-z])/i;

  function parseUnitMatrix(text) {
    if (!text) return null;
    var m = UNIT_BLOCK_RE.exec(String(text));
    if (!m) return null;
    var rows = [];
    var block = m[1];
    var lines = block.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) continue;
      var parts = t.split(/\s+/);
      var row = [];
      var ok = parts.length >= 1;
      for (var j = 0; j < parts.length; j++) {
        var v = parseFloat(parts[j]);
        if (!isFinite(v)) { ok = false; break; }
        row.push(v);
      }
      if (!ok || !row.length) break; // end of the numeric block
      rows.push(row);
    }
    if (!rows.length) return null;
    // All rows must share the same length (number of unit basis vectors).
    var n = rows[0].length;
    for (var k = 1; k < rows.length; k++) {
      if (rows[k].length !== n) return null;
    }
    return rows;
  }

  // Group matrix rows by identical unit vector (rounded to 1e-6). Returns
  // groups in order of first appearance: { key, vector, rows: [featureIndex] }.
  function groupUnitRows(rows) {
    var groups = [];
    var byKey = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var key = row.map(function (v) { return Math.round(v * 1e6); }).join(",");
      if (!byKey[key]) {
        byKey[key] = {
          key: key,
          vector: row.slice(),
          rows: [],
          dimensionless: row.every(function (v) { return Math.abs(v) < 1e-9; }),
        };
        groups.push(byKey[key]);
      }
      byKey[key].rows.push(i);
    }
    return groups;
  }

  // ---------------------------------------------------------------------------
  // Data file parsing
  // ---------------------------------------------------------------------------

  // nameMap letters: index 0 = sample name (kept as string), index 1 = target
  // property, index 2.. = features. Returns column-major numeric arrays keyed
  // by letter (excluding the name column) plus the sample names.
  function parseDataFile(text, nameMap) {
    var lines = text.replace(/\r\n?/g, "\n").split("\n");
    // drop trailing empty lines
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    var nCols = nameMap.length;
    var cols = {};
    for (var i = 1; i < nCols; i++) {
      cols[nameMap[i].new_name] = new Float64Array(lines.length - 1);
    }
    var names = new Array(lines.length - 1);
    for (var r = 1; r < lines.length; r++) {
      var parts = lines[r].trim().split(/\s+/);
      if (parts.length !== nCols) {
        throw new Error(
          "Data row " + r + " has " + parts.length + " columns, expected " + nCols +
          ". The file may be corrupted or use a different layout."
        );
      }
      names[r - 1] = parts[0];
      for (var c = 1; c < nCols; c++) {
        cols[nameMap[c].new_name][r - 1] = parseFloat(parts[c]);
      }
    }
    return {
      n: names.length,
      names: names,
      cols: cols,
      featureLetters: nameMap.slice(2).map(function (r) { return r.new_name; }),
    };
  }

  function makeColumns(nameMap) {
    return nameMap.map(function (r, i) {
      return {
        letter: r.new_name,
        original: r.original_name,
        role: i === 0 ? "name" : i === 1 ? "target" : "feature",
      };
    });
  }

  function makeFeatureGetter(cols, featureSet, rowIndex) {
    return function (letter) {
      return featureSet[letter] ? cols[letter][rowIndex] : NaN;
    };
  }

  // ---------------------------------------------------------------------------
  // Pipeline
  // ---------------------------------------------------------------------------

  // Resolve the coefficient layout and, for a multi-task run, the task split.
  //
  // The layout is decidable from the files themselves: a model uses `descDim`
  // descriptors, so a single-task coefficient row holds descDim + 1 numbers while
  // a multi-task row holds ntask × (descDim + 1) of them, stored as one
  // [c0, c1 … cn] block per task (see SISSO.out's per-task coefficient listing).
  // The per-task sample counts come from SISSO.in's nsample=n1,n2,… list,
  // falling back to the "Number of samples for the task(s)" line of SISSO.out.
  //
  // This single function is what BOTH the pipeline and the health check call.
  // It collects problems in `issues` and only throws when `opts.strict` is set
  // (the pipeline fails fast; the health check wants the full list to show the
  // user). Having one resolver is deliberate: two implementations of "is this a
  // task layout?" is exactly how a health check ends up green-lighting a run the
  // pipeline then refuses to parse.
  //
  //   opts.strict  true (default) -> throw on the first error-level issue
  //   opts.train   optional { n } when the caller has not parsed train.dat
  //
  // Returns { multiTask, ntask, descDim, nsamples, taskWeighting, scmt, taskStd,
  //           taskSizeSource, tasks, issues, declaredDescDim, declaredNtask }
  function resolveLayout(files, top, coeffs, train, opts) {
    var strict = !(opts && opts.strict === false);
    var issues = [];
    function err(code, message) {
      issues.push({ code: code, level: "error", message: message });
      if (strict) {
        var e = new Error(message);
        e.code = code;
        throw e;
      }
    }
    function warn(code, message) {
      issues.push({ code: code, level: "warning", message: message });
    }

    var dims = top.featureLists.map(function (l) { return l.length; });
    var descDim = dims.length ? dims[0] : 0;
    var mixedDims = dims.some(function (d) { return d !== descDim; });
    if (mixedDims) {
      err("mixed-descriptor-dims",
        "The ranked-model file mixes descriptor dimensions (" + dims.join(", ") +
        " feature id(s) per model), so the coefficient layout is ambiguous and the models " +
        "cannot be split into tasks reliably.");
    }

    var inInfo = files.sissoInText ? parseSissoIn(files.sissoInText) : null;
    var outInfo = files.sissoOutText ? parseSissoOutTasks(files.sissoOutText) : null;

    // SISSO's ptype=2 is a classification run: its "target" is a class label, so
    // RMSE / MAE / R² / ρ are not defined. Computing them anyway and showing them
    // next to genuine regression numbers would be worse than refusing.
    if (inInfo && inInfo.ptype !== null && inInfo.ptype !== 1) {
      err("ptype",
        "SISSO.in declares ptype=" + inInfo.ptype +
        (inInfo.ptype === 2 ? " (classification)" : "") + ". This analyzer handles regression " +
        "(ptype=1) only — error metrics such as RMSE / R² / ρ are not defined for class labels.");
    }

    var declaredNtask = (inInfo && inInfo.ntask) || (outInfo && outInfo.ntask) || null;
    var info = {
      multiTask: false, ntask: 1, descDim: descDim, nsamples: null,
      taskWeighting: (inInfo && inInfo.taskWeighting) || (outInfo && outInfo.taskWeighting) || 1,
      scmt: !!(inInfo && inInfo.scmt) || !!(outInfo && outInfo.scmt),
      taskStd: (outInfo && outInfo.taskStd) || [],
      taskSizeSource: null, tasks: null, issues: issues,
      declaredDescDim: inInfo && inInfo.descDim !== null ? inInfo.descDim : null,
      declaredNtask: declaredNtask,
    };

    var rowLens = coeffs.map(function (c) { return c.length; });
    var rowLen = rowLens.length ? rowLens[0] : 0;
    var ragged = -1;
    for (var i = 1; i < rowLens.length; i++) {
      if (rowLens[i] !== rowLen) { ragged = i; break; }
    }
    if (ragged >= 0) {
      err("ragged-coeffs",
        "Coefficient rows have inconsistent lengths (row 1 has " + rowLen + " value(s), row " +
        (ragged + 1) + " has " + rowLens[ragged] + " value(s)) — the file looks truncated.");
    }
    // Nothing below can be decided from an ambiguous layout.
    if (mixedDims || ragged >= 0) return info;

    if (info.declaredDescDim !== null && info.declaredDescDim !== descDim) {
      warn("desc-dim-mismatch",
        "SISSO.in declares desc_dim=" + info.declaredDescDim + " but every ranked model uses " +
        descDim + " descriptor(s). The ranked-model file wins; check that the loaded files " +
        "belong to the same run.");
    }

    var n = train ? train.n : 0;

    if (!rowLen || rowLen === descDim + 1) {
      // Single-task layout: ntask must not be declared as > 1.
      if (declaredNtask && declaredNtask > 1) {
        warn("ntask-mismatch",
          "SISSO.in / SISSO.out declare ntask=" + declaredNtask + " but the coefficient rows " +
          "hold a single task's worth of values (" + (descDim + 1) + "). Treated as a " +
          "single-task run; check that the loaded files belong to the same run.");
      }
      return info;
    }

    if (rowLen % (descDim + 1) !== 0) {
      err("bad-coeff-length",
        "Coefficient rows hold " + rowLen + " value(s), which is neither " + (descDim + 1) +
        " (one task) nor a whole multiple of it. The coefficient file does not belong to " +
        "this ranked-model file.");
      return info;
    }

    var ntask = rowLen / (descDim + 1);
    info.multiTask = true;
    info.ntask = ntask;

    if (declaredNtask && declaredNtask !== ntask) {
      warn("ntask-mismatch",
        "SISSO.in / SISSO.out declare ntask=" + declaredNtask + " but the coefficient rows " +
        "carry " + ntask + " task block(s) of " + (descDim + 1) + " value(s) each. The " +
        "coefficient layout (" + ntask + " tasks) is used; check that the loaded files belong " +
        "to the same run.");
    }

    var nsamples = null, source = null;
    if (inInfo && inInfo.nsamples && inInfo.nsamples.length === ntask) {
      nsamples = inInfo.nsamples.map(function (v) { return Math.round(v); });
      source = "SISSO.in";
    } else if (outInfo && outInfo.nsamples && outInfo.nsamples.length === ntask) {
      nsamples = outInfo.nsamples.slice();
      source = "SISSO.out";
    }
    if (!nsamples) {
      var declaredSizes = (inInfo && inInfo.nsamples) || (outInfo && outInfo.nsamples) || null;
      if (declaredSizes && declaredSizes.length !== ntask) {
        err("task-count-mismatch",
          "The task sample list (" + declaredSizes.join(", ") + ") holds " + declaredSizes.length +
          " value(s) but the coefficient rows imply " + ntask + " task(s).");
      } else {
        err("unknown-task-sizes",
          "Multi-task coefficient layout detected (" + ntask + " tasks × " + (descDim + 1) +
          " coefficients per model) but the per-task sample counts are unknown. Load SISSO.in " +
          "(nsample=n1,n2,…) or SISSO.out — both record how train.dat is split into tasks.");
      }
      return info;
    }

    var total = 0;
    for (var s = 0; s < nsamples.length; s++) total += nsamples[s];
    if (total !== n) {
      err("task-size-mismatch",
        "Multi-task sample counts from " + source + " (" + nsamples.join(" + ") + " = " + total +
        ") do not add up to the " + n + " data row(s) in train.dat. train.dat must hold the " +
        "task blocks stacked vertically under a single header.");
      return info;
    }

    var tasks = [];
    var start = 0;
    for (var t = 0; t < ntask; t++) {
      tasks.push({
        key: "t" + (t + 1),
        index: t + 1,
        label: "task_" + ("00" + (t + 1)).slice(-3),
        start: start,
        n: nsamples[t],
        std: outInfo && outInfo.taskStd ? outInfo.taskStd[t] : undefined,
        data: sliceDataset(train, start, nsamples[t]),
      });
      start += nsamples[t];
    }
    info.nsamples = nsamples;
    info.taskSizeSource = source;
    info.tasks = tasks;
    return info;
  }

  // Pipeline entry point for the layout question: identical resolution, but it
  // fails fast so a broken file set surfaces as one clear error.
  function detectMultiTask(files, top, coeffs, train) {
    return resolveLayout(files, top, coeffs, train, { strict: true });
  }

  // files: { trainText, verifyText?, topText, coeffText, uspaceText,
  //          sissoInText?, sissoOutText? }
  function runPipeline(files) {
    var headerNames = readHeaderNames(files.trainText);
    var nameMap = makeNameMap(headerNames);
    var renamer = buildRenamer(nameMap);

    var top = parseTopFile(files.topText);
    var coeffs = parseCoeffFile(files.coeffText);
    if (top.ranks.length !== coeffs.length) {
      throw new Error(
        "Row-count mismatch: " + top.ranks.length + " models in top file but " +
        coeffs.length + " rows in coefficient file."
      );
    }

    // Only rename features actually referenced by the top models (not the
    // whole 100k-line Uspace), which keeps parsing near-instant.
    var needed = new Set();
    top.featureLists.forEach(function (ids) {
      ids.forEach(function (id) { needed.add(id); });
    });
    var uspace = parseUspace(files.uspaceText, renamer, needed);

    var train = parseDataFile(files.trainText, nameMap);
    var verify = files.verifyText ? parseDataFile(files.verifyText, nameMap) : null;
    var targetLetter = nameMap[1].new_name; // 'b'
    var yTrain = Array.from(train.cols[targetLetter]);
    var yVerify = verify ? Array.from(verify.cols[targetLetter]) : null;

    // Single-task vs multi-task (MT-SISSO) layout, resolved from the coefficient
    // row length + SISSO.in / SISSO.out task bookkeeping.
    var mt = detectMultiTask(files, top, coeffs, train);

    // MT-SISSO produces no verify.dat, and a hold-out row carries no task
    // identity — SISSO.in only splits train.dat, so there is no defensible way to
    // decide which task's coefficients a verify row belongs to. Rather than
    // emitting permanently empty verify / Δ columns, drop the file and record
    // that we did (the health check reports it as a warning).
    var verifyIgnored = false;
    if (mt.multiTask && verify) {
      verify = null;
      yVerify = null;
      verifyIgnored = true;
    }

    // `descDim` is taken from the first ranked model (a top file holds one
    // descriptor dimension; resolveLayout rejects a file whose models disagree).
    var models = [];
    for (var mi = 0; mi < top.ranks.length; mi++) {
      var ids = top.featureLists[mi];
      var co = coeffs[mi];
      var perTask = mt.ntask > 1 ? taskCoeffBlocks(co, mt.ntask) : [co];
      if (!perTask || perTask[0].length !== ids.length + 1) {
        throw new Error(
          "Model " + (mi + 1) + ": expected " + (ids.length + 1) +
          " coefficients per task (intercept + " + ids.length + " features) but found " +
          co.length + " value(s) across " + mt.ntask + " task(s)."
        );
      }

      // The descriptor set is shared by every task, so the term list is built
      // once and only the coefficients differ per task.
      var descRecs = [];
      var termBodies = [];
      for (var k = 0; k < ids.length; k++) {
        var fid = ids[k];
        var fNew = uspace.idToRenamed.get(fid);
        var fOrig = uspace.idToOrig.get(fid);
        if (fNew === undefined) {
          throw new Error("Model " + (mi + 1) + ": feature id " + fid + " missing from Uspace.expressions.");
        }
        termBodies.push({ renamed: fNew, original: fOrig });
        // Structured per-term record: the Uspace id plus the descriptor
        // expression in original- and renamed-feature spelling. Feature /
        // descriptor usage statistics and "contains" matching are built from
        // these records (never from the formatted coefficient string).
        descRecs.push({ id: fid, original: fOrig, renamed: fNew });
      }

      // One formula per task: c0 + c1·d1 + … with that task's own coefficients.
      var formulasNew = [], formulasOrig = [];
      for (var ti = 0; ti < perTask.length; ti++) {
        var tc = perTask[ti];
        var tNew = [], tOrig = [];
        for (var q = 0; q < ids.length; q++) {
          tNew.push("(" + tc[q + 1] + ")*(" + termBodies[q].renamed + ")");
          tOrig.push("(" + tc[q + 1] + ")*(" + termBodies[q].original + ")");
        }
        formulasNew.push("(" + tc[0] + ") + " + tNew.join(" + "));
        formulasOrig.push("(" + tc[0] + ") + " + tOrig.join(" + "));
      }

      models.push({
        rank: top.ranks[mi],
        // `formula` / `formulaOriginal` stay a single expression for the legacy
        // single-formula UI. A multi-task model additionally carries the full
        // per-task list (formulasByTask / coefficientsByTask).
        formula: formulasNew[0],
        formulaOriginal: formulasOrig[0],
        formulasByTask: mt.ntask > 1 ? formulasNew : null,
        formulasOriginalByTask: mt.ntask > 1 ? formulasOrig : null,
        coefficientsByTask: mt.ntask > 1 ? perTask : null,
        descriptors: descRecs,
        featureIds: ids.slice(),
        rmseSisso: top.rmses[mi],
        maxaeSisso: top.maxaes[mi],
        pred: {},
        metrics: {},
        predTrain: null,
        predVerify: null,
        metricsTrain: null,
        metricsVerify: null,
      });
    }

    // The formula evaluator must only ever see the *feature* columns, never the
    // sample-id or the target property. This prevents a malformed formula from
    // silently reading the answer it is supposed to predict.
    var featureSet = {};
    train.featureLetters.forEach(function (letter) { featureSet[letter] = true; });

    // Predict one model over one dataset slice with one formula.
    function predictOver(model, formulaText, data, label) {
      var fn;
      try {
        fn = compileFormula(formulaText);
      } catch (err) {
        model.error = model.error || ("formula compile failed (" + label + "): " + err.message);
        return null;
      }
      var pred = new Float64Array(data.n);
      for (var i = 0; i < data.n; i++) {
        pred[i] = fn(makeFeatureGetter(data.cols, featureSet, i));
      }
      return pred;
    }

    models.forEach(function (model) {
      if (mt.ntask > 1) {
        // Per-task predictions, then the pooled series over the stacked rows so
        // the "train" dataset (and its scatter / residual histogram) covers
        // every sample exactly once, in train.dat order.
        var pooled = new Float64Array(train.n);
        var anyTask = false;
        for (var t = 0; t < mt.tasks.length; t++) {
          var task = mt.tasks[t];
          var predTask = predictOver(model, model.formulasByTask[t], task.data, task.label);
          if (!predTask) continue;
          anyTask = true;
          pooled.set(predTask, task.start);
          model.pred[task.key] = predTask;
          model.metrics[task.key] = computeMetrics(
            Array.from(task.data.cols[targetLetter]), predTask);
        }
        if (anyTask) {
          model.pred.train = pooled;
          model.metrics.train = computeMetrics(yTrain, pooled);
        } else {
          model.metrics.train = computeMetrics(yTrain, new Float64Array(train.n).fill(NaN));
        }
        if (!model.metrics.train.ok) {
          model.error = model.error || "non-finite predictions on the pooled train set";
        }
        // Legacy aliases: "train" is the pooled dataset, there is no verify.dat
        // in an MT-SISSO run.
        model.predTrain = model.pred.train || null;
        model.metricsTrain = model.metrics.train;
        model.metricsVerify = null;
        model.predVerify = null;
        // SISSO's own overall score (task-balanced / sample-weighted aggregate).
        var agg = aggregateTaskMetrics(
          mt.tasks.map(function (tk) { return model.metrics[tk.key]; }),
          mt.nsamples, mt.taskWeighting);
        model.overallRmse = agg.rmse;
        model.overallMaxae = agg.maxae;
        return;
      }

      var predTrain = predictOver(model, model.formula, train, "train");
      if (predTrain) {
        model.pred.train = predTrain;
        model.predTrain = predTrain;
        model.metrics.train = computeMetrics(yTrain, predTrain);
        model.metricsTrain = model.metrics.train;
        if (!model.metricsTrain.ok) {
          model.error = model.error || "non-finite predictions on train set";
        }
      } else {
        model.metrics.train = computeMetrics(yTrain, new Float64Array(train.n).fill(NaN));
        model.metricsTrain = model.metrics.train;
      }

      if (verify) {
        var predVerify = predictOver(model, model.formula, verify, "verify");
        if (predVerify) {
          model.pred.verify = predVerify;
          model.predVerify = predVerify;
          model.metrics.verify = computeMetrics(yVerify, predVerify);
          model.metricsVerify = model.metrics.verify;
        }
      }
    });

    var sameAsTrain = files.verifyText && files.verifyText.trim() === files.trainText.trim();
    return {
      meta: {
        nTrain: train.n,
        nVerify: verify ? verify.n : 0,
        nFeatures: nameMap.length - 2,
        nModels: models.length,
        targetLetter: targetLetter,
        targetName: nameMap[1].original_name,
        validationNote: sameAsTrain ? "in-sample" : null,
        // Multi-task bookkeeping (null/false for an ordinary single-task run).
        multiTask: mt.multiTask,
        ntask: mt.ntask,
        nsamples: mt.nsamples,
        taskWeighting: mt.taskWeighting,
        scmt: mt.scmt,
        taskStd: mt.taskStd,
        taskSizeSource: mt.taskSizeSource,
        // True when a verify.dat was supplied for a multi-task run and dropped.
        verifyIgnored: verifyIgnored,
        // SISSO.in's declared desc_dim when it disagrees with the ranked-model
        // file (the file wins; this is what the health check reports on).
        declaredDescDim: mt.declaredDescDim === undefined ? null : mt.declaredDescDim,
        declaredNtask: mt.declaredNtask === undefined ? null : mt.declaredNtask,
        tasks: mt.tasks
          ? mt.tasks.map(function (t) {
            return { key: t.key, index: t.index, label: t.label, start: t.start, n: t.n, std: t.std };
          })
          : null,
      },
      columns: makeColumns(nameMap),
      train: train,
      verify: verify,
      tasks: mt.tasks || null,
      models: models,
    };
  }

  return {
    FUNCS: FUNCS,
    letterSeries: letterSeries,
    readHeaderNames: readHeaderNames,
    makeNameMap: makeNameMap,
    buildRenamer: buildRenamer,
    parseTopFile: parseTopFile,
    parseCoeffFile: parseCoeffFile,
    parseUspace: parseUspace,
    parseSissoIn: parseSissoIn,
    parseSissoOutTasks: parseSissoOutTasks,
    sissoInEntries: sissoInEntries,
    taskCoeffBlocks: taskCoeffBlocks,
    sliceDataset: sliceDataset,
    aggregateTaskMetrics: aggregateTaskMetrics,
    detectMultiTask: detectMultiTask,
    resolveLayout: resolveLayout,
    compileFormula: compileFormula,
    formulaAst: formulaAst,
    formulaToPlain: formulaToPlain,
    formulaToLatex: formulaToLatex,
    formulaToUnicodeMath: formulaToUnicodeMath,
    computeMetrics: computeMetrics,
    errorSeries: errorSeries,
    finiteResiduals: finiteResiduals,
    residualStats: residualStats,
    autoBinCount: autoBinCount,
    errorHistogram: errorHistogram,
    spearman: spearman,
    pearson: pearson,
    parseDataFile: parseDataFile,
    makeFeatureGetter: makeFeatureGetter,
    runPipeline: runPipeline,
    parseUnitMatrix: parseUnitMatrix,
    groupUnitRows: groupUnitRows,
    paretoScore: paretoScore,
    paretoFront2D: paretoFront2D,
    paretoFront3D: paretoFront3D,
    paretoFormula: paretoFormula,
    paretoExportRows: paretoExportRows,
    csvField: csvField,
    rowsToCsv: rowsToCsv,
    metricValue: metricValue,
    modelPrediction: modelPrediction,
    metricSortEndpoint: metricSortEndpoint,
    deltaMetricValue: deltaMetricValue,
    deltaDirection: deltaDirection,
    availableDatasets: availableDatasets,
    datasetData: datasetData,
    datasetTask: datasetTask,
    paretoAxesEqual: paretoAxesEqual,
    paretoAxesDistinct: paretoAxesDistinct,
    paretoDefaultAxes: paretoDefaultAxes,
    normalizeModelStates: normalizeModelStates,
    modelStatesToJSON: modelStatesToJSON,
    modelExcluded: modelExcluded,
    modelFavorite: modelFavorite,
    compareMetricRows: compareMetricRows,
    compareSampleMatrix: compareSampleMatrix,
    uniqueIdentifiers: uniqueIdentifiers,
    normalizeDescriptorText: normalizeDescriptorText,
    descriptorTextsOf: descriptorTextsOf,
    descriptorKeysOf: descriptorKeysOf,
    modelFeatureNames: modelFeatureNames,
    modelUsesFeature: modelUsesFeature,
    modelsWithFeature: modelsWithFeature,
    modelUsesDescriptor: modelUsesDescriptor,
    modelsWithDescriptor: modelsWithDescriptor,
    featureUsage: featureUsage,
    descriptorUsage: descriptorUsage,
    usageReport: usageReport,
    batchSetModelStates: batchSetModelStates,
    undoBatchModels: undoBatchModels,
  };
});
