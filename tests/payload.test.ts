import { describe, expect, it } from "vitest";
import { closingDeviceId, decodeClosing, decodePayload, encodeClosing, encodePayload, isClosingId, type DevicePayload } from "../src/core/payload";

const sample = (over: Partial<DevicePayload> = {}): DevicePayload => ({
  format: "pseudonymizer-device",
  version: 1,
  device: { name: "MacBook JK", codeShownAtStand: 4 },
  vault: { language: "de" },
  table: { entries: [] },
  ...over,
});

const enc = (x: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(x));
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("encodePayload / decodePayload", () => {
  it("round trip", () => {
    const p = sample();
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });
  it("round trip with codeShownAtStand null and English", () => {
    const p = sample({ device: { name: "iPhone JK", codeShownAtStand: null }, vault: { language: "en" } });
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });
  it("a name with umlauts and other non-ASCII characters survives", () => {
    const p = sample({ device: { name: "Müller's Büro-Mac ß 日本", codeShownAtStand: 0 } });
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });
  it("is byte-identical for equal input", () => {
    expect(encodePayload(sample())).toEqual(encodePayload(sample()));
  });
  it("is byte-identical for equal input built in another key order", () => {
    const shuffled = {
      table: { entries: [] },
      vault: { language: "de" },
      device: { codeShownAtStand: 4, name: "MacBook JK" },
      version: 1,
      format: "pseudonymizer-device",
    } as DevicePayload;
    expect(encodePayload(shuffled)).toEqual(encodePayload(sample()));
  });
  it("writes the keys in a fixed order: format, version, device, vault, table", () => {
    const s = text(encodePayload(sample()));
    const at = ["format", "version", "device", "vault", "table"].map((k) => s.indexOf(`"${k}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it("returns UTF-8 bytes", () => {
    expect(encodePayload(sample())).toBeInstanceOf(Uint8Array);
  });

  it("version 2 gives an error", () => {
    expect(decodePayload(enc({ ...sample(), version: 2 }))).toEqual({ error: "version" });
  });
  it("a missing version is a version error", () => {
    const { version: _v, ...rest } = sample();
    expect(decodePayload(enc(rest))).toEqual({ error: "version" });
  });
  it("truncated JSON gives a json error", () => {
    const b = encodePayload(sample());
    expect(decodePayload(b.slice(0, b.length - 5))).toEqual({ error: "json" });
  });
  it("empty input and invalid UTF-8 give a json error", () => {
    expect(decodePayload(new Uint8Array())).toEqual({ error: "json" });
    expect(decodePayload(new Uint8Array([0xff, 0xfe, 0x80]))).toEqual({ error: "json" });
  });
  it("invalid UTF-8 inside a string is an error, not silently repaired to U+FFFD", () => {
    const b = encodePayload(sample({ device: { name: "ABC", codeShownAtStand: null } }));
    const i = text(b).indexOf("ABC");
    const bad = new Uint8Array(b);
    bad[i + 1] = 0xff;
    expect(decodePayload(bad)).toEqual({ error: "json" });
  });
  it("a foreign format gives a format error", () => {
    expect(decodePayload(enc({ ...sample(), format: "something-else" }))).toEqual({ error: "format" });
  });
  it("a foreign format wins over a foreign version", () => {
    expect(decodePayload(enc({ ...sample(), format: "x", version: 9 }))).toEqual({ error: "format" });
  });
  it("valid JSON that is not an object gives a format error", () => {
    for (const v of [null, 3, "x", [], true]) expect(decodePayload(enc(v))).toEqual({ error: "format" });
  });
  it("a damaged structure gives a format error", () => {
    const bad: unknown[] = [
      { ...sample(), device: null },
      { ...sample(), device: { name: 3, codeShownAtStand: 1 } },
      { ...sample(), device: { name: "x", codeShownAtStand: "4" } },
      { ...sample(), device: { name: "x", codeShownAtStand: -1 } },
      { ...sample(), device: { name: "x", codeShownAtStand: 1.5 } },
      { ...sample(), vault: { language: "fr" } },
      { ...sample(), vault: null },
      (({ table: _t, ...r }) => r)(sample()),
    ];
    for (const b of bad) expect(decodePayload(enc(b))).toEqual({ error: "format" });
  });
  it("unknown extra keys fall away", () => {
    const r = decodePayload(enc({ ...sample(), extra: 1 }));
    expect(r).toEqual(sample());
  });
  it("errors carry a code only, never the content", () => {
    const r = decodePayload(enc({ ...sample({ device: { name: "Max Mustermann", codeShownAtStand: null } }), version: 2 }));
    expect(JSON.stringify(r)).not.toContain("Mustermann");
  });
});

describe("Abschlussdatei einer ersetzten Kette", () => {
  it("round trip: nur die Markierung, kein Feld für Tabelle, Werte oder Namen", () => {
    expect(decodeClosing(encodeClosing())).toEqual({ closed: true });
    expect(JSON.parse(text(encodeClosing()))).toEqual({ format: "pseudonymizer-closed", version: 1, replaced: true });
  });
  it("(g) ein Leser, der die Markierung nicht kennt, wertet sie nie als leere Tabelle: decodePayload meldet einen Fehler", () => {
    const r = decodePayload(encodeClosing());
    expect("error" in r).toBe(true);
    expect("table" in r).toBe(false);
  });
  it("ein Geräteinhalt ist keine Abschlussdatei, eine neuere Fassung und eine unvollständige Markierung auch nicht", () => {
    expect(decodeClosing(encodePayload(sample()))).toEqual({ error: "format" });
    expect(decodeClosing(enc({ format: "pseudonymizer-closed", version: 2, replaced: true }))).toEqual({ error: "version" });
    expect(decodeClosing(enc({ format: "pseudonymizer-closed", version: 1, replaced: false }))).toEqual({ error: "format" });
    expect(decodeClosing(enc({ format: "pseudonymizer-closed", version: 1 }))).toEqual({ error: "format" });
    expect(decodeClosing(new TextEncoder().encode("{kaputt"))).toEqual({ error: "json" });
  });
  it("der Dateiname trägt Gerät und Kette; nur solche Namen gelten als Abschlussdatei", () => {
    const id = closingDeviceId("dev-a", "c0de0101");
    expect(id).toBe("closed-dev-a-c0de0101");
    expect(isClosingId(id)).toBe(true);
    expect(isClosingId("dev-a")).toBe(false);
    expect(isClosingId("k3x9m2ab7q")).toBe(false);
    expect(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(closingDeviceId("x".repeat(64), "c0de0101"))).toBe(true);
  });
});
