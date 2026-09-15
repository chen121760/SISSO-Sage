import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CAPABILITIES } from "../src/capabilities.mjs";
import {
  AnalysisCache,
  comparisonResult,
  featureContextResult,
  inspectionResult,
  leakageResult,
  listModelsResult,
  modelResult,
  paretoResult,
  selectionResult,
  MODEL_LIST_HARD_CAP,
} from "../src/service.mjs";
import { VERSION } from "../src/version.mjs";

const runInput = {
  run: z.string().min(1).describe("Absolute or working-directory-relative path to a SISSO result directory, .tar, .tar.gz, or .tgz archive."),
  verifyFile: z.string().min(1).optional().describe("Optional external verify.dat path."),
  featuresFile: z.string().min(1).optional().describe("Optional researcher-maintained sage.features.json path."),
  sourceRoot: z.string().min(1).optional().describe("Optional root directory containing feature extraction code and dictionaries."),
  dictionaryFile: z.string().min(1).optional().describe("Optional explicit feature dictionary CSV path."),
  renameMapFile: z.string().min(1).optional().describe("Optional explicit old-to-new feature rename CSV path."),
  topFile: z.string().min(1).optional().describe("Optional explicit Models/top*_D* file path."),
  refresh: z.boolean().optional().describe("Re-read files instead of reusing this server session's cached analysis."),
};

const resultOutput = { result: z.record(z.string(), z.unknown()) };
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function resultMessage(result) {
  if (result.kind === "sisso-sage-inspection") {
    return `Inspected SISSO run: health=${result.health?.level || "unknown"}, models=${result.run?.nModels ?? "unknown"}, confirmed metadata=${result.featureMetadata?.resolvedFeatures ?? 0}/${result.featureMetadata?.totalFeatures ?? 0}, documented=${result.featureMetadata?.documentedFeatures ?? 0}.`;
  }
  if (result.kind === "sisso-sage-model-list") return `Returned ${result.returned} of ${result.total} matching models${result.truncated ? " (truncated)" : ""}.`;
  if (result.kind === "sisso-sage-model") return `Returned evidence for model rank ${result.model.rank}.`;
  if (result.kind === "sisso-sage-comparison") return `Compared model ranks ${result.ranks.join(", ")}.`;
  if (result.kind === "sisso-sage-pareto") return `Returned ${result.front.length} Pareto-front models from ${result.eligibleModels} eligible models.`;
  if (result.kind === "sisso-sage-selection") return `Returned ${result.candidates.length} objective-evidence model candidates for semantic review.`;
  if (result.kind === "sisso-sage-feature-context") return `Feature source trace status: ${result.status}.`;
  if (result.kind === "sisso-sage-leakage") {
    return `Leakage check (${result.mode}): verdict=${result.verdict}` +
      (result.holdoutIsIndependent === false ? " — hold-out is NOT independent." : "") + ".";
  }
  return "SISSO-Sage tool completed.";
}

