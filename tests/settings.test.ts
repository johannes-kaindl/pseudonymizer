import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, withFolder, type PseudonymizerSettings } from "../src/core/settings";

describe("DEFAULT_SETTINGS", () => {
  it("carries the agreed defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      folder: "_pseudonymizer",
      copyMode: "placeholder",
      statusBar: true,
      rules: { patterns: true, salutation: true, signature: true, "header-lines": true, "postal-address": true },
    });
  });
});

describe("loadSettings", () => {
  it("null gives the defaults, and a copy rather than the shared object", () => {
    const s = loadSettings(null);
    expect(s).toEqual(DEFAULT_SETTINGS);
    s.rules.patterns = false;
    expect(DEFAULT_SETTINGS.rules.patterns).toBe(true);
  });
  it("anything that is not an object gives the defaults", () => {
    for (const raw of [undefined, 3, "x", [], true]) expect(loadSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
  it("repairs field by field", () => {
    const s = loadSettings({ copyMode: "x", folder: 3, rules: { salutation: false } });
    expect(s.copyMode).toBe("placeholder");
    expect(s.folder).toBe("_pseudonymizer");
    expect(s.rules.salutation).toBe(false);
    expect(s.rules.patterns).toBe(true);
    expect(s.rules.signature).toBe(true);
    expect(s.rules["header-lines"]).toBe(true);
    expect(s.rules["postal-address"]).toBe(true);
  });
  it("keeps valid values", () => {
    const s = loadSettings({ copyMode: "as-shown", statusBar: false, folder: "Privat/Tabelle", rules: { patterns: false } });
    expect(s).toMatchObject({ copyMode: "as-shown", statusBar: false, folder: "Privat/Tabelle" });
    expect(s.rules.patterns).toBe(false);
  });
  it("a non-boolean switch falls back to the default", () => {
    const s = loadSettings({ statusBar: "no", rules: { patterns: "off", signature: 0 } });
    expect(s.statusBar).toBe(true);
    expect(s.rules.patterns).toBe(true);
    expect(s.rules.signature).toBe(true);
  });
  it("unknown keys drop away, at the top and in rules", () => {
    const s = loadSettings({ extra: 1, name: "Max Mustermann", rules: { patterns: false, mystery: true } });
    expect(Object.keys(s).sort()).toEqual(["copyMode", "folder", "rules", "statusBar"]);
    expect(Object.keys(s.rules).sort()).toEqual(["header-lines", "patterns", "postal-address", "salutation", "signature"]);
    expect(JSON.stringify(s)).not.toContain("Mustermann");
  });
  it("a stored folder that the rules refuse falls back to the default", () => {
    for (const folder of ["", "  ", "../x", "a/../b", ".obsidian/x", "/abs", "a/.hidden"]) expect(loadSettings({ folder }).folder).toBe("_pseudonymizer");
  });
  it("a stored folder is normalised", () => {
    expect(loadSettings({ folder: " Privat//Tabelle/ " }).folder).toBe("Privat/Tabelle");
  });
});

describe("withFolder", () => {
  const base: PseudonymizerSettings = loadSettings(null);
  it("trims and normalises the input", () => {
    const r = withFolder(base, " _pseudonymizer/ ");
    expect("error" in r).toBe(false);
    expect((r as PseudonymizerSettings).folder).toBe("_pseudonymizer");
    expect((withFolder(base, "a//b/./c/") as PseudonymizerSettings).folder).toBe("a/b/c");
  });
  it("does not touch the input", () => {
    const r = withFolder(base, "Neu") as PseudonymizerSettings;
    expect(r.folder).toBe("Neu");
    expect(base.folder).toBe("_pseudonymizer");
    expect(r).not.toBe(base);
  });
  it("refuses empty, traversal and the config folder", () => {
    expect(withFolder(base, "")).toEqual({ error: "folder" });
    expect(withFolder(base, "   ")).toEqual({ error: "folder" });
    expect(withFolder(base, "../x")).toEqual({ error: "folder" });
    expect(withFolder(base, "a/../x")).toEqual({ error: "folder" });
    expect(withFolder(base, ".obsidian/x")).toEqual({ error: "folder" });
    expect(withFolder(base, ".obsidian")).toEqual({ error: "folder" });
  });
  it("refuses a whitespace-only segment, an absolute path and a NUL", () => {
    expect(withFolder(base, "a/ /b")).toEqual({ error: "folder" });
    expect(withFolder(base, "/abs")).toEqual({ error: "folder" });
    expect(withFolder(base, "a\0b")).toEqual({ error: "folder" });
  });
  it("a hidden segment is refused anywhere, so the configuration folder of any name is out", () => {
    expect(withFolder(base, ".Obsidian/x")).toEqual({ error: "folder" });
    expect(withFolder(base, ".config-x/y")).toEqual({ error: "folder" });
    expect(withFolder(base, "a/.hidden/b")).toEqual({ error: "folder" });
    expect(withFolder(base, ".obsidian-notes")).toEqual({ error: "folder" });
  });
  it("a dot inside a name is fine", () => {
    expect((withFolder(base, "Privat/v1.2/Tabelle") as PseudonymizerSettings).folder).toBe("Privat/v1.2/Tabelle");
  });
});
