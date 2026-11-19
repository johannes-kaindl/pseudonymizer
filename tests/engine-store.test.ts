import { describe, expect, it } from "vitest";
import { MemoryTable } from "../src/core/memory-table";
import { PseudonymizerEngine, type TableStorePort } from "../src/obsidian/engine";
import { personTable, ID_A } from "./helpers/store-fixtures";

describe("engine: persist and refresh", () => {
  it("without a store nothing is written and persist says not-ready", async () => {
    const e = new PseudonymizerEngine(new MemoryTable());
    expect(await e.persist(personTable(ID_A, "Max Mustermann"))).toEqual({ error: "not-ready" });
    await expect(e.refresh()).resolves.toBeUndefined();
  });
  it("hands the change to the current store, looked up at call time", async () => {
    const calls: string[] = [];
    let store: TableStorePort | null = null;
    const e = new PseudonymizerEngine(new MemoryTable(), () => store);
    store = { refresh: () => { calls.push("refresh"); return Promise.resolve(); }, persist: () => { calls.push("persist"); return Promise.resolve({ error: "storage-failed" as const }); } };
    expect(await e.persist()).toEqual({ error: "storage-failed" });
    await e.refresh();
    expect(calls).toEqual(["persist", "refresh"]);
  });
});
