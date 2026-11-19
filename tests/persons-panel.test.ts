// Reiter „Personen“ (Bauplan Aufgabe 18, Spec 8.1 Leitplanke 2, 8.9): Suche über alle Formen, Werte und Formen, zusammenführen, Wert abhängen, vergessen; jede Änderung über `persist`.
// Die Handlungen laufen echt (Fake-Platte, WebCrypto), nur die Fenster sind gespielt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { PseudonymizerView, type ViewHost } from "../src/obsidian/view";
import { createPersonsApi } from "../src/obsidian/persons-actions";
import { renderPersons, type PersonsPanelState } from "../src/obsidian/persons-panel";
import { serializeTable, tableEntry, tableFindValue, tableForgotten, tableGroups } from "../src/vendor/kit/placeholder-table";
import type { PluginState } from "../src/core/status";
import { BERTA_ADDRESS, BERTA_IBAN, PERSON, PERSON_B, all, buttonTexts, click, idFrom, noticeKeys, one, personLabels, personsRig, textOf, type El, type PersonsRig, type Script } from "./helpers/persons-rig";
import { conflictTable } from "./helpers/table-fixtures";
import { personTable } from "./helpers/store-fixtures";
import { makeFakeEl } from "./vendor/kit/obsidian-mock";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  setLang("en");
  spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

const typeQuery = (parent: El, value: string): void => {
  const input = one(parent, "input");
  input.value = value;
  for (const cb of input._listeners.input ?? []) cb(new Event("input"));
};

async function mounted(opts: Parameters<typeof personsRig>[0] = {}): Promise<{ r: PersonsRig; parent: El; state: PersonsPanelState }> {
  const r = await personsRig(opts);
  const state: PersonsPanelState = { query: "", selected: null };
  const parent = r.mount((p) => { renderPersons(p, r.api, state); });
  return { r, parent, state };
}
const openEntry = (parent: El, label: string): void => {
  const head = all(parent, ".pseu-person-head").find((h) => textOf(h).startsWith(label));
  if (head === undefined) throw new Error(`kein Eintrag ${label}`);
  click(head);
};
const entryButton = (parent: El, text: string, nth = 0): El => {
  const b = all(parent, "button").filter((x) => textOf(x) === text)[nth];
  if (b === undefined) throw new Error(`kein Knopf ${text}`);
  return b;
};

describe("Reiter Personen: Liste und Suche", () => {
  it("zeigt je Eintrag eine Zeile mit Name, Art und Zahl der Werte; ohne Einträge den Leerzustand ohne Suchfeld", async () => {
    const { parent } = await mounted();
    expect(personLabels(parent)).toEqual(["Max Mustermann", "Berta Beispiel"]);
    expect(textOf(one(parent, ".pseu-persons-count"))).toBe("2 of 2 entries");
    expect(textOf(all(parent, ".pseu-person-meta")[0])).toBe("Person · values: 5");

    const r = await personsRig();
    const state: PersonsPanelState = { query: "", selected: null };
    const empty = makeFakeEl();
    renderPersons(empty, { ...r.api, list: () => [] }, state);
    expect(all(empty, ".pseu-empty")).toHaveLength(1);
    expect(all(empty, "input")).toHaveLength(0);
  });

  it("sucht über alle Formen: Name, Kurzform, Mail, Telefon in anderer Schreibweise, Adresse, IBAN mit und ohne Leerzeichen, Platzhalter; Groß und Klein gilt gleich", async () => {
    const { parent } = await mounted();
    const find = (q: string): string[] => { typeQuery(parent, q); return personLabels(parent); };
    expect(find("mustermann")).toEqual(["Max Mustermann"]);
    expect(find("MAX@EXAMPLE.ORG")).toEqual(["Max Mustermann"]);
    expect(find("+49 30 1234567")).toEqual(["Max Mustermann"]);
    expect(find("0171")).toEqual(["Max Mustermann"]);
    expect(find("0171 / 2345678")).toEqual(["Max Mustermann"]);
    expect(find("musterstraße")).toEqual(["Berta Beispiel"]);
    expect(find(BERTA_IBAN.toLowerCase())).toEqual(["Berta Beispiel"]);
    expect(find(BERTA_IBAN.replace(/ /g, ""))).toEqual(["Berta Beispiel"]);
    expect(find(`person_${PERSON_B}_mail`)).toEqual(["Berta Beispiel"]);
    expect(find("berta@")).toEqual(["Berta Beispiel"]);
    expect(find("")).toEqual(["Max Mustermann", "Berta Beispiel"]);
    expect(find("gibt es nicht")).toEqual([]);
    expect(textOf(one(parent, ".pseu-empty"))).toBe("Nothing matches this search.");
  });

  it("die Suche überlebt das Neuzeichnen (der Zustand liegt beim Reiter)", async () => {
    const { r, parent, state } = await mounted();
    typeQuery(parent, "berta");
    expect(state.query).toBe("berta");
    // ein Neuzeichnen (etwa nach einer Änderung von außen) bekommt denselben Zustand
    const again = makeFakeEl();
    renderPersons(again, r.api, state);
    expect(personLabels(again)).toEqual(["Berta Beispiel"]);
  });
});

