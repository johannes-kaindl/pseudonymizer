import { describe, expect, it } from "vitest";
import { createApi } from "../src/core/api";
import { StubEngine } from "../src/obsidian/stub-engine";

describe("StubEngine", () => {
  it("reports not-set-up and the api refuses without touching text", async () => {
    const api = createApi(() => new StubEngine());
    expect(api.status()).toEqual({ state: "not-set-up" });
    expect(api.containsPlaceholder("Person_k3x9m2ab7q")).toBe(false);
    expect((await api.transform({ caller: "x", documentKey: "d", interactive: false, parts: [] }) as { error: string }).error).toBe("not-ready");
    expect((api.restore("Person_k3x9m2ab7q", { caller: "x" }) as { error: string }).error).toBe("not-ready");
  });
});
