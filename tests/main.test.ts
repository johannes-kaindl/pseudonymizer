import { describe, expect, it } from "vitest";
import PseudonymizerPlugin from "../src/main";
import type { Engine } from "../src/core/engine";
import { isPseudonymizerApi } from "../src/vendor/kit/pseudonymizer-source";
import { PseudonymizerSettingTab } from "../src/obsidian/settings-tab";

function load() {
  const store = new Map<string, unknown>();
  const app = { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => { store.set(k, v); }, vault: { configDir: ".obsidian" } };
  const Ctor = PseudonymizerPlugin as unknown as new (app: unknown, manifest: unknown) => PseudonymizerPlugin & { settingTabs: unknown[] };
  const plugin = new Ctor(app, { id: "pseudonymizer", name: "Pseudonymizer", version: "0.0.1" });
  return { plugin, store };
}

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
  it("starting with garbage in data.json falls back to the defaults", async () => {
    const { plugin } = load();
    await plugin.saveData({ folder: "../x", copyMode: 7, secret: "Max Mustermann" });
    await plugin.onload();
    expect(plugin.settings).toMatchObject({ folder: "_pseudonymizer", copyMode: "placeholder" });
    await plugin.saveSettings();
    expect(JSON.stringify(await plugin.loadData())).not.toContain("Mustermann");
  });
});
