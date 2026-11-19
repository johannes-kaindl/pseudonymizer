import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api";
import type { Engine } from "../src/core/engine";
import type { PluginState } from "../src/core/status";
import { isPseudonymizerApi, type ApiError as PseudonymizerApiError, type PseudonymizerApi, type TransformRequest } from "../src/vendor/kit/pseudonymizer-source";

const SECRET = "Max Mustermann";

function fakeEngine(state: PluginState = "ready", over: Partial<Engine> = {}): { engine: Engine; calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = {
    state: vi.fn(() => state),
    transform: vi.fn(async (req: TransformRequest) => ({ parts: req.parts.map((p) => ({ id: p.id, value: p.value })), entities: [], applied: 0 })),
    restore: vi.fn((text: string) => ({ text, restored: 0, unknown: [], forgotten: [] })),
    containsPlaceholder: vi.fn(() => true),
  };
  return { engine: { ...calls, ...over } as unknown as Engine, calls };
}

const goodReq = (): TransformRequest => ({ caller: "mailstone", documentKey: "<id@example.org>", interactive: false, parts: [{ id: "a", kind: "text", value: "Hallo" }] });
const code = (r: unknown): string | undefined => (r as PseudonymizerApiError).error;

function api(state: PluginState = "ready", over: Partial<Engine> = {}): { api: PseudonymizerApi; calls: ReturnType<typeof fakeEngine>["calls"] } {
  const { engine, calls } = fakeEngine(state, over);
  return { api: createApi(() => engine), calls };
}