describe("Reiter Personen: Detail", () => {
  it("klappt einen Eintrag auf: jeder Wert mit Feld, Klartext und Platzhalter, je Wert „Wert abhängen“, darunter Zusammenführen und Vergessen", async () => {
    const { parent } = await mounted();
    expect(all(parent, ".pseu-person-detail")).toHaveLength(0);
    openEntry(parent, "Max Mustermann");
    const forms = all(parent, ".pseu-form");
    expect(forms).toHaveLength(5);
    const row = (placeholder: string): El => { const f = forms.find((x) => textOf(one(x, ".pseu-form-placeholder")) === placeholder); if (f === undefined) throw new Error(placeholder); return f; };
    expect(textOf(row(`Person_${PERSON}`))).toContain("Max Mustermann");
    expect(textOf(row(`Person_${PERSON}_2`))).toContain("Max");
    expect(textOf(row(`Person_${PERSON}_Mail`))).toContain("Mailmax@example.org");
    expect(textOf(row(`Person_${PERSON}_Telefon_2`))).toContain("0171 2345678");
    expect(textOf(one(row(`Person_${PERSON}_Telefon`), ".pseu-form-field"))).toBe("Phone");
    expect(all(parent, ".pseu-form-detach")).toHaveLength(5);
    expect(buttonTexts(one(parent, ".pseu-person-actions"))).toEqual(["Merge with another entry", "Forget"]);
    expect(one(parent, ".pseu-person-forget").hasClass("mod-warning")).toBe(true);
    expect(one(parent, ".pseu-person-head").getAttribute("aria-expanded")).toBe("true");
    // der zweite Klick klappt wieder zu; der Zustand zeigt es nicht nur über eine Farbe (aria-expanded und Pfeil im Text der Zeile)
    openEntry(parent, "Max Mustermann");
    expect(all(parent, ".pseu-person-detail")).toHaveLength(0);
    expect(one(parent, ".pseu-person-head").getAttribute("aria-expanded")).toBe("false");
  });

  it("kein Klartext in den Beschriftungen der Knöpfe: aria-label nennt den Platzhalter, nie den Wert", async () => {
    const { parent } = await mounted();
    openEntry(parent, "Max Mustermann");
    const labels = all(parent, "button").map((b) => b.getAttribute("aria-label")).filter((x): x is string => x !== null);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) { expect(l).not.toContain("Mustermann"); expect(l).not.toContain("example.org"); }
    expect(labels).toContain(`Detach the value of Person_${PERSON}_Mail`);
  });

  it("ein Platz mit zwei Werten ist ein Konflikt: Text statt Knopf „Wert abhängen“", async () => {
    const { parent } = await mounted({ table: conflictTable() });
    openEntry(parent, "Max Mustermann");
    expect(all(parent, ".pseu-warning").length).toBeGreaterThan(0);
    const conflicted = all(parent, ".pseu-form").filter((f) => all(f, ".pseu-warning").length > 0);
    for (const f of conflicted) expect(all(f, ".pseu-form-detach")).toHaveLength(0);
  });
});

