import { describe, expect, it } from "vitest";
import { Platform } from "obsidian";
import type { App } from "obsidian";
import { createDeviceState } from "../src/obsidian/device";

function fakeApp() {
  const store = new Map<string, unknown>();
  return { store, app: { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => { if (v === null) store.delete(k); else store.set(k, v); } } as unknown as App };
}

/** Wie Obsidian 1.15.1 gemessen (filename-sanitizer, GUI-Smoke 2026-11-12): `saveLocalStorage(key, false)` speichert nichts, `loadLocalStorage` liefert danach `null`. */
function obsidianLikeApp() {
  const store = new Map<string, unknown>();
  return { store, app: { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => { if (v === null || v === false) store.delete(k); else store.set(k, v); } } as unknown as App };
}

const setMobile = (on: boolean): void => { (Platform as { isMobile: boolean }).isMobile = on; };

describe("device state: show plain text", () => {
  it("is on without a stored value", () => {
    expect(createDeviceState(fakeApp().app).showPlaintext).toBe(true);
  });
  it("off survives a fresh state, also when the storage drops false", () => {
    const f = obsidianLikeApp();
    const d = createDeviceState(f.app);
    d.setShowPlaintext(false);
    expect(d.showPlaintext).toBe(false);
    expect(createDeviceState(f.app).showPlaintext).toBe(false);
    d.setShowPlaintext(true);
    expect(createDeviceState(f.app).showPlaintext).toBe(true);
  });
  it("is stored as text under a plugin-prefixed key", () => {
    const f = fakeApp();
    const d = createDeviceState(f.app);
    d.setShowPlaintext(false);
    expect(f.store.get("pseudonymizer-show-plaintext")).toBe("off");
    d.setShowPlaintext(true);
    expect(f.store.get("pseudonymizer-show-plaintext")).toBe("on");
  });
  it("garbage in the storage reads as the default", () => {
    const f = fakeApp();
    f.store.set("pseudonymizer-show-plaintext", 42);
    expect(createDeviceState(f.app).showPlaintext).toBe(true);
  });
  it("a storage that throws gives the default and does not throw", () => {
    const app = { loadLocalStorage: () => { throw new Error("x"); }, saveLocalStorage: () => { throw new Error("x"); } } as unknown as App;
    const d = createDeviceState(app);
    expect(d.showPlaintext).toBe(true);
    expect(() => { d.setShowPlaintext(false); }).not.toThrow();
    expect(() => d.deviceName).not.toThrow();
  });
});

describe("device state: device name", () => {
  it("is Desktop-xxxx on desktop and Mobile-xxxx on mobile, four hex characters", () => {
    setMobile(false);
    expect(createDeviceState(fakeApp().app).deviceName).toMatch(/^Desktop-[0-9a-f]{4}$/);
    setMobile(true);
    expect(createDeviceState(fakeApp().app).deviceName).toMatch(/^Mobile-[0-9a-f]{4}$/);
    setMobile(false);
  });
  it("is generated once and stays stable across reads and fresh states", () => {
    const f = fakeApp();
    const d = createDeviceState(f.app);
    const first = d.deviceName;
    expect(d.deviceName).toBe(first);
    expect(createDeviceState(f.app).deviceName).toBe(first);
    expect(f.store.get("pseudonymizer-device-name")).toBe(first);
  });
  it("takes its suffix from crypto.getRandomValues", () => {
    const calls: number[] = [];
    const fake = (arr: Uint16Array): Uint16Array => { calls.push(arr.length); arr[0] = 0xabcd; return arr; };
    setMobile(false);
    expect(createDeviceState(fakeApp().app, fake).deviceName).toBe("Desktop-abcd");
    expect(calls).toEqual([1]);
  });
  it("pads a small number to four characters", () => {
    const fake = (arr: Uint16Array): Uint16Array => { arr[0] = 0x0a; return arr; };
    setMobile(false);
    expect(createDeviceState(fakeApp().app, fake).deviceName).toBe("Desktop-000a");
  });
  it("can be set, and an empty name brings a generated one back", () => {
    const f = fakeApp();
    const d = createDeviceState(f.app);
    d.setDeviceName("  Büro-Mac ");
    expect(d.deviceName).toBe("Büro-Mac");
    expect(createDeviceState(f.app).deviceName).toBe("Büro-Mac");
    d.setDeviceName("   ");
    expect(d.deviceName).toMatch(/^(Desktop|Mobile)-[0-9a-f]{4}$/);
  });
  it("device values never leave through data.json: only prefixed local keys are written", () => {
    const f = fakeApp();
    const d = createDeviceState(f.app);
    d.setShowPlaintext(false);
    d.setDeviceName("Büro-Mac");
    expect([...f.store.keys()].every((k) => k.startsWith("pseudonymizer-"))).toBe(true);
  });
});

describe("device state: replace-pending mark (W2)", () => {
  it("is null without a value, stored as text under a plugin-prefixed key, and cleared by null", () => {
    const f = obsidianLikeApp();
    const d = createDeviceState(f.app);
    expect(d.replacePending).toBeNull();
    d.setReplacePending("abcd0123");
    expect(f.store.get("pseudonymizer-replace-pending")).toBe("abcd0123");
    expect(createDeviceState(f.app).replacePending).toBe("abcd0123");
    d.setReplacePending(null);
    expect(createDeviceState(f.app).replacePending).toBeNull();
  });
});
