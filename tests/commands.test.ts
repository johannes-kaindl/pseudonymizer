import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Notice } from "./vendor/kit/obsidian-mock";
import { COMMANDS, VIEW_TABS, VIEW_TYPE_PSEUDONYMIZER, commandGate, statusEntryModel, stateIndicator, type CommandId } from "../src/core/commands";
import { loadSettings, type PseudonymizerSettings } from "../src/core/settings";
import type { PluginState } from "../src/core/status";
import { STRINGS } from "../src/i18n/strings";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { MemoryTable } from "../src/core/memory-table";
import { registerCommands, runCommand, type CommandHost } from "../src/obsidian/commands";

const IDS: CommandId[] = [
  "toggle-plaintext", "pseudonymize-selection", "pseudonymize-note", "search-plaintext", "lookup-placeholder", "copy-plaintext", "copy-placeholders",
  "forget-person", "show-recovery-code", "enter-recovery-code", "replace-key", "open-view", "set-up",
];

describe("COMMANDS", () => {
  it("has the thirteen commands, unique ids, non-empty icons", () => {
    expect(COMMANDS.map((c) => c.id).sort()).toEqual([...IDS].sort());
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(13);
    for (const c of COMMANDS) expect(c.icon.trim()).not.toBe("");
  });
  it("every name key has a text in English and German", () => {
    for (const c of COMMANDS) {
      expect(STRINGS.en[c.nameKey as keyof typeof STRINGS.en], c.nameKey).toBeTruthy();
      expect(STRINGS.de[c.nameKey as keyof typeof STRINGS.de], c.nameKey).toBeTruthy();
    }
  });
  it("view type and tabs", () => {
    expect(VIEW_TYPE_PSEUDONYMIZER).toBe("pseudonymizer-view");
    expect(VIEW_TABS.map((t) => t.id)).toEqual(["persons", "exceptions", "devices"]);
    for (const t of VIEW_TABS) {
      expect(t.icon).not.toBe("");
      expect(STRINGS.en[t.labelKey as keyof typeof STRINGS.en], t.labelKey).toBeTruthy();
      expect(STRINGS.de[t.labelKey as keyof typeof STRINGS.de], t.labelKey).toBeTruthy();
    }
  });
});

describe("commandGate", () => {
  const spec = (id: CommandId) => COMMANDS.find((c) => c.id === id)!;
  const ctx = (state: PluginState, over: Partial<{ hasEditor: boolean; copyMode: "placeholder" | "as-shown" }> = {}) => ({ state, hasEditor: true, copyMode: "placeholder" as const, ...over });

  it("copy-placeholders is only visible when copying gives what is shown; copy-plaintext in both", () => {
    expect(commandGate(spec("copy-placeholders"), ctx("ready", { copyMode: "placeholder" }))).toBe("hide");
    expect(commandGate(spec("copy-placeholders"), ctx("ready", { copyMode: "as-shown" }))).toBe("run");
    expect(commandGate(spec("copy-plaintext"), ctx("ready", { copyMode: "placeholder" }))).toBe("run");
    expect(commandGate(spec("copy-plaintext"), ctx("ready", { copyMode: "as-shown" }))).toBe("run");
  });
  it("an editor command is hidden without an editor", () => {
    expect(commandGate(spec("pseudonymize-selection"), ctx("ready", { hasEditor: false }))).toBe("hide");
    expect(commandGate(spec("pseudonymize-selection"), ctx("ready"))).toBe("run");
  });
  it("ready-only commands name the reason instead of vanishing", () => {
    expect(commandGate(spec("forget-person"), ctx("locked"))).toBe("locked");
    expect(commandGate(spec("forget-person"), ctx("not-set-up"))).toBe("not-set-up");
    expect(commandGate(spec("forget-person"), ctx("ready"))).toBe("run");
    expect(commandGate(spec("pseudonymize-selection"), ctx("locked"))).toBe("locked");
  });
  it("locked-or-ready needs a set-up table", () => {
    expect(commandGate(spec("replace-key"), ctx("not-set-up"))).toBe("not-set-up");
    expect(commandGate(spec("replace-key"), ctx("locked"))).toBe("run");
    expect(commandGate(spec("replace-key"), ctx("ready"))).toBe("run");
  });
  it("any runs in every state", () => {
    for (const id of ["toggle-plaintext", "open-view", "set-up", "enter-recovery-code"] as const) {
      for (const s of ["ready", "locked", "not-set-up"] as const) expect(commandGate(spec(id), ctx(s, { hasEditor: false }))).toBe("run");
    }
  });
});

