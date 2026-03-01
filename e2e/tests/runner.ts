/**
 * Test runner for E2E tests.
 *
 * Discovers and runs numbered test files (01-*.ts, 02-*.ts, etc.) from tests/.
 *
 * Usage:
 *   bun run test              # Run all tests
 *   bun run test:one <name>   # Run a single test by name/pattern
 */

import { readdir } from "fs/promises";
import { join } from "path";
import type { TestFn, TestResult } from "../lib/types";

interface RunnerArgs {
  only?: string;
}

function parseArgs(): RunnerArgs {
  const args = process.argv.slice(2);
  const result: RunnerArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--only" && args[i + 1]) {
      result.only = args[i + 1];
      i++;
    }
  }

  return result;
}

/** Discover numbered test files (01-*.ts, 02-*.ts, etc.) from tests/ directory */
async function discoverTests(): Promise<string[]> {
  const testsDir = import.meta.dir;
  try {
    const files = await readdir(testsDir);
    // Match numbered test files: 01-*.ts, 02-*.ts, etc.
    const testFiles = files
      .filter((f) => /^\d{2}-.*\.ts$/.test(f))
      .sort() // Ensure numeric order
      .map((f) => join(testsDir, f));
    return testFiles;
  } catch {
    return [];
  }
}

async function loadTest(filePath: string): Promise<TestFn | null> {
  try {
    const mod = await import(filePath);
    if (typeof mod.name === "string" && typeof mod.run === "function") {
      return { name: mod.name, run: mod.run };
    }
    return null;
  } catch (err) {
    console.error(`Failed to load test: ${filePath}`, err);
    return null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printResult(result: TestResult): void {
  const status = result.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const duration = `\x1b[90m(${formatDuration(result.duration)})\x1b[0m`;
  console.log(`  ${status} ${result.name} ${duration}`);
  if (!result.passed && result.error) {
    console.log(`    \x1b[31m${result.error}\x1b[0m`);
  }
}

function printSummary(results: TestResult[]): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log();
  console.log("─".repeat(50));
  const passedStr = `\x1b[32m${passed} passed\x1b[0m`;
  const failedStr = failed > 0 ? `\x1b[31m${failed} failed\x1b[0m` : "";
  const parts = [passedStr, failedStr].filter(Boolean).join(", ");
  console.log(`  ${parts} in ${formatDuration(totalTime)}`);
}

async function writeResults(results: TestResult[]): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = join(import.meta.dir, "../results");

  // Ensure results directory exists
  await Bun.write(join(resultsDir, ".gitkeep"), "");

  const filename = `${timestamp}.json`;
  const filepath = join(resultsDir, filename);

  const output = {
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
    },
    results,
  };

  await Bun.write(filepath, JSON.stringify(output, null, 2));
  return filename;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Discover tests from tests/ directory
  const testPaths = await discoverTests();

  // Load all tests
  const tests: TestFn[] = [];
  for (const path of testPaths) {
    const test = await loadTest(path);
    if (test) {
      tests.push(test);
    }
  }

  // Filter by name if --only is specified
  let testsToRun = tests;
  if (args.only) {
    testsToRun = tests.filter(
      (t) => t.name === args.only || t.name.includes(args.only!)
    );
    if (testsToRun.length === 0) {
      console.error(`No test found matching: ${args.only}`);
      process.exit(1);
    }
  }

  // Print header
  console.log();
  console.log(`Running ${testsToRun.length} test(s)...`);
  console.log();

  // Run tests sequentially
  const results: TestResult[] = [];
  for (const test of testsToRun) {
    const result = await test.run();
    results.push(result);
    printResult(result);
  }

  // Print summary
  printSummary(results);

  // Write JSON results
  const filename = await writeResults(results);
  console.log(`  Results written to results/${filename}`);
  console.log();

  // Exit with error code if any tests failed
  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