describe("Reiter Personen: zusammenführen", () => {
  it("führt zwei Einträge zusammen: beide IDs lösen danach weiter auf (restore), in der Tabelle und in der Gerätedatei; die Ansicht zeigt einen Eintrag", async () => {
    const { r, parent } = await mounted({ script: { partner: PERSON_B } });
    openEntry(parent, "Max Mustermann");
    click(entryButton(parent, "Merge with another entry"));
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.persons.merged"]);
    const text = `Hallo Person_${PERSON}, schreib an Person_${PERSON_B}_Mail.`;
    const res = r.restore(text);
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.text).toBe("Hallo Max Mustermann, schreib an berta@example.org.");
      expect(res.unknown).toEqual([]);
    }
    expect(tableGroups(r.table())).toHaveLength(1);
    expect(tableEntry(r.table(), PERSON)?.ids).toEqual([PERSON, PERSON_B].sort());
    // dieselbe Aussage aus der Datei, wie ein anderes Gerät sie liest
    const file = await r.fileTable();
    expect(tableGroups(file)).toHaveLength(1);
    expect(tableFindValue(file, null, "Berta Beispiel")).toBeDefined();
    // die Ansicht zeigt einen Eintrag mit dem Hinweis, dass beide Kennungen gelten
    expect(personLabels(parent)).toHaveLength(1);
    expect(textOf(one(parent, ".pseu-person-meta"))).toContain("values: 9");
  });

  it("Abbrechen in der Wahl oder in der Bestätigung ändert nichts und schreibt nichts", async () => {
    for (const script of [{ partner: null }, { partner: PERSON_B, confirm: false }]) {
      const { r, parent } = await mounted({ script });
      const before = r.table();
      r.fs.clearLog();
      openEntry(parent, "Max Mustermann");
      click(entryButton(parent, "Merge with another entry"));
      await r.idle();
      expect(r.table()).toBe(before);
      expect(r.fs.mutations).toBe(0);
      expect(r.persistCalls.n).toBe(0);
      expect(noticeKeys(r)).toEqual([]);
    }
  });

  it("schreibt nach dem Fragen auf dem frischen Stand: ist der Partner inzwischen vergessen, meldet es das und ändert nichts", async () => {
    const script: Script = { partner: PERSON_B };
    const { r, parent } = await mounted({ script });
    script.during = async () => { expect((await r.d.store.forget(PERSON_B)).ok).toBe(true); };
    openEntry(parent, "Max Mustermann");
    click(entryButton(parent, "Merge with another entry"));
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.persons.gone"]);
    expect(tableGroups(r.table())).toHaveLength(1);
    expect(r.table().links).toHaveLength(0);
  });

  it("ohne anderen Eintrag gibt es nichts zu wählen: die Meldung sagt es", async () => {
    const { r, parent } = await mounted({ table: personTable(PERSON, "Max Mustermann") });
    openEntry(parent, "Max Mustermann");
    click(entryButton(parent, "Merge with another entry"));
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.persons.mergeNone"]);
  });
});

describe("Reiter Personen: Wert abhängen", () => {
  it("macht aus dem Wert einen eigenen Eintrag ohne Träger; der alte Platzhalter löst weiter auf", async () => {
    const { r, parent } = await mounted();
    openEntry(parent, "Max Mustermann");
    const detach = all(parent, ".pseu-form").find((f) => textOf(one(f, ".pseu-form-placeholder")) === `Person_${PERSON}_Mail`);
    click(one(detach as El, ".pseu-form-detach"));
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.persons.detachDone"]);
    const fresh = idFrom(101);
    expect(tableEntry(r.table(), fresh)?.kind).toBe("none");
    expect(tableEntry(r.table(), fresh)?.values.map((v) => v.value.text)).toEqual(["max@example.org"]);
    const res = r.restore(`Mail Person_${PERSON}_Mail und Mail_${fresh}`);
    if ("error" in res) throw new Error(res.error);
    expect(res.text).toBe("Mail max@example.org und max@example.org");
    // der Wert gehört nicht mehr zu Max: seine Zeile ist weg, die Zahl der Werte sinkt von 5 auf 4
    const maxRow = all(parent, ".pseu-person").find((li) => textOf(one(li, ".pseu-person-label")).startsWith("Max Mustermann")) as El;
    expect(textOf(one(maxRow, ".pseu-person-meta"))).toContain("values: 4");
    expect((await r.fileTable()).redirects).toHaveLength(1);
  });

  it("danach lässt Vergessen der Person den Wert in Ruhe (Spec 8.1 Leitplanke 2); die Person und ihre anderen Werte sind weg", async () => {
    const { r, parent } = await mounted();
    openEntry(parent, "Max Mustermann");
    const row = all(parent, ".pseu-form").find((f) => textOf(one(f, ".pseu-form-placeholder")) === `Person_${PERSON}_Mail`) as El;
    click(one(row, ".pseu-form-detach"));
    await r.idle();
    // Vergessen aus dem Reiter: derselbe Ablauf wie der Befehl, mit dem Eintrag vorgewählt.
    click(entryButton(parent, "Forget"));
    await r.idle();
    expect(r.forgets).toEqual([PERSON]);
    expect(r.forgetChoices.n).toBe(0);
    expect(tableForgotten(r.table())).toContain(PERSON);
    expect(r.plans).toHaveLength(1);
    // die Liste der Werte im Warndialog trägt die Mail nicht mehr (sie ist abgehängt und bleibt)
    expect(r.plans[0].option.values.map((v) => v.text)).not.toContain("max@example.org");
    const res = r.restore(`A Person_${PERSON} B Person_${PERSON}_Telefon C Person_${PERSON}_Mail`);
    if ("error" in res) throw new Error(res.error);
    expect(res.text).toBe(`A Person_${PERSON} B Person_${PERSON}_Telefon C max@example.org`);
    expect(res.forgotten).toEqual([`Person_${PERSON}`, `Person_${PERSON}_Telefon`]);
    // dasselbe aus der Datei
    const file = await r.fileTable();
    expect(tableFindValue(file, "mail", "max@example.org")).toBeDefined();
    expect(tableFindValue(file, "phone", "030 1234567")).toBeUndefined();
  });

  it("Abbrechen in der Bestätigung ändert nichts", async () => {
    const { r, parent } = await mounted({ script: { confirm: false } });
    openEntry(parent, "Max Mustermann");
    r.fs.clearLog();
    click(all(parent, ".pseu-form-detach")[0]);
    await r.idle();
    expect(r.fs.mutations).toBe(0);
    expect(r.table().redirects).toHaveLength(0);
  });
});