describe("statusEntryModel", () => {
  it("ready: a toggle whose pressed state and icon follow the plain-text switch", () => {
    expect(statusEntryModel("ready", true)).toMatchObject({ pressed: true, icon: "eye", click: "toggle-plaintext", labelKey: "statusBar.on" });
    expect(statusEntryModel("ready", false)).toMatchObject({ pressed: false, icon: "eye-off", click: "toggle-plaintext", labelKey: "statusBar.off" });
  });
  it("locked leads to the code entry, not-set-up to the set-up, neither is a toggle", () => {
    expect(statusEntryModel("locked", true)).toMatchObject({ pressed: null, click: "enter-recovery-code", icon: "lock-keyhole" });
    expect(statusEntryModel("not-set-up", true)).toMatchObject({ pressed: null, click: "set-up" });
  });
  it("every key has a text in both languages", () => {
    for (const s of ["ready", "locked", "not-set-up"] as const) for (const on of [true, false]) {
      const m = statusEntryModel(s, on);
      for (const k of [m.labelKey, m.hintKey]) {
        expect(STRINGS.en[k as keyof typeof STRINGS.en], k).toBeTruthy();
        expect(STRINGS.de[k as keyof typeof STRINGS.de], k).toBeTruthy();
      }
    }
  });
  it("stateIndicator never relies on colour: each state has its own phase and text", () => {
    expect(stateIndicator("ready").phase).toBe("ok");
    expect(stateIndicator("locked").phase).toBe("warning");
    expect(stateIndicator("not-set-up").phase).toBe("idle");
    expect(new Set(["ready", "locked", "not-set-up"].map((s) => stateIndicator(s as PluginState).textKey)).size).toBe(3);
  });
});

function makeHost(state: PluginState = "ready", over: { copyMode?: "placeholder" | "as-shown"; editor?: boolean } = {}) {
  const store = new Map<string, unknown>();
  let shown = true;
  let changes = 0;
  const opened: (string | undefined)[] = [];
  const flows: string[] = [];
  const added: { id: string; name: string; icon?: string; checkCallback?: (checking: boolean) => boolean }[] = [];
  const settings: PseudonymizerSettings = loadSettings({ copyMode: over.copyMode ?? "placeholder" });
  const host: CommandHost = {
    app: { workspace: { getActiveViewOfType: () => (over.editor ? { editor: {} } : null) } } as unknown as CommandHost["app"],
    settings,
    device: { get showPlaintext() { return shown; }, setShowPlaintext: (on: boolean) => { shown = on; store.set("x", on); }, deviceName: "d", setDeviceName: () => undefined },
    memory: new MemoryTable(),
    state: () => state,
    openView: (tab) => { opened.push(tab); return Promise.resolve(); },
    emitChange: () => { changes++; },
    runSetUp: () => { flows.push("set-up"); return Promise.resolve(); },
    runEnterCode: () => { flows.push("enter-code"); return Promise.resolve(); },
    runShowCode: () => { flows.push("show-code"); return Promise.resolve(); },
  };
  const plugin = { addCommand: (c: (typeof added)[number]) => { added.push(c); return c; } };
  return { host, plugin, added, opened, flows, shown: () => shown, changes: () => changes };
}

const lastNotice = (): string => String(Notice.instances[Notice.instances.length - 1]?.message ?? "");

