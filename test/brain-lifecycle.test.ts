import { describe, expect, test } from "bun:test";
import { Hippocampus } from "../src/hippocampus/index";
import { RAS } from "../src/ras/index";
import { Thalamus } from "../src/thalamus/index";
import { Tick } from "../src/tick/index";

describe("brain stub lifecycle", () => {
  describe("Thalamus", () => {
    test("start does not throw", async () => {
      const t = new Thalamus();
      await expect(t.start()).resolves.toBeUndefined();
    });

    test("stop does not throw", async () => {
      const t = new Thalamus();
      await expect(t.stop()).resolves.toBeUndefined();
    });

    test("syncAll returns result", async () => {
      const t = new Thalamus();
      const result = await t.syncAll();
      expect(result.ok).toBe(true);
      expect(result.groups).toBe(0);
      expect(result.buffers).toBe(0);
    });

    test("syncChannel returns result", async () => {
      const t = new Thalamus();
      const result = await t.syncChannel("telegram");
      expect(result.ok).toBe(true);
      expect(result.groups).toBe(0);
      expect(result.buffers).toBe(0);
    });
  });

  describe("Tick", () => {
    test("start does not throw", async () => {
      const t = new Tick();
      await expect(t.start()).resolves.toBeUndefined();
    });

    test("stop does not throw", async () => {
      const t = new Tick();
      await expect(t.stop()).resolves.toBeUndefined();
    });

    test("fire does not throw", async () => {
      const t = new Tick();
      await expect(t.fire()).resolves.toBeUndefined();
    });
  });

  describe("Hippocampus", () => {
    test("start does not throw", async () => {
      const h = new Hippocampus();
      await expect(h.start()).resolves.toBeUndefined();
    });

    test("stop does not throw", async () => {
      const h = new Hippocampus();
      await expect(h.stop()).resolves.toBeUndefined();
    });

    test("consolidate does not throw", async () => {
      const h = new Hippocampus();
      await expect(h.consolidate()).resolves.toBeUndefined();
    });
  });

  describe("RAS", () => {
    test("start does not throw", async () => {
      const r = new RAS();
      await expect(r.start()).resolves.toBeUndefined();
    });

    test("stop does not throw", async () => {
      const r = new RAS();
      await expect(r.stop()).resolves.toBeUndefined();
    });

    test("scan does not throw", async () => {
      const r = new RAS();
      await expect(r.scan()).resolves.toBeUndefined();
    });
  });
});
