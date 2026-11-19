// `planTransform` und `applyPlan` (Bauplan Aufgabe 13, Spec 8.1, 8.4, 8.7): rein, ohne Gerätedateien. Die Tabelle ist `sampleTable()` (Person_k3x9m2ab7q: „Max Mustermann“, „Max“, Mail, zwei Telefone).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, RULE_GROUPS, type RuleGroup } from "../src/core/settings";
import { applyPlan, candidateKey, decisionsOf, markCandidates, planTransform, withMarks, type Answer, type Applied, type PlanResult } from "../src/core/transform";
import { findPlaceholders, formatPlaceholder } from "../src/vendor/kit/placeholder";
import { emptyTable, tableAddEntry, tableFindValue, tableIsException, tableIsPlain, tableSetException, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";
import type { TransformPart, TransformRequest } from "../src/vendor/kit/pseudonymizer-source";
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
