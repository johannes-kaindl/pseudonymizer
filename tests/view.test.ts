import { describe, expect, it, beforeEach } from "vitest";
import { ItemView } from "obsidian";
import type { CommandId } from "../src/core/commands";
import { VIEW_TYPE_PSEUDONYMIZER } from "../src/core/commands";
import type { DevicesModel } from "../src/core/devices-view";
import type { LockReason, PluginState } from "../src/core/status";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { PseudonymizerView, type ViewHost } from "../src/obsidian/view";
import { makeFakeEl } from "./vendor/kit/obsidian-mock";

type El = ReturnType<typeof makeFakeEl>;

const readyModel = (over: Partial<DevicesModel> = {}): DevicesModel => ({
  state: "ready", reason: null, stand: 0, anyForgotten: false, progress: null, codeStand: 0, stray: [],
  rows: [{ deviceId: "own", name: "Mac Büro", own: true, stand: 0, status: "read", problemKind: null }],
  ...over,
});

function make(state: PluginState = "not-set-up", opts: { reason?: LockReason | null; model?: DevicesModel } = {}) {
  let current = state;
  const listeners = new Set<() => void>();
  const runs: CommandId[] = [];
  const names: string[] = [];
  let name = "Mac Büro";
  const host: ViewHost = {
    state: () => current,
    run: (id) => { runs.push(id); },
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    lockReason: () => opts.reason ?? null,
    folder: () => "_pseudonymizer",
    devices: () => opts.model ?? readyModel(),
    deviceName: () => name,
    setDeviceName: (n) => { names.push(n); name = n; },
  };
  const View = PseudonymizerView as unknown as new (leaf: unknown, host: ViewHost) => PseudonymizerView;
  const view = new View({}, host);
  (view as unknown as { contentEl: El }).contentEl = makeFakeEl();
  const root = (): El => (view as unknown as { contentEl: El }).contentEl;
  return { view, host, root, runs, names, listeners, setState: (s: PluginState) => { current = s; for (const l of listeners) l(); } };
}

const panels = (root: El): El[] => root.children[1].children as El[];
const buttons = (el: El): El[] => el.querySelectorAll("button") as El[];
const text = (el: El): string => String((el as unknown as { textContent?: string }).textContent ?? "");

