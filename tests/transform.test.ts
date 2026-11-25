// `planTransform` und `applyPlan` (Bauplan Aufgabe 13, Spec 8.1, 8.4, 8.7): rein, ohne Gerätedateien. Die Tabelle ist `sampleTable()` (Person_k3x9m2ab7q: „Max Mustermann“, „Max“, Mail, zwei Telefone).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, RULE_GROUPS, type RuleGroup } from "../src/core/settings";
import { applyPlan, candidateKey, decisionsOf, markCandidates, planTransform, withMarks, type Answer, type Applied, type PlanResult } from "../src/core/transform";
import { findPlaceholders, formatPlaceholder } from "../src/vendor/kit/placeholder";
import { emptyTable, tableAddEntry, tableFindValue, tableIsException, tableIsPlain, tableSetException, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";
import type { TransformPart, TransformRequest } from "../src/vendor/kit/pseudonymizer-source";
import { MemoryTable } from "../src/core/memory-table";
import { PseudonymizerEngine } from "../src/obsidian/engine";
import { pruefeLinear, pruefeLinearFuzz } from "./vendor/kit/linear-probe";
import { must, PERSON, sampleTable, withValue } from "./helpers/table-fixtures";

const P = `Person_${PERSON}`;
const ALL_ON: Record<RuleGroup, boolean> = DEFAULT_SETTINGS.rules;
const part = (id: string, value: string, kind: TransformPart["kind"] = "text"): TransformPart => ({ id, kind, value });
const req = (parts: TransformPart[], extra: Partial<TransformRequest> = {}): TransformRequest => ({ caller: "test", documentKey: "doc-1", interactive: false, parts, ...extra });
const plan = (r: TransformRequest, table: PlaceholderTable = sampleTable(), rules: Record<RuleGroup, boolean> = ALL_ON): PlanResult => planTransform(r, table, decisionsOf(table), rules);
/** Kennungen, die man lesen kann: 0000000001, 0000000002, … (gültig im Alphabet). */
const counterIds = (): (() => string) => { let n = 0; return () => String(++n).padStart(10, "0"); };
const ok = (a: Applied): Extract<Applied, { ok: true }> => { if (!a.ok) throw new Error("applyPlan: nicht ok"); return a; };
/** Alles bekannte ersetzen, jeden offenen Kandidaten stehen lassen (Antwort „hier lassen“): zeigt, was die Planung allein tut. */
function known(r: TransformRequest, table: PlaceholderTable = sampleTable(), rules = ALL_ON): string[] {
  const p = plan(r, table, rules);
  const answers = new Map<string, Answer>(p.candidates.map((c) => [candidateKey(c), { action: "keep-here" }]));
  return ok(applyPlan(r, p, table, answers, counterIds())).parts.map((x) => x.value);
}
const one = (text: string, kind: TransformPart["kind"] = "text", table?: PlaceholderTable, extra: Partial<TransformRequest> = {}): string => known(req([part("a", text, kind)], extra), table)[0] ?? "";
const values = (p: PlanResult): string[] => p.candidates.map((c) => c.value);

describe("bekannte Werte", () => {
  it("werden ohne Rückfrage ersetzt, als ganzes Wort, der längere Treffer gewinnt", () => {
    const r = req([part("a", "Max Mustermann schrieb an Max und Maximilian.")]);
    const p = plan(r);
    expect(p.candidates).toEqual([]);
    expect(one(r.parts[0]?.value ?? "")).toBe(`${P} schrieb an ${P}_2 und Maximilian.`);
    expect(p.replacements.get("Max Mustermann")).toBe(P);
    expect(p.replacements.get("Max")).toBe(`${P}_2`);
  });

  it("Mail, Telefon in anderer Schreibweise und Name in anderer Schreibung finden denselben Eintrag", () => {
    expect(one("Mail MAX@example.org, Tel 030-1234567 oder 0171/2345678, gez. max MUSTERMANN")).toBe(`Mail ${P}_Mail, Tel ${P}_Telefon oder ${P}_Telefon_2, gez. ${P}`);
  });

  it("ein Wort, das nur Teil eines längeren ist, bleibt: Maximilian, xMax, Max_2, Max-Mustermann", () => {
    const t = "Maximilian xMax Max_2 Max-Mustermann";
    expect(one(t)).toBe(t);
  });

  it("Satzzeichen hinter dem Wort gehören nicht zum Wert", () => {
    expect(one("Hallo Max, (Max) „Max“ Max.")).toBe(`Hallo ${P}_2, (${P}_2) „${P}_2“ ${P}_2.`);
  });

  it("ein bekannter Wert wird auch ersetzt, wenn die Regelgruppe seiner Art abgeschaltet ist", () => {
    const off = Object.fromEntries(RULE_GROUPS.map((g) => [g, false])) as Record<RuleGroup, boolean>;
    expect(known(req([part("a", "Hallo Max, Tel 030 1234567")]), sampleTable(), off)[0]).toBe(`Hallo ${P}_2, Tel ${P}_Telefon`);
  });
});

describe("K2: keep bei längeren bekannten Formen und im Dateinamen (Sicherheits-Lesung Runde 1)", () => {
  it("K2a: ein längerer bekannter Wert, der einen keep-Wert enthält, ist ein anderer Wert und wird ersetzt; der keep-Wert allein bleibt", () => {
    const table = must(tableAddEntry(sampleTable(), "q7d2w8n4tz", "organisation"));
    const withOrg = withValue(table, "q7d2w8n4tz", null, "Max Mustermann GmbH");
    const r = req([part("a", "Gruss an Max Mustermann GmbH und an Max Mustermann")], { keep: ["Max Mustermann"] });
    const p = plan(r, withOrg);
    expect(p.candidates).toEqual([]);
    expect(known(r, withOrg)[0]).toBe("Gruss an Organisation_q7d2w8n4tz und an Max Mustermann");
  });

  it("K2b: im Dateinamen gilt ein keep-Wert mit Bindestrich in seiner Dateinamenform: unverändert, kein Kandidat", () => {
    const r = req([part("a", "Rechnung_max-muster@example.org.pdf", "filename")], { keep: ["max-muster@example.org"] });
    expect(plan(r).candidates).toEqual([]);
    expect(known(r)[0]).toBe("Rechnung_max-muster@example.org.pdf");
  });

  it("K2b: ohne keep ist die Adresse ein Kandidat, gierig gelesen samt dem Wort davor (Entscheidung 2026-11-25); ein bekannter Name davor bleibt eigener Treffer", () => {
    const r = req([part("a", "Rechnung_max-muster@example.org.pdf", "filename")]);
    expect(values(plan(r, emptyTable()))).toEqual(["Rechnung_max-muster@example.org"]);
    expect(values(plan(r))).toEqual(["muster@example.org"]);
    expect(known(r)[0]).toBe(`Rechnung-${P}_2-muster@example.org.pdf`);
  });
});

describe("N4: die Dateinamenform eines keep-Werts sperrt nur in Dateinamen-Teilen (Sicherheits-Lesung Runde 2)", () => {
  const withMuster = (): PlaceholderTable => withValue(sampleTable(), PERSON, null, "Max Muster");

  it("keep: [\"Max-Muster\"]: im Text ersetzt, im Dateinamen unverändert", () => {
    const r = req([part("t", "Hallo Max Muster"), part("f", "Max_Muster.pdf", "filename")], { keep: ["Max-Muster"] });
    const out = known(r, withMuster());
    expect(out[0]).toBe(`Hallo ${P}_3`);
    expect(out[1]).toBe("Max_Muster.pdf");
  });

  it("dasselbe in einer Zeile (`line`)", () => {
    expect(known(req([part("l", "Max Muster", "line")], { keep: ["Max-Muster"] }), withMuster())[0]).toBe(`${P}_3`);
  });

  it("ohne Dateinamen-Teil ändert sich nichts gegenüber früher: ein keep-Wert mit Bindestrich bleibt sperrend, wo er genau so steht", () => {
    expect(known(req([part("t", "Hallo Max-Muster")], { keep: ["Max-Muster"] }), withMuster())[0]).toBe("Hallo Max-Muster");
  });
});

describe("N6: derselbe Wert an einer Stelle, die kein Erkenner fand, wird mit ersetzt (Spec 8.5: eine Karte je Wert)", () => {
  const NAME = "Erika Musterfrau";
  const text = `Hallo ${NAME},\n\nBis bald, Hallo ${NAME}, und ${NAME}.\n`;
  const answer = (r: TransformRequest, p: PlanResult): Map<string, Answer> => new Map(p.candidates.map((c) => [candidateKey(c), { action: "replace", carrier: "person" } as Answer]));

  for (const kind of ["text", "line"] as const) {
    it(`${kind}: nach „Ersetzen“ steht an keiner Stelle des Werts mehr Klartext`, () => {
      const r = req([part("a", kind === "line" ? `Hallo ${NAME}, Bis bald, Hallo ${NAME}, und ${NAME}.` : text, kind)]);
      const p = plan(r);
      const found = p.candidates.filter((c) => c.value === NAME).length;
      expect(found).toBeGreaterThan(0);
      const a = ok(applyPlan(r, p, sampleTable(), answer(r, p), counterIds()));
      expect(a.parts[0]?.value).not.toContain(NAME);
      const id = a.table.entries.find((e) => e.id === "0000000001")?.id;
      expect(id).toBeDefined();
      expect(a.parts[0]?.value.match(/Person_0000000001/g)).toHaveLength(3);
    });
  }

  it("keep-here für den Wert lässt jede Stelle stehen", () => {
    const r = req([part("a", text)]);
    const p = plan(r);
    const stay = new Map<string, Answer>(p.candidates.map((c) => [candidateKey(c), { action: "keep-here" }]));
    expect(ok(applyPlan(r, p, sampleTable(), stay, counterIds())).parts[0]?.value).toBe(text);
  });
});

describe("keep, Ausnahmeliste und „hier lassen“", () => {
  it("keep des Aufrufers: der Wert bleibt, ohne Kandidaten", () => {
    const r = req([part("a", "Max Mustermann <max@example.org> und Max")], { keep: ["Max Mustermann", "MAX@example.org"] });
    const p = plan(r);
    expect(p.candidates).toEqual([]);
    expect(one("Max Mustermann <max@example.org> und Max", "text", sampleTable(), { keep: ["Max Mustermann", "MAX@example.org"] })).toBe(`Max Mustermann <max@example.org> und ${P}_2`);
  });

  it("Ausnahmeliste: ein bekannter Wert bleibt im Klartext", () => {
    const t = must(tableSetException(sampleTable(), "Max Mustermann", true));
    expect(one("Max Mustermann und Max", "text", t)).toBe(`Max Mustermann und ${P}_2`);
  });

  it("„hier lassen“ gilt nur für denselben documentKey", () => {
    const t = sampleTable();
    const fresh = counterIds();
    const p0 = plan(req([part("a", "Rufen Sie Erika Musterfrau an: Frau Musterfrau")]), t);
    expect(p0.candidates.length).toBeGreaterThan(0);
    // Entscheidung „hier lassen“ in doc-1 gespeichert (über applyPlan), dann dasselbe in doc-1 und doc-2
    const answers = new Map<string, Answer>(p0.candidates.map((c) => [candidateKey(c), { action: "keep-here" }]));
    const done = ok(applyPlan(req([part("a", "x")]), p0, t, answers, fresh));
    expect(tableIsPlain(done.table, "doc-1", "Musterfrau")).toBe(true);
    const again1 = planTransform(req([part("a", "Frau Musterfrau")]), done.table, decisionsOf(done.table), ALL_ON);
    const again2 = planTransform(req([part("a", "Frau Musterfrau")], { documentKey: "doc-2" }), done.table, decisionsOf(done.table), ALL_ON);
    expect(values(again1)).toEqual([]);
    expect(values(again2)).toEqual(["Musterfrau"]);
  });

  it("ein keep-Wort sperrt auch einen bekannten Wert, der darin vorkommt (Gleichstand: keep vor bekannt)", () => {
    expect(one("Max", "text", sampleTable(), { keep: ["Max"] })).toBe("Max");
  });
});

describe("Mail-Kopf: entities", () => {
  const pair = { name: "Erika Musterfrau", email: "erika@example.org" };

  it("ein unbekanntes Paar ergibt Kandidaten „neue Person“ und Adresse, mit Besitzervorschlag aus der Struktur", () => {
    const p = plan(req([part("a", "x")], { entities: [pair] }));
    expect(p.candidates.map((c) => [c.kind, c.value, c.partId, c.entity, c.suggestedOwner])).toEqual([
      ["person", "Erika Musterfrau", "", 0, "erika@example.org"],
      ["mail", "erika@example.org", "", 0, "Erika Musterfrau"],
    ]);
  });

  it("ein bekanntes Paar wird ersetzt, ohne Kandidaten", () => {
    const r = req([part("a", "max@example.org", "line")], { entities: [{ name: "Max Mustermann", email: "max@example.org" }] });
    const a = ok(applyPlan(r, plan(r), sampleTable(), new Map(), counterIds()));
    expect(a.parts).toEqual([{ id: "a", value: `${P}_Mail` }]);
    expect(a.entities).toEqual([{ name: P, email: `${P}_Mail` }]);
  });

  it("der Name allein steht auch ohne Anrede im Text: er stammt aus dem Kopf", () => {
    const p = plan(req([part("a", "Absender war Erika Musterfrau.", "line")], { entities: [pair] }));
    expect(p.candidates.filter((c) => c.partId === "a").map((c) => [c.value, c.suggestedOwner])).toEqual([["Erika Musterfrau", "erika@example.org"]]);
  });

  it("eine Nummer ohne Strukturbeleg hat keinen Besitzervorschlag", () => {
    const p = plan(req([part("a", "Rufen Sie 030 7654321 an.")]));
    expect(p.candidates.map((c) => [c.kind, c.value, c.suggestedOwner])).toEqual([["phone", "030 7654321", null]]);
  });

  it("ein bekannter Name mit unbekannter Adresse: die Adresse wird mit dem Namen als Vorschlag gemeldet", () => {
    const p = plan(req([part("a", "x")], { entities: [{ name: "Max Mustermann", email: "max.privat@example.org" }] }));
    expect(p.candidates.map((c) => [c.kind, c.suggestedOwner])).toEqual([["mail", "Max Mustermann"]]);
  });
});

describe("geschützte Bereiche (Spec 8.4)", () => {
  const MAIL = "max@example.org";
  it.each([
    ["Code-Block", "```\nMax Mustermann <max@example.org>\n```"],
    ["Inline-Code", "so: `max@example.org` und `Max`"],
    ["Link-Ziel", "[Seite](https://example.org/max@example.org)"],
    ["URL", "siehe https://example.org/Max/max@example.org"],
    ["Wikilink-Ziel", "siehe [[Max Mustermann]] und ![[Max.png]]"],
    ["Tag", "#max@example.org"],
    ["Kommentar", "<!-- Max Mustermann max@example.org --> und %% Max %%"],
    ["Mathe", "$Max + 030 1234567$"],
  ])("%s bleibt unverändert", (_name, text) => {
    const p = plan(req([part("a", text)]));
    expect(p.edits).toEqual([]);
    expect(p.candidates).toEqual([]);
    expect(one(text)).toBe(text);
  });

  it("eine Adresse im mailto-Ziel und im Autolink wird ersetzt", () => {
    expect(one(`[Mail](mailto:${MAIL}) und <${MAIL}>`)).toBe(`[Mail](mailto:${P}_Mail) und <${P}_Mail>`);
  });

  it("der Anzeigetext eines Links wird ersetzt, das Ziel nicht", () => {
    expect(one("[Max](https://example.org/max) und [[Max Mustermann|Max]]")).toBe(`[${P}_2](https://example.org/max) und [[Max Mustermann|${P}_2]]`);
  });

  it("eine Eigenschaft als Zeile: das Link-Ziel `[[Max Mustermann]]` bleibt", () => {
    const text = 'up: "[[Max Mustermann]]"';
    expect(one(text, "line")).toBe(text);
  });

  it("ein Platzhalter im Text wird nicht noch einmal gelesen (zweiter Lauf über denselben Text)", () => {
    const text = `Hallo ${P}_2,\n\nViele Grüße\n${P}\n\n-- \n${P}\nTel ${P}_Telefon`;
    const p = plan(req([part("a", text)]));
    expect(p.candidates).toEqual([]);
    expect(one(text)).toBe(text);
  });
});

describe("Überlappung und Regelgruppen", () => {
  it("der längere Treffer gewinnt: „Max Mustermann“ (unbekannt) schlägt das bekannte „Max“", () => {
    const t = withValue(must(tableAddEntry(emptyTable(), PERSON, "person")), PERSON, null, "Max");
    const p = plan(req([part("a", "Hallo Max Mustermann,")]), t);
    expect(values(p)).toEqual(["Max Mustermann"]);
    expect(p.replacements.size).toBe(0);
  });

  it("eine abgeschaltete Regelgruppe erzeugt keine Kandidaten ihrer Art", () => {
    const text = "Hallo Erika,\n\ndanke. Rufen Sie 030 7654321 an.\n\nViele Grüße\nMax Beispiel";
    const all = plan(req([part("a", text)]), emptyTable());
    expect(all.candidates.map((c) => c.value).sort()).toEqual(["030 7654321", "Erika", "Max Beispiel"].sort());
    const noSalutation = plan(req([part("a", text)]), emptyTable(), { ...ALL_ON, salutation: false });
    expect(values(noSalutation)).toEqual(["030 7654321"]);
    const noPatterns = plan(req([part("a", text)]), emptyTable(), { ...ALL_ON, patterns: false });
    expect(noPatterns.candidates.map((c) => c.value).sort()).toEqual(["Erika", "Max Beispiel"]);
  });

  it("die benannte Lücke: „die Kollegin Schmidt“ ohne Anrede wird nicht gefunden (Spec 8.4)", () => {
    const text = "Bitte frag die Kollegin Schmidt nach dem Termin.";
    expect(plan(req([part("a", text)]), emptyTable()).candidates).toEqual([]);
    expect(one(text, "text", emptyTable())).toBe(text);
  });
});

describe("Dateinamen", () => {
  const filename = (name: string): string => one(name, "filename");
  const found = (s: string): number => findPlaceholders(s).length;

  it.each([
    ["Rechnung_max@example.org.pdf", `Rechnung-${P}_Mail.pdf`],
    ["max@example.org_2024.pdf", `${P}_Mail-2024.pdf`],
    ["Rechnung-max@example.org.pdf", `Rechnung-${P}_Mail.pdf`],
    ["Max_Mustermann_Rechnung.pdf", `${P}-Rechnung.pdf`],
  ])("%s: der Platzhalter wird genau einmal wiedergefunden", (name, expected) => {
    const out = filename(name);
    expect(out).toBe(expected);
    expect(found(out)).toBe(1);
  });

  it("die Endung wird nie ersetzt, auch wenn sie wie ein Wert aussieht", () => {
    expect(filename("Max.docx")).toBe(`${P}_2.docx`);
    expect(filename("max@example.org")).toBe(`${P}_Mail`);
    expect(filename("notiz.max")).toBe("notiz.max");
  });

  it("der Rückweg stellt den Dateinamen mit Bindestrich her, nicht byte-gleich (benannte Grenze)", () => {
    // Hinweg: `_` neben der Stelle wird `-`; der Platzhalter selbst bleibt unversehrt, also kommt hinten „Rechnung-max@example.org.pdf“ heraus.
    const out = filename("Rechnung_max@example.org.pdf");
    expect(out).not.toBe("Rechnung_max@example.org.pdf");
    expect(out.replace(`${P}_Mail`, "max@example.org")).toBe("Rechnung-max@example.org.pdf");
  });

  describe("bekannte Werte mit Bindestrich (Welle 37, Stichprobe „Adressen mit Bindestrich im Dateinamen“)", () => {
    const hyphenTable = (): PlaceholderTable => withValue(withValue(sampleTable(), PERSON, "mail", "max-muster@example.org"), PERSON, null, "Hans-Peter Muster");
    it.each([
      ["Rechnung_max-muster@example.org.pdf", `Rechnung-${P}_Mail_2.pdf`],
      ["max-muster@example.org.pdf", `${P}_Mail_2.pdf`],
      ["Rechnung max-muster@example.org.pdf", `Rechnung ${P}_Mail_2.pdf`],
      ["Hans-Peter_Muster_Vertrag.pdf", `${P}_3-Vertrag.pdf`],
      ["Vertrag Hans-Peter Muster.pdf", `Vertrag ${P}_3.pdf`],
      ["Hans-Peter-Muster.pdf", `${P}_3.pdf`],
    ])("%s: ganz ersetzt, kein Rest im Klartext, kein Kandidat", (name, expected) => {
      const r = req([part("a", name, "filename")]);
      expect(plan(r, hyphenTable()).candidates).toEqual([]);
      expect(known(r, hyphenTable())[0]).toBe(expected);
    });
    it("ein Wert aus dem Mail-Kopf mit Bindestrich wird im Dateinamen als ganzer Wert Kandidat", () => {
      const r = req([part("a", "Rechnung_erika-muster@example.org.pdf", "filename")], { entities: [{ email: "erika-muster@example.org" }] });
      expect(values(plan(r, emptyTable()))).toContain("erika-muster@example.org");
      expect(values(plan(r, emptyTable()))).not.toContain("muster@example.org");
    });
    it("in Text und Zeilen bleibt die Bindestrich-Form die einzige: „Hans Peter Muster“ ist dort kein bekannter Wert", () => {
      expect(one("Hans Peter Muster", "line", hyphenTable())).toBe("Hans Peter Muster");
    });
  });

  describe("unbekannte Adresse gierig gelesen (Entscheidung Johannes 2026-11-25)", () => {
    /** Alle Kandidaten mit der Vorgabe ersetzen: das Ergebnis und die neue Tabelle. */
    const replaced = (name: string, table: PlaceholderTable = emptyTable(), extra: Partial<TransformRequest> = {}): { out: string; table: PlaceholderTable } => {
      const r = req([part("a", name, "filename")], extra);
      const a = ok(applyPlan(r, plan(r, table), table, new Map(), counterIds()));
      return { out: a.parts[0]?.value ?? "", table: a.table };
    };
    it.each([
      ["Rechnung-max-muster@example.org.pdf", "Rechnung-max-muster@example.org"],
      ["Rechnung_max-muster@example.org.pdf", "Rechnung_max-muster@example.org"],
      ["Rechnung_max_muster@example.org.pdf", "Rechnung_max_muster@example.org"],
      ["max-muster@example.org.pdf", "max-muster@example.org"],
      ["Rechnung max-muster@example.org.pdf", "max-muster@example.org"],
      ["Rechnung-max@example.org.pdf", "Rechnung-max@example.org"],
      ["Rechnung-Müller-max@example.org.pdf", "Rechnung-Müller-max@example.org"],
      ["Rechnung-max@example-firma.org.pdf", "Rechnung-max@example-firma.org"],
    ])("%s: ein Kandidat über die ganze Folge, kein Stück der Adresse bleibt Klartext", (name, value) => {
      expect(values(plan(req([part("a", name, "filename")]), emptyTable()))).toEqual([value]);
      const { out } = replaced(name);
      expect(out).not.toMatch(/max|muster|example|Müller/i);
      expect(findPlaceholders(out)).toHaveLength(1);
    });
    it("ein Leerzeichen, eine Klammer und ein Platzhalter im Namen beenden das gierige Lesen; ein Trenner am Anfang bleibt stehen", () => {
      expect(values(plan(req([part("a", "(Rechnung)-max@example.org.pdf", "filename")]), emptyTable()))).toEqual(["max@example.org"]);
      const withPlaceholder = `${P}-max-muster@example.org.pdf`;
      expect(values(plan(req([part("a", withPlaceholder, "filename")]), emptyTable()))).toEqual(["max-muster@example.org"]);
      expect(replaced(withPlaceholder).out).toBe(`${P}-Mail_0000000001.pdf`);
    });
    it("Vorrang: eine bekannte Adresse ersetzt im Dateinamen weiter nur sich selbst, das Wort davor bleibt", () => {
      expect(plan(req([part("a", "Rechnung-max@example.org.pdf", "filename")])).candidates).toEqual([]);
      expect(replaced("Rechnung-max@example.org.pdf", sampleTable()).out).toBe(`Rechnung-${P}_Mail.pdf`);
      expect(replaced("Rechnung_max@example.org_2024.pdf", sampleTable()).out).toBe(`Rechnung-${P}_Mail-2024.pdf`);
    });
    it("Vorrang: eine Adresse aus dem Mail-Kopf und ein keep-Wert gewinnen gegen die gierige Fassung", () => {
      const fromHeader = req([part("a", "Rechnung-erika@example.org.pdf", "filename")], { entities: [{ email: "erika@example.org" }] });
      expect(values(plan(fromHeader, emptyTable()))).toEqual(["erika@example.org", "erika@example.org"]);
      const kept = req([part("a", "Rechnung-erika@example.org.pdf", "filename")], { keep: ["erika@example.org"] });
      expect(plan(kept, emptyTable()).candidates).toEqual([]);
      expect(known(kept, emptyTable())[0]).toBe("Rechnung-erika@example.org.pdf");
    });
    it("Gegenlesung 1: ein bekannter Name oder eine bekannte Nummer davor bleibt ein eigener Treffer und wird nie Teil des Mail-Werts", () => {
      for (const [name, expected] of [
        ["Max-Mustermann-info@example.com.pdf", `${P}-Mail_0000000001.pdf`],
        ["Max Mustermann-Rechnung_info@example.com.pdf", `${P}-Mail_0000000001.pdf`],
        ["Max_info@example.com.pdf", `${P}_2-Mail_0000000001.pdf`],
        ["030-1234567-info@example.com.pdf", `${P}_Telefon-Mail_0000000001.pdf`],
      ] as const) {
        const r = req([part("a", name, "filename")]);
        expect(values(plan(r))).toEqual([name.includes("Rechnung") ? "Rechnung_info@example.com" : "info@example.com"]);
        expect(replaced(name, sampleTable()).out).toBe(expected);
      }
    });
    it("Gegenlesung 1: das Wort direkt vor dem @ gehört immer zur Adresse, auch wenn es ein bekannter Name ist", () => {
      expect(values(plan(req([part("a", "hans-max@example.com.pdf", "filename")])))).toEqual(["hans-max@example.com"]);
    });
    it("Gegenlesung 2: eine Adresse aus der Ausnahmeliste bleibt, die gierige Fassung entfällt", () => {
      const t = must(tableSetException(emptyTable(), "info@example.org", true));
      const r = req([part("a", "Rechnung-info@example.org.pdf", "filename")]);
      expect(plan(r, t).candidates).toEqual([]);
      expect(known(r, t)[0]).toBe("Rechnung-info@example.org.pdf");
    });
    it("Gegenlesung 3 bis 5: hinter einem Platzhalter, zerlegte Umlaute, Apostroph, zweite Adresse ohne Trenner, Domain mit Bindestrich ohne Endung", () => {
      for (const [name, value] of [
        [`${P}.max@example.com.pdf`, "max@example.com"],
        [`${P}+max@example.com.pdf`, "max@example.com"],
        ["Mu\u0308ller-max@example.com.pdf", "Mu\u0308ller-max@example.com"],
        ["O'Brien-max@example.com.pdf", "O'Brien-max@example.com"],
        ["max@example-firma.org", "max@example-firma.org"],
        ["Rechnung-max@example-firma.org", "Rechnung-max@example-firma.org"],
      ] as const) {
        expect(values(plan(req([part("a", name, "filename")]), emptyTable()))).toEqual([value]);
      }
      expect(values(plan(req([part("a", "erika@example.org-hans-max@example.com.pdf", "filename")]), emptyTable()))).toEqual(["erika@example.org", "hans-max@example.com"]);
    });
    it("Laufzeit: viele Adressen in einem Namen bleiben linear", () => {
      for (const unit of ["a@example.com ", "max@example.org-", "Max-x@example.com_"]) {
        const r = pruefeLinear((k: number) => plan(req([part("a", `${unit.repeat(k)}.pdf`, "filename")]), sampleTable()), (n) => Math.max(1, Math.floor(n / 10)));
        expect(r.linear, r.message).toBe(true);
      }
    });
    it("in Text und Zeilen ändert sich nichts: dort las das Muster die Folge schon immer ganz", () => {
      expect(values(plan(req([part("a", "Rechnung-max-muster@example.org", "line")]), emptyTable()))).toEqual(["Rechnung-max-muster@example.org"]);
    });
    it("restore stellt den Dateinamen aus dem Platzhalter byte-gleich wieder her, auch mit Unterstrich und Wort davor", () => {
      for (const name of ["Rechnung_max-muster@example.org.pdf", "Rechnung-Müller-max@example.org.pdf", "Rechnung max-muster@example.org.pdf"]) {
        const { out, table } = replaced(name);
        expect(out).not.toBe(name);
        const memory = new MemoryTable();
        memory.open(table);
        expect(new PseudonymizerEngine(memory).restore(out, "test")).toMatchObject({ text: name, restored: 1 });
      }
    });
  });

  it("ein Dateiname ohne Fund bleibt, wie er ist", () => {
    expect(filename("Scan_0001.pdf")).toBe("Scan_0001.pdf");
  });
});

describe("applyPlan", () => {
  const SAMPLE = "Von: Erika Musterfrau <erika@example.org>\nHallo Max Beispiel,";

  it("neue Einträge: Name und Adresse gehören derselben Person, wenn die Struktur sie bindet", () => {
    const r = req([part("a", "erika@example.org", "line")], { entities: [{ name: "Erika Musterfrau", email: "erika@example.org" }] });
    const a = ok(applyPlan(r, plan(r, emptyTable()), emptyTable(), new Map(), counterIds()));
    expect(a.parts).toEqual([{ id: "a", value: "Person_0000000001_Mail" }]);
    expect(a.entities).toEqual([{ name: "Person_0000000001", email: "Person_0000000001_Mail" }]);
    expect(a.changed).toBe(true);
    expect(tableFindValue(a.table, null, "Erika Musterfrau")?.id).toBe("0000000001");
  });

  it("„gehört niemandem“: die Adresse bekommt einen eigenen Eintrag ohne Träger (Mail_<id>), der Name bleibt eine Person", () => {
    const r = req([part("a", "erika@example.org", "line")], { entities: [{ name: "Erika Musterfrau", email: "erika@example.org" }] });
    const p = plan(r, emptyTable());
    const answers = new Map<string, Answer>([[candidateKey({ kind: "mail", value: "erika@example.org" }), { action: "replace", owner: "nobody" }]]);
    const a = ok(applyPlan(r, p, emptyTable(), answers, counterIds()));
    expect(a.parts[0]?.value).toMatch(/^Mail_[0-9a-hjkmnp-tv-z]{10}$/);
    expect(a.entities[0]?.name).toBe("Person_0000000001");
    expect(a.entities[0]?.email).toBe(a.parts[0]?.value);
  });

  it("keep und Ausnahmeliste: eine Zeile, die nur die Adresse der Entity ist, bleibt, und die Entity auch", () => {
    const r = req([part("a", "erika@example.org", "line")], { entities: [{ name: "Erika Musterfrau", email: "erika@example.org" }], keep: ["erika@example.org"] });
    const a = ok(applyPlan(r, plan(r, emptyTable()), emptyTable(), new Map(), counterIds()));
    expect(a.parts[0]?.value).toBe("erika@example.org");
    expect(a.entities[0]?.email).toBe("erika@example.org");
    const t = must(tableSetException(emptyTable(), "erika@example.org", true));
    const r2 = req([part("a", "erika@example.org", "line")], { entities: [{ email: "erika@example.org" }] });
    const b = ok(applyPlan(r2, plan(r2, t), t, new Map(), counterIds()));
    expect(b.parts[0]?.value).toBe("erika@example.org");
    expect(b.entities).toEqual([{ email: "erika@example.org" }]);
  });

  it("genau ein { id, value } je Teil, in der Reihenfolge der Anfrage; ein leerer Teil bleibt leer", () => {
    const r = req([part("z", "Max"), part("m", ""), part("a", "Hallo Max", "line")]);
    const a = ok(applyPlan(r, plan(r), sampleTable(), new Map(), counterIds()));
    expect(a.parts).toEqual([{ id: "z", value: `${P}_2` }, { id: "m", value: "" }, { id: "a", value: `Hallo ${P}_2` }]);
    expect(a.applied).toBe(2);
  });

  it("result.entities hat dieselbe Länge und Reihenfolge wie req.entities, auch mit leeren und bekannten Einträgen", () => {
    const entities = [{ email: "max@example.org" }, { name: "Max Mustermann" }, {}, { name: "Erika Musterfrau", email: "erika@example.org" }];
    const r = req([part("a", "x")], { entities });
    const a = ok(applyPlan(r, plan(r), sampleTable(), new Map(), counterIds()));
    expect(a.entities).toHaveLength(entities.length);
    expect(a.entities.slice(0, 3)).toEqual([{ email: `${P}_Mail` }, { name: P }, {}]);
    expect(a.entities[3]?.name).toMatch(/^Person_0000000001$/);
  });

  it("deterministisch: ein zweiter Aufruf mit gleicher Eingabe nach dem ersten ergibt dieselbe Ausgabe", () => {
    const r = req([part("a", SAMPLE), part("b", "Erika Musterfrau", "line")], { entities: [{ name: "Erika Musterfrau", email: "erika@example.org" }] });
    const first = ok(applyPlan(r, plan(r, emptyTable()), emptyTable(), new Map(), counterIds()));
    expect(first.changed).toBe(true);
    const second = ok(applyPlan(r, plan(r, first.table), first.table, new Map(), counterIds()));
    expect(second.changed).toBe(false);
    expect(second.parts).toEqual(first.parts);
    expect(second.entities).toEqual(first.entities);
    expect(second.table).toBe(first.table);
  });

  it("hat ein anderer Weg denselben Wert inzwischen angelegt, gilt dessen Kennung, und es entsteht kein zweiter Eintrag", () => {
    const r = req([part("a", "Erika Musterfrau", "line")], { entities: [{ name: "Erika Musterfrau" }] });
    const planned = plan(r, emptyTable());
    const meanwhile = ok(applyPlan(r, planned, emptyTable(), new Map(), () => "0000000009")).table;
    const mine = ok(applyPlan(r, planned, meanwhile, new Map(), counterIds()));
    expect(mine.parts[0]?.value).toBe("Person_0000000009");
    expect(mine.changed).toBe(false);
    expect(mine.table.entries).toHaveLength(1);
  });

  it("„hier lassen“ und „immer lassen“ werden in die Tabelle geschrieben, der Text bleibt", () => {
    const r = req([part("a", "Hallo Erika, Tel 030 7654321")]);
    const p = plan(r, emptyTable());
    const answers = new Map<string, Answer>([
      [candidateKey({ kind: "person", value: "Erika" }), { action: "keep-here" }],
      [candidateKey({ kind: "phone", value: "030 7654321" }), { action: "keep-always" }],
    ]);
    const a = ok(applyPlan(r, p, emptyTable(), answers, counterIds()));
    expect(a.parts[0]?.value).toBe("Hallo Erika, Tel 030 7654321");
    expect(tableIsPlain(a.table, "doc-1", "Erika")).toBe(true);
    expect(tableIsException(a.table, "030 7654321")).toBe(true);
  });

  it("ein Name, dessen Adresse die Tabelle schon einer Person zuordnet, wird eine weitere Schreibweise dieser Person (Vorgabe)", () => {
    const r = req([part("a", "x")], { entities: [{ name: "M. Mustermann", email: "max@example.org" }] });
    const a = ok(applyPlan(r, plan(r), sampleTable(), new Map(), counterIds()));
    expect(a.entities).toEqual([{ name: `${P}_3`, email: `${P}_Mail` }]);
  });

  it("eine Antwort, die die Tabelle ablehnt (unbekannter Eintrag), gibt { ok: false } und ändert nichts", () => {
    const r = req([part("a", "Erika Musterfrau", "line")], { entities: [{ name: "Erika Musterfrau" }] });
    const answers = new Map<string, Answer>([[candidateKey({ kind: "person", value: "Erika Musterfrau" }), { action: "replace", entry: "0000000005" }]]);
    expect(applyPlan(r, plan(r, emptyTable()), emptyTable(), answers, counterIds())).toEqual({ ok: false });
  });

  it("die Platzhalter-Wörter folgen der Sprache des Vaults", () => {
    const r = req([part("a", "Tel 030 1234567")]);
    const a = ok(applyPlan(r, planTransform(r, sampleTable(), decisionsOf(sampleTable()), ALL_ON, "en"), sampleTable(), new Map(), counterIds(), "en"));
    expect(a.parts[0]?.value).toBe(`Tel ${formatPlaceholder({ carrier: "person", id: PERSON, field: "phone", n: 1 }, "en")}`);
    expect(a.parts[0]?.value).toBe(`Tel ${P}_Phone`);
  });
});

describe("geschlossene Liste erfundener Mails", () => {
  const load = (name: string): string => readFileSync(new URL(`./fixtures/mails/${name}`, import.meta.url), "utf8");
  const FIXED: Record<string, [string, string][]> = {
    "de-anfrage.txt": [
      ["person", "Erika Musterfrau"], ["mail", "erika@example.org"], ["mail", "max@example.org"], ["person", "Mustermann"], ["person", "Musterfrau"], ["phone", "030 1234567"],
      ["iban", "DE89 3704 0044 0532 0130 00"], ["person", "Erika Musterfrau"], ["person", "Erika Musterfrau"], ["phone", "030 1234567"], ["address", "Musterstraße 1, 12345 Musterstadt"], ["mail", "erika@example.org"],
    ],
    "en-thread.txt": [
      ["person", "Max"], ["person", "Musterfrau"], ["phone", "+49 30 1234567"], ["person", "Erika Musterfrau"], ["person", "Max Mustermann"], ["mail", "max@example.org"], ["person", "Musterfrau"], ["person", "Max Mustermann"],
    ],
    "de-markup.txt": [["person", "Max"], ["mail", "max@example.org"], ["mail", "erika@example.org"], ["mail", "erika@example.org"], ["person", "Erika"]],
  };

  it.each(Object.keys(FIXED))("%s: genau diese Kandidaten, in dieser Reihenfolge", (name) => {
    const p = plan(req([part("t", load(name))]), emptyTable());
    expect(p.candidates.map((c) => [c.kind, c.value])).toEqual(FIXED[name]);
  });

  it.each(Object.keys(FIXED))("%s: alles bestätigt — kein erfundener Wert bleibt im Text (außer geschützt), und der Rückweg stellt den Text her", (name) => {
    const text = load(name);
    const r = req([part("t", text)]);
    const a = ok(applyPlan(r, plan(r, emptyTable()), emptyTable(), new Map(), counterIds()));
    const out = a.parts[0]?.value ?? "";
    expect(findPlaceholders(out).length).toBeGreaterThan(0);
    // Was im Text nach dem Hinweg noch als Klartext steht, steht an geschützter Stelle (Code, Link-Ziel, URL, Tag, Wikilink, Kommentar).
    const protectedText = name === "de-markup.txt" ? ["[[Max Mustermann]]", "`max@example.org`", "Max Mustermann <max@example.org>\n```", "#max@example.org"] : ["https://example.org/rechnung/max@example.org"];
    let rest = out;
    for (const s of protectedText) rest = rest.split(s).join("");
    for (const secret of ["Erika", "erika@example.org", "max@example.org", "030 1234567", "DE89 3704", "Musterstraße", "Mustermann", "Musterfrau"]) {
      if (name === "de-anfrage.txt" && secret === "Mustermann") continue; // „Max Mustermann“ im An-Kopf: benannte Grenze (kein Kopfzeilen-Erkenner für „An:“)
      expect(rest, secret).not.toContain(secret);
    }
    // Rückweg über die Tabelle: dieselbe Zeichenfolge wie vorher (jeder Wert nur in einer Schreibweise).
    let back = out;
    for (const f of findPlaceholders(out).reverse()) {
      const parts = { carrier: f.carrier, id: f.id, field: f.field, n: f.n };
      const slot = a.table.values.find((v) => v.id === parts.id && v.field === parts.field && v.n === parts.n);
      back = back.slice(0, f.start) + (slot?.text ?? f.raw) + back.slice(f.end);
    }
    expect(back).toBe(text);
  });

  it("ein Platzhalter bekommt für denselben Wert bei jeder Stelle denselben Platzhalter", () => {
    const text = load("de-anfrage.txt");
    const r = req([part("t", text)]);
    const a = ok(applyPlan(r, plan(r, emptyTable()), emptyTable(), new Map(), counterIds()));
    const out = a.parts[0]?.value ?? "";
    const phones = findPlaceholders(out).filter((f) => f.field === "phone");
    expect(phones).toHaveLength(2);
    expect(phones[0]?.raw).toBe(phones[1]?.raw);
  });
});

describe("Laufzeit", () => {
  it("planTransform ist linear in der Länge des Textes (Fuzz über die Zeichen, die die Suche anlaufen lassen)", { timeout: 180_000 }, () => {
    const table = sampleTable();
    const r = pruefeLinearFuzz((s) => planTransform(req([part("a", s)]), table, decisionsOf(table), ALL_ON), { alphabet: ["Max ", "@", "\n", "Hallo "], maxLaenge: 2, verschachtelt: false });
    expect(r.verdaechtig, JSON.stringify(r.verdaechtig)).toEqual([]);
  });

  it("auch mit einer großen Tabelle bleibt die Zeit linear in der Länge des Textes, und jede bekannte Form wird gefunden", { timeout: 60_000 }, () => {
    let table = emptyTable();
    for (let i = 0; i < 300; i++) {
      const id = String(i + 1).padStart(10, "0");
      table = must(tableAddEntry(table, id, "person"));
      table = withValue(table, id, null, `Vorname${String(i)} Nachname${String(i)}`);
      table = withValue(table, id, "mail", `person${String(i)}@example.org`);
    }
    const unit = "Vorname7 Nachname7 schrieb an person8@example.org über Nachname9. ";
    const run = (n: number): number => planTransform(req([part("a", unit.repeat(n))]), table, decisionsOf(table), ALL_ON).edits.length;
    expect(run(10)).toBe(20);
    const r = pruefeLinear((n: number) => run(n), (n) => Math.max(1, Math.floor(n / 50)));
    expect(r.linear, r.message).toBe(true);
  });
});

describe("Signaturblock als Strukturbeleg für den Besitzervorschlag", () => {
  const owners = (text: string, extra: Partial<TransformRequest> = {}): [string, string | null][] => plan(req([part("a", text)], extra)).candidates.map((c) => [c.value, c.suggestedOwner]);

  it("Telefon, Mail und Adresse im Block hinter der Grußformel bekommen den Namen des Blocks vorgeschlagen, der Name selbst nicht", () => {
    expect(owners("Bitte melden Sie sich.\n\nViele Grüße\nErika Musterfrau\nTel. 030 7654321\nerika@example.org\nMusterstraße 5, 10115 Berlin")).toEqual([
      ["Erika Musterfrau", null],
      ["030 7654321", "Erika Musterfrau"],
      ["erika@example.org", "Erika Musterfrau"],
      ["Musterstraße 5, 10115 Berlin", "Erika Musterfrau"],
    ]);
  });

  it("hinter „-- “ gilt die Namenszeile ebenso", () => {
    expect(owners("Text\n-- \nBerta Beispiel\nTel. 030 5555555")).toEqual([["Berta Beispiel", null], ["030 5555555", "Berta Beispiel"]]);
  });

  it("geteilte Daten ohne Namen im Block (Zentrale, info@) bleiben ohne Vorschlag", () => {
    expect(owners("Bitte melden Sie sich.\n\nViele Grüße\n\nTel. 030 5555555\ninfo@example.org")).toEqual([["030 5555555", null], ["info@example.org", null]]);
  });

  it("eine Nummer hinter einer Leerzeile gehört nicht mehr zum Block und bekommt keinen Vorschlag", () => {
    expect(owners("Viele Grüße\nErika Musterfrau\nTel. 030 7654321\n\nZentrale 030 5555555")).toEqual([["Erika Musterfrau", null], ["030 7654321", "Erika Musterfrau"], ["030 5555555", null]]);
  });

  it("eine Nummer im Fließtext (kein Block) bekommt keinen Vorschlag, auch wenn weiter oben ein Name unter einer Grußformel steht", () => {
    expect(owners("Hallo Erika,\n\nruf mich unter 030 7654321 an.")).toEqual([["Erika", null], ["030 7654321", null]]);
  });

  it("das Paar aus dem Mail-Kopf geht vor dem Signaturblock", () => {
    const r = owners("Viele Grüße\nBerta Beispiel\nberta@example.org", { entities: [{ name: "Erika Musterfrau", email: "berta@example.org" }] });
    expect(r.find(([v]) => v === "berta@example.org")?.[1]).toBe("Erika Musterfrau");
  });

  it("ein Name, der in keep steht (eigene Identität), wird nicht vorgeschlagen", () => {
    expect(owners("Viele Grüße\nErika Musterfrau\nTel. 030 7654321", { keep: ["Erika Musterfrau"] })).toEqual([["030 7654321", null]]);
  });

  it("ein bekannter Name im Block wird vorgeschlagen; die Vorgabe hängt die Nummer an diesen Eintrag", () => {
    const r = req([part("a", "Viele Grüße\nMax Mustermann\nTel. 030 5555555")]);
    const p = plan(r);
    expect(p.candidates.map((c) => [c.value, c.suggestedOwner])).toEqual([["030 5555555", "Max Mustermann"]]);
    const a = ok(applyPlan(r, p, sampleTable(), new Map(), counterIds()));
    expect(a.parts[0]?.value).toBe(`Viele Grüße\n${P}\nTel. ${P}_Telefon_3`);
  });

  it("unbeaufsichtigt ändert der Vorschlag nichts: nur bekannte Werte werden ersetzt, die offene Nummer bleibt Kandidat", () => {
    const r = req([part("a", "Viele Grüße\nErika Musterfrau\nTel. 030 7654321")]);
    expect(plan(r).candidates).toHaveLength(2);
    expect(known(r)[0]).toBe("Viele Grüße\nErika Musterfrau\nTel. 030 7654321");
  });
});

describe("von Hand markierte Stellen", () => {
  const text = "Die Kollegin Schmidt schrieb. Schmidt ruft an, Schmidtke nicht: `Schmidt` im Code.";

  it("jede freie Stelle des Wortlauts wird ein Kandidat, ein längeres Wort und Code nicht", () => {
    const r = req([part("a", text)]);
    const c = markCandidates(r, plan(r), [{ value: "Schmidt", kind: "person" }]);
    expect(c.map((x) => [x.value, x.start, x.suggestedOwner])).toEqual([["Schmidt", 13, null], ["Schmidt", 30, null]]);
  });

  it("eine Stelle, die der Plan schon belegt (bekannter Wert), wird nicht noch einmal angeboten", () => {
    const r = req([part("a", "Max Mustermann und Mustermann")]);
    const c = markCandidates(r, plan(r), [{ value: "Mustermann", kind: "person" }]);
    expect(c.map((x) => x.start)).toEqual([19]);
  });

  it("schließt die benannte Lücke „die Kollegin Schmidt“: mit der Markierung wird die Stelle ersetzt, alle Stellen mit derselben Kennung", () => {
    const r = req([part("a", "Die Kollegin Schmidt schrieb. Schmidt ruft an.")]);
    const p = plan(r);
    expect(p.candidates).toEqual([]);
    const full = withMarks(r, p, [{ value: "Schmidt", kind: "person" }]);
    const a = ok(applyPlan(r, full, sampleTable(), new Map(), counterIds()));
    expect(a.parts[0]?.value).toBe("Die Kollegin Person_0000000001 schrieb. Person_0000000001 ruft an.");
  });

  it("eine markierte Nummer gehört vorgabegemäß niemandem", () => {
    const r = req([part("a", "Sondernummer 99 12 34")]);
    const full = withMarks(r, plan(r), [{ value: "99 12 34", kind: "phone" }]);
    expect(ok(applyPlan(r, full, sampleTable(), new Map(), counterIds())).parts[0]?.value).toBe("Sondernummer Telefon_0000000001");
  });

  it("im Dateinamen gilt _ als Leerzeichen; ohne Markierung bleibt der Plan, wie er ist", () => {
    const r = req([part("a", "Rechnung_Erika_Musterfrau.pdf", "filename")]);
    expect(markCandidates(r, plan(r), [{ value: "Erika_Musterfrau", kind: "person" }]).map((x) => x.value)).toEqual(["Erika Musterfrau"]);
    const p = plan(r);
    expect(withMarks(r, p, [])).toBe(p);
    const full = withMarks(r, p, [{ value: "Erika_Musterfrau", kind: "person" }]);
    expect(ok(applyPlan(r, full, sampleTable(), new Map(), counterIds())).parts[0]?.value).toBe("Rechnung-Person_0000000001.pdf");
  });
});
