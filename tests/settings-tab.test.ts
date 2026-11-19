import { describe, expect, it } from "vitest";
import { Setting } from "obsidian";
import type { App } from "obsidian";
import { loadSettings } from "../src/core/settings";
import { PseudonymizerSettingTab } from "../src/obsidian/settings-tab";
import type PseudonymizerPlugin from "../src/main";
import "../src/i18n/strings";
import { STRINGS } from "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { makeFakeEl } from "./vendor/kit/obsidian-mock";

type Def = { type?: string; heading?: string; name?: string; items?: Def[]; control?: { type: string; key: string }; render?: (s: Setting) => void };

function makeTab(opts: { locked?: boolean; answer?: boolean } = {}) {
  let saved = 0;
  const asked: { message: unknown }[] = [];
  const plugin = {
    settings: loadSettings(null),
    saveSettings: () => { saved++; return Promise.resolve(); },
    folderLocked: () => opts.locked === true,
  } as unknown as PseudonymizerPlugin;
  const app = { vault: { configDir: ".obsidian" } } as unknown as App;
  const Tab = PseudonymizerSettingTab as unknown as new (app: App, plugin: PseudonymizerPlugin, confirm: (o: { message: unknown }) => Promise<boolean>) => PseudonymizerSettingTab;
  const tab = new Tab(app, plugin, (o) => { asked.push(o); return Promise.resolve(opts.answer ?? true); });
  (tab as unknown as { containerEl: unknown }).containerEl = makeFakeEl();
  let updates = 0;
  (tab as unknown as { update: () => void }).update = () => { updates++; };
  return { tab, plugin, saved: () => saved, asked, updates: () => updates };
}

const defs = (tab: PseudonymizerSettingTab): Def[] => tab.getSettingDefinitions() as unknown as Def[];
const groups = (tab: PseudonymizerSettingTab): Def[] => defs(tab).filter((d) => d.type === "group");

describe("settings tab: structure", () => {
  it("the help row comes first, then four groups", () => {
    const d = defs(makeTab().tab);
    expect(d[0].type).not.toBe("group");
    expect(d[0].name).toBe("Help");
    expect(groups(makeTab().tab).map((g) => g.heading)).toEqual(["Table", "Copying", "Display", "Detection rules"]);
  });
  it("the German tab carries German headings", () => {
    setLang("de");
    expect(groups(makeTab().tab).map((g) => g.heading)).toEqual(["Tabelle", "Kopieren", "Anzeige", "Erkennungsregeln"]);
    expect(defs(makeTab().tab)[0].name).toBe("Hilfe");
    setLang("en");
  });
  it("the detection group has one toggle per rule group, five in all", () => {
    const rules = groups(makeTab().tab)[3];
    expect(rules.items?.map((i) => i.control?.key)).toEqual(["rules.patterns", "rules.salutation", "rules.signature", "rules.header-lines", "rules.postal-address"]);
    expect(rules.items?.every((i) => i.control?.type === "toggle")).toBe(true);
  });
  it("the status bar row names the switch and every row has a name", () => {
    const display = groups(makeTab().tab)[2];
    expect(display.items?.[0].name).toBe("Status bar");
    for (const g of groups(makeTab().tab)) for (const i of g.items ?? []) expect(i.name).toBeTruthy();
  });
  it("every text key used exists in both languages", () => {
    expect(Object.keys(STRINGS.de).sort()).toEqual(Object.keys(STRINGS.en).sort());
  });
});

describe("settings tab: values", () => {
  it("getControlValue reads top-level and rule keys", () => {
    const { tab, plugin } = makeTab();
    plugin.settings.rules.signature = false;
    expect(tab.getControlValue("rules.signature")).toBe(false);
    expect(tab.getControlValue("rules.patterns")).toBe(true);
    expect(tab.getControlValue("statusBar")).toBe(true);
    expect(tab.getControlValue("nope")).toBeUndefined();
  });
  it("setControlValue stores rule toggles and the status bar switch, and saves", async () => {
    const { tab, plugin, saved } = makeTab();
    await tab.setControlValue("rules.salutation", false);
    await tab.setControlValue("statusBar", false);
    expect(plugin.settings.rules.salutation).toBe(false);
    expect(plugin.settings.statusBar).toBe(false);
    expect(saved()).toBe(2);
  });
  it("setControlValue ignores unknown keys", async () => {
    const { tab, plugin, saved } = makeTab();
    await tab.setControlValue("nope", 1);
    await tab.setControlValue("rules.mystery", false);
    expect(saved()).toBe(0);
    expect(Object.keys(plugin.settings.rules)).toHaveLength(5);
  });
  it("copy mode: a known value is saved, an unknown one is ignored", async () => {
    const { tab, plugin, saved } = makeTab();
    await tab.setControlValue("copyMode", "as-shown");
    expect(plugin.settings.copyMode).toBe("as-shown");
    await tab.setControlValue("copyMode", "bogus");
    expect(plugin.settings.copyMode).toBe("as-shown");
    expect(saved()).toBe(1);
  });
});

