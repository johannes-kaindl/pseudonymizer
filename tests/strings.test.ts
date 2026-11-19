import { describe, expect, it } from "vitest";
import { STRINGS } from "../src/i18n/strings";

describe("strings", () => {
  it("en and de carry the same keys", () => {
    expect(Object.keys(STRINGS.de).sort()).toEqual(Object.keys(STRINGS.en).sort());
  });
  it("placeholders match between the languages", () => {
    for (const [k, en] of Object.entries(STRINGS.en)) {
      const ph = (s: string): string[] => (s.match(/\{\d\}/g) ?? []).sort();
      expect(ph(STRINGS.de[k as keyof typeof STRINGS.de])).toEqual(ph(en));
    }
  });
});