function errorResult(error) {
  const payload = {
    kind: "sisso-sage-error",
    error: error instanceof Error ? error.message : String(error),
    health: error?.health || undefined,
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function registerReadTool(server, name, config, handler) {
  server.registerTool(
    name,
    { ...config, outputSchema: resultOutput, annotations: readOnlyAnnotations },
    async (input) => {
      try {
        const result = await handler(input);
        return {
          structuredContent: { result },
          content: [{ type: "text", text: resultMessage(result) }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

export function createSissoSageMcpServer(options = {}) {
  const cache = options.cache || new AnalysisCache(options.cacheLimit);
  const server = new McpServer(
    { name: "sisso-sage", version: VERSION },
    {
      instructions: "Start every run analysis with inspect_run and stop if health is error. When verify.dat exists, call check_leakage before selection and do not treat a non-independent split as external validation. Use select_candidates only as an objective-evidence shortlist, then compare multiple finalists. Report per-task and aggregate MT evidence. Review formulaEvidence and use feature_context before physical claims; never infer meaning from an ambiguous name or emit a scalar elegance score.",
    },
  );

  registerReadTool(server, "get_capabilities", {
    title: "Get SISSO-Sage capabilities",
    description: "Discover the available SISSO analysis workflow and its scientific decision policy.",
    inputSchema: {},
  }, () => ({ ...CAPABILITIES, kind: "sisso-sage-capabilities" }));

  registerReadTool(server, "inspect_run", {
    title: "Inspect a SISSO run",
    description: "Use first for every SISSO result. Validates required files and returns run layout, health, datasets, task metadata, warnings, and feature-provenance coverage.",
    inputSchema: runInput,
  }, (input) => inspectionResult(cache.load(input.run, input)));

  registerReadTool(server, "check_leakage", {
    title: "Check hold-out independence",
    description: "Verify that held-out rows are genuinely unseen before trusting any hold-out metric. Compares verify.dat against train.dat by exact sample name, then structure id, then composition, and flags identical sample+condition rows (true leakage). For MT-SISSO without verify.dat it compares the task partitions instead. Read-only and descriptive.",
    inputSchema: runInput,
  }, (input) => leakageResult(cache.load(input.run, input)));

  registerReadTool(server, "list_models", {
    title: "List SISSO models",
    description: "List model evidence records, optionally sorted by a dataset metric or filtered by primitive feature. Use limit to page through every model; the response reports returned/limit/truncated so a partial list is never mistaken for the full ranking.",
    inputSchema: {
      ...runInput,
      limit: z.number().int().min(1).max(MODEL_LIST_HARD_CAP).optional(),
      sort: z.string().optional().describe("rank, structure.astNodeCount, or dataset.metric such as verify.rmse or t1.rmse. Interpretability is not a scalar sort key."),
      feature: z.string().optional().describe("Only return models using this exact primitive feature name."),
    },
  }, (input) => listModelsResult(cache.load(input.run, input), input));

  registerReadTool(server, "get_model", {
    title: "Get one SISSO model",
    description: "Retrieve formulas, descriptors, metrics, primitive features, structural evidence, observed-domain checks, provenance confidence, and the semantic-review rubric for one model rank.",
    inputSchema: { ...runInput, rank: z.number().int().positive() },
  }, (input) => modelResult(cache.load(input.run, input), input.rank));

  registerReadTool(server, "compare_models", {
    title: "Compare SISSO models",
    description: "Retrieve aligned evidence for two to ten finalist model ranks before making a recommendation.",
    inputSchema: {
      ...runInput,
      ranks: z.array(z.number().int().positive()).min(2).max(10),
    },
  }, (input) => comparisonResult(cache.load(input.run, input), input.ranks));

  registerReadTool(server, "pareto_frontier", {
    title: "Find the SISSO Pareto frontier",
    description: "Return Pareto layers over predictive performance and target-normalized generalization gap when holdout data exist; otherwise use syntactic complexity as an explicitly in-sample fallback.",
    inputSchema: {
      ...runInput,
      dataset: z.string().optional().describe("Dataset key such as verify, train, t1, or sisso-overall."),
      metric: z.enum(["rmse", "mae", "maxae", "r2", "rho"]).optional(),
    },
  }, (input) => paretoResult(cache.load(input.run, input), input));

  registerReadTool(server, "select_candidates", {
    title: "Select SISSO model candidates",
    description: "Create a strict-size shortlist using predictive evidence, a near-optimal performance envelope, and Pareto rank only. Interpretability and provenance do not pre-filter candidates; an LLM/researcher reviews the returned finalists with the supplied rubric.",
    inputSchema: {
      ...runInput,
      dataset: z.string().optional().describe("Dataset key such as verify, train, t1, or sisso-overall."),
      metric: z.enum(["rmse", "mae", "maxae", "r2", "rho"]).optional(),
      limit: z.number().int().min(1).max(10).optional(),
      nearOptimalTolerance: z.number().min(0).max(1).optional(),
    },
  }, (input) => selectionResult(cache.load(input.run, input), input));

  registerReadTool(server, "feature_context", {
    title: "Trace a SISSO feature",
    description: "Retrieve metadata, bounded source snippets, and a referenced Python function body when available before interpreting a primitive feature. An unresolved result requires researcher input rather than guessing.",
    inputSchema: {
      ...runInput,
      feature: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, (input) => featureContextResult(cache.load(input.run, input), input.feature, input));

  return server;
}

export async function main() {
  const server = createSissoSageMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`SISSO-Sage MCP failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
