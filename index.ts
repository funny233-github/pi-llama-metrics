/**
 * Pi Extension: llama.cpp Stats Display (Streaming-based)
 *
 * Uses SSE stream data to calculate real-time TPS for both prefill and generation.
 * Shows metrics in status line or widget without polling.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, Container } from "@earendil-works/pi-tui";

// ─── Type Definitions ─────────────────────────────────────────────────────────

interface LlamaCppSSEDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface LlamaCppSSEChunk {
  prompt_progress?: {
    processed: number;
    total: number;
    time_ms: number;
  };
  choices?: Array<{
    delta?: LlamaCppSSEDelta;
  }>;
  usage?: {
    completion_tokens?: number;
  };
}

// ─── State ───────────────────────────────────────────────────────────────────

let currentProgress: {
  total?: number;
  processed?: number;
  time_ms?: number;
} | null = null;
let prevProcessed = 0;
let prevTimeMs = 0;
let isGenerating = false;

let uiRef: any = null;
let hasUIRef = false;
let originalFetch: typeof fetch | null = null;

// Generation tracking
let generatedTokens = 0; // Cumulative tokens across all rounds
let generationBaseTokens = 0; // Tokens at start of current generation round
let generationStartTime: number | null = null;

// Latest metrics for widget
let latestStreamingMetrics: LlamaMetrics | null = null;

// Window smoothing for real-time TPS
const windowSizeMs = 1000;
const tokenWindow: { tokens: number; time: number }[] = [];
const prefillWindow: { processed: number; time: number }[] = [];
let usageApplied = false;
let usageJustApplied = false; // Flag for first chunk after usage

interface LlamaMetrics {
  generationSpeed?: number;
  lastUpdate?: number;
}

let lastDisplay: string | null = null;
let statusLineVisible = true; // Default visible (no toggle needed for decode info)
let lastPrefillTps = 0; // For ETA calculation

// Reset all state at start of each new request
function resetGenerationState() {
  isGenerating = false;
  generationStartTime = null;
  generationBaseTokens = generatedTokens; // Preserve cumulative, set baseline
  currentProgress = null;
  prevProcessed = 0;
  prevTimeMs = 0;
  latestStreamingMetrics = null; // Clear metrics to avoid cross-round contamination
  lastDisplay = null; // Clear display cache
  tokenWindow.length = 0; // Clear window for new stream
  prefillWindow.length = 0; // Clear prefill window
  usageApplied = false; // Reset usage flag
  usageJustApplied = false; // Reset flag
  lastPrefillTps = 0; // Reset ETA calculation basis
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ANSI gray (bright black), some terminals render as dark gray
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

function formatTps(speed: number | undefined): string {
  if (speed === undefined) return "";
  return `${speed.toFixed(1)} tok/s`;
}

// Better token estimation for CJK and code
function estimateTokens(content: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of content) {
    const code = char.codePointAt(0) ?? 0;
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
      (code >= 0xac00 && code <= 0xd7af) || // Hangul
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
      (code >= 0xff00 && code <= 0xffef); // Full-width characters
    if (isCJK) cjk++;
    else other++;
  }
  // CJK: ~1 char = 1 token, others: ~4 chars = 1 token
  return Math.max(1, Math.round(cjk + other / 4));
}

// ─── SSE Stream Interceptor ──────────────────────────────────────────────────

function parseSSEEvent(line: string): LlamaCppSSEChunk | null {
  if (!line.startsWith("data: ")) return null;
  const jsonStr = line.slice(6);
  if (jsonStr === "[DONE]") return null;

  try {
    return JSON.parse(jsonStr) as LlamaCppSSEChunk;
  } catch {
    return null;
  }
}

function handleProgressEvent(p: {
  processed: number;
  total: number;
  time_ms: number;
}) {
  if (currentProgress) {
    prevProcessed = currentProgress.processed ?? 0;
    prevTimeMs = currentProgress.time_ms ?? 0;
  }
  currentProgress = p;

  // First check if prefill is complete - exit early if so
  const prefillDone = p.total !== undefined && p.processed >= p.total;

  if (prefillDone) {
    if (!isGenerating) {
      // Short prompt scenario: only one progress event, derive TPS from p.time_ms
      if (lastPrefillTps === 0 && p.time_ms > 0 && p.processed > 0) {
        lastPrefillTps = (p.processed / p.time_ms) * 1000;
        // Note: prefill has ended at this point, working message will be cleared,
        // lastPrefillTps is retained for next ETA usage (though meaningless for this round)
      }
      isGenerating = true;
      updateWorkingMessage(); // Clear progress bar
    }
    return; // Skip TPS calculation for completion event
  }

  if (!isGenerating) {
    const deltaP = (p.processed ?? 0) - prevProcessed;
    const deltaT = (p.time_ms ?? 0) - prevTimeMs;
    if (deltaT > 0 && deltaP > 0) {
      // Window smoothing on llama.cpp internal clock
      prefillWindow.push({ processed: p.processed ?? 0, time: p.time_ms });
      const maxTime = p.time_ms;
      while (
        prefillWindow.length > 0 &&
        maxTime - prefillWindow[0].time > windowSizeMs
      ) {
        prefillWindow.shift();
      }

      let tps = 0;
      if (prefillWindow.length >= 2) {
        const first = prefillWindow[0];
        const last = prefillWindow[prefillWindow.length - 1];
        const dP = last.processed - first.processed;
        const dT = last.time - first.time;
        if (dT > 0 && dP > 0) {
          tps = (dP / dT) * 1000;
        }
      }
      if (tps === 0) {
        tps = deltaP / (deltaT / 1000);
      }

      lastPrefillTps = tps;
      updateWorkingMessage(); // Only called once per TPS update (mutually exclusive with prefillDone branch)
    }
  }
}

// Update working message with prefill progress bar, speed, and ETA
function updateWorkingMessage(): void {
  if (!uiRef || !hasUIRef) return;

  // Use >= to catch processed > total boundary case
  if (
    currentProgress?.total !== undefined &&
    currentProgress.processed !== undefined &&
    currentProgress.processed >= currentProgress.total
  ) {
    uiRef.setWorkingMessage();
    return;
  }

  if (
    currentProgress &&
    currentProgress.total &&
    currentProgress.processed !== undefined
  ) {
    // Clamp percentage to [0, 100] to prevent negative repeat
    const pct = Math.min(
      100,
      Math.max(0, (currentProgress.processed / currentProgress.total) * 100),
    );
    const barWidth = 12; // Shrink bar width to make room for speed
    const filled = Math.min(
      barWidth,
      Math.max(0, Math.round((pct / 100) * barWidth)),
    );
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    // Speed string
    let speedStr = "";
    if (lastPrefillTps > 0) {
      speedStr = ` ${lastPrefillTps.toFixed(0)} tok/s`;
    }

    // ETA calculation with clamped remaining
    let etaStr = "";
    if (lastPrefillTps > 0) {
      const remaining = Math.max(
        0,
        currentProgress.total - currentProgress.processed,
      );
      const etaSec = remaining / lastPrefillTps;
      if (etaSec < 60) {
        etaStr = ` ETA: ${etaSec.toFixed(1)}s`;
      } else {
        const m = Math.floor(etaSec / 60);
        const s = Math.round(etaSec % 60);
        etaStr = ` ETA: ${m}m${s}s`;
      }
    }

    uiRef.setWorkingMessage(
      `PREFILL: ${bar} ${pct.toFixed(0).padStart(3)}%${speedStr}${etaStr}`,
    );
  } else {
    uiRef.setWorkingMessage();
  }
}

function handleCompletionText(content: string) {
  // Use more accurate token estimation for CJK and code
  const tokens = estimateTokens(content);
  generatedTokens += tokens;

  // Track generation start time on first token (avoid first-token latency)
  if (!generationStartTime) {
    isGenerating = true; // Double insurance: mark as generating even without prefill events
    generationStartTime = Date.now();
    generationBaseTokens = generatedTokens - tokens; // Baseline for this round
  }

  // First chunk after usage: only reset window baseline, don't calculate TPS
  if (usageJustApplied) {
    usageJustApplied = false;
    tokenWindow.length = 0;
    tokenWindow.push({ tokens: generatedTokens, time: Date.now() });
    return;
  }

  const now = Date.now();

  // Window smoothing for real-time TPS (store cumulative values)
  tokenWindow.push({ tokens: generatedTokens, time: now });
  // Remove old entries outside window
  while (tokenWindow.length > 0 && now - tokenWindow[0].time > windowSizeMs) {
    tokenWindow.shift();
  }

  // Calculate smoothed TPS from recent window
  let smoothedTps = 0;
  if (tokenWindow.length >= 2) {
    const first = tokenWindow[0];
    const last = tokenWindow[tokenWindow.length - 1];
    const deltaTokens = last.tokens - first.tokens;
    const deltaMs = last.time - first.time;
    if (deltaMs > 0 && deltaTokens > 0) {
      smoothedTps = (deltaTokens / deltaMs) * 1000;
    }
  }

  // Fallback to average from start if window too small
  if (smoothedTps === 0 && generationStartTime) {
    const elapsedMs = now - generationStartTime;
    if (elapsedMs > 0) {
      const roundTokens = generatedTokens - generationBaseTokens;
      smoothedTps = (roundTokens / elapsedMs) * 1000;
    }
  }

  // Only send generationSpeed
  if (currentCtx) {
    const metrics: LlamaMetrics = {
      generationSpeed: smoothedTps,
      lastUpdate: now,
    };
    updateStatus(currentCtx, metrics);
  }
}

function captureTimings(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let buffer = "";
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      // Reset generation state for each new response stream (handles multiple requests per round)
      resetGenerationState();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const chunk = parseSSEEvent(line);
          if (!chunk) continue;

          if (chunk.prompt_progress) {
            handleProgressEvent(chunk.prompt_progress);
            // No need to call updateWorkingMessage() here - already done inside handleProgressEvent
          }

          // Extract all output types from choices[0].delta
          if (chunk.choices && chunk.choices.length > 0) {
            const delta = chunk.choices[0].delta;
            if (delta) {
              let combined = "";

              // 1. Text output
              if (
                typeof delta.content === "string" &&
                delta.content.length > 0
              ) {
                combined += delta.content;
              }

              // 2. Thinking/reasoning content (DeepSeek-R1, QwQ, etc.)
              if (
                typeof delta.reasoning_content === "string" &&
                delta.reasoning_content.length > 0
              ) {
                combined += delta.reasoning_content;
              }
              if (
                typeof delta.reasoning === "string" &&
                delta.reasoning.length > 0
              ) {
                combined += delta.reasoning;
              }

              // 3. Tool call parameters (streaming JSON fragments)
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const args = tc?.function?.arguments;
                  if (typeof args === "string" && args.length > 0) {
                    combined += args;
                  }
                  // Some implementations send function name separately, also counts as token-level output
                  const name = tc?.function?.name;
                  if (typeof name === "string" && name.length > 0) {
                    combined += name;
                  }
                }
              }

              // 4. Unified processing via handleCompletionText
              if (combined.length > 0) {
                handleCompletionText(combined);
              }
            }
          }

          // Use real token count from usage event for accuracy (only once)
          if (!usageApplied && chunk.usage?.completion_tokens !== undefined) {
            usageApplied = true;
            usageJustApplied = true; // Mark first chunk after usage
            const realRoundTokens = chunk.usage.completion_tokens;

            // 1. First calculate final average TPS for this round using old baseline + real value
            let finalTps: number | undefined;
            if (generationStartTime !== null) {
              const elapsedMs = Date.now() - generationStartTime;
              if (elapsedMs > 0) {
                finalTps = (realRoundTokens / elapsedMs) * 1000;
              }
            }

            // 2. Update cumulative tokens (maintain cross-round cumulative semantics)
            generatedTokens = generationBaseTokens + realRoundTokens;

            // 3. Reset window, but retain generationStartTime / generationBaseTokens
            //    This way if there are more chunks later, average is still calculated from round start, won't show 0
            const now = Date.now();
            tokenWindow.length = 0;
            tokenWindow.push({ tokens: generatedTokens, time: now });

            // 4. Display final TPS
            if (finalTps !== undefined && currentCtx) {
              updateStatus(currentCtx, {
                generationSpeed: finalTps,
                lastUpdate: now,
              });
            }
          }
        }

        controller.enqueue(value);
      }
      controller.close();
    },
    cancel(reason?: any) {
      // Clear working message on interruption to avoid progress bar residue
      if (uiRef && hasUIRef) {
        uiRef.setWorkingMessage();
      }
      reader.cancel(reason);
    },
  });
}

// ─── Fetch Interception ──────────────────────────────────────────────────────

// Extract scheme://host (the request origin) from a URL, tolerant of
// malformed input. Path, query and trailing slashes are ignored so that
// requests to the same server match regardless of /v1 or endpoint path.
function requestOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    const m = url.match(/^[a-z]+:\/\/[^/]+/i);
    return m ? m[0] : url;
  }
}

async function isLlamaCppRequest(input: any): Promise<boolean> {
  const url = typeof input === "string" ? input : input?.url;
  if (typeof url !== "string") return false;
  if (!url.includes("/chat/completions")) return false;

  const origin = requestOrigin(url);

  // Learn the server origin from the first request of the session, before any
  // early return, so later requests can be matched against it. Reset on
  // session_start / model_select (see below) so it re-detects instead of
  // freezing. Robust to host spelling differences (localhost vs 127.0.0.1)
  // and to /v1 path variants, and does NOT depend on the server running with
  // --metrics (the extension computes metrics from the SSE stream, not the
  // /metrics endpoint).
  if (!llamaCppUrl) {
    llamaCppUrl = origin;
  }
  return llamaCppUrl === origin;
}

function ensureStreamOptions(init?: any): void {
  try {
    const body = init?.body;
    if (!body) return;

    const isString = typeof body === "string";
    const p = isString ? JSON.parse(body) : { ...body };

    if (!p.stream_options) {
      p.stream_options = { include_usage: true };
    } else if (!p.stream_options.include_usage) {
      p.stream_options.include_usage = true;
    }

    if (p.stream && !p.return_progress) {
      p.return_progress = true;
    }

    const newBody = JSON.stringify(p);
    if (isString) {
      init.body = newBody;
    } else {
      Object.assign(body, p);
    }
  } catch {
    // Ignore parse errors
  }
}

// ─── Display builders ────────────────────────────────────────────────────────

function buildDisplayString(metrics: LlamaMetrics): string {
  if (metrics.generationSpeed !== undefined) {
    return `${GRAY}${formatTps(metrics.generationSpeed)}${RESET}`;
  }
  return "";
}

function updateStatus(ctx: ExtensionContext, metrics: LlamaMetrics) {
  // Preserve latestStreamingMetrics for widget command
  latestStreamingMetrics = latestStreamingMetrics
    ? { ...latestStreamingMetrics, ...metrics }
    : metrics;

  if (!statusLineVisible) return;

  const display = buildDisplayString(latestStreamingMetrics);
  if (display !== "" && display !== lastDisplay && ctx.hasUI) {
    lastDisplay = display;
    ctx.ui.setStatus("pi-llama-metrics", display);
  }
}

// ─── Extension ───────────────────────────────────────────────────────────────

let currentCtx: ExtensionContext | null = null;
// Server origin (scheme://host) learned from the first request of the session.
// Reset on session_start / model_select so detection re-derives instead of
// freezing on the first request.
let llamaCppUrl: string | null = null;

export default function (pi: ExtensionAPI) {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  if (globalState["pi-llama-metrics-display/loaded"]) return;
  globalState["pi-llama-metrics-display/loaded"] = true;

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    if (!(await isLlamaCppRequest(input))) {
      return originalFetch!(input, init);
    }

    ensureStreamOptions(init);

    const response = await originalFetch!(input, init);

    if (response.ok && response.body) {
      return new Response(captureTimings(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    }
    return response;
  };

  pi.on("before_agent_start", (_event, ctx) => {
    uiRef = ctx.ui;
    hasUIRef = ctx.hasUI;

    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
      // Start of new round, clear status line to avoid showing previous decode value
      // (prefill phase doesn't display in status line, so it should be empty at this point)
      if (statusLineVisible) {
        ctx.ui.setStatus("pi-llama-metrics", undefined);
      }
    }

    resetGenerationState();
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    generatedTokens = 0;
    llamaCppUrl = null; // Re-learn server origin for this session
    resetGenerationState(); // Consistent reset across all state
  });

  pi.on("model_select", async (_event, ctx) => {
    // Switching to a model on a different server re-learns the origin here,
    // so the old server's origin is not matched anymore.
    llamaCppUrl = null;
    if (ctx.hasUI && statusLineVisible) {
      ctx.ui.setStatus("pi-llama-metrics", undefined);
    }
    lastDisplay = null;
    latestStreamingMetrics = null; // Old model data no longer meaningful
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.hasUI) {
      // Only clear working message, status line retains decode info
      ctx.ui.setWorkingMessage();
    }
  });

  pi.on("session_shutdown", async () => {
    statusLineVisible = true; // Reset to default visible
    uiRef = null;
    hasUIRef = false;
    generatedTokens = 0;
    resetGenerationState();

    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }

    delete globalState["pi-llama-metrics-display/loaded"];
  });

  pi.registerCommand("llama-metrics", {
    description: "Show llama.cpp metrics widget",
    handler: async (_args, ctx) => {
      if (latestStreamingMetrics?.generationSpeed === undefined) {
        ctx.ui.notify(
          "No metrics data available. Start generating to see metrics.",
          "warning",
        );
        return;
      }

      const speed = latestStreamingMetrics.generationSpeed;
      ctx.ui.setWidget("llama-metrics-widget", () => {
        const container = new Container();
        // Gray: try using theme API; if not supported, fall back to ANSI
        const label = `${GRAY}${formatTps(speed)}${RESET}`;
        container.addChild(new Text(label, 1, 0));
        return container;
      });

      ctx.ui.notify("Metrics widget displayed", "info");
    },
  });

  pi.registerCommand("llama-metrics-toggle", {
    description: "Toggle llama.cpp metrics in status line",
    handler: async (_args, ctx) => {
      statusLineVisible = !statusLineVisible;

      if (statusLineVisible) {
        // Re-display if we have data
        if (latestStreamingMetrics?.generationSpeed !== undefined) {
          const display = buildDisplayString(latestStreamingMetrics);
          if (display && display !== lastDisplay && ctx.hasUI) {
            lastDisplay = display;
            ctx.ui.setStatus("pi-llama-metrics", display);
          }
        }
        ctx.ui.notify("Metrics shown", "info");
      } else {
        ctx.ui.setStatus("pi-llama-metrics", undefined);
        lastDisplay = null;
        ctx.ui.notify("Metrics hidden", "info");
      }
    },
  });
}
