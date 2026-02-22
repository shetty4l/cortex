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

    test("syncAll does not throw", async () => {
      const t = new Thalamus();
      await expect(t.syncAll()).resolves.toBeUndefined();
    });

    test("syncChannel does not throw", async () => {
      const t = new Thalamus();
      await expect(t.syncChannel("telegram")).resolves.toBeUndefined();
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
