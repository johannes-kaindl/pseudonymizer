import { describe, expect, it, beforeEach } from "vitest";
import { ItemView } from "obsidian";
import type { CommandId } from "../src/core/commands";
import { VIEW_TYPE_PSEUDONYMIZER } from "../src/core/commands";
import type { PluginState } from "../src/core/status";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { PseudonymizerView, type ViewHost } from "../src/obsidian/view";
import { makeFakeEl } from "./vendor/kit/obsidian-mock";

type El = ReturnType<typeof makeFakeEl>;

function make(state: PluginState = "not-set-up") {
  let current = state;
  const listeners = new Set<() => void>();
  const runs: CommandId[] = [];
  const host: ViewHost = { state: () => current, run: (id) => { runs.push(id); }, onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
  const View = PseudonymizerView as unknown as new (leaf: unknown, host: ViewHost) => PseudonymizerView;
  const view = new View({}, host);
  (view as unknown as { contentEl: El }).contentEl = makeFakeEl();
  const root = (): El => (view as unknown as { contentEl: El }).contentEl;
  return { view, host, root, runs, listeners, setState: (s: PluginState) => { current = s; for (const l of listeners) l(); } };
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

  it("ready: each tab has its own empty state, no set-up buttons", async () => {
    const m = make("ready");
    await m.view.onOpen();
    const texts = panels(m.root()).map((p) => text(p.querySelectorAll(".pseu-empty")[0] as El));
    expect(new Set(texts).size).toBe(3);
    for (const p of panels(m.root())) expect(buttons(p)).toHaveLength(0);
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
