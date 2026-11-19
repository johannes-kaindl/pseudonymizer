import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { openGlobalSearch } from "../src/obsidian/global-search";

const appWith = (internalPlugins: unknown): App => ({ internalPlugins }) as unknown as App;

describe("openGlobalSearch", () => {
  it("calls the search of the core plugin with the query, on the plugin instance, and says true", () => {
    const seen: { self: unknown; query: string }[] = [];
    const instance = { openGlobalSearch(this: unknown, q: string) { seen.push({ self: this, query: q }); } };
    const getPluginById = vi.fn((id: string) => (id === "global-search" ? { instance } : null));
    expect(openGlobalSearch(appWith({ getPluginById }), `"k3x9m2ab7q" OR "m4t8c6r2vp"`)).toBe(true);
    expect(seen).toEqual([{ self: instance, query: `"k3x9m2ab7q" OR "m4t8c6r2vp"` }]);
  });
  it("says false, never throws, when any step is missing", () => {
    expect(openGlobalSearch(appWith(undefined), "q")).toBe(false);
    expect(openGlobalSearch(appWith({}), "q")).toBe(false);
    expect(openGlobalSearch(appWith({ getPluginById: () => null }), "q")).toBe(false);
    expect(openGlobalSearch(appWith({ getPluginById: () => ({}) }), "q")).toBe(false);
    expect(openGlobalSearch(appWith({ getPluginById: () => ({ instance: {} }) }), "q")).toBe(false);
    expect(openGlobalSearch(appWith({ getPluginById: () => ({ instance: { openGlobalSearch: "no" } }) }), "q")).toBe(false);
  });
  it("says false when the search throws", () => {
    const boom = { getPluginById: () => ({ instance: { openGlobalSearch: () => { throw new Error("Max Mustermann"); } } }) };
    expect(openGlobalSearch(appWith(boom), "q")).toBe(false);
  });
});
