import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findVendoredCss, missingKitCss } from "./vendor/kit/kit-css";

describe("Kit-CSS", () => {
  it("jede gevendorte *_CSS-Konstante steht wortgleich in styles.css", () => {
    const vendorDir = "src/vendor/kit-obsidian";
    expect(findVendoredCss(vendorDir).length).toBeGreaterThan(0);
    expect(missingKitCss(vendorDir, readFileSync("styles.css", "utf8"))).toEqual([]);
  });

  it("die Kennzeichnung der Lesesicht und die des Editors (Live Preview) stehen beide in styles.css", () => {
    const names = findVendoredCss("src/vendor/kit-obsidian").map((c) => c.name);
    expect(names).toContain("TEXT_SWAP_CSS");
    expect(names).toContain("TEXT_SWAP_EDITOR_CSS");
    const css = readFileSync("styles.css", "utf8");
    for (const sel of [".okit-swap-inline.is-shown", ".okit-swap-inline.is-unreadable", ".okit-swap-inline.is-forgotten"]) expect(css).toContain(sel);
  });
});