describe("Reiter Personen: Vergessen", () => {
  it("startet den vorhandenen Ablauf mit dem Eintrag vorgewählt: keine zweite Personenwahl, der Warndialog nennt alle Werte, Abbrechen vergisst nichts", async () => {
    const { r, parent } = await mounted({ script: { confirm: false } });
    openEntry(parent, "Berta Beispiel");
    click(entryButton(parent, "Forget"));
    await r.idle();
    expect(r.forgets).toEqual([PERSON_B]);
    expect(r.forgetChoices.n).toBe(0);
    expect(r.plans[0].option.values.map((v) => v.text)).toEqual(expect.arrayContaining(["Berta Beispiel", "berta@example.org", BERTA_ADDRESS, BERTA_IBAN]));
    expect(tableForgotten(r.table())).toEqual([]);
  });

  it("bestätigt: der Eintrag ist vergessen, die Liste zeigt ihn nicht mehr", async () => {
    const { r, parent } = await mounted();
    openEntry(parent, "Berta Beispiel");
    click(entryButton(parent, "Forget"));
    await r.idle();
    expect(tableForgotten(r.table())).toEqual([PERSON_B]);
    expect(personLabels(parent)).toEqual(["Max Mustermann"]);
  });
});

describe("Reiter Personen: Schreibfehler und Zustand", () => {
  it("scheitert das Schreiben der Gerätedatei, meldet eine Notice den Fehler ohne Klartext und die Tabelle bleibt unverändert", async () => {
    const { r, parent } = await mounted({ script: { partner: PERSON_B } });
    const before = serializeTable(r.table());
    r.fs.failWrites = true;
    openEntry(parent, "Max Mustermann");
    click(entryButton(parent, "Merge with another entry"));
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.persons.storage"]);
    expect(serializeTable(r.table())).toBe(before);
    expect(tableGroups(r.table())).toHaveLength(2);
    // die Meldung nennt weder Namen noch Werte
    for (const n of r.notices) expect(JSON.stringify(n)).not.toMatch(/Mustermann|Beispiel|example/);
    r.fs.failWrites = false;
    r.notices.length = 0;
    // Wert abhängen scheitert ebenso
    r.fs.failWrites = true;
    click(all(parent, ".pseu-form-detach")[0]);
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.persons.storage"]);
    expect(r.table().redirects).toHaveLength(0);
  });

  it("ohne Tabelle (gesperrt oder nicht eingerichtet) tut keine Handlung etwas: sie sagt den Grund und fragt nichts", async () => {
    const r = await personsRig();
    let state: PluginState = "locked";
    const asked: string[] = [];
    const api = createPersonsApi({
      memory: { table: () => null, language: () => "de", state: () => state },
      persist: () => { asked.push("persist"); return Promise.resolve(); },
      forget: () => { asked.push("forget"); return Promise.resolve(); },
      ui: {
        choosePartner: () => { asked.push("choose"); return Promise.resolve(null); },
        confirmMerge: () => { asked.push("confirm"); return Promise.resolve(true); },
        confirmDetach: () => { asked.push("confirm"); return Promise.resolve(true); },
        askException: () => { asked.push("ask"); return Promise.resolve("x"); },
        notify: (k) => { asked.push(k); },
      },
      changed: () => undefined,
    });
    expect(api.list()).toEqual([]);
    expect(api.exceptions()).toEqual([]);
    await api.merge(PERSON);
    await api.detach(PERSON, { carrier: "person", id: PERSON, field: "mail", n: 1 });
    await api.forget(PERSON);
    await api.addException();
    await api.removeException("x");
    state = "not-set-up";
    await api.merge(PERSON);
    expect(asked).toEqual(["notice.locked", "notice.locked", "notice.locked", "notice.locked", "notice.locked", "notice.notSetUp"]);
    expect(r.persistCalls.n).toBe(0);
  });
});

