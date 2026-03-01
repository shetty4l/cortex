/**
 * Wait and sleep utilities for E2E tests.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
  message?: string;
  showSpinner?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clearLine(): void {
  process.stdout.write("\r\x1b[K");
}

/**
 * Wait for a condition to be met. Returns when fn returns a truthy value.
 * Throws on timeout.
 */
export async function waitFor<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  opts: WaitForOptions = {}
): Promise<T> {
  const {
    timeout = 30000,
    interval = 500,
    message = "Condition not met",
    showSpinner = false,
  } = opts;
  const deadline = Date.now() + timeout;
  let frameIndex = 0;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();

    if (showSpinner) {
      const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
      const countdown = formatCountdown(remaining);
      clearLine();
      process.stdout.write(`${frame} ${countdown} remaining`);
      frameIndex++;
    }

    const result = await fn();
    if (result !== null && result !== undefined) {
      if (showSpinner) {
        clearLine();
      }
      return result;
    }
    await sleep(interval);
  }

  if (showSpinner) {
    clearLine();
  }

  throw new Error(`${message} (timeout: ${timeout}ms)`);
}
