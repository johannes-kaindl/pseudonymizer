import { describe, expect, it } from "vitest";
import { deriveStatus, type LockReason, type PluginState, type StatusInput } from "../src/core/status";

const base: StatusInput = {
  deviceFiles: 0,
  readableHeads: 0,
  hasKey: false,
  keyCorrupt: false,
  openedFiles: 0,
  ownChainMatches: false,
  storageError: false,
};

interface Row {
  name: string;
  input: Partial<StatusInput>;
  state: PluginState;
  reason: LockReason | null;
}

const rows: Row[] = [
  { name: "no file and no key is not set up", input: {}, state: "not-set-up", reason: null },
  { name: "unreadable files and no key: locked, never not-set-up", input: { deviceFiles: 2 }, state: "locked", reason: "no-key" },
  { name: "readable files and no key", input: { deviceFiles: 1, readableHeads: 1 }, state: "locked", reason: "no-key" },
  { name: "key and only files without a readable head", input: { hasKey: true, deviceFiles: 2, readableHeads: 0 }, state: "locked", reason: "unreadable" },
  { name: "corrupt key store entry", input: { keyCorrupt: true, deviceFiles: 1, readableHeads: 1 }, state: "locked", reason: "key-corrupt" },
  { name: "corrupt key store entry without any file", input: { keyCorrupt: true }, state: "locked", reason: "key-corrupt" },
  { name: "key but no file: never ready with an empty table", input: { hasKey: true }, state: "locked", reason: "table-missing" },
  { name: "key, files, none opened, foreign chain", input: { hasKey: true, deviceFiles: 1, readableHeads: 1, ownChainMatches: false }, state: "locked", reason: "foreign-chain" },
  { name: "key, files of the own chain, none opened", input: { hasKey: true, deviceFiles: 1, readableHeads: 1, ownChainMatches: true }, state: "locked", reason: "key-opens-nothing" },
  { name: "at least one file opened", input: { hasKey: true, deviceFiles: 3, readableHeads: 2, openedFiles: 1, ownChainMatches: true }, state: "ready", reason: null },
  { name: "opened files win over a foreign chain flag of other files", input: { hasKey: true, deviceFiles: 2, readableHeads: 2, openedFiles: 1, ownChainMatches: false }, state: "ready", reason: null },
  { name: "storage error beats not set up", input: { storageError: true }, state: "locked", reason: "storage-failed" },
  { name: "storage error beats ready", input: { storageError: true, hasKey: true, deviceFiles: 1, readableHeads: 1, openedFiles: 1, ownChainMatches: true }, state: "locked", reason: "storage-failed" },
  { name: "storage error beats a corrupt key", input: { storageError: true, keyCorrupt: true }, state: "locked", reason: "storage-failed" },
];

describe("deriveStatus", () => {
  it.each(rows)("$name", ({ input, state, reason }) => {
    expect(deriveStatus({ ...base, ...input })).toEqual({ state, reason });
  });

  it("covers every lock reason at least once", () => {
    const seen = new Set(rows.map((r) => r.reason));
    for (const r of ["no-key", "key-opens-nothing", "table-missing", "foreign-chain", "unreadable", "key-corrupt", "storage-failed"] as const) {
      expect(seen.has(r)).toBe(true);
    }
  });
});
