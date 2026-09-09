/**
 * Pi Extension: llama.cpp Metrics Display
 *
 * Displays real-time prefill and generation speeds from llama.cpp's metrics endpoint
 * and SSE stream timings. Shows in the TUI status line or as a widget.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, Box, Container } from "@earendil-works/pi-tui";
import fs from "node:fs";

const DEBUG = process.env.LLAMA_CPP_METRICS_DEBUG === "1";
const LOG_FILE = "/tmp/pi-llama-metrics.log";

function log(...args: any[]) {
	if (!DEBUG) return;
	fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [pi-llama-metrics] ${args.join(" ")}\n`);
}

// Store latest metrics data
interface LlamaMetrics {
	prefillSpeed?: number;
	generationSpeed?: number;
	prefillTime?: number;
	generationTime?: number;
	promptTokens?: number;
	generatedTokens?: number;
	lastUpdate?: number;
	progress?: {
		total?: number;
		processed?: number;
		cache?: number;
		pct?: number;
	};
}

const latestMetrics = new Map<string, LlamaMetrics>();
let lastDisplay: string | null = null;
let currentModelId: string | null = null;
let pollingInterval: NodeJS.Timeout | null = null;

// Fetch metrics from llama.cpp server
async function fetchMetrics(baseUrl: string): Promise<LlamaMetrics | null> {
	try {
		const response = await fetch(`${baseUrl}/metrics`);
		if (!response.ok) return null;

		const text = await response.text();
		const metrics: LlamaMetrics = {};

		// Parse Prometheus format
		const lines = text.split("\n");
		for (const line of lines) {
			if (line.startsWith("#")) continue;
			if (!line.trim()) continue;

			const parts = line.split(" ");
			if (parts.length < 2) continue;

			const metricName = parts[0];
			const value = parseFloat(parts[1]);

			switch (metricName) {
				case "llamacpp:prompt_tokens_seconds":
					metrics.prefillSpeed = value;
					break;
				case "llamacpp:predicted_tokens_seconds":
					metrics.generationSpeed = value;
					break;
				case "llamacpp:prompt_seconds_total":
					metrics.prefillTime = value;
					break;
				case "llamacpp:tokens_predicted_seconds_total":
					metrics.generationTime = value;
					break;
				case "llamacpp:prompt_tokens_total":
					metrics.promptTokens = value;
					break;
				case "llamacpp:tokens_predicted_total":
					metrics.generatedTokens = value;
					break;
			}
		}

		metrics.lastUpdate = Date.now();
		return metrics;
	} catch (error) {
		log("Failed to fetch metrics:", error);
		return null;
	}
}

// Format time in ms or seconds
function formatTime(seconds: number | undefined): string {
	if (seconds === undefined) return "";
	if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
	return `${seconds.toFixed(2)}s`;
}

// Format tokens per second
function formatTps(speed: number | undefined): string {
	if (speed === undefined) return "";
	return `${speed.toFixed(1)} tok/s`;
}

// Build display string for status line
function buildDisplayString(metrics: LlamaMetrics, modelId: string): string {
	const parts = [];

	if (metrics.prefillSpeed) {
		parts.push(`⚡ ${formatTps(metrics.prefillSpeed)}`);
	}
	if (metrics.generationSpeed) {
		parts.push(`🔥 ${formatTps(metrics.generationSpeed)}`);
	}
	if (metrics.promptTokens !== undefined && metrics.generatedTokens !== undefined) {
		parts.push(`📊 ${metrics.promptTokens} / ${metrics.generatedTokens}`);
	}

	if (parts.length === 0) {
		return `🦙 ${modelId}`;
	}

	return `🦙 ${modelId} • ${parts.join(" • ")}`;
}

// Build widget content for TUI
function buildWidgetContent(metrics: LlamaMetrics, modelId: string, theme: any) {
	const container = new Container();

	// Model ID line
	const modelText = new Text(`🦙 ${modelId}`, 1, 0);
	modelText.setColor(theme.fg("accent", "text"));
	container.addChild(modelText);

	// Metrics lines
	if (metrics.prefillSpeed) {
		const prefillText = new Text(`⚡ Prefill: ${formatTps(metrics.prefillSpeed)}`, 1, 0);
		prefillText.setColor(theme.fg("success", "text"));
		container.addChild(prefillText);
	}

	if (metrics.generationSpeed) {
		const genText = new Text(`🔥 Generation: ${formatTps(metrics.generationSpeed)}`, 1, 0);
		genText.setColor(theme.fg("warning", "text"));
		container.addChild(genText);
	}

	if (metrics.promptTokens !== undefined && metrics.generatedTokens !== undefined) {
		const tokensText = new Text(`📊 Tokens: ${metrics.promptTokens} / ${metrics.generatedTokens}`, 1, 0);
		tokensText.setColor(theme.fg("muted", "text"));
		container.addChild(tokensText);
	}

	if (metrics.progress?.pct !== undefined) {
		const progressText = new Text(`📈 Progress: ${metrics.progress.pct}% (${metrics.progress.processed}/${metrics.progress.total})`, 1, 0);
		progressText.setColor(theme.fg("info", "text"));
		container.addChild(progressText);
	}

	if (container.getChildren().length === 0) {
		const emptyText = new Text("No metrics available", 1, 0);
		emptyText.setColor(theme.fg("dim", "text"));
		container.addChild(emptyText);
	}

	return container;
}

// Update TUI status
function updateStatus(ctx: ExtensionContext, modelId: string, metrics: LlamaMetrics) {
	const display = buildDisplayString(metrics, modelId);

	if (display !== lastDisplay && ctx.hasUI) {
		lastDisplay = display;
		ctx.ui.setStatus("pi-llama-metrics", display);
		log("Updated status:", display);
	}
}

// Extension entry point
export default function (pi: ExtensionAPI) {
	log("Extension loaded");

	let currentCtx: ExtensionContext | null = null;

	pi.on("session_start", async (_event, ctx) => {
		log("session_start event");
		currentCtx = ctx;
		currentModelId = ctx.model?.id || null;
		log("Current model:", currentModelId);

		// Start polling if not already running
		if (!pollingInterval) {
			startPolling();
		}
	});

	pi.on("model_select", async (event, ctx) => {
		log("model_select event");
		currentModelId = event.model?.id || null;
		log("New model:", currentModelId);
	});

	pi.on("turn_start", async (_event, ctx) => {
		log("turn_start event");
		// Metrics will be updated by the polling loop
	});

	pi.on("message_update", async (event, ctx) => {
		// Could capture SSE progress here if needed
		log("message_update event");
	});

	pi.on("session_shutdown", () => {
		log("session_shutdown event");
		if (pollingInterval) {
			clearInterval(pollingInterval);
			pollingInterval = null;
		}
		latestMetrics.clear();
		lastDisplay = null;
		currentModelId = null;
		currentCtx = null;
	});

	// Poll for metrics every 2 seconds
	function startPolling() {
		pollingInterval = setInterval(async () => {
			if (!currentCtx || !currentModelId) {
				log("No context or model ID set, skipping poll");
				return;
			}

			// Get the base URL from the current provider
			const currentProvider = currentCtx.model?.provider;
			if (!currentProvider) {
				log("No provider found for model:", currentModelId);
				return;
			}

			// Try to get baseUrl from model registry
			const model = currentCtx.modelRegistry.find(currentProvider, currentModelId);
			if (!model || !model.baseUrl) {
				log("No baseUrl found for model:", currentModelId);
				return;
			}

			const metrics = await fetchMetrics(model.baseUrl);
			if (metrics) {
				latestMetrics.set(currentModelId, metrics);
				log("Fetched metrics for", currentModelId, ":", metrics);

				// Update status if we have UI
				updateStatus(currentCtx, currentModelId, metrics);
			} else {
				log("Failed to fetch metrics for", currentModelId);
			}
		}, 2000);

		log("Started polling every 2 seconds");
	}

	// Register a command to show metrics widget
	pi.registerCommand("llama-metrics", {
		description: "Show llama.cpp metrics widget",
		handler: async (args, ctx) => {
			if (!currentModelId) {
				ctx.ui.notify("No llama.cpp model selected", "warning");
				return;
			}

			const metrics = latestMetrics.get(currentModelId);
			if (!metrics) {
				ctx.ui.notify("No metrics data available", "warning");
				return;
			}

			// Show widget above editor
			ctx.ui.setWidget("llama-metrics-widget", (tui, theme) => {
				const container = new Container();
				container.addChild(new Text(`🦙 ${currentModelId}`, 1, 0));

				if (metrics.prefillSpeed) {
					container.addChild(new Text(`⚡ Prefill: ${formatTps(metrics.prefillSpeed)}`, 1, 0));
				}
				if (metrics.generationSpeed) {
					container.addChild(new Text(`🔥 Generation: ${formatTps(metrics.generationSpeed)}`, 1, 0));
				}
				if (metrics.promptTokens !== undefined && metrics.generatedTokens !== undefined) {
					container.addChild(new Text(`📊 Tokens: ${metrics.promptTokens} / ${metrics.generatedTokens}`, 1, 0));
				}

				return container;
			});

			ctx.ui.notify("Metrics widget displayed", "info");
		},
	});

	// Register a command to toggle metrics display
	pi.registerCommand("llama-metrics-toggle", {
		description: "Toggle llama.cpp metrics in status line",
		handler: async (args, ctx) => {
			if (!currentModelId) {
				ctx.ui.notify("No llama.cpp model selected", "warning");
				return;
			}

			const metrics = latestMetrics.get(currentModelId);
			if (!metrics) {
				ctx.ui.notify("No metrics data available", "warning");
				return;
			}

			if (lastDisplay) {
				ctx.ui.setStatus("pi-llama-metrics", undefined);
				lastDisplay = null;
				ctx.ui.notify("Metrics hidden", "info");
			} else {
				updateStatus(ctx, currentModelId, metrics);
				ctx.ui.notify("Metrics shown", "info");
			}
		},
	});

	log("Extension initialized");
}
