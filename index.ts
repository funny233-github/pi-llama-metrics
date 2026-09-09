/**
 * Pi Extension: llama.cpp Stats Display (Streaming-based)
 *
 * Uses SSE stream data to calculate real-time TPS for both prefill and generation.
 * Shows metrics in status line or widget without polling.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, Container } from "@earendil-works/pi-tui";
import fs from "node:fs";

// ─── State ───────────────────────────────────────────────────────────────────

let currentProgress: { total?: number; processed?: number; time_ms?: number } | null = null;
let prevProcessed = 0;
let prevTimeMs = 0;
let hasReceivedPrefill = false;

const rateHistory: { processed: number; tps: number }[] = [];
const MAX_RATE_POINTS = 20;
let uiRef: any = null;
let hasUIRef = false;
let originalFetch: typeof fetch | null = null;

// Generation tracking
let generatedTokens = 0;
let generationStartTime: number | null = null;

// Latest metrics for widget
let latestStreamingMetrics: LlamaMetrics | null = null;

// ─── Metrics state ───────────────────────────────────────────────────────────

interface LlamaMetrics {
	prefillSpeed?: number;
	generationSpeed?: number;
	prefillTime?: number;
	generationTime?: number;
	promptTokens?: number;
	generatedTokens?: number;
	lastUpdate?: number;
}

let lastDisplay: string | null = null;
let currentModelId: string | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}m ${s}s`;
}

function formatTokensPerSec(processed: number, timeMs: number): string {
	const secs = timeMs / 1000;
	if (secs <= 0) return "";
	const rate = processed / secs;
	return `${rate.toFixed(1)} tok/s`;
}

function formatTps(speed: number | undefined): string {
	if (speed === undefined) return "";
	return `${speed.toFixed(1)} tok/s`;
}

// ─── SSE Stream Interceptor ──────────────────────────────────────────────────

interface SSEChunk {
	prompt_progress?: {
		processed: number;
		total: number;
		time_ms: number;
	};
	completion_text?: string;
}

function parseSSEEvent(line: string): SSEChunk | null {
	if (!line.startsWith("data: ")) return null;
	const jsonStr = line.slice(6);
	if (jsonStr === "[DONE]") return null;

	try {
		return JSON.parse(jsonStr) as SSEChunk;
	} catch {
		return null;
	}
}

function handleProgressEvent(p: { processed: number; total: number; time_ms: number }) {
	if (currentProgress) {
		prevProcessed = currentProgress.processed ?? 0;
		prevTimeMs = currentProgress.time_ms ?? 0;
	}
	currentProgress = p;
	hasReceivedPrefill = true;

	const deltaP = (p.processed ?? 0) - prevProcessed;
	const deltaT = (p.time_ms ?? 0) - prevTimeMs;
	if (deltaT > 0 && deltaP > 0) {
		const tps = deltaP / (deltaT / 1000);
		rateHistory.push({ processed: p.processed ?? 0, tps });
		if (rateHistory.length > MAX_RATE_POINTS) {
			rateHistory.shift();
		}

		// Update status line in real-time during prefill
		if (currentCtx && currentModelId) {
			const metrics: LlamaMetrics = {
				prefillSpeed: tps,
				promptTokens: p.processed ?? 0,
				lastUpdate: Date.now()
			};
			updateStatus(currentCtx, currentModelId, metrics);
		}
	}
}

function handleCompletionText(text: string) {
	// Simple token counting (approximate)
	const tokens = text.trim().split(/\s+/).length;
	if (tokens === 0) return;

	generatedTokens += tokens;

	// Track generation start time on first token
	if (!generationStartTime) {
		generationStartTime = Date.now();
	}

	// Calculate generation TPS
	const elapsed = Date.now() - generationStartTime;
	if (elapsed > 0) {
		const tps = (generatedTokens / elapsed) * 1000;
		if (currentCtx && currentModelId) {
			const metrics: LlamaMetrics = {
				generationSpeed: tps,
				generatedTokens: generatedTokens,
				lastUpdate: Date.now()
			};
			updateStatus(currentCtx, currentModelId, metrics);
		}
	}
}

function captureTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let buffer = "";
	const decoder = new TextDecoder();

	return new ReadableStream({
		async start(controller) {
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
						updateWorkingMessage();
					}
					if (chunk.completion_text) {
						handleCompletionText(chunk.completion_text);
					}
				}

				controller.enqueue(value);
			}
			controller.close();
		},
		cancel(reason?: any) {
			reader.cancel(reason);
		},
	});
}

// ─── Fetch Interception ──────────────────────────────────────────────────────

function isLlamaCppRequest(input: any): boolean {
	const url = typeof input === "string" ? input : input?.url;
	if (typeof url !== "string") return false;
	if (!url.includes("/chat/completions")) return false;

	if (!llamaCppUrl) {
		let hostPart = url.replace(/https?:\/\//, "").split("/")[0];
		llamaCppUrl = `http://${hostPart}/v1`;
	}

	return url.includes(llamaCppUrl.replace(/https?:\/\//, "").replace(/^\/+/, ""));
}

function ensureStreamOptions(input: any, init?: any): void {
	try {
		let body = init?.body;
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

function buildDisplayString(metrics: LlamaMetrics, modelId: string): string {
	const parts = [];

	if (metrics.prefillSpeed) parts.push(`PREFILL: ${formatTps(metrics.prefillSpeed)}`);
	if (metrics.generationSpeed) parts.push(`GENERATION: ${formatTps(metrics.generationSpeed)}`);
	if (metrics.promptTokens !== undefined) {
		parts.push(`PREFILL TOKENS: ${metrics.promptTokens}`);
	}
	if (metrics.generatedTokens !== undefined) {
		parts.push(`GENERATED TOKENS: ${metrics.generatedTokens}`);
	}

	if (parts.length === 0) return `MODEL: ${modelId}`;
	return `MODEL: ${modelId} | ${parts.join(" | ")}`;
}

function buildWidgetContent(metrics: LlamaMetrics, modelId: string, theme: any) {
	const container = new Container();

	const modelText = new Text(`MODEL: ${modelId}`, 1, 0);
	container.addChild(modelText);

	if (metrics.prefillSpeed) {
		const prefillText = new Text(`PREFILL SPEED: ${formatTps(metrics.prefillSpeed)}`, 1, 0);
		container.addChild(prefillText);
	}

	if (metrics.generationSpeed) {
		const genText = new Text(`GENERATION SPEED: ${formatTps(metrics.generationSpeed)}`, 1, 0);
		container.addChild(genText);
	}

	if (metrics.promptTokens !== undefined) {
		const tokensText = new Text(`PREFILL TOKENS: ${metrics.promptTokens}`, 1, 0);
		container.addChild(tokensText);
	}

	if (metrics.generatedTokens !== undefined) {
		const genTokensText = new Text(`GENERATED TOKENS: ${metrics.generatedTokens}`, 1, 0);
		container.addChild(genTokensText);
	}

	if (container.children.length === 0) {
		const emptyText = new Text("NO METRICS AVAILABLE", 1, 0);
		container.addChild(emptyText);
	}

	return container;
}

function updateStatus(ctx: ExtensionContext, modelId: string, metrics: LlamaMetrics) {
	// Store for widget access
	latestStreamingMetrics = { ...metrics };

	const display = buildDisplayString(metrics, modelId);
	if (display !== lastDisplay && ctx.hasUI) {
		lastDisplay = display;
		ctx.ui.setStatus("pi-llama-metrics", display);
	}
}

function updateWorkingMessage(): void {
	if (!uiRef || !hasUIRef) return;
	
	if (currentProgress?.total && currentProgress.processed === currentProgress.total) {
		uiRef.setWorkingMessage();
	} else if (currentProgress && currentProgress.total && currentProgress.processed !== undefined) {
		const pct = (currentProgress.processed / currentProgress.total) * 100;
		const filled = Math.round((pct / 100) * 20);
		const bar = "█".repeat(filled) + "░".repeat(20 - filled);
		const msg = `PREFILL: ${bar} ${pct.toFixed(0).padStart(3)}%`;
		uiRef.setWorkingMessage(msg);
	} else {
		uiRef.setWorkingMessage();
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

let currentCtx: ExtensionContext | null = null;
let llamaCppUrl: string | null = null;

// Simple logger (disabled by default)
function log(...args: any[]) {
	// Enable for debugging:
	// console.log(...args);
}

export default function (pi: ExtensionAPI) {
	const globalState = globalThis as Record<PropertyKey, unknown>;
	if (globalState["pi-llama-metrics-display/loaded"]) return;
	globalState["pi-llama-metrics-display/loaded"] = true;

	originalFetch = globalThis.fetch;
	globalThis.fetch = async (input: any, init?: any) => {
		if (!isLlamaCppRequest(input)) {
			return originalFetch!(input, init);
		}

		ensureStreamOptions(input, init);

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
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		currentModelId = ctx.model?.id || null;
		generatedTokens = 0;
		generationStartTime = null;
		latestStreamingMetrics = null;
	});

	pi.on("model_select", async (event, ctx) => {
		currentModelId = event.model?.id || null;
		lastDisplay = null;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on("session_shutdown", async () => {
		uiRef = null;
		hasUIRef = false;
		rateHistory.length = 0;
		prevProcessed = 0;
		prevTimeMs = 0;
		latestStreamingMetrics = null;
		lastDisplay = null;
		currentModelId = null;
		currentCtx = null;
		generatedTokens = 0;
		generationStartTime = null;

		if (originalFetch) {
			globalThis.fetch = originalFetch;
			originalFetch = null;
		}

		delete globalState["pi-llama-metrics-display/loaded"];
	});

	pi.registerCommand("llama-metrics", {
		description: "Show llama.cpp metrics widget",
		handler: async (args, ctx) => {
			if (!currentModelId) {
				ctx.ui.notify("No model selected", "warning");
				return;
			}

			if (!latestStreamingMetrics) {
				ctx.ui.notify("No metrics data available. Start generating to see metrics.", "warning");
				return;
			}

			const metrics = latestStreamingMetrics;

			ctx.ui.setWidget("llama-metrics-widget", (tui, theme) => {
				const container = new Container();
				container.addChild(new Text(`MODEL: ${currentModelId}`, 1, 0));

				if (metrics.prefillSpeed) {
					container.addChild(new Text(`PREFILL SPEED: ${formatTps(metrics.prefillSpeed)}`, 1, 0));
				}
				if (metrics.generationSpeed) {
					container.addChild(new Text(`GENERATION SPEED: ${formatTps(metrics.generationSpeed)}`, 1, 0));
				}
				if (metrics.promptTokens !== undefined) {
					container.addChild(new Text(`PREFILL TOKENS: ${metrics.promptTokens}`, 1, 0));
				}
				if (metrics.generatedTokens !== undefined) {
					container.addChild(new Text(`GENERATED TOKENS: ${metrics.generatedTokens}`, 1, 0));
				}

				return container;
			});

			ctx.ui.notify("Metrics widget displayed", "info");
		},
	});

	pi.registerCommand("llama-metrics-toggle", {
		description: "Toggle llama.cpp metrics in status line",
		handler: async (args, ctx) => {
			if (!currentModelId) {
				ctx.ui.notify("No model selected", "warning");
				return;
			}

			if (!latestStreamingMetrics) {
				ctx.ui.notify("No metrics data available", "warning");
				return;
			}

			if (lastDisplay) {
				ctx.ui.setStatus("pi-llama-metrics", undefined);
				lastDisplay = null;
				ctx.ui.notify("Metrics hidden", "info");
			} else {
				updateStatus(ctx, currentModelId, latestStreamingMetrics);
				ctx.ui.notify("Metrics shown", "info");
			}
		},
	});
}
