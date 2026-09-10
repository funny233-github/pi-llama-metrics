#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extension name and destination
const EXTENSION_NAME = "pi-llama-metrics-display";
const HOME_PI_EXTENSIONS = path.join(
  process.env.HOME || process.env.HOMEPATH,
  ".pi",
  "agent",
  "extensions",
);

console.log(`📦 Installing ${EXTENSION_NAME} to ${HOME_PI_EXTENSIONS}...`);

// Create destination directory if it doesn't exist
if (!fs.existsSync(HOME_PI_EXTENSIONS)) {
  fs.mkdirSync(HOME_PI_EXTENSIONS, { recursive: true });
  console.log(`✅ Created directory: ${HOME_PI_EXTENSIONS}`);
}

// Destination for this extension
const EXTENSION_DEST = path.join(HOME_PI_EXTENSIONS, EXTENSION_NAME);

// Check if extension already exists
if (fs.existsSync(EXTENSION_DEST)) {
  console.log(`⚠️  Extension already exists at ${EXTENSION_DEST}`);
  console.log("   Removing existing files...");

  // Remove all files in the directory
  const files = fs.readdirSync(EXTENSION_DEST);
  for (const file of files) {
    const filePath = path.join(EXTENSION_DEST, file);
    if (fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    } else {
      fs.rmSync(filePath, { recursive: true });
    }
  }
  // Remove the directory itself
  fs.rmdirSync(EXTENSION_DEST);
  console.log("✅ Removed existing extension");
}

// Create extension directory
fs.mkdirSync(EXTENSION_DEST, { recursive: true });
console.log(`✅ Created extension directory: ${EXTENSION_DEST}`);

// Copy files to destination
const filesToCopy = ["index.ts", "package.json", "README.md"];

let copied = 0;
for (const file of filesToCopy) {
  const srcPath = path.join(__dirname, file);
  const destPath = path.join(EXTENSION_DEST, file);

  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`✅ Copied ${file}`);
    copied++;
  } else {
    console.error(`❌ Missing source file: ${file}`);
  }
}

if (copied === filesToCopy.length) {
  console.log("");
  console.log(`🎉 Installation complete!`);
  console.log(`📍 Extension location: ${EXTENSION_DEST}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Restart pi (or run /reload)`);
  console.log("  2. Select a llama.cpp model");
  console.log("  3. Metrics will appear in the status line automatically");
  console.log("");
  console.log("Commands:");
  console.log("  /llama-metrics          - Show metrics widget");
  console.log("  /llama-metrics-toggle   - Toggle status line display");
  console.log("");
} else {
  console.error("❌ Installation failed. Some files could not be copied.");
  process.exit(1);
}
