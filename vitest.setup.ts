import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads the repo-root .env into the test environment (Node 20.12+ native
 * `process.loadEnvFile`). Missing .env is fine — tests that need a real key
 * (llm-integration) skip themselves.
 *
 * This is test-only. The apps do NOT load .env — they read process.env
 * directly (docker/minikube injects the values).
 */
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(rootDir, ".env");

try {
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
} catch (error) {
  // Malformed .env must not silently break the suite
  console.warn(`[vitest.setup] Failed to load ${envPath}:`, error);
}
