import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { planJevReview, scoreJevPlan, selectJevCandidates, jevReviewMarkdown, callJev, validateJevResponse,
  JEV_MODEL, JEV_DIMENSIONS } from "../src/index.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sage-jev-"));
  fs.mkdirSync(path.join(root, "Models"));
  fs.mkdirSync(path.join(root, "SIS_subspaces"));
  fs.writeFileSync(path.join(root, "train.dat"), "name target f1 f2\nt1 1 1 4\nt2 2 2 3\nt3 3 3 2\nt4 4 4 1\n");
  fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\nv1 5 5 0\nv2 6 6 -1\n");
  fs.writeFileSync(path.join(root, "Models", "top0004_D001"), "Rank RMSE MaxAE Feature_ID\n1 0.0 0.0 ( 1)\n2 0.0 0.0 ( 2)\n3 1.0 1.0 ( 3)\n4 0.0 0.0 ( 1)\n");
  fs.writeFileSync(path.join(root, "Models", "top0004_D001_coeff"), "Model_ID c0 c1\n1 0 1\n2 5 -1\n3 0 1\n4 0 1\n");
  fs.writeFileSync(path.join(root, "SIS_subspaces", "Uspace.expressions"), "(f1) SIS_score = 1\n(f2) SIS_score = 0.9\n(f1/f2) SIS_score = 0.8\n");
  fs.writeFileSync(path.join(root, "sage.features.json"), JSON.stringify({ schemaVersion: "1.0.0", features: {
    f1: { description: "Measured energy", unit: "eV", reviewStatus: "confirmed", source: { file: "features.py", function: "compute_f1" } },
    f2: { description: "Second measured energy", unit: "eV", reviewStatus: "confirmed", source: { file: "features.py", function: "compute_f2" } },
  } }));
  fs.writeFileSync(path.join(root, "features.py"), "def compute_f1(s):\n    return s.first\n\ndef compute_f2(s):\n    return s.second\n");
  return root;
}

const context = { target: { description: "Response energy", unit: "eV" }, researchQuestion: "Predict response energy using available measurements." };

function response(request, { level = 2, availability = "assessable", confidence = 1 } = {}) {
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id,
    question.type === "choice" ? { type: "choice", choice: availability, confidence,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === availability ? 1 : 0])) }
      : { type: "score", score: level, confidence,
        legend: Object.fromEntries(question.criteria.map((text, i) => [i, text])),
        probabilities: Object.fromEntries(question.criteria.map((_, i) => [i, i === level ? 1 : 0])) },
  ])), usage: { input_tokens: 1000, output_tokens: 100 } };
}

test("response validation accepts rounded API distributions but rejects impossible scores and probability mass", () => {
  const request = { model: JEV_MODEL, questions: { grade: { type: "score", criteria: ["a", "b", "c", "d"] } } };
  const make = (probabilities, score) => ({ model: JEV_MODEL, answers: { grade: { type: "score", probabilities, score, confidence: 0.9 } } });
  // Captured live response: the provider score uses probabilities before rounding.
  validateJevResponse(make({ 0: 0.02, 1: 0.9, 2: 0.08, 3: 0 }, 1.07), request);
  validateJevResponse(make({ 0: 0.11, 1: 0.01, 2: 0.3, 3: 0.58 }, 2.37), request);
  validateJevResponse(make({ 0: 0.01, 1: 0.92, 2: 0.07, 3: 0.01 }, 1.07), request);
  assert.throws(() => validateJevResponse(make({ 0: 0.02, 1: 0.9, 2: 0.08, 3: 0 }, 1.2), request), /expectation/);
  assert.throws(() => validateJevResponse(make({ 0: 0.02, 1: 0.9, 2: 0.08, 3: 0.1 }, 1.07), request), /sum/);
  assert.throws(() => validateJevResponse(make({ 0: 0, 1: 0, 2: 1, 3: 0 }, 2.03), request), /expectation/);
});