describe("die Ansicht: Personen und Ausnahmen nur im Zustand ready", () => {
  const panelsOf = (view: PseudonymizerView): El[] => (view as unknown as { contentEl: El }).contentEl.children[1].children as El[];

  async function view(state: PluginState, r: PersonsRig): Promise<PseudonymizerView> {
    const host: ViewHost = {
      state: () => state,
      run: () => undefined,
      onChange: () => () => undefined,
      lockReason: () => (state === "locked" ? "no-key" : null),
      folder: () => "_pseudonymizer",
      devices: () => ({ state, reason: null, stand: 0, anyForgotten: false, progress: null, codeStand: 0, stray: [], rows: [] }),
      deviceName: () => "Mac",
      setDeviceName: () => undefined,
      removeDevice: () => undefined,
      persons: r.api,
    };
    const View = PseudonymizerView as unknown as new (leaf: unknown, host: ViewHost) => PseudonymizerView;
    const v = new View({}, host);
    (v as unknown as { contentEl: El }).contentEl = makeFakeEl();
    await v.onOpen();
    return v;
  }

  it("bereit: Reiter Personen zeigt die Liste, Reiter Ausnahmen den Leerzustand mit „Ausnahme hinzufügen“", async () => {
    const r = await personsRig();
    const v = await view("ready", r);
    expect(personLabels(panelsOf(v)[0])).toEqual(["Max Mustermann", "Berta Beispiel"]);
    expect(buttonTexts(panelsOf(v)[1])).toEqual(["Add exception"]);
  });

  it("gesperrt und nicht eingerichtet: beide Reiter zeigen den Zustand und keine Handlung (nur Code eingeben, Einrichten)", async () => {
    const r = await personsRig();
    for (const [state, buttons] of [["locked", ["Enter code"]], ["not-set-up", ["Set up", "Enter code"]]] as const) {
      const v = await view(state, r);
      for (const p of panelsOf(v).slice(0, 2)) {
        expect(buttonTexts(p)).toEqual(buttons);
        expect(all(p, ".pseu-person")).toHaveLength(0);
        expect(all(p, ".okit-status")).toHaveLength(1);
        expect(all(p, ".pseu-empty")).toHaveLength(1);
      }
    }
  });

  it("eine Änderung von außen zeichnet den Reiter neu: die Suche bleibt, das Suchfeld bekommt den Fokus zurück; ein Fokuswechsel zeichnet nie neu (der erste Klick nach dem Tippen geht nicht verloren)", async () => {
    const r = await personsRig();
    const listeners = new Set<() => void>();
    const host: ViewHost = {
      state: () => "ready", run: () => undefined, onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      lockReason: () => null, folder: () => "x", devices: () => ({ state: "ready", reason: null, stand: 0, anyForgotten: false, progress: null, codeStand: 0, stray: [], rows: [] }),
      deviceName: () => "Mac", setDeviceName: () => undefined, removeDevice: () => undefined, persons: r.api,
    };
    const View = PseudonymizerView as unknown as new (leaf: unknown, host: ViewHost) => PseudonymizerView;
    const v = new View({}, host);
    (v as unknown as { contentEl: El }).contentEl = makeFakeEl();
    await v.onOpen();
    const p = panelsOf(v)[0];
    const input = one(p, "input");
    for (const cb of input._listeners.focus) cb(new Event("focus"));
    typeQuery(p, "berta");
    // Fokus verlassen (Maus drückt auf einen Knopf): kein Neuzeichnen, der Knopf unter der Maus bleibt derselbe
    const head = one(p, ".pseu-person-head");
    for (const cb of input._listeners.blur) cb(new Event("blur"));
    expect(one(p, ".pseu-person-head")).toBe(head);
    // zurück im Feld, dann kommt eine Änderung von außen
    for (const cb of input._listeners.focus) cb(new Event("focus"));
    for (const l of listeners) l();
    const again = one(p, "input");
    expect(again).not.toBe(input);
    expect(again.__focusCount).toBe(1);
    expect(again.value).toBe("berta");
    expect(personLabels(p)).toEqual(["Berta Beispiel"]);
  });
});