describe("createApi", () => {
  it("version is 1 and the contract guard accepts the object", () => {
    const { api: a } = api();
    expect(a.version).toBe(1);
    expect(isPseudonymizerApi(a)).toBe(true);
  });

  it("status() reports the state of the engine", () => {
    for (const s of ["ready", "locked", "not-set-up"] as const) expect(api(s).api.status()).toEqual({ state: s });
  });

  it("status() never throws: a failing engine reads as locked", () => {
    const { api: a } = api("ready", { state: () => { throw new Error(SECRET); } });
    expect(a.status()).toEqual({ state: "locked" });
  });

  it("the engine can be swapped without replacing the api object", async () => {
    let current = fakeEngine("not-set-up").engine;
    const a = createApi(() => current);
    expect(a.status().state).toBe("not-set-up");
    current = fakeEngine("ready").engine;
    expect(a.status().state).toBe("ready");
  });

  describe("transform: input check before anything else", () => {
    const bad: [string, unknown][] = [
      ["no request", undefined],
      ["request is not an object", "text"],
      ["missing caller", { ...goodReq(), caller: undefined }],
      ["blank caller", { ...goodReq(), caller: "  " }],
      ["empty documentKey", { ...goodReq(), documentKey: "" }],
      ["interactive is not a boolean", { ...goodReq(), interactive: "yes" }],
      ["parts is not an array", { ...goodReq(), parts: "x" }],
      ["part id is not a string", { ...goodReq(), parts: [{ id: 1, kind: "text", value: "x" }] }],
      ["part id is empty", { ...goodReq(), parts: [{ id: "", kind: "text", value: "x" }] }],
      ["duplicate part id", { ...goodReq(), parts: [{ id: "a", kind: "text", value: "x" }, { id: "a", kind: "line", value: "y" }] }],
      ["kind outside text|line|filename", { ...goodReq(), parts: [{ id: "a", kind: "html", value: "x" }] }],
      ["value is not a string", { ...goodReq(), parts: [{ id: "a", kind: "text", value: 5 }] }],
      ["part is null", { ...goodReq(), parts: [null] }],
      ["title is not a string", { ...goodReq(), title: 3 }],
      ["entities is not an array", { ...goodReq(), entities: {} }],
      ["entity name is not a string", { ...goodReq(), entities: [{ name: 4 }] }],
      ["keep is not an array of strings", { ...goodReq(), keep: ["a", 2] }],
    ];
    for (const [name, req] of bad) {
      it(`${name} -> invalid-input, engine not called`, async () => {
        const { api: a, calls } = api();
        const r = await a.transform(req as TransformRequest);
        expect(code(r)).toBe("invalid-input");
        expect(calls.transform).not.toHaveBeenCalled();
        expect(calls.state).not.toHaveBeenCalled();
      });
    }
  });

  describe("transform: state", () => {
    it("not-set-up -> not-ready without calling the engine", async () => {
      const { api: a, calls } = api("not-set-up");
      expect(code(await a.transform(goodReq()))).toBe("not-ready");
      expect(calls.transform).not.toHaveBeenCalled();
    });
    it("locked -> locked without calling the engine", async () => {
      const { api: a, calls } = api("locked");
      expect(code(await a.transform(goodReq()))).toBe("locked");
      expect(calls.transform).not.toHaveBeenCalled();
    });
    it("ready -> the engine result goes through unchanged", async () => {
      const { api: a, calls } = api("ready");
      const req = { ...goodReq(), entities: [{ name: "A", email: "a@example.org" }], keep: ["me@example.org"], title: "T" };
      expect(await a.transform(req)).toEqual({ parts: [{ id: "a", value: "Hallo" }], entities: [], applied: 0 });
      expect(calls.transform).toHaveBeenCalledTimes(1);
    });
    it("an error value of the engine goes through", async () => {
      const err: PseudonymizerApiError = { error: "deferred", message: "open candidates" };
      const { api: a } = api("ready", { transform: async () => err });
      expect(await a.transform(goodReq())).toEqual(err);
    });
  });

  describe("transform: failing engine", () => {
    it("a throwing engine -> storage-failed, message without the exception text", async () => {
      const { api: a } = api("ready", { transform: () => { throw new Error(SECRET); } });
      const r = await a.transform(goodReq()) as PseudonymizerApiError;
      expect(r.error).toBe("storage-failed");
      expect(r.message).not.toContain(SECRET);
      expect(JSON.stringify(r)).not.toContain("Mustermann");
    });
    it("a rejecting engine -> storage-failed, message without the exception text", async () => {
      const { api: a } = api("ready", { transform: () => Promise.reject(new Error(SECRET)) });
      const r = await a.transform(goodReq()) as PseudonymizerApiError;
      expect(r.error).toBe("storage-failed");
      expect(r.message).not.toContain(SECRET);
    });
    it("a throwing state() on transform -> storage-failed, never an exception", async () => {
      const { api: a } = api("ready", { state: () => { throw new Error(SECRET); } });
      const r = await a.transform(goodReq()) as PseudonymizerApiError;
      expect(r.error).toBe("storage-failed");
      expect(r.message).not.toContain(SECRET);
    });
  });

  describe("restore", () => {
    it("a non-string -> invalid-input, engine not called", () => {
      const { api: a, calls } = api();
      expect(code(a.restore(5 as unknown as string, { caller: "x" }))).toBe("invalid-input");
      expect(calls.restore).not.toHaveBeenCalled();
    });
    it("a missing caller -> invalid-input", () => {
      const { api: a, calls } = api();
      expect(code(a.restore("t", undefined as unknown as { caller: string }))).toBe("invalid-input");
      expect(code(a.restore("t", { caller: "" }))).toBe("invalid-input");
      expect(calls.restore).not.toHaveBeenCalled();
    });
    it("locked -> locked, not-set-up -> not-ready, each without calling the engine", () => {
      const l = api("locked");
      expect(code(l.api.restore("t", { caller: "mailstone" }))).toBe("locked");
      expect(l.calls.restore).not.toHaveBeenCalled();
      const n = api("not-set-up");
      expect(code(n.api.restore("t", { caller: "mailstone" }))).toBe("not-ready");
      expect(n.calls.restore).not.toHaveBeenCalled();
    });
    it("ready -> the engine gets text and caller, the result goes through", () => {
      const { api: a, calls } = api("ready");
      expect(a.restore("Hallo", { caller: "mailstone" })).toEqual({ text: "Hallo", restored: 0, unknown: [], forgotten: [] });
      expect(calls.restore).toHaveBeenCalledWith("Hallo", "mailstone");
    });
    it("a throwing engine -> not-ready, message without the exception text", () => {
      const { api: a } = api("ready", { restore: () => { throw new Error(SECRET); } });
      const r = a.restore("t", { caller: "x" }) as PseudonymizerApiError;
      expect(r.error).toBe("not-ready");
      expect(r.message).not.toContain(SECRET);
    });
    it("a throwing state() -> not-ready", () => {
      const { api: a } = api("ready", { state: () => { throw new Error(SECRET); } });
      expect(code(a.restore("t", { caller: "x" }))).toBe("not-ready");
    });
  });

  describe("containsPlaceholder", () => {
    it("a non-string is false and the engine is not asked", () => {
      const { api: a, calls } = api();
      expect(a.containsPlaceholder(5 as unknown as string)).toBe(false);
      expect(a.containsPlaceholder(null as unknown as string)).toBe(false);
      expect(calls.containsPlaceholder).not.toHaveBeenCalled();
    });
    it("a string asks the engine", () => {
      const { api: a, calls } = api();
      expect(a.containsPlaceholder("Person_k3x9m2ab7q")).toBe(true);
      expect(calls.containsPlaceholder).toHaveBeenCalledWith("Person_k3x9m2ab7q");
    });
    it("a throwing engine is false", () => {
      const { api: a } = api("ready", { containsPlaceholder: () => { throw new Error(SECRET); } });
      expect(a.containsPlaceholder("x")).toBe(false);
    });
  });
});
