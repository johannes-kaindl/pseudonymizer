import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_SECRET_ID, createKeyStore } from "../src/obsidian/key-store";
import { codeOf, codeWithVersion, fakeSecrets, sampleContent } from "./helpers/key-fixtures";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  // Kein Schlüssel und kein Code in console, in keinem Test dieser Datei.
  expect(printed).toBe(0);
});

const isError = (r: unknown): r is { error: string } => typeof r === "object" && r !== null && "error" in r;

describe("key store: id", () => {
  it("uses the id the spec names and an id Obsidian accepts", () => {
    expect(KEY_SECRET_ID).toBe("pseudonymizer-key");
    expect(KEY_SECRET_ID).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("key store: round trip", () => {
  it("reads null when nothing is stored", () => {
    expect(createKeyStore(fakeSecrets()).read()).toBeNull();
  });
  it("write then read returns the same chain id, stand and key", () => {
    const secrets = fakeSecrets();
    const store = createKeyStore(secrets);
    const c = sampleContent(5, 42);
    expect(store.write(c)).toBeUndefined();
    const back = store.read();
    expect(isError(back) || back === null).toBe(false);
    if (back === null || isError(back)) return;
    expect(Array.from(back.chainId)).toEqual(Array.from(c.chainId));
    expect(back.stand).toBe(42);
    expect(Array.from(back.key)).toEqual(Array.from(c.key));
  });
  it("stores the key in the text form of the recovery code under the key id", () => {
    const secrets = fakeSecrets();
    const c = sampleContent(2, 7);
    createKeyStore(secrets).write(c);
    expect(secrets.raw(KEY_SECRET_ID)).toBe(codeOf(c));
    expect(secrets.calls).toContain(`set:${KEY_SECRET_ID}`);
  });
  it("a second write replaces the first", () => {
    const store = createKeyStore(fakeSecrets());
    store.write(sampleContent(1, 1));
    store.write(sampleContent(1, 2));
    const back = store.read();
    expect(isError(back) || back === null ? -1 : back.stand).toBe(2);
  });
  it("reads a stored value written in lower case and with blanks (the same reading as the code entry)", () => {
    const secrets = fakeSecrets();
    secrets.poke(KEY_SECRET_ID, ` ${codeOf(sampleContent(4, 9)).toLowerCase()} `);
    const back = createKeyStore(secrets).read();
    expect(isError(back) || back === null ? -1 : back.stand).toBe(9);
  });
});

describe("key store: a damaged value never yields a key", () => {
  const damaged: [string, string][] = [
    ["not a code at all", "hello world"],
    ["too short", codeOf(sampleContent()).slice(0, 20)],
    ["too long", `${codeOf(sampleContent())}-AAAAA`],
    ["a character outside the alphabet", `${"U".repeat(5)}${codeOf(sampleContent()).slice(5)}`],
    ["one symbol changed (check symbol fails)", (() => { const c = codeOf(sampleContent()); return `${c[0] === "0" ? "1" : "0"}${c.slice(1)}`; })()],
    ["two neighbours swapped (check symbol fails)", (() => { const c = codeOf(sampleContent(1, 1)); return `${c[1]}${c[0]}${c.slice(2)}`; })()],
    ["an unknown version with a valid check symbol", codeWithVersion(2)],
  ];
  for (const [name, value] of damaged) {
    it(`${name} gives { error: "corrupt" } and nothing else`, () => {
      const secrets = fakeSecrets();
      secrets.poke(KEY_SECRET_ID, value);
      const r = createKeyStore(secrets).read();
      expect(r).toEqual({ error: "corrupt" });
      expect(r).not.toHaveProperty("key");
    });
  }
  it("the fixture with an unknown version really carries a valid check symbol (so the version path is the one reached)", () => {
    expect(codeWithVersion(1)).toBe(codeOf({ ...sampleContent(), stand: 0 }));
  });
  it("a damaged value is not repaired or cleared by reading", () => {
    const secrets = fakeSecrets();
    secrets.poke(KEY_SECRET_ID, "garbage");
    const store = createKeyStore(secrets);
    store.read();
    store.read();
    expect(secrets.raw(KEY_SECRET_ID)).toBe("garbage");
    expect(secrets.calls.filter((c) => c.startsWith("set:") || c.startsWith("delete:"))).toEqual([]);
  });
  it("a store whose read throws gives corrupt, never a key, and the message does not travel", () => {
    const r = createKeyStore(fakeSecrets({ throwOnGet: "TOPSECRET-MATERIAL" })).read();
    expect(r).toEqual({ error: "corrupt" });
    expect(JSON.stringify(r)).not.toContain("TOPSECRET");
  });
});

describe("key store: clear", () => {
  it("writes the empty string and read gives null afterwards", () => {
    const secrets = fakeSecrets();
    const store = createKeyStore(secrets);
    store.write(sampleContent());
    store.clear();
    expect(secrets.raw(KEY_SECRET_ID)).toBe("");
    expect(secrets.calls).toContain(`delete:${KEY_SECRET_ID}`);
    expect(store.read()).toBeNull();
  });
  it("clear on an empty store is harmless", () => {
    const store = createKeyStore(fakeSecrets());
    expect(() => { store.clear(); }).not.toThrow();
    expect(store.read()).toBeNull();
  });
});

describe("key store: write failures are values", () => {
  it("a store that throws gives { error: 'storage-failed' } and no text of the exception", () => {
    const content = sampleContent();
    const r = createKeyStore(fakeSecrets({ throwOnSet: `could not persist ${codeOf(content)} TOPSECRET` })).write(content);
    expect(r).toEqual({ error: "storage-failed" });
    const shown = JSON.stringify(r);
    expect(shown).not.toContain("TOPSECRET");
    expect(shown).not.toContain(codeOf(content).slice(0, 11));
  });
  it("a store that keeps nothing without throwing is caught by the read-back", () => {
    const secrets = fakeSecrets({ dropWrites: true });
    const store = createKeyStore(secrets);
    expect(store.write(sampleContent())).toEqual({ error: "storage-failed" });
    expect(store.read()).toBeNull();
  });
  it("a store that holds another value than written is a failure too", () => {
    const secrets = fakeSecrets();
    const store = createKeyStore({ ...secrets, set: (id, v) => { secrets.set(id, `${v}-X`); } });
    expect(store.write(sampleContent())).toEqual({ error: "storage-failed" });
  });
  it("content that cannot be encoded writes nothing and gives storage-failed", () => {
    const secrets = fakeSecrets();
    const bad = { ...sampleContent(), key: new Uint8Array(31) };
    expect(createKeyStore(secrets).write(bad)).toEqual({ error: "storage-failed" });
    expect(secrets.calls.filter((c) => c.startsWith("set:"))).toEqual([]);
  });
  it("a failed write leaves the older key in place", () => {
    const secrets = fakeSecrets();
    const store = createKeyStore(secrets);
    store.write(sampleContent(1, 1));
    const failing = createKeyStore({ ...secrets, set: () => { throw new Error("boom"); } });
    expect(failing.write(sampleContent(1, 2))).toEqual({ error: "storage-failed" });
    const back = store.read();
    expect(isError(back) || back === null ? -1 : back.stand).toBe(1);
  });
});
