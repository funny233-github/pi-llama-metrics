#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extension name and destination
const EXTENSION_NAME = "pi-llama-metrics";
const HOME_PI_EXTENSIONS = path.join(
  process.env.HOME || process.env.HOMEPATH,
  ".pi",
  "agent",
  "extensions",
);

console.log(`🗑️  Uninstalling ${EXTENSION_NAME}...`);
console.log(`   From: ${HOME_PI_EXTENSIONS}`);
console.log("");

// Destination for this extension
const EXTENSION_DEST = path.join(HOME_PI_EXTENSIONS, EXTENSION_NAME);

// Check if extension exists
if (!fs.existsSync(EXTENSION_DEST)) {
  console.log(`⚠️  Extension not found at ${EXTENSION_DEST}`);
  console.log("   Nothing to uninstall.");
  console.log("");
  process.exit(0);
}

// Remove extension directory
console.log("📦 Removing extension directory...");
fs.rmSync(EXTENSION_DEST, { recursive: true });
console.log("✅ Extension removed successfully!");
console.log("");
console.log("Next steps:");
console.log("  Restart pi (or run /reload) to apply changes");
console.log("");