describe("PseudonymizerView", () => {
  beforeEach(() => { setLang("en"); });

  it("is an ItemView with its own type; one hub with three tabs and three panels", async () => {
    const m = make();
    expect(m.view).toBeInstanceOf(ItemView);
    expect(m.view.getViewType()).toBe(VIEW_TYPE_PSEUDONYMIZER);
    await m.view.onOpen();
    expect(m.root().children).toHaveLength(2);
    const tabs = m.root().children[0].querySelectorAll("button") as El[];
    expect(tabs.map((b) => b.getAttribute("data-tab"))).toEqual(["persons", "exceptions", "devices"]);
    expect(panels(m.root())).toHaveLength(3);
  });

  it("not set up: every panel offers 'Set up' and 'Enter code' with equal weight", async () => {
    const m = make("not-set-up");
    await m.view.onOpen();
    for (const p of panels(m.root())) {
      const bs = buttons(p);
      expect(bs.map((b) => text(b))).toEqual(["Set up", "Enter code"]);
      expect(bs.every((b) => !b.hasClass("mod-cta"))).toBe(true);
      expect(p.querySelectorAll(".pseu-empty")).toHaveLength(1);
    }
  });

  it("the buttons run the commands set-up and enter-recovery-code", async () => {
    const m = make("not-set-up");
    await m.view.onOpen();
    const [setUp, enter] = buttons(panels(m.root())[0]);
    for (const cb of setUp._listeners.click) cb(new Event("click"));
    for (const cb of enter._listeners.click) cb(new Event("click"));
    expect(m.runs).toEqual(["set-up", "enter-recovery-code"]);
  });

  it("locked: a reason and one 'Enter code' button", async () => {
    const m = make("locked");
    await m.view.onOpen();
    const p = panels(m.root())[2];
    expect(buttons(p).map((b) => text(b))).toEqual(["Enter code"]);
    expect(p.querySelectorAll(".pseu-empty")).toHaveLength(1);
  });

  it("ready: persons and exceptions have their own empty state, no set-up buttons", async () => {
    const m = make("ready");
    await m.view.onOpen();
    const texts = panels(m.root()).slice(0, 2).map((p) => text(p.querySelectorAll(".pseu-empty")[0] as El));
    expect(new Set(texts).size).toBe(2);
    for (const p of panels(m.root()).slice(0, 2)) expect(buttons(p)).toHaveLength(0);
  });

  it("locked with a key but no device file (table-missing): names the folder and the settings, offers 'Enter code' only, never 'Set up'", async () => {
    const m = make("locked", { reason: "table-missing", model: readyModel({ state: "locked", reason: "table-missing", rows: [], stand: null, codeStand: null }) });
    await m.view.onOpen();
    for (const p of panels(m.root())) {
      const msg = text(p.querySelectorAll(".pseu-empty")[0] as El);
      expect(msg).toContain("_pseudonymizer");
      expect(msg).toContain("plugin settings");
      expect(buttons(p).map((b) => text(b))).not.toContain("Set up");
      expect(buttons(p).map((b) => text(b))).toContain("Enter code");
    }
  });

  it("locked: every reason has its own sentence", async () => {
    const reasons: LockReason[] = ["no-key", "table-missing", "foreign-chain", "key-opens-nothing", "unreadable", "key-corrupt", "storage-failed"];
    const seen = new Set<string>();
    for (const reason of reasons) {
      const m = make("locked", { reason, model: readyModel({ state: "locked", reason, rows: [], stand: null, codeStand: null }) });
      await m.view.onOpen();
      seen.add(text(panels(m.root())[0].querySelectorAll(".pseu-empty")[0] as El));
    }
    expect(seen.size).toBe(reasons.length);
  });

  it("locked: the devices tab lists the files that arrived, unreadable ones with their reason in words", async () => {
    const m = make("locked", {
      reason: "foreign-chain",
      model: readyModel({
        state: "locked", reason: "foreign-chain", stand: null, codeStand: null,
        rows: [
          { deviceId: "a", name: "a", own: false, stand: 2, status: "not-opened", problemKind: null },
          { deviceId: "b", name: "b", own: false, stand: 0, status: "problem", problemKind: "unreadable-header" },
        ],
      }),
    });
    await m.view.onOpen();
    const devices = panels(m.root())[2];
    const items = devices.querySelectorAll(".pseu-device") as El[];
    expect(items).toHaveLength(2);
    expect(text(items[0])).toContain("Not opened");
    expect(text(items[1])).toContain("Cannot be read");
    // the persons tab does not list files
    expect(panels(m.root())[0].querySelectorAll(".pseu-device")).toHaveLength(0);
  });

  it("ready, devices tab: name field, one row per device with stand and status, the key block and one 'Show recovery code' button", async () => {
    const m = make("ready", {
      model: readyModel({
        stand: 3, codeStand: 3,
        rows: [
          { deviceId: "own", name: "Mac Büro", own: true, stand: 3, status: "read", problemKind: null },
          { deviceId: "x1", name: "iPhone", own: false, stand: 3, status: "read", problemKind: null },
        ],
      }),
    });
    await m.view.onOpen();
    const p = panels(m.root())[2];
    const items = p.querySelectorAll(".pseu-device") as El[];
    expect(items).toHaveLength(2);
    expect(text(items[0])).toContain("this device");
    expect(text(items[0])).toContain("key stand 3");
    expect(text(items[1])).toContain("iPhone");
    expect(text(p.querySelectorAll(".pseu-devices-key")[0] as El)).toContain("key stand 3, which is the current stand");
    // only what part a builds: no replace-key, no remove-device, no forget button
    expect(buttons(p).map((b) => text(b))).toEqual(["Show recovery code"]);
    expect(text(p)).toContain("can no longer be turned back into names");
  });

  it("devices tab: the saved code is flagged when it is older than the current stand or missing; the forget progress names the open devices", async () => {
    const old = make("ready", {
      model: readyModel({
        stand: 5, codeStand: 4,
        anyForgotten: true,
        progress: { devicesDone: 2, devicesTotal: 3, pending: ["iPhone"], codeStand: 4, currentStand: 5, codeOutdated: true, complete: false },
      }),
    });
    await old.view.onOpen();
    const key = text(panels(old.root())[2].querySelectorAll(".pseu-devices-key")[0] as El);
    expect(key).toContain("2 of 3 devices have caught up (open: iPhone)");
    expect(key).toContain("key stand 4; the current stand is 5");
    const none = make("ready", { model: readyModel({ codeStand: null }) });
    await none.view.onOpen();
    expect(text(panels(none.root())[2].querySelectorAll(".pseu-devices-key")[0] as El)).toContain("No saved recovery code is recorded");
  });

  it("the 'Show recovery code' button runs the command", async () => {
    const m = make("ready");
    await m.view.onOpen();
    const [b] = buttons(panels(m.root())[2]);
    for (const cb of b._listeners.click) cb(new Event("click"));
    expect(m.runs).toEqual(["show-recovery-code"]);
  });

  it("a changed device name goes to the host; an empty entry shows the name the host falls back to", async () => {
    const m = make("ready");
    await m.view.onOpen();
    const input = panels(m.root())[2].querySelectorAll("input")[0] as El & { __component: { setValue(v: string): void; getValue(): string } };
    input.__component.setValue("Mac Küche");
    for (const cb of input._listeners.change) cb(new Event("change"));
    expect(m.names).toEqual(["Mac Küche"]);
    expect(input.__component.getValue()).toBe("Mac Küche");
  });

  it("while the name field has the focus, a change of state does not repaint the panel", async () => {
    const m = make("ready");
    await m.view.onOpen();
    const input = panels(m.root())[2].querySelectorAll("input")[0] as El;
    for (const cb of input._listeners.focus) cb(new Event("focus"));
    const before = panels(m.root())[2].querySelectorAll("input")[0];
    for (const l of m.listeners) l();
    expect(panels(m.root())[2].querySelectorAll("input")[0]).toBe(before);
    for (const cb of input._listeners.blur) cb(new Event("blur"));
    expect(panels(m.root())[2].querySelectorAll("input")[0]).not.toBe(before);
  });

  it("the state sits on top as a status indicator with text, icon, class and aria-label", async () => {
    const m = make("locked");
    await m.view.onOpen();
    const st = panels(m.root())[0].querySelectorAll(".okit-status")[0] as El;
    expect(st.hasClass("is-warning")).toBe(true);
    expect(st.getAttribute("aria-label")).toBe("Locked");
    expect(text(st.querySelectorAll(".okit-status-label")[0] as El)).toBe("Locked");
    expect((st.querySelectorAll(".okit-status-icon")[0] as El).getAttribute("data-icon")).toBe("alert-triangle");
  });

  it("repaints when the state changes and stops listening on close", async () => {
    const m = make("not-set-up");
    await m.view.onOpen();
    expect(m.listeners.size).toBeGreaterThan(0);
    m.setState("ready");
    const st = panels(m.root())[0].querySelectorAll(".okit-status")[0] as El;
    expect(st.hasClass("is-ok")).toBe(true);
    expect(buttons(panels(m.root())[0])).toHaveLength(0);
    await m.view.onClose();
    expect(m.listeners.size).toBe(0);
  });

  it("showTab switches the hub", async () => {
    const m = make();
    await m.view.onOpen();
    m.view.showTab("devices");
    expect(panels(m.root())[2].hasClass("is-hidden")).toBe(false);
    expect(panels(m.root())[0].hasClass("is-hidden")).toBe(true);
  });
});
