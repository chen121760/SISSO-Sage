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
  listModelsResult,
  modelResult,
  paretoResult,
  selectionResult,
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
    return `Inspected SISSO run: health=${result.health?.level || "unknown"}, models=${result.run?.nModels ?? "unknown"}, metadata=${result.featureMetadata?.resolvedFeatures ?? 0}/${result.featureMetadata?.totalFeatures ?? 0}.`;
  }
  if (result.kind === "sisso-sage-model-list") return `Returned ${result.returned} of ${result.total} matching models.`;
  if (result.kind === "sisso-sage-model") return `Returned evidence for model rank ${result.model.rank}.`;
  if (result.kind === "sisso-sage-comparison") return `Compared model ranks ${result.ranks.join(", ")}.`;
  if (result.kind === "sisso-sage-pareto") return `Returned ${result.front.length} Pareto-front models from ${result.eligibleModels} eligible models.`;
  if (result.kind === "sisso-sage-selection") return `Returned ${result.recommendations.length} auditable model candidates.`;
  if (result.kind === "sisso-sage-feature-context") return `Feature source trace status: ${result.status}.`;
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
      instructions: "Start every run analysis with inspect_run. Stop model selection if health is error. Prefer holdout metrics, report per-task and aggregate MT evidence, inspect multiple finalists, and never infer physical meaning from an ambiguous feature name. Use feature_context or request original extraction code before making physical claims.",
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

  registerReadTool(server, "list_models", {
    title: "List SISSO models",
    description: "List a bounded set of model evidence records, optionally sorted by a dataset metric or filtered by primitive feature.",
    inputSchema: {
      ...runInput,
      limit: z.number().int().min(1).max(100).optional(),
      sort: z.string().optional().describe("rank, interpretability, or dataset.metric such as verify.rmse or t1.rmse."),
      feature: z.string().optional().describe("Only return models using this exact primitive feature name."),
    },
  }, (input) => listModelsResult(cache.load(input.run, input), input));

  registerReadTool(server, "get_model", {
    title: "Get one SISSO model",
    description: "Retrieve formulas, descriptors, metrics, primitive features, provenance coverage, interpretability evidence, and numerical-domain risks for one model rank.",
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
    description: "Find models not dominated on prediction metric and symbolic complexity. Use to expose performance-complexity alternatives.",
    inputSchema: {
      ...runInput,
      dataset: z.string().optional().describe("Dataset key such as verify, train, t1, or sisso-overall."),
      metric: z.enum(["rmse", "mae", "maxae", "r2", "rho"]).optional(),
    },
  }, (input) => paretoResult(cache.load(input.run, input), input));

  registerReadTool(server, "select_candidates", {
    title: "Select SISSO model candidates",
    description: "Create an auditable multi-role shortlist covering predictive, balanced, interpretable, robust, and Pareto-alternative candidates. This is not a claim of physical truth.",
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
    description: "Retrieve metadata and exact identifier matches in feature-extraction source before interpreting a primitive feature. An unresolved result requires researcher input rather than guessing.",
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
