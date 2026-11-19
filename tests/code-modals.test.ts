import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Modal, Notice } from "./vendor/kit/obsidian-mock";
import "../src/i18n/strings";
import { STRINGS } from "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { checkRecoveryCodeInput, enterRecoveryCode, showRecoveryCode } from "../src/obsidian/code-modals";
import { codeOf, codeWithVersion, sampleContent } from "./helpers/key-fixtures";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
const setSecret = vi.fn();
const getSecret = vi.fn();
const app = { secretStorage: { setSecret, getSecret } } as unknown as App;

beforeEach(() => {
  setLang("en");
  Notice.instances.length = 0;
  Modal.__last = null;
  setSecret.mockClear();
  getSecret.mockClear();
  spies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  vi.unstubAllGlobals();
  // Kein Schlüssel und kein Code in console, und kein Modal berührt den Schlüsselbund.
  expect(printed).toBe(0);
  expect(setSecret).not.toHaveBeenCalled();
  expect(getSecret).not.toHaveBeenCalled();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const lastModal = (): any => { const m = Modal.__last; if (!m) throw new Error("no modal open"); return m; };
const button = (label: string): any => {
  const hit = lastModal().contentEl.querySelectorAll("button").find((b: any) => b.__component?.textValue === label);
  if (!hit) throw new Error(`no button ${label}`);
  return hit.__component;
};
const click = (label: string): void => { button(label).clickCB(); };
function track<T>(p: Promise<T>): { settled: () => boolean; value: () => T | undefined; promise: Promise<T> } {
  let done = false; let v: T | undefined;
  void p.then((x) => { done = true; v = x; });
  return { settled: () => done, value: () => v, promise: p };
}
const en = STRINGS.en;

describe("checkRecoveryCodeInput", () => {
  const content = sampleContent(3, 12);
  it("decodes a valid code to chain id, stand and key", () => {
    const r = checkRecoveryCodeInput(codeOf(content));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(r.content.chainId)).toEqual(Array.from(content.chainId));
    expect(r.content.stand).toBe(12);
    expect(Array.from(r.content.key)).toEqual(Array.from(content.key));
  });
  it("reads lower case, blanks and typographic hyphens", () => {
    const messy = ` ${codeOf(content).toLowerCase().replace(/-/g, "‐")} `;
    expect(checkRecoveryCodeInput(messy).ok).toBe(true);
  });
  it("names the reason: length, character, checksum, version", () => {
    const good = codeOf(content);
    const len = checkRecoveryCodeInput(good.slice(0, 30));
    expect(len).toMatchObject({ ok: false, problem: { reason: "length", expected: 65 } });
    const chr = checkRecoveryCodeInput(`U${good.slice(1)}`);
    expect(chr).toMatchObject({ ok: false, problem: { reason: "character", at: 0 } });
    const sum = checkRecoveryCodeInput(`${good[0] === "0" ? "1" : "0"}${good.slice(1)}`);
    expect(sum).toMatchObject({ ok: false, problem: { reason: "checksum" } });
    const ver = checkRecoveryCodeInput(codeWithVersion(9));
    expect(ver).toMatchObject({ ok: false, problem: { reason: "version", found: 9 } });
  });
  it("a failure carries no character of the input", () => {
    const r = checkRecoveryCodeInput("§§§-SECRETWORD");
    expect(JSON.stringify(r)).not.toMatch(/SECRETWORD|§/);
  });
});

describe("showRecoveryCode", () => {
  const content = sampleContent(7, 4);
  const code = codeOf(content);

  it("shows the code in groups of five that join back to the code", () => {
    void showRecoveryCode(app, content, { requireConfirmation: false });
    const groups = lastModal().contentEl.querySelectorAll(".pseu-code-group").map((g: { textContent: string }) => g.textContent);
    expect(groups).toHaveLength(13);
    expect(groups.slice(0, 12).every((g: string) => g.length === 5)).toBe(true);
    expect(groups.join("-")).toBe(code);
  });
  it("says the code is the key and points to a password manager", () => {
    void showRecoveryCode(app, content, { requireConfirmation: false });
    const text = lastModal().contentEl.textContent as string;
    expect(text).toContain(en["modal.code.show.intro"]);
    expect(text).toMatch(/password manager/);
    expect(text).toContain(en["modal.code.show.clipboardHint"]);
    expect(lastModal().titleEl.textContent ?? "").toBeDefined();
  });
  it("the German texts are shown in German", () => {
    setLang("de");
    void showRecoveryCode(app, content, { requireConfirmation: true });
    const text = lastModal().contentEl.textContent as string;
    expect(text).toContain(STRINGS.de["modal.code.show.intro"]);
    expect(text).toContain(STRINGS.de["modal.code.show.saved"]);
  });
  it("the copy button puts the whole code on the clipboard and the notice does not repeat it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    void showRecoveryCode(app, content, { requireConfirmation: false });
    click(en["modal.code.show.copy"]);
    await flush();
    expect(writeText).toHaveBeenCalledWith(code);
    const notices = Notice.instances.map((n) => String(n.message));
    expect(notices).toEqual([en["modal.code.show.copied"]]);
    expect(notices.join(" ")).not.toContain(code.slice(0, 11));
  });
  it("a refused clipboard says so and does not claim success", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    void showRecoveryCode(app, content, { requireConfirmation: false });
    click(en["modal.code.show.copy"]);
    await flush();
    expect(Notice.instances.map((n) => String(n.message))).toEqual([en["modal.code.show.copyFailed"]]);
  });

  describe("with the required check box", () => {
    const tick = (on: boolean): void => {
      const box = lastModal().contentEl.querySelector("input");
      box.checked = on;
      box.dispatchEvent({ type: "change" });
    };
    it("has a check box with the sentence from the spec and Cancel left of Continue", () => {
      void showRecoveryCode(app, content, { requireConfirmation: true });
      expect(lastModal().contentEl.textContent).toContain("I have saved the code");
      const labels = lastModal().contentEl.querySelector(".modal-button-container").children.map((b: { __component: { textValue: string } }) => b.__component.textValue);
      expect(labels).toEqual(["Cancel", "Continue"]);
      expect(button("Continue").ctaSet).toBe(true);
    });
    it("Continue does nothing until the box is ticked, then confirms with true", async () => {
      const r = track(showRecoveryCode(app, content, { requireConfirmation: true }));
      click("Continue");
      await flush();
      expect(r.settled()).toBe(false);
      tick(true);
      tick(false);
      click("Continue");
      await flush();
      expect(r.settled()).toBe(false);
      tick(true);
      click("Continue");
      expect(await r.promise).toBe(true);
    });
    it("Cancel answers false, also after the box was ticked", async () => {
      const r = track(showRecoveryCode(app, content, { requireConfirmation: true }));
      tick(true);
      click("Cancel");
      expect(await r.promise).toBe(false);
    });
    it("closing the dialog (Escape, click outside) answers false", async () => {
      const r = track(showRecoveryCode(app, content, { requireConfirmation: true }));
      tick(true);
      lastModal().close();
      expect(await r.promise).toBe(false);
    });
  });

  describe("without the check box", () => {
    it("has no check box; Done answers true, closing answers false", async () => {
      const a = showRecoveryCode(app, content, { requireConfirmation: false });
      expect(lastModal().contentEl.querySelector("input")).toBeNull();
      click("Done");
      expect(await a).toBe(true);
      const b = showRecoveryCode(app, content, { requireConfirmation: false });
      lastModal().close();
      expect(await b).toBe(false);
    });
  });

  it("removes the code from the dialog when it closes", async () => {
    const r = showRecoveryCode(app, content, { requireConfirmation: false });
    const modal = lastModal();
    click("Done");
    await r;
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.contentEl.querySelectorAll(".pseu-code-group")).toHaveLength(0);
  });
  it("answers once even if Done is followed by the close of the dialog", async () => {
    const r = track(showRecoveryCode(app, content, { requireConfirmation: false }));
    click("Done");
    lastModal().close();
    expect(await r.promise).toBe(true);
  });
  it("content that cannot be encoded opens no dialog, answers false and names no key material", async () => {
    const bad = { ...content, key: new Uint8Array(5) };
    expect(await showRecoveryCode(app, bad, { requireConfirmation: true })).toBe(false);
    expect(Modal.__last).toBeNull();
    expect(Notice.instances.map((n) => String(n.message))).toEqual([en["modal.code.show.unavailable"]]);
  });
});