test("plan covers every fitted candidate, audits domains, traces definitions, and deduplicates identical requests", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = planJevReview(root, { context, sourceRoot: root });
  assert.equal(plan.coverage.total, 4);
  assert.equal(plan.coverage.included, 4);
  assert.equal(plan.coverage.blocked, 1);
  assert.equal(plan.coverage.uniqueRequests, 2);
  assert.ok(plan.models[2].blockers.includes("observed-domain-failure"));
  assert.match(plan.definitions.f1.sourceEvidence.preferredDefinition.text, /s.first/);
  assert.deepEqual(Object.keys(plan.models[0].evidence.metrics.verify), ["rmse", "mae", "maxae", "r2", "rho"]);
  assert.equal(plan.models[0].requestHash, plan.models[3].requestHash);
  assert.equal("rank" in plan.models[0].request.state.formula, false, "SISSO rank must not bias the semantic judge");
  assert.equal(JSON.stringify(plan.models[0].request).includes('"v1"'), false, "sample rows are not transmitted");
  assert.equal(planJevReview(root, { context, sourceRoot: root, limit: 2 }).coverage.truncated, true);
});

test("all dimensions and model files retain their identities across directory and archive inputs", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Models", "top0001_D002"), "Rank RMSE MaxAE Feature_ID\n1 0.0 0.0 ( 1 2)\n");
  fs.writeFileSync(path.join(root, "Models", "top0001_D002_coeff"), "Model_ID c0 c1 c2\n1 0 1 0\n");
  const plan = planJevReview(root, { context });
  assert.equal(plan.coverage.total, 5);
  assert.equal(new Set(plan.models.map((item) => item.id)).size, 5);
  assert.deepEqual([...new Set(plan.models.map((item) => item.evidence.descriptorDimension))].sort(), [1, 2]);
  const selected = planJevReview(root, { context, topFile: path.join(root, "Models", "top0004_D001") });
  assert.equal(selected.coverage.total, 4);
  const chunks = [];
  for (const relative of ["train.dat", "verify.dat", "SIS_subspaces/Uspace.expressions", "Models/top0004_D001", "Models/top0004_D001_coeff", "Models/top0001_D002", "Models/top0001_D002_coeff"]) {
    const data = fs.readFileSync(path.join(root, relative));
    const header = Buffer.alloc(512);
    header.write(`run/${relative}`);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header[156] = 48;
    chunks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  const archive = path.join(root, "run.tgz");
  fs.writeFileSync(archive, zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])));
  assert.equal(planJevReview(archive, { context }).coverage.total, 5);
});

test("API transport uses the official endpoint, honors backoff, never leaks provider error bodies, and validates probabilities", async () => {
  const request = { model: JEV_MODEL, state: {}, questions: { x: { type: "score", instructions: "Test", criteria: ["low", "high"] } } };
  const good = { model: JEV_MODEL, answers: { x: { type: "score", score: 0.75, confidence: 0.5, probabilities: { 0: 0.25, 1: 0.75 } } } };
  const waits = [];
  let calls = 0;
  const result = await callJev(request, { apiKey: "unit-test-key", sleep: async (ms) => waits.push(ms), fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.headers.Authorization, "Bearer unit-test-key");
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body), request);
    return ++calls === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "0.01" } }) : Response.json(good);
  } });
  assert.equal(result.answers.x.score, 0.75);
  assert.deepEqual(waits, [10]);
  await assert.rejects(callJev(request, { apiKey: "secret", fetchImpl: async () => new Response("secret private state", { status: 401 }) }), /HTTP 401/);
  await assert.rejects(callJev(request, { apiKey: "secret", retries: 0, fetchImpl: async () => { throw new Error("secret"); } }), (error) => !error.message.includes("secret"));
  assert.throws(() => validateJevResponse({ ...good, model: "jev-wrong" }, request), /different model/);
  assert.throws(() => validateJevResponse({ ...good, answers: { x: { ...good.answers.x, score: 0.1 } } }, request), /expectation/);
  assert.throws(() => validateJevResponse({ ...good, answers: { x: { ...good.answers.x, probabilities: { 0: 0.1, 1: 0.1 } } } }, request), /sum/);
});

