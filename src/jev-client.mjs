import { setTimeout as delay } from "node:timers/promises";
import { JEV_ENDPOINT } from "./jev-rubric.mjs";

function distribution(answer, keys, label) {
  const p = answer?.probabilities;
  if (!p || Object.keys(p).length !== keys.length || keys.some((key) => !Object.hasOwn(p, key)
    || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1)) {
    throw new Error(`Invalid Jev probability distribution: ${label}.`);
  }
  // Live responses serialize probabilities and scores to two decimal places.
  // Validate whether a normalized underlying distribution can round to them.
  const rounded = Object.values(p).every((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);
  const margin = rounded ? 0.005 : 1e-4 / keys.length;
  const lower = keys.map((key) => Math.max(0, p[key] - margin));
  const upper = keys.map((key) => Math.min(1, p[key] + margin));
  if (lower.reduce((sum, value) => sum + value, 0) > 1 + 1e-8
    || upper.reduce((sum, value) => sum + value, 0) < 1 - 1e-8) {
    throw new Error(`Jev probabilities do not sum to one: ${label}.`);
  }
  return { rounded, lower, upper };
}

function expectationBound(lower, upper, descending) {
  const values = [...lower];
  let remaining = Math.max(0, 1 - values.reduce((sum, value) => sum + value, 0));
  const indices = values.map((_, i) => i);
  if (descending) indices.reverse();
  for (const i of indices) {
    const added = Math.min(remaining, upper[i] - values[i]);
    values[i] += added;
    remaining -= added;
  }
  return values.reduce((sum, value, i) => sum + i * value, 0);
}

export function validateJevResponse(response, request) {
  if (!response || typeof response.model !== "string" || !response.model || !response.answers) {
    throw new Error("Malformed Jev response: model and answers are required.");
  }
  if (request.model !== "jev-latest" && request.model !== "jev-preview" && response.model !== request.model) {
    throw new Error("Jev returned a different model version than requested.");
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type || !Number.isFinite(answer.confidence)
      || answer.confidence < 0 || answer.confidence > 1) throw new Error(`Invalid Jev answer: ${id}.`);
    const keys = question.type === "score" ? question.criteria.map((_, i) => String(i)) : Object.keys(question.criteria);
    const bounds = distribution(answer, keys, id);
    if (question.type === "score") {
      const scoreMargin = bounds.rounded && Math.abs(answer.score * 100 - Math.round(answer.score * 100)) < 1e-8 ? 0.005 : 1e-4;
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1
        || answer.score + scoreMargin < expectationBound(bounds.lower, bounds.upper, false) - 1e-8
        || answer.score - scoreMargin > expectationBound(bounds.lower, bounds.upper, true) + 1e-8) {
        throw new Error(`Invalid Jev score expectation: ${id}.`);
      }
    } else if (!keys.includes(answer.choice)
      || answer.probabilities[answer.choice] < Math.max(...Object.values(answer.probabilities)) - (bounds.rounded ? 0.01 + 1e-8 : 1e-4)) {
      throw new Error(`Invalid Jev choice: ${id}.`);
    }
  }
  if (response.usage && (!Number.isInteger(response.usage.input_tokens) || response.usage.input_tokens < 0
    || !Number.isInteger(response.usage.output_tokens) || response.usage.output_tokens < 0)) {
    throw new Error("Invalid Jev token usage.");
  }
  return response;
}

export async function callJev(request, options = {}) {
  const apiKey = options.apiKey || process.env.TYPESAFE_API_KEY;
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Set TYPESAFE_API_KEY before running jev-score. jev-plan works without an API key.");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || delay;
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(retries) || retries < 0 || retries > 8) throw new Error("retries must be an integer from 0 to 8.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be positive.");
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let retryWait = null;
    try {
      response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.ok) {
        let payload;
        try { payload = await response.json(); } catch { throw new Error("Jev returned invalid JSON."); }
        return validateJevResponse(payload, request);
      }
      // Never echo a provider error body: it could include credentials or input data.
      if (![408, 429, 500, 502, 503, 504, 529].includes(response.status) || attempt === retries) {
        throw new Error(`Jev API returned HTTP ${response.status}${response.status === 401 ? ": check your API key and account access" : ""}.`);
      }
      const after = response.headers?.get("retry-after");
      const seconds = after && /^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000 : NaN;
      const dateWait = after ? Date.parse(after) - Date.now() : NaN;
      retryWait = Number.isFinite(seconds) ? seconds : Number.isFinite(dateWait) ? Math.max(0, dateWait) : null;
      await response.body?.cancel();
    } catch (error) {
      if (response) throw error;
      if (attempt === retries) throw new Error("Jev request failed or timed out. Completed judgments remain in the checkpoint; retry with --resume.");
    } finally {
      clearTimeout(timer);
    }
    const wait = retryWait ?? Math.min(30000, 500 * 2 ** attempt);
    // Honor Retry-After rather than hammering a temporarily unavailable API.
    await sleep(wait);
  }
}