describe("enterRecoveryCode", () => {
  const content = sampleContent(9, 21);
  const type = (value: string): void => { lastModal().contentEl.querySelector(".okit-prompt-field").value = value; };
  const shownError = (): string => String(lastModal().contentEl.querySelector(".okit-prompt-error").textContent);

  it("opens the text dialog from the kit with the title and the hint", () => {
    void enterRecoveryCode(app);
    expect(lastModal().contentEl.textContent).toContain(en["modal.code.enter.message"]);
    expect(lastModal().contentEl.querySelector(".okit-prompt-field")).not.toBeNull();
    expect(button(en["modal.code.enter.ok"]).ctaSet).toBe(true);
  });
  it("answers the decoded content for a valid code and stores nothing", async () => {
    const r = enterRecoveryCode(app);
    type(codeOf(content).toLowerCase());
    click(en["modal.code.enter.ok"]);
    const got = await r;
    expect(got).not.toBeNull();
    if (got === null) return;
    expect(Array.from(got.chainId)).toEqual(Array.from(content.chainId));
    expect(got.stand).toBe(21);
    expect(Array.from(got.key)).toEqual(Array.from(content.key));
    // Das Beenden der Prüfung (afterEach) zeigt: setSecret und getSecret wurden nie gerufen.
  });
  const cases: [string, () => string, string][] = [
    ["length", () => codeOf(content).slice(0, 30), "The code has 25 characters; 65 are expected. Check that nothing is missing or doubled."],
    ["character", () => `U${codeOf(content).slice(1)}`, "Character number 1 cannot be part of a code (hyphens and spaces are not counted)."],
    ["checksum", () => { const c = codeOf(content); return `${c[0] === "0" ? "1" : "0"}${c.slice(1)}`; }, en["modal.code.enter.error.checksum"]],
    ["version", () => codeWithVersion(9), "This code has format 9, which this version of the plugin does not know. Update the plugin."],
  ];
  for (const [reason, input, message] of cases) {
    it(`a code with the wrong ${reason} keeps the dialog open and says so; a corrected code then goes through`, async () => {
      const r = track(enterRecoveryCode(app));
      type(input());
      click(en["modal.code.enter.ok"]);
      await flush();
      expect(r.settled()).toBe(false);
      expect(shownError()).toBe(message);
      type(codeOf(content));
      click(en["modal.code.enter.ok"]);
      expect((await r.promise)?.stand).toBe(21);
    });
  }
  it("never says 'wrong key' and never repeats what was typed", async () => {
    const r = track(enterRecoveryCode(app));
    type("§§§ SECRETWORD");
    click(en["modal.code.enter.ok"]);
    await flush();
    expect(shownError()).not.toMatch(/SECRETWORD|§|wrong key/i);
    click("Cancel");
    expect(await r.promise).toBeNull();
  });
  it("Cancel and closing answer null", async () => {
    const a = enterRecoveryCode(app);
    click("Cancel");
    expect(await a).toBeNull();
    const b = enterRecoveryCode(app);
    lastModal().close();
    expect(await b).toBeNull();
  });
  it("the German dialog names the reason in German", async () => {
    setLang("de");
    const r = track(enterRecoveryCode(app));
    type(codeOf(content).slice(0, 30));
    click(STRINGS.de["modal.code.enter.ok"]);
    await flush();
    expect(shownError()).toBe("Der Code hat 25 Zeichen, erwartet werden 65. Prüfe, ob etwas fehlt oder doppelt ist.");
    click(STRINGS.de["modal.cancel"]);
    await r.promise;
  });
});
