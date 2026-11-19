// Fenster von Vergessen, Schlüssel ersetzen und Gerät entfernen: Personenwahl und Warndialoge (Spec 8.3, UI-STANDARD §2: Abbrechen links, Warnung rechts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Modal, SuggestModal } from "./vendor/kit/obsidian-mock";
import "../src/i18n/strings";
import { STRINGS } from "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { createKeyActionsUi, forgetDialogLines } from "../src/obsidian/key-actions-ui";
import { listPersons, planForget, type ForgetPlan } from "../src/core/forget-plan";
import { PERSON, must, sampleTable } from "./helpers/table-fixtures";
import { tableSetException } from "../src/vendor/kit/placeholder-table";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
const app = {} as unknown as App;
beforeEach(() => {
  setLang("en");
  Modal.__last = null;
  SuggestModal.__instance = null;
  spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});
const en = STRINGS.en;
const lastModal = (): any => { const m = Modal.__last; if (!m) throw new Error("no modal open"); return m; };
const buttons = (): any[] => lastModal().contentEl.querySelectorAll("button").map((b: any) => b.__component);
const labels = (): string[] => buttons().map((b) => b.textValue);
const paragraphs = (): string[] => lastModal().contentEl.querySelectorAll("p").map((p: any) => p.textContent as string);

const plan = (over: Partial<ForgetPlan> = {}): ForgetPlan => {
  const p = planForget(sampleTable(), "en", PERSON, [], "own");
  if (p === null) throw new Error("fixture");
  return { ...p, ...over };
};

describe("forgetDialogLines", () => {
  it("says irreversible, lists every value with its placeholder, offers detaching, and gives the sentence of Spec 8.3 and the limit of the old key", () => {
    const lines = forgetDialogLines(plan());
    expect(lines[0]).toBe(en["modal.forget.irreversible"]);
    expect(lines).toContain(en["modal.forget.values"]);
    expect(lines).toContain(`Person_${PERSON}_Mail: max@example.org`);
    expect(lines).toContain(`Person_${PERSON}_Phone_2: 0171 2345678`);
    expect(lines).toContain(en["modal.forget.detach"]);
    expect(lines).toContain(en["modal.forget.complete"]);
    expect(lines).toContain(en["modal.forget.keyLeft"]);
    // the sentence says what is missing, not more: it names the conditions and the leak until they are met
    expect(en["modal.forget.complete"]).toMatch(/only when/);
    expect(en["modal.forget.complete"]).toMatch(/Until then/);
    expect(en["modal.forget.complete"]).not.toMatch(/\bsafe\b|\bsecure\b|\bguarantee/i);
    expect(en["modal.forget.keyLeft"]).toMatch(/local storage/);
  });

  it("names devices whose version could not be read, only when there are some, and the exception list only when a value is on it", () => {
    expect(forgetDialogLines(plan())).not.toContain(expect.stringContaining("iPhone"));
    const lines = forgetDialogLines(plan({ unreadableDevices: ["iPhone", "Büro-PC"], exceptionListed: true }));
    expect(lines.some((l) => l.includes("iPhone, Büro-PC"))).toBe(true);
    expect(lines).toContain(en["modal.forget.exception"]);
    expect(forgetDialogLines(plan())).not.toContain(en["modal.forget.exception"]);
    expect(forgetDialogLines(plan()).some((l) => l === en["modal.forget.devices"])).toBe(false);
  });

  it("German carries the same lines", () => {
    setLang("de");
    const lines = forgetDialogLines(plan({ unreadableDevices: ["iPhone"], exceptionListed: true }));
    expect(lines).toContain(STRINGS.de["modal.forget.complete"]);
    expect(STRINGS.de["modal.forget.complete"]).toMatch(/Vollständig vergessen ist eine Person erst, wenn/);
    expect(lines).toContain(STRINGS.de["modal.forget.keyLeft"]);
    expect(lines).toContain(STRINGS.de["modal.forget.exception"]);
  });
});

