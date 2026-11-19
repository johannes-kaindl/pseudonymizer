import { beforeEach, describe, expect, it, vi } from "vitest";
import PseudonymizerPlugin from "../src/main";
import type { Engine } from "../src/core/engine";
import { isPseudonymizerApi } from "../src/vendor/kit/pseudonymizer-source";
import { PseudonymizerSettingTab } from "../src/obsidian/settings-tab";
import { FakeFs } from "./helpers/fake-fs";
import { CHAIN, ID_A, contentAt, personTable, seedFile } from "./helpers/store-fixtures";
import { encodeRecoveryCode } from "../src/vendor/kit/recovery-code";
import { Modal } from "./vendor/kit/obsidian-mock";

function load(fs: FakeFs = new FakeFs("_pseudonymizer"), secrets: Map<string, string> = new Map()) {
  const store = new Map<string, unknown>();
  const listeners: ((path: string) => void)[] = [];
  const app = {
    loadLocalStorage: (k: string) => store.get(k) ?? null,
    saveLocalStorage: (k: string, v: unknown) => { store.set(k, v); },
    secretStorage: { getSecret: (id: string) => secrets.get(id) ?? "", setSecret: (id: string, v: string) => { secrets.set(id, v); } },
    workspace: { onLayoutReady: (cb: () => void) => { cb(); }, on: () => ({}), iterateAllLeaves: () => undefined, containerEl: { ownerDocument: { body: { querySelectorAll: () => [] } } } },
    vault: {
      configDir: ".obsidian",
      adapter: fs.adapter,
      on: (_evt: string, cb: (f: { path: string }) => void) => { listeners.push((p) => { cb({ path: p }); }); return {}; },
      offref: () => undefined,
    },
  };
  const Ctor = PseudonymizerPlugin as unknown as new (app: unknown, manifest: unknown) => PseudonymizerPlugin & { settingTabs: unknown[] };
  const plugin = new Ctor(app, { id: "pseudonymizer", name: "Pseudonymizer", version: "0.0.1" });
  return { plugin, store, fs, secrets };
}
const intervals: { cb: () => void; ms: number }[] = [];
beforeEach(() => {
  intervals.length = 0;
  vi.stubGlobal("window", { setInterval: (cb: () => void, ms: number) => { intervals.push({ cb, ms }); return intervals.length; }, clearInterval: () => undefined });
});
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("PseudonymizerPlugin", () => {
  it("loads defaults, creates the device state and registers the settings tab", async () => {
    const { plugin } = load();
    await plugin.onload();
    expect(plugin.settings.folder).toBe("_pseudonymizer");
    expect(plugin.device.showPlaintext).toBe(true);
    expect(plugin.settingTabs[0]).toBeInstanceOf(PseudonymizerSettingTab);
  });
  it("exposes the plugin api v1, reading the engine at call time", async () => {
    const { plugin } = load();
    await plugin.onload();
    expect(isPseudonymizerApi(plugin.api)).toBe(true);
    expect(plugin.api.status()).toEqual({ state: "not-set-up" });
    plugin.engine = { ...plugin.engine, state: () => "ready" } as Engine;
    expect(plugin.api.status()).toEqual({ state: "ready" });
  });
  it("wires the reading view and a copy handler, refreshes the reading view on every change and lets go on unload", async () => {
    const { plugin } = load();
    const spy = plugin as unknown as { registerMarkdownPostProcessor(h: unknown): void; registerDomEvent(...a: unknown[]): void };
    const post = vi.spyOn(spy, "registerMarkdownPostProcessor");
    const dom = vi.spyOn(spy, "registerDomEvent");
    await plugin.onload();
    expect(post).toHaveBeenCalledTimes(1);
    expect(dom).toHaveBeenCalledWith(expect.anything(), "copy", expect.any(Function));
    const hook = vi.fn();
    plugin.reading.onRefresh(hook);
    plugin.emitChange();
    plugin.run("toggle-plaintext");
    expect(hook).toHaveBeenCalledTimes(2);
    plugin.onunload();
    plugin.emitChange();
    expect(hook).toHaveBeenCalledTimes(2);
  });
  it("registers the view, thirteen commands with icons and a status bar entry", async () => {
    const { plugin } = load();
    await plugin.onload();
    const p = plugin as unknown as { views: Record<string, unknown>; commands: { id: string; icon: string }[] };
    expect(Object.keys(p.views)).toEqual(["pseudonymizer-view"]);
    expect(p.commands).toHaveLength(13);
    expect(p.commands.every((c) => c.icon)).toBe(true);
    expect((plugin as unknown as { statusBar: { item: { shown: boolean } } }).statusBar.item.shown).toBe(true);
  });
  it("the status bar switch in the settings removes and restores the entry", async () => {
    const { plugin } = load();
    await plugin.onload();
    const bar = (plugin as unknown as { statusBar: { item: { shown: boolean } } }).statusBar;
    plugin.settings.statusBar = false;
    await plugin.saveSettings();
    expect(bar.item.shown).toBe(false);
    plugin.settings.statusBar = true;
    await plugin.saveSettings();
    expect(bar.item.shown).toBe(true);
  });
  it("the toggle command repaints the status bar", async () => {
    const { plugin } = load();
    await plugin.onload();
    const bar = (plugin as unknown as { statusBar: { item: { el: { querySelector(s: string): { getAttribute(a: string): string | null } } } } }).statusBar;
    plugin.state = () => "ready";
    plugin.emitChange();
    expect(bar.item.el.querySelector("button").getAttribute("aria-pressed")).toBe("true");
    plugin.run("toggle-plaintext");
    expect(plugin.device.showPlaintext).toBe(false);
    expect(bar.item.el.querySelector("button").getAttribute("aria-pressed")).toBe("false");
  });
  it("unload stops listening", async () => {
    const { plugin } = load();
    await plugin.onload();
    let n = 0;
    plugin.onChange(() => { n++; });
    plugin.onunload();
    plugin.emitChange();
    expect(n).toBe(0);
  });
  it("saveSettings persists only the settings", async () => {
    const { plugin, store } = load();
    await plugin.onload();
    plugin.settings.rules.signature = false;
    await plugin.saveSettings();
    const reloaded = await plugin.loadData() as Record<string, unknown>;
    expect(Object.keys(reloaded).sort()).toEqual(["copyMode", "folder", "rules", "statusBar"]);
    expect((reloaded.rules as Record<string, boolean>).signature).toBe(false);
    expect([...store.keys()].every((k) => k.startsWith("pseudonymizer-"))).toBe(true);
  });
  it("device values stay out of data.json", async () => {
    const { plugin } = load();
    await plugin.onload();
    plugin.device.setDeviceName("Büro-Mac");
    plugin.device.setShowPlaintext(false);
    await plugin.saveSettings();
    expect(JSON.stringify(await plugin.loadData())).not.toContain("Büro");
  });
  it("the folder is free until the table is set up", async () => {
    const { plugin } = load();
    await plugin.onload();
    expect(plugin.folderLocked()).toBe(false);
  });
  it("the folder is locked as soon as this device holds a key, also when the folder gives nothing (the folder is the way out) or the key is damaged", async () => {
    const fs = new FakeFs("_pseudonymizer");
    const secrets = new Map<string, string>();
    const { plugin } = load(fs, secrets);
    await plugin.onload();
    await flush();
    expect(plugin.folderLocked()).toBe(false);
    const code = encodeRecoveryCode(await contentAt(CHAIN, 0));
    if (!code.ok) throw new Error("fixture");
    secrets.set("pseudonymizer-key", code.code);
    expect(plugin.folderLocked()).toBe(true);
    expect(plugin.api.status().state).not.toBe("ready");
    secrets.set("pseudonymizer-key", "kaputt");
    expect(plugin.folderLocked()).toBe(true);
    secrets.set("pseudonymizer-key", "");
    expect(plugin.folderLocked()).toBe(false);
  });
  it("the device model lists the files that arrived, also while locked, and names this device", async () => {
    const fs = new FakeFs("_pseudonymizer");
    await seedFile(fs, { deviceId: "dev-seed", stand: 1, table: personTable(ID_A, "Max Mustermann"), name: "iPhone" });
    const { plugin } = load(fs);
    await plugin.onload();
    await flush();
    const m = plugin.devicesModel();
    expect(m.state).toBe("locked");
    expect(m.reason).toBe("no-key");
    expect(m.rows.map((r) => [r.deviceId, r.status, r.stand])).toEqual([["dev-seed", "not-opened", 1]]);
    expect(m.rows[0].own).toBe(false);
  });
  it("a new device name is stored on the device and written to the own device file at once", async () => {
    const fs = new FakeFs("_pseudonymizer");
    await seedFile(fs, { deviceId: "dev-seed", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const secrets = new Map<string, string>();
    const code = encodeRecoveryCode(await contentAt(CHAIN, 0));
    if (!code.ok) throw new Error("fixture");
    secrets.set("pseudonymizer-key", code.code);
    const { plugin } = load(fs, secrets);
    await plugin.onload();
    await flush();
    let changes = 0;
    plugin.onChange(() => { changes++; });
    const own = (): string[] => fs.names().filter((n) => n.endsWith(".pseudo") && n !== "dev-seed.pseudo");
    const before = own();
    (plugin as unknown as { setDeviceName(n: string): void }).setDeviceName("Mac Küche");
    await flush();
    expect(plugin.device.deviceName).toBe("Mac Küche");
    expect(own().length).toBeGreaterThanOrEqual(before.length);
    expect(plugin.devicesModel().rows.find((r) => r.own)?.name).toBe("Mac Küche");
    expect(changes).toBeGreaterThan(0);
  });
  it("starting with garbage in data.json falls back to the defaults", async () => {
    const { plugin } = load();
    await plugin.saveData({ folder: "../x", copyMode: 7, secret: "Max Mustermann" });
    await plugin.onload();
    expect(plugin.settings).toMatchObject({ folder: "_pseudonymizer", copyMode: "placeholder" });
    await plugin.saveSettings();
    expect(JSON.stringify(await plugin.loadData())).not.toContain("Mustermann");
  });

  it("opens the device files at start: a key and a readable file make the plugin ready, and the engine persists through the store", async () => {
    const fs = new FakeFs("_pseudonymizer");
    await seedFile(fs, { deviceId: "dev-seed", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const secrets = new Map<string, string>();
    const code = encodeRecoveryCode(await contentAt(CHAIN, 0));
    if (!code.ok) throw new Error("fixture");
    secrets.set("pseudonymizer-key", code.code);
    const { plugin } = load(fs, secrets);
    await plugin.onload();
    await flush();
    expect(plugin.state()).toBe("ready");
    const engine = plugin.engine as unknown as { persist(c?: unknown): Promise<unknown>; refresh(): Promise<void> };
    expect(await engine.persist(personTable("m4t8c6r2vp", "Berta Beispiel"))).toBeUndefined();
    expect(fs.names().filter((n) => n.endsWith(".pseudo"))).toHaveLength(2);
  });
  it("hands the review window to the engine: an interactive transform with an open finding opens it, closing it answers cancelled, an unattended one answers deferred", async () => {
    const fs = new FakeFs("_pseudonymizer");
    await seedFile(fs, { deviceId: "dev-seed", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const secrets = new Map<string, string>();
    const code = encodeRecoveryCode(await contentAt(CHAIN, 0));
    if (!code.ok) throw new Error("fixture");
    secrets.set("pseudonymizer-key", code.code);
    const { plugin } = load(fs, secrets);
    await plugin.onload();
    await flush();
    const request = { caller: "test", documentKey: "doc-1", parts: [{ id: "a", kind: "text" as const, value: "Hallo Erika Musterfrau," }] };
    Modal.__last = null;
    expect(await plugin.api.transform({ ...request, interactive: false })).toMatchObject({ error: "deferred" });
    expect(Modal.__last).toBeNull();
    const pending = plugin.api.transform({ ...request, interactive: true });
    await flush();
    expect(Modal.__last).not.toBeNull();
    (Modal.__last as Modal | null)?.close();
    expect(await pending).toMatchObject({ error: "cancelled" });
  });
  it("refreshes over all files at least every 60 seconds and picks up a file that arrived without an event", async () => {
    const fs = new FakeFs("_pseudonymizer");
    await seedFile(fs, { deviceId: "dev-seed", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const secrets = new Map<string, string>();
    const code = encodeRecoveryCode(await contentAt(CHAIN, 0));
    if (!code.ok) throw new Error("fixture");
    secrets.set("pseudonymizer-key", code.code);
    const { plugin } = load(fs, secrets);
    await plugin.onload();
    await flush();
    const tick = intervals.find((i) => i.ms === 60_000);
    expect(tick).toBeDefined();
    await seedFile(fs, { deviceId: "dev-late", stand: 0, table: personTable("m4t8c6r2vp", "Berta Beispiel") });
    tick?.cb();
    await flush();
    const table = plugin.memory.table();
    expect(table?.entries.map((e) => e.id).sort()).toEqual(["k3x9m2ab7q", "m4t8c6r2vp"]);
  });
  it("a key without any readable file is locked, not an empty table, and nothing is written", async () => {
    const fs = new FakeFs("_pseudonymizer");
    const secrets = new Map<string, string>();
    const code = encodeRecoveryCode(await contentAt(CHAIN, 0));
    if (!code.ok) throw new Error("fixture");
    secrets.set("pseudonymizer-key", code.code);
    const { plugin } = load(fs, secrets);
    await plugin.onload();
    await flush();
    expect(plugin.api.status()).toEqual({ state: "locked" });
    expect(fs.mutations).toBe(0);
  });
  it("changing the folder in the settings starts over at the new folder", async () => {
    const fs = new FakeFs("_pseudonymizer");
    await seedFile(fs, { deviceId: "dev-seed", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const secrets = new Map<string, string>();
    const code = encodeRecoveryCode(await contentAt(CHAIN, 0));
    if (!code.ok) throw new Error("fixture");
    secrets.set("pseudonymizer-key", code.code);
    const { plugin } = load(fs, secrets);
    await plugin.onload();
    await flush();
    expect(plugin.state()).toBe("ready");
    plugin.settings.folder = "elsewhere";
    await plugin.saveSettings();
    await flush();
    expect(plugin.api.status()).toEqual({ state: "locked" });
    expect(plugin.memory.reason()).toBe("table-missing");
  });
});