describe("settings tab: folder", () => {
  it("a valid folder is saved without a question while the folder is not locked", async () => {
    const { tab, plugin, saved, asked } = makeTab();
    expect(await tab.setFolder(" Privat/Tabelle/ ")).toEqual({ ok: true });
    expect(plugin.settings.folder).toBe("Privat/Tabelle");
    expect(saved()).toBe(1);
    expect(asked).toHaveLength(0);
  });
  it("an invalid folder is refused, named, and nothing is saved", async () => {
    const { tab, plugin, saved } = makeTab();
    expect(await tab.setFolder("../x")).toEqual({ ok: false, reason: "invalid" });
    expect(await tab.setFolder("")).toEqual({ ok: false, reason: "invalid" });
    expect(await tab.setFolder(".obsidian/x")).toEqual({ ok: false, reason: "invalid" });
    expect(plugin.settings.folder).toBe("_pseudonymizer");
    expect(saved()).toBe(0);
  });
  it("a locked folder asks first and tells that files are not moved", async () => {
    const { tab, plugin, saved, asked } = makeTab({ locked: true, answer: true });
    expect(await tab.setFolder("Neu")).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0].message)).toContain("not moved");
    expect(plugin.settings.folder).toBe("Neu");
    expect(saved()).toBe(1);
  });
  it("a locked folder stays when the question is declined", async () => {
    const { tab, plugin, saved } = makeTab({ locked: true, answer: false });
    expect(await tab.setFolder("Neu")).toEqual({ ok: false, reason: "declined" });
    expect(plugin.settings.folder).toBe("_pseudonymizer");
    expect(saved()).toBe(0);
  });
  it("an unchanged folder asks nothing and saves nothing", async () => {
    const { tab, saved, asked } = makeTab({ locked: true });
    expect(await tab.setFolder("_pseudonymizer")).toEqual({ ok: true });
    expect(asked).toHaveLength(0);
    expect(saved()).toBe(0);
  });
  it("the folder row renders a text field with an accessible name", () => {
    const { tab } = makeTab();
    const row = groups(tab)[0].items?.[0];
    const setting = new Setting(makeFakeEl());
    row?.render?.(setting);
    const input = (setting as unknown as { components: { inputEl: { getAttribute(n: string): string | null } }[] }).components[0].inputEl;
    expect(input.getAttribute("aria-label")).toBe("Folder of the table");
  });
});

describe("settings tab: no plain text in data.json", () => {
  it("the stored settings carry no name or value", async () => {
    const { tab, plugin } = makeTab();
    await tab.setFolder("Privat");
    expect(Object.keys(plugin.settings).sort()).toEqual(["copyMode", "folder", "rules", "statusBar"]);
  });
});

describe("settings tab: rendered rows", () => {
  it("the copy mode row renders a radio group with both choices, the saved one active", () => {
    const { tab } = makeTab();
    const row = groups(tab)[1].items?.[0];
    const setting = new Setting(makeFakeEl());
    row?.render?.(setting);
    const root = (setting.controlEl as unknown as { children: { getAttribute(n: string): string | null; children: { textContent?: string; className: string }[] }[] }).children[0];
    expect(root.getAttribute("role")).toBe("radiogroup");
    expect(root.children.map((b) => b.textContent)).toEqual(["Placeholders", "What I see"]);
    expect(root.children[0].className).toContain("is-active");
  });
  it("leaving the folder field with an invalid value shows the message and restores the field", async () => {
    const { tab, plugin } = makeTab();
    const row = groups(tab)[0].items?.[0];
    const setting = new Setting(makeFakeEl());
    row?.render?.(setting);
    const tx = (setting as unknown as { components: { inputEl: { _listeners: Record<string, ((e?: unknown) => void)[]> }; setValue(v: string): unknown; getValue(): string }[] }).components[0];
    tx.setValue("../x");
    tx.inputEl._listeners.blur[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(tx.getValue()).toBe(plugin.settings.folder);
    const note = (setting.descEl as unknown as { children: { textContent?: string; className: string }[] }).children.at(-1);
    expect(note?.textContent).toContain("../x");
    expect(note?.className).toContain("pseu-warning");
  });
});