describe("confirmForget", () => {
  it("Cancel on the left, the warning button on the right with the label 'Forget for good'; confirming answers true", async () => {
    const p = createKeyActionsUi(app).confirmForget(plan());
    expect(labels()).toEqual([en["modal.cancel"], en["modal.forget.confirm"]]);
    expect(buttons()[1].destructiveSet).toBe(true);
    expect(buttons()[0].destructiveSet).not.toBe(true);
    expect(paragraphs()).toContain(`Person_${PERSON}_Mail: max@example.org`);
    buttons()[1].clickCB();
    expect(await p).toBe(true);
  });

  it("Cancel and closing answer false", async () => {
    const a = createKeyActionsUi(app).confirmForget(plan());
    buttons()[0].clickCB();
    expect(await a).toBe(false);
    const b = createKeyActionsUi(app).confirmForget(plan());
    lastModal().close();
    expect(await b).toBe(false);
  });
});

describe("confirmReplaceKey and confirmRemoveDevice", () => {
  it("replace: warns that other devices are locked; Cancel left, warning right", async () => {
    const p = createKeyActionsUi(app).confirmReplaceKey();
    expect(labels()).toEqual([en["modal.cancel"], en["modal.replace.confirm"]]);
    expect(buttons()[1].destructiveSet).toBe(true);
    expect(paragraphs()).toContain(en["modal.replace.message"]);
    buttons()[1].clickCB();
    expect(await p).toBe(true);
  });

  it("remove, readable: names the device and says its file is taken over first; unreadable: warns of the loss", async () => {
    const a = createKeyActionsUi(app).confirmRemoveDevice({ name: "iPhone JK", readable: true });
    expect(paragraphs()).toContain(en["modal.device.readable"]);
    expect(paragraphs()).not.toContain(en["modal.device.unreadable"]);
    expect(paragraphs()).toContain(en["modal.device.noAccess"]);
    expect(lastModal().titleEl.textContent ?? "").toContain("iPhone JK");
    buttons()[0].clickCB();
    expect(await a).toBe(false);
    const b = createKeyActionsUi(app).confirmRemoveDevice({ name: "Alt-PC", readable: false });
    expect(paragraphs()).toContain(en["modal.device.unreadable"]);
    expect(paragraphs()).not.toContain(en["modal.device.readable"]);
    expect(labels()).toEqual([en["modal.cancel"], en["modal.device.confirm"]]);
    expect(buttons()[1].destructiveSet).toBe(true);
    buttons()[1].clickCB();
    expect(await b).toBe(true);
  });
});

describe("choosePerson", () => {
  const options = (): ReturnType<typeof listPersons> => listPersons(must(tableSetException(sampleTable(), "x", true)), "en");
  const modal = (): any => { const m = SuggestModal.__instance; if (!m) throw new Error("no suggest modal"); return m; };

  it("filters by name, value and placeholder; renders label and meta", async () => {
    const p = createKeyActionsUi(app).choosePerson(options());
    // the mock's open() does nothing; the constructor ran
    expect(modal().getSuggestions("mustermann")).toHaveLength(1);
    expect(modal().getSuggestions("nobody")).toHaveLength(0);
    expect(modal().emptyStateText).toBe(en["modal.forget.pick.empty"]);
    const el = { children: [] as any[], createDiv(o: any) { this.children.push(o); return this; } };
    modal().renderSuggestion(options()[0], el);
    expect(el.children.map((c: any) => c.text)).toEqual(["Max Mustermann", `Person · values: ${String(options()[0].values.length)}`]);
    modal().selectSuggestion(options()[0]);
    expect(await p).toBe(PERSON);
  });

  it("choosing answers the id even though the dialog closes first; closing without a choice answers null", async () => {
    const a = createKeyActionsUi(app).choosePerson(options());
    // Obsidian: die Wahl schließt den Dialog (onClose), danach erst kommt onChooseSuggestion. Der Stub-Dialog schließt nicht von selbst, also in dieser Reihenfolge von Hand.
    modal().onClose();
    modal().onChooseSuggestion(options()[0]);
    expect(await a).toBe(PERSON);
    const b = createKeyActionsUi(app).choosePerson(options());
    modal().onClose();
    expect(await b).toBeNull();
  });
});
