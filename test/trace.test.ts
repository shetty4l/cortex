import { describe, expect, test } from "bun:test";
import { generateTraceId, getTraceId, runWithTraceId } from "../src/trace";

describe("trace", () => {
  test("generateTraceId returns 8-character string", () => {
    const id = generateTraceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBe(8);
  });

  test("generateTraceId returns unique values", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTraceId());
    }
    expect(ids.size).toBe(100);
  });

  test("getTraceId returns undefined outside of context", () => {
    expect(getTraceId()).toBeUndefined();
  });

  test("getTraceId returns trace ID inside context", () => {
    const traceId = "abc12345";
    let capturedId: string | undefined;

    runWithTraceId(traceId, () => {
      capturedId = getTraceId();
    });

    expect(capturedId).toBe(traceId);
  });

  test("runWithTraceId returns function result", () => {
    const result = runWithTraceId("trace1", () => {
      return 42;
    });

    expect(result).toBe(42);
  });

  test("runWithTraceId supports async functions", async () => {
    const traceId = "async123";
    let capturedId: string | undefined;

    await runWithTraceId(traceId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      capturedId = getTraceId();
    });

    expect(capturedId).toBe(traceId);
  });

  test("nested runWithTraceId uses innermost context", () => {
    const outer = "outer123";
    const inner = "inner456";
    let outerCapture: string | undefined;
    let innerCapture: string | undefined;

    runWithTraceId(outer, () => {
      outerCapture = getTraceId();

      runWithTraceId(inner, () => {
        innerCapture = getTraceId();
      });
    });

    expect(outerCapture).toBe(outer);
    expect(innerCapture).toBe(inner);
  });

  test("trace context is restored after nested context exits", () => {
    const outer = "outer789";
    const inner = "inner012";
    let afterNestedCapture: string | undefined;

    runWithTraceId(outer, () => {
      runWithTraceId(inner, () => {
        // Inside inner
      });
      afterNestedCapture = getTraceId();
    });

    expect(afterNestedCapture).toBe(outer);
  });

  test("trace ID propagates through Promise.all", async () => {
    const traceId = "promise1";
    const captures: (string | undefined)[] = [];

    await runWithTraceId(traceId, async () => {
      await Promise.all([
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          captures.push(getTraceId());
        })(),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          captures.push(getTraceId());
        })(),
      ]);
    });

    expect(captures).toEqual([traceId, traceId]);
  });
});
