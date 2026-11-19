import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Modal } from "./vendor/kit/obsidian-mock";
import "../src/i18n/strings";
import { STRINGS } from "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { askExistingFiles, askSetUp } from "../src/obsidian/setup-modals";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
const app = {} as unknown as App;
beforeEach(() => {
  setLang("en");
  Modal.__last = null;
  spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

const en = STRINGS.en;
const lastModal = (): any => { const m = Modal.__last; if (!m) throw new Error("no modal open"); return m; };
const button = (label: string): any => {
  const hit = lastModal().contentEl.querySelectorAll("button").find((b: any) => b.__component?.textValue === label);
  if (!hit) throw new Error(`no button ${label}`);
  return hit.__component;
};
const labels = (): string[] => lastModal().contentEl.querySelectorAll("button").map((b: any) => b.__component?.textValue ?? b.textContent);

describe("askExistingFiles", () => {
  it("offers Cancel on the left, then 'Enter code' and 'Set up anyway' as equal ways; names the folder", async () => {
    const p = askExistingFiles(app, "_pseudonymizer");
    expect(labels()).toEqual([en["modal.cancel"], en["modal.setup.exists.enterCode"], en["modal.setup.exists.setUpAnyway"]]);
    expect(lastModal().contentEl.textContent).toContain("_pseudonymizer");
    // neither way is the highlighted one, and starting over wears the warning style
    expect(button(en["modal.setup.exists.enterCode"]).ctaSet).toBe(false);
    expect(button(en["modal.setup.exists.setUpAnyway"]).ctaSet).toBe(false);
    expect(button(en["modal.setup.exists.setUpAnyway"]).destructiveSet).toBe(true);
    button(en["modal.setup.exists.enterCode"]).clickCB();
    expect(await p).toBe("enter-code");
  });
  it("'Set up anyway' answers set-up-anyway; Cancel and closing answer null", async () => {
    const a = askExistingFiles(app, "x");
    button(en["modal.setup.exists.setUpAnyway"]).clickCB();
    expect(await a).toBe("set-up-anyway");
    const b = askExistingFiles(app, "x");
    button(en["modal.cancel"]).clickCB();
    expect(await b).toBeNull();
    const c = askExistingFiles(app, "x");
    lastModal().close();
    expect(await c).toBeNull();
  });
});

describe("askSetUp", () => {
  it("states the sync prerequisite as unchecked, the loss of the key, and the language that applies to the vault", async () => {
    void askSetUp(app, "de");
    const text = lastModal().contentEl.textContent as string;
    expect(text).toContain(en["modal.setup.sync"]);
    expect(en["modal.setup.sync"]).toMatch(/Not checked/);
    expect(en["modal.setup.sync"]).toContain(".pseudo");
    expect(text).toContain(en["modal.setup.loss"]);
    expect(text).toContain(en["modal.setup.language.hint"]);
  });
  it("the German dialog is German", () => {
    setLang("de");
    void askSetUp(app, "de");
    expect(lastModal().contentEl.textContent).toContain(STRINGS.de["modal.setup.sync"]);
  });
  it("answers with the language that was preselected, Cancel on the left and 'Set up' as the highlighted right button", async () => {
    const p = askSetUp(app, "en");
    const btns = labels().filter((l) => l === en["modal.cancel"] || l === en["modal.setup.confirm"]);
    expect(btns).toEqual([en["modal.cancel"], en["modal.setup.confirm"]]);
    expect(button(en["modal.setup.confirm"]).ctaSet).toBe(true);
    button(en["modal.setup.confirm"]).clickCB();
    expect(await p).toBe("en");
  });
  it("the language choice is taken from the segmented control", async () => {
    const p = askSetUp(app, "de");
    const seg = lastModal().contentEl.querySelectorAll(".okit-segmented-btn");
    expect(seg.map((b: any) => b.getAttribute("data-value"))).toEqual(["de", "en"]);
    for (const cb of seg[1]._listeners.click) cb(new Event("click"));
    button(en["modal.setup.confirm"]).clickCB();
    expect(await p).toBe("en");
  });
  it("Cancel and closing answer null", async () => {
    const a = askSetUp(app, "de");
    button(en["modal.cancel"]).clickCB();
    expect(await a).toBeNull();
    const b = askSetUp(app, "de");
    lastModal().close();
    expect(await b).toBeNull();
  });
});
