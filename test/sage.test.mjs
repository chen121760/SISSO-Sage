import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { analyzeDirectory, buildBundle, paretoModels, readTarEntries, selectModels, traceFeatureSource } from "../src/index.mjs";
import { createSissoSageMcpServer } from "../mcp/server.mjs";

function tinyTar(name, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header[156] = "0".charCodeAt(0);
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sisso-sage-"));
  fs.mkdirSync(path.join(root, "Models"));
  fs.mkdirSync(path.join(root, "SIS_subspaces"));
  fs.writeFileSync(path.join(root, "train.dat"), "name target f1 f2\ns1 1 1 4\ns2 2 2 3\ns3 3 3 2\ns4 4 4 1\n");
  fs.writeFileSync(path.join(root, "verify.dat"), "name target f1 f2\nv1 5 5 0\nv2 6 6 -1\n");
  fs.writeFileSync(path.join(root, "Models", "top0003_D001"), "Rank RMSE MaxAE Feature_ID\n1 0.0 0.0 ( 1)\n2 1.0 2.0 ( 2)\n3 0.5 1.0 ( 3)\n");
  fs.writeFileSync(path.join(root, "Models", "top0003_D001_coeff"), "Model_ID c0 c1\n1 0 1\n2 5 -1\n3 0 0.8\n");
  fs.writeFileSync(path.join(root, "SIS_subspaces", "Uspace.expressions"), "(f1) SIS_score = 1\n(f2) SIS_score = 0.8\n(f1/f2) SIS_score = 0.7\n");
  fs.writeFileSync(path.join(root, "sage.features.json"), JSON.stringify({ schemaVersion: "1.0.0", features: {
    f1: { description: "Primary measurement", unit: "eV", source: { file: "features.py", function: "f1" } },
    f2: { description: "Secondary measurement", unit: "eV", source: { file: "features.py", function: "f2" } }
  }}));
  fs.writeFileSync(path.join(root, "features.py"), "def compute_f1(structure):\n    return structure.value  # f1\n");
  return root;
}

test("analyzes a directory into AI-readable model evidence", () => {
  const root = fixture();
  try {
    const analysis = analyzeDirectory(root);
    assert.equal(analysis.health.level, "pass");
    assert.equal(analysis.result.meta.nModels, 3);
    assert.deepEqual(analysis.summaries[0].features, ["f1"]);
    assert.equal(analysis.summaries[0].interpretabilityEvidence.status, "evidence-supported");
    assert.equal(analysis.summaries[2].interpretabilityEvidence.risks[0].code, "singularity");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builds Pareto and multi-role recommendations", () => {
  const root = fixture();
  try {
    const analysis = analyzeDirectory(root);
    const pareto = paretoModels(analysis.result);
    assert.equal(pareto.evaluation.dataset, "verify");
    assert.ok(pareto.front.some((point) => point.rank === 1));
    const selection = selectModels(analysis.result, analysis.summaries, { limit: 4 });
    assert.ok(selection.recommendations.length >= 1);
    assert.ok(selection.recommendations.some((item) => item.roles.includes("predictive")));
    const bundle = buildBundle(analysis);
    assert.equal(bundle.schemaVersion, "1.0.0");
    assert.equal(bundle.models.length, 3);
    assert.equal(bundle.provenance.generator, "SISSO-Sage");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI inspection, Pareto, and selection emit valid JSON", () => {
  const root = fixture();
  const cli = path.resolve("bin", "sisso-sage.mjs");
  try {
    for (const command of ["inspect", "pareto", "select"]) {
      const run = spawnSync(process.execPath, [cli, command, root, "--compact"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const output = JSON.parse(run.stdout);
      assert.ok(output.kind.startsWith("sisso-sage-"));
      if (command === "pareto") {
        assert.equal(output.evaluation.dataset, "verify");
        assert.ok(output.front.length > 0);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("traces exact feature identifiers in extraction source", () => {
  const root = fixture();
  try {
    const trace = traceFeatureSource("f1", root);
    assert.equal(trace.status, "matches-found");
    assert.ok(trace.matches.some((match) => match.file === "features.py"));
    assert.ok(trace.matches.every((match) => !match.text.includes("f10")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reads gzip-compressed TAR entries without extracting them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sisso-sage-tar-"));
  const archive = path.join(root, "run.tgz");
  try {
    fs.writeFileSync(archive, zlib.gzipSync(tinyTar("run/train.dat", "name target f1\ns1 1 1\n")));
    const entries = readTarEntries(archive);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "run/train.dat");
    assert.match(entries[0].data.toString("utf8"), /s1 1 1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP client discovers and calls the read-only SISSO tools", async () => {
  const root = fixture();
  const server = createSissoSageMcpServer();
  const client = new Client({ name: "sisso-sage-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "get_capabilities",
      "inspect_run",
      "list_models",
      "get_model",
      "compare_models",
      "pareto_frontier",
      "select_candidates",
      "feature_context",
    ]);
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));

    const inspected = await client.callTool({ name: "inspect_run", arguments: { run: root } });
    assert.equal(inspected.isError, undefined);
    assert.equal(inspected.structuredContent.result.health.level, "pass");
    assert.equal(inspected.structuredContent.result.run.nModels, 3);

    const selected = await client.callTool({ name: "select_candidates", arguments: { run: root, limit: 4 } });
    assert.equal(selected.structuredContent.result.evaluation.dataset, "verify");
    assert.ok(selected.structuredContent.result.recommendations.some((item) => item.roles.includes("predictive")));

    const missing = await client.callTool({ name: "get_model", arguments: { run: root, rank: 999 } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Model rank not found/);
  } finally {
    await client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled MCP stdio entrypoint completes a real handshake", async () => {
  const client = new Client({ name: "sisso-sage-stdio-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./dist/sisso-sage-mcp.mjs"],
    cwd: path.resolve("."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "inspect_run"));
  } finally {
    await client.close();
  }
});
