import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("scaffold", () => {
  const manifest = read("manifest.json");
  const pkg = read("package.json");
  it("manifest carries the agreed identity", () => {
    expect(manifest.id).toBe("pseudonymizer");
    expect(manifest.name).toBe("Pseudonymizer");
    expect(manifest.isDesktopOnly).toBe(false);
    expect(manifest.minAppVersion).toBe("1.13.0");
    expect(manifest.author).toBe("Johannes Kaindl");
  });
  it("package.json matches the manifest and the licence", () => {
    expect(pkg.version).toBe(manifest.version);
    expect(pkg.license).toBe("AGPL-3.0-or-later");
  });
});

describe("constants", () => {
  it("device keys carry the plugin prefix", async () => {
    const { DEVICE_KEY_PREFIX } = await import("../src/core/constants");
    expect(DEVICE_KEY_PREFIX).toBe("pseudonymizer-");
  });
});
