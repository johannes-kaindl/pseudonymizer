import { describe, expect, it, beforeEach } from "vitest";
import type { CommandId } from "../src/core/commands";
import type { PluginState } from "../src/core/status";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { createPluginStatusBar } from "../src/obsidian/status-bar";
import { makeFakeEl } from "./vendor/kit/obsidian-mock";

function make(initial: { state?: PluginState; shown?: boolean; visible?: boolean } = {}) {
  let state: PluginState = initial.state ?? "ready";
  let shown = initial.shown ?? true;
  const listeners = new Set<() => void>();
  const runs: CommandId[] = [];
  const items: ReturnType<typeof makeFakeEl>[] = [];
  const plugin = { addStatusBarItem: () => { const el = makeFakeEl(); items.push(el); return el; } };
  const bar = createPluginStatusBar({
    plugin,
    visible: initial.visible ?? true,
    state: () => state,
    showPlaintext: () => shown,
    run: (id) => {
      runs.push(id);
      if (id === "toggle-plaintext") { shown = !shown; for (const l of listeners) l(); }
    },
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  });
  const button = () => bar.item.el?.querySelector("button") as ReturnType<typeof makeFakeEl> | null;
  return { bar, button, runs, items, listeners, setState: (s: PluginState) => { state = s; for (const l of listeners) l(); }, click: () => { for (const cb of button()?._listeners?.click ?? []) cb(new Event("click")); }, labelOf: () => String((button()?.querySelectorAll(".pseu-status-label")[0] as { textContent?: string }).textContent) };
}

describe("status bar entry", () => {
  beforeEach(() => { setLang("en"); });

  it("is a real button with text and icon, aria-pressed follows the switch", () => {
    const m = make();
    const b = m.button()!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("type")).toBe("button");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(m.labelOf()).toBe("Plain text: on");
    expect(b.querySelectorAll(".pseu-status-icon")[0].getAttribute("data-icon")).toBe("eye");
    expect(b.getAttribute("aria-label")).toContain("Plain text: on");
  });

  it("a click toggles, and the entry repaints with the other text, icon and aria-pressed", () => {
    const m = make();
    m.click();
    expect(m.runs).toEqual(["toggle-plaintext"]);
    const b = m.button()!;
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(m.labelOf()).toBe("Plain text: off");
    expect(b.querySelectorAll(".pseu-status-icon")[0].getAttribute("data-icon")).toBe("eye-off");
  });

  it("locked: says locked, is no toggle, a click runs enter-recovery-code", () => {
    const m = make({ state: "locked" });
    expect(m.labelOf()).toBe("Locked");
    expect(m.button()!.getAttribute("aria-pressed")).toBeNull();
    m.click();
    expect(m.runs).toEqual(["enter-recovery-code"]);
  });

  it("not set up: a click runs set-up", () => {
    const m = make({ state: "not-set-up" });
    expect(m.labelOf()).toBe("Not set up");
    m.click();
    expect(m.runs).toEqual(["set-up"]);
  });

  it("follows a change of the state", () => {
    const m = make({ state: "not-set-up" });
    m.setState("ready");
    expect(m.labelOf()).toBe("Plain text: on");
    expect(m.button()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("German texts", () => {
    setLang("de");
    expect(make().labelOf()).toBe("Klartext: an");
    expect(make({ state: "locked" }).labelOf()).toBe("Gesperrt");
  });

  it("visible: false creates no entry, setVisible(true) brings it back, false removes it", () => {
    const m = make({ visible: false });
    expect(m.bar.item.shown).toBe(false);
    expect(m.items).toHaveLength(0);
    m.bar.item.setVisible(true);
    expect(m.bar.item.shown).toBe(true);
    expect(m.labelOf()).toBe("Plain text: on");
    m.bar.item.setVisible(false);
    expect(m.bar.item.shown).toBe(false);
  });

  it("dispose unsubscribes and removes the entry", () => {
    const m = make();
    expect(m.listeners.size).toBe(1);
    m.bar.dispose();
    expect(m.listeners.size).toBe(0);
    expect(m.bar.item.shown).toBe(false);
  });
});