describe("registerCommands", () => {
  beforeEach(() => { setLang("en"); Notice.instances.length = 0; });
  afterEach(() => { setLang("en"); });

  it("registers thirteen commands with an icon, a translated name and no plugin-name prefix", () => {
    const { host, plugin, added } = makeHost();
    registerCommands(plugin, host);
    expect(added).toHaveLength(13);
    for (const c of added) {
      expect(c.icon).toBeTruthy();
      expect(c.name).not.toBe("");
      expect(c.name).not.toMatch(/^command\./);
      expect(c.name.toLowerCase()).not.toContain("pseudonymizer:");
    }
    setLang("de");
    const de = makeHost();
    registerCommands(de.plugin, de.host);
    expect(de.added.find((c) => c.id === "forget-person")?.name).toBe("Person vergessen");
  });

  it("each registered id, name and icon matches COMMANDS (the literals in registerCommands cannot drift)", () => {
    for (const lang of ["en", "de"] as const) {
      setLang(lang);
      const { host, plugin, added } = makeHost();
      registerCommands(plugin, host);
      expect(added.map((c) => c.id).sort()).toEqual(COMMANDS.map((c) => c.id).sort());
      for (const spec of COMMANDS) {
        const c = added.find((a) => a.id === spec.id)!;
        expect(c.name, spec.id).toBe(STRINGS[lang][spec.nameKey as keyof typeof STRINGS.en]);
        expect(c.icon, spec.id).toBe(spec.icon);
      }
    }
  });

  it("toggle-plaintext flips the device switch and tells the interface", () => {
    const { host, plugin, added, shown, changes } = makeHost("not-set-up");
    registerCommands(plugin, host);
    const toggle = added.find((c) => c.id === "toggle-plaintext")!;
    expect(toggle.checkCallback?.(true)).toBe(true);
    toggle.checkCallback?.(false);
    expect(shown()).toBe(false);
    expect(changes()).toBe(1);
    toggle.checkCallback?.(false);
    expect(shown()).toBe(true);
  });

  it("open-view opens the view", () => {
    const { host, plugin, added, opened } = makeHost("not-set-up");
    registerCommands(plugin, host);
    added.find((c) => c.id === "open-view")!.checkCallback?.(false);
    expect(opened).toEqual([undefined]);
  });

  it("a command whose function is missing shows the 'not available yet' notice", () => {
    const { host, plugin, added } = makeHost("ready", { editor: true });
    registerCommands(plugin, host);
    for (const id of ["pseudonymize-selection", "pseudonymize-note", "copy-plaintext", "forget-person", "replace-key"]) {
      Notice.instances.length = 0;
      added.find((c) => c.id === id)!.checkCallback?.(false);
      expect(lastNotice(), id).toBe(STRINGS.en["notice.notAvailable"]);
    }
  });

  it("set-up, enter-recovery-code and show-recovery-code run their flows, not the 'not available yet' notice", () => {
    const { host, plugin, added, flows } = makeHost("ready");
    registerCommands(plugin, host);
    Notice.instances.length = 0;
    // set-up and enter-recovery-code are open in every state (the flows decide what to say); show-recovery-code needs a table that is set up
    for (const id of ["set-up", "enter-recovery-code", "show-recovery-code"]) added.find((c) => c.id === id)!.checkCallback?.(false);
    expect(flows).toEqual(["set-up", "enter-code", "show-code"]);
    expect(Notice.instances).toHaveLength(0);
  });

  it("lookup-placeholder and search-plaintext are wired to their functions, not to the 'not available yet' notice", async () => {
    const { host, plugin, added } = makeHost("ready", { editor: true });
    registerCommands(plugin, host);
    for (const id of ["lookup-placeholder", "search-plaintext"]) {
      Notice.instances.length = 0;
      added.find((c) => c.id === id)!.checkCallback?.(false);
      await new Promise((r) => setTimeout(r, 0));
      // the memory of the fake host holds no table: the functions themselves say so
      expect(lastNotice(), id).toBe(STRINGS.en["notice.notSetUp"]);
    }
  });

  it("palette check: copy-placeholders appears only in the as-shown setting", () => {
    const a = makeHost("ready", { copyMode: "placeholder" });
    registerCommands(a.plugin, a.host);
    expect(a.added.find((c) => c.id === "copy-placeholders")!.checkCallback?.(true)).toBe(false);
    const b = makeHost("ready", { copyMode: "as-shown" });
    registerCommands(b.plugin, b.host);
    expect(b.added.find((c) => c.id === "copy-placeholders")!.checkCallback?.(true)).toBe(true);
  });

  it("a locked table says so and runs nothing", () => {
    const { host, plugin, added } = makeHost("locked", { editor: true });
    registerCommands(plugin, host);
    added.find((c) => c.id === "forget-person")!.checkCallback?.(false);
    expect(lastNotice()).toBe(STRINGS.en["notice.locked"]);
  });

  it("an editor command is hidden in the palette without an editor", () => {
    const { host, plugin, added } = makeHost("ready", { editor: false });
    registerCommands(plugin, host);
    expect(added.find((c) => c.id === "pseudonymize-selection")!.checkCallback?.(true)).toBe(false);
  });

  it("runCommand (status bar, view) applies the same gate", () => {
    const { host, flows } = makeHost("not-set-up");
    runCommand(host, "forget-person");
    expect(lastNotice()).toBe(STRINGS.en["notice.notSetUp"]);
    Notice.instances.length = 0;
    runCommand(host, "set-up");
    expect(flows).toEqual(["set-up"]);
    expect(Notice.instances).toHaveLength(0);
  });
});