test("checkpoint reuses exact evidence, retries failures, and invalidates changed context", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = planJevReview(root, { context });
  const checkpoint = path.join(root, "review.checkpoint.jsonl");
  let calls = 0;
  const partial = await scoreJevPlan(plan, { checkpoint, concurrency: 1, callImpl: async (request) => {
    if (++calls === 2) throw new Error("simulate transient failure");
    return response(request);
  } });
  assert.equal(partial.coverage.scored, 2);
  assert.equal(partial.coverage.errors, 1);
  calls = 0;
  const complete = await scoreJevPlan(plan, { checkpoint, resume: true, callImpl: async (request) => { calls++; return response(request); } });
  assert.equal(calls, 1);
  assert.equal(complete.execution.cachedRequests, 1);
  assert.equal(complete.coverage.scored, 3);
  assert.equal(complete.coverage.errors, 0);
  await assert.rejects(scoreJevPlan(plan, { checkpoint, callImpl: async (request) => response(request) }), /already exists/);
  const changed = planJevReview(root, { context: { ...context, deployment: { description: "New deployment" } } });
  calls = 0;
  await scoreJevPlan(changed, { checkpoint, resume: true, callImpl: async (request) => { calls++; return response(request); } });
  assert.equal(calls, 2, "changed evidence must not reuse stale judgments");
});

test("missing definitions, missing dimension evidence and low confidence never become automatic positive semantic evidence", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missingTarget = await scoreJevPlan(planJevReview(root), { callImpl: async (request) => response(request, { level: 3 }) });
  assert.ok(Object.values(missingTarget.models[0].semanticAssessment).every((result) => result.status === "not-assessable" && result.score === null));
  const insufficient = await scoreJevPlan(planJevReview(root, { context }), { callImpl: async (request) => response(request, { availability: "insufficient" }) });
  assert.ok(Object.values(insufficient.models[0].semanticAssessment).every((result) => result.normalizedScore === null));
  const uncertain = await scoreJevPlan(planJevReview(root, { context }), { callImpl: async (request) => response(request, { confidence: 0.2 }) });
  assert.ok(Object.values(uncertain.models[0].semanticAssessment).every((result) => result.status === "needs-review"));
  assert.ok(selectJevCandidates(uncertain).candidates.every((candidate) => candidate.evidenceFor.every((entry) => entry.kind !== "scientific-inference")));
  const raw = JSON.parse(fs.readFileSync(path.join(root, "sage.features.json"), "utf8"));
  raw.features.f1.reviewStatus = "ai-draft";
  fs.writeFileSync(path.join(root, "sage.features.json"), JSON.stringify(raw));
  const unconfirmed = await scoreJevPlan(planJevReview(root, { context }), { callImpl: async (request) => response(request) });
  assert.equal(unconfirmed.models[0].semanticAssessment.descriptorMeaning.status, "not-assessable");
});

test("semantic review cannot rescue invalid or predictively uncompetitive models, and duplicate descriptor structures collapse", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = await scoreJevPlan(planJevReview(root, { context }), { callImpl: async (request) => response(request, { level: 3 }) });
  report.models.push({ ...structuredClone(report.models[1]), id: "poor-model", predictive: { ...report.models[1].predictive, value: 10 } });
  const selection = selectJevCandidates(report, { limit: 5 });
  assert.equal(selection.candidates.length, 2);
  assert.ok(selection.candidates.every((item) => item.rank !== 3 && item.id !== "poor-model"));
  assert.equal(selection.methodology.compositeEleganceScore, false);
  assert.equal(selectJevCandidates(report, { limit: 1 }).candidates.length, 1);
  assert.ok(selection.candidates.every((item) => item.evidenceAgainst.length));
  assert.match(jevReviewMarkdown(selection), /完整公式/);
  assert.match(jevReviewMarkdown(selection), /Agent 应逐项说明/);
  assert.equal(Object.keys(selection.candidates[0].semanticAssessment).length, Object.keys(JEV_DIMENSIONS).length);
});

test("train-only and non-independent verify evidence retain the correct generalization status", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\nt1 1 1 4\nv2 6 6 -1\n");
  assert.equal(planJevReview(root, { context }).models[0].predictive.generalizationStatus, "non-independent");
  fs.unlinkSync(path.join(root, "verify.dat"));
  const plan = planJevReview(root, { context });
  assert.equal(plan.models[0].predictive.dataset, "train");
  assert.equal(plan.models[0].predictive.generalizationStatus, "not-assessable");
});

