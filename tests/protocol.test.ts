import { describe, expect, it } from "vitest";
import {
  advanceCandidates,
  classifyFile,
  codeStandOf,
  forgetProgress,
  mustAdvanceBeforeWrite,
  type DeviceView,
  type FileHead,
  type OwnKey,
} from "../src/core/protocol";

const own: OwnKey = { chainId: "0a0b0c0d", stand: 4 };
const head = (stand: number, chainId = own.chainId, deviceId = "dev-a"): FileHead => ({ deviceId, chainId, stand });

describe("classifyFile", () => {
  it.each([
    [4, "0a0b0c0d", "same"],
    [3, "0a0b0c0d", "behind"],
    [0, "0a0b0c0d", "behind"],
    [5, "0a0b0c0d", "ahead"],
    [1004, "0a0b0c0d", "ahead"],
    [1005, "0a0b0c0d", "too-far"],
    [2000, "0a0b0c0d", "too-far"],
    [4, "ffffffff", "foreign-chain"],
    [5000, "ffffffff", "foreign-chain"],
    [1, "ffffffff", "foreign-chain"],
  ] as const)("stand %i on chain %s is %s", (stand, chainId, expected) => {
    expect(classifyFile(own, head(stand, chainId), 1000)).toBe(expected);
  });

  it("maxJump is a parameter, not a constant", () => {
    expect(classifyFile(own, head(6), 1)).toBe("too-far");
    expect(classifyFile(own, head(5), 1)).toBe("ahead");
    expect(classifyFile(own, head(6), 2)).toBe("ahead");
  });
});

describe("advanceCandidates", () => {
  it("takes only own-chain files within the jump, highest first, each stand once", () => {
    const heads = [head(5), head(7), head(7, own.chainId, "dev-b"), head(2000), head(9, "ffffffff")];
    expect(advanceCandidates(own, heads, 1000)).toEqual([7, 5]);
  });
  it("ignores same and behind", () => {
    expect(advanceCandidates(own, [head(4), head(3), head(0)], 1000)).toEqual([]);
  });
  it("the upper bound is own.stand + maxJump, inclusive", () => {
    expect(advanceCandidates(own, [head(1004), head(1005)], 1000)).toEqual([1004]);
  });
  it("does not change its input", () => {
    const heads = [head(5), head(7)];
    advanceCandidates(own, heads, 1000);
    expect(heads.map((h) => h.stand)).toEqual([5, 7]);
  });
});

const dev = (name: string, over: Partial<DeviceView> = {}): DeviceView => ({
  deviceId: `id-${name}`,
  name,
  opened: true,
  stand: 5,
  carriesMarks: true,
  ...over,
});

describe("forgetProgress", () => {
  it("counts devices that are opened and carry the marks; names the others", () => {
    const p = forgetProgress([dev("MacBook JK"), dev("Mac mini"), dev("iPhone JK", { opened: false })], 5, 5);
    expect(p).toMatchObject({ devicesDone: 2, devicesTotal: 3, pending: ["iPhone JK"], complete: false });
  });
  it("complete when all are done, on the same stand, and the code matches the current stand", () => {
    const p = forgetProgress([dev("a"), dev("b"), dev("c")], 5, 5);
    expect(p).toMatchObject({ devicesDone: 3, devicesTotal: 3, pending: [], codeStand: 5, currentStand: 5, codeOutdated: false, complete: true });
  });
  it("an outdated code blocks completion and is flagged", () => {
    const p = forgetProgress([dev("a"), dev("b")], 5, 4);
    expect(p).toMatchObject({ codeStand: 4, currentStand: 5, codeOutdated: true, complete: false });
  });
  it("no recorded code counts as outdated", () => {
    const p = forgetProgress([dev("a")], 5, null);
    expect(p).toMatchObject({ codeStand: null, codeOutdated: true, complete: false });
  });
  it("same stand without the marks does not count as caught up", () => {
    const p = forgetProgress([dev("a"), dev("iPad", { stand: 5, carriesMarks: false })], 5, 5);
    expect(p).toMatchObject({ devicesDone: 1, devicesTotal: 2, pending: ["iPad"], complete: false });
  });
  it("a device whose file cannot be opened is pending", () => {
    const p = forgetProgress([dev("a"), dev("b", { opened: false, carriesMarks: true })], 5, 5);
    expect(p.pending).toEqual(["b"]);
    expect(p.complete).toBe(false);
  });
  it("devices with the marks but on different stands are not complete (Spec 8.3: alle auf demselben Stand)", () => {
    const p = forgetProgress([dev("a"), dev("b", { stand: 6 })], 5, 5);
    expect(p).toMatchObject({ devicesDone: 2, pending: [], complete: false });
  });
  it("no devices is nothing measured, not complete", () => {
    expect(forgetProgress([], 5, 5)).toMatchObject({ devicesDone: 0, devicesTotal: 0, complete: false });
  });
  it("keeps the order of the devices in pending", () => {
    const p = forgetProgress([dev("z", { opened: false }), dev("a", { opened: false })], 5, 5);
    expect(p.pending).toEqual(["z", "a"]);
  });
});

describe("mustAdvanceBeforeWrite (Spec 8.3 Regel 2)", () => {
  const written = { stand: 5, ids: new Set(["a", "b"]) };
  it("true when the same stand already carried an id that is now forgotten", () => {
    expect(mustAdvanceBeforeWrite(written, 5, new Set(["b"]))).toBe(true);
  });
  it("false when none of the written ids is forgotten", () => {
    expect(mustAdvanceBeforeWrite(written, 5, new Set(["c"]))).toBe(false);
  });
  it("false at another stand", () => {
    expect(mustAdvanceBeforeWrite(written, 6, new Set(["b"]))).toBe(false);
    expect(mustAdvanceBeforeWrite(written, 4, new Set(["b"]))).toBe(false);
  });
  it("false when nothing was written yet", () => {
    expect(mustAdvanceBeforeWrite(null, 5, new Set(["b"]))).toBe(false);
  });
  it("false when nothing is forgotten", () => {
    expect(mustAdvanceBeforeWrite(written, 5, new Set())).toBe(false);
  });
});

describe("codeStandOf", () => {
  const p = (chainId: string, codeShownAtStand: number | null) => ({ chainId, codeShownAtStand });
  it("takes the maximum of the own chain only", () => {
    expect(codeStandOf([p("c1", 2), p("c1", 4), p("c1", 3), p("c2", 9)], "c1")).toBe(4);
  });
  it("skips null entries", () => {
    expect(codeStandOf([p("c1", null), p("c1", 1)], "c1")).toBe(1);
  });
  it("null when none is set", () => {
    expect(codeStandOf([p("c1", null)], "c1")).toBeNull();
    expect(codeStandOf([p("c2", 7)], "c1")).toBeNull();
    expect(codeStandOf([], "c1")).toBeNull();
  });
  it("a stand of 0 is a stand", () => {
    expect(codeStandOf([p("c1", 0), p("c1", null)], "c1")).toBe(0);
  });
});