test("multi-task review retains per-task formulas, pooled metrics and SISSO aggregate evidence", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.unlinkSync(path.join(root, "verify.dat"));
  fs.writeFileSync(path.join(root, "SISSO.in"), "ntask=2\nnsample=2,2\ntask_weighting=1\ndesc_dim=1\n");
  fs.writeFileSync(path.join(root, "Models", "top0004_D001_coeff"), "Model_ID task_coefficients\n1 0 1 0 1\n2 5 -1 5 -1\n3 0 1 0 1\n4 0 1 0 1\n");
  const ratioRmse = Math.sqrt((0.75 ** 2 + (4 / 3) ** 2 + 1.5 ** 2) / 4);
  fs.writeFileSync(path.join(root, "Models", "top0004_D001"), `Rank RMSE MaxAE Feature_ID\n1 0.0 0.0 ( 1)\n2 0.0 0.0 ( 2)\n3 ${ratioRmse} 1.5 ( 3)\n4 0.0 0.0 ( 1)\n`);
  const plan = planJevReview(root, { context });
  assert.deepEqual(Object.keys(plan.models[0].evidence.metrics), ["train", "t1", "t2"]);
  assert.deepEqual(plan.models[0].evidence.formulas.map((formula) => formula.dataset), ["t1", "t2"]);
  assert.equal(plan.models[0].predictive.dataset, "sisso-overall");
  assert.equal(plan.models[0].predictive.value, 0);
  assert.equal(plan.models[0].predictive.generalizationStatus, "not-assessable");
});

test("resume repairs only a partial trailing checkpoint and can rebuild a fully cached report without a key", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = planJevReview(root, { context });
  const checkpoint = path.join(root, "partial.checkpoint.jsonl");
  await scoreJevPlan(plan, { checkpoint, callImpl: async (request) => response(request) });
  fs.appendFileSync(checkpoint, '{"incomplete":');
  const rebuilt = await scoreJevPlan(plan, { checkpoint, resume: true });
  assert.equal(rebuilt.coverage.scored, 3);
  assert.equal(rebuilt.execution.calledRequests, 0);
  assert.equal(fs.readFileSync(checkpoint, "utf8").endsWith("\n"), true);
  fs.writeFileSync(checkpoint, "invalid\n");
  await assert.rejects(scoreJevPlan(plan, { checkpoint, resume: true }), /line 1/);
});

test("401 stops starting new jobs and bounded concurrency limits in-flight requests", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = planJevReview(root, { context });
  let calls = 0;
  const stopped = await scoreJevPlan(plan, { concurrency: 1, callImpl: async () => { calls++; throw new Error("Jev API returned HTTP 401: check access."); } });
  assert.equal(calls, 1);
  assert.match(stopped.execution.stopReason, /HTTP 401/);
  assert.equal(stopped.coverage.errors, 3);
  let active = 0;
  let maximum = 0;
  await scoreJevPlan(plan, { concurrency: 1, callImpl: async (request) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return response(request);
  } });
  assert.equal(maximum, 1);
});

test("CLI protects original SISSO inputs and reports/selects cached evidence without network access", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const train = path.join(root, "train.dat");
  const original = fs.readFileSync(train, "utf8");
  const blocked = spawnSync(process.execPath, ["bin/sisso-sage.mjs", "jev-plan", root, "--output", train], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /overwrite an input/);
  assert.equal(fs.readFileSync(train, "utf8"), original);
  const report = await scoreJevPlan(planJevReview(root, { context }), { callImpl: async (request) => response(request) });
  const scores = path.join(root, "test.jev.scores.json");
  fs.writeFileSync(scores, JSON.stringify(report));
  const shortlist = spawnSync(process.execPath, ["bin/sisso-sage.mjs", "jev-select", scores], { encoding: "utf8" });
  assert.equal(shortlist.status, 0, shortlist.stderr);
  assert.equal(JSON.parse(shortlist.stdout).candidates.length, 2);
  const markdown = path.join(root, "review.md");
  const generated = spawnSync(process.execPath, ["bin/sisso-sage.mjs", "jev-report", scores, "--output", markdown], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(fs.readFileSync(markdown, "utf8"), /公式审查/);
});

test("CLI dry-run creates a complete plan without API credentials; invalid health stops planning", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contextFile = path.join(root, "context.json");
  fs.writeFileSync(contextFile, JSON.stringify(context));
  const output = path.join(root, "review.jev.plan.json");
  const args = ["bin/sisso-sage.mjs", "jev-plan", root, "--context", contextFile, "--source-root", root, "--output", output, "--compact"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).coverage.total, 4);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).coverage.uniqueRequests, 2);
  fs.writeFileSync(path.join(root, "train.dat"), "broken\n");
  const broken = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(broken.status, 0);
  assert.equal(JSON.parse(broken.stderr).health.level, "error");
});
