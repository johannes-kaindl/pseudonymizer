// Das Modell des Prüffensters (Bauplan Aufgabe 14): rein, ohne Fenster.
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { alsoOf, answerOf, answersOf, buildCards, contextOf, ownerEntries, ownerOptions, replaceCount, textSegments } from "../src/core/review-model";
import { candidateKey, decisionsOf, defaultAnswer, planTransform, uniqueCandidates, type PlanResult } from "../src/core/transform";
import type { TransformRequest } from "../src/vendor/kit/pseudonymizer-source";
import { PERSON, sampleTable } from "./helpers/table-fixtures";

const table = sampleTable();
const plan = (text: string, extra: Partial<TransformRequest> = {}): { req: TransformRequest; plan: PlanResult } => {
  const req: TransformRequest = { caller: "t", documentKey: "d", interactive: true, parts: [{ id: "a", kind: "text", value: text }], ...extra };
  return { req, plan: planTransform(req, table, decisionsOf(table), DEFAULT_SETTINGS.rules) };
};
const need = <T>(x: T | undefined): T => { if (x === undefined) throw new Error("erwartet"); return x; };

describe("Karten", () => {
  it("eine Karte je Wert, nicht je Stelle, in der Reihenfolge des ersten Auftretens; die Stellen stehen in der Karte", () => {
    const { plan: p } = plan("Hallo Erika Musterfrau,\nTel 030 7654321.\nHallo Erika Musterfrau,\nFrau Musterfrau ruft an.");
    const cards = buildCards(p.candidates, table);
    expect(cards.map((c) => [c.value, c.places.length])).toEqual([["Erika Musterfrau", 2], ["030 7654321", 1], ["Musterfrau", 1]]);
    expect(cards.map((c) => c.key)).toEqual(uniqueCandidates(p.candidates).map(candidateKey));
  });

  it("Vorgabe: Weg Ersetzen und genau die Antwort, die die Engine ohne Fenster nähme", () => {
    const { plan: p } = plan("Viele Grüße\nErika Musterfrau\nTel. 030 7654321\n\nZentrale 030 5555555");
    const cards = buildCards(p.candidates, table);
    expect(cards.every((c) => c.way === "replace")).toBe(true);
    for (const c of uniqueCandidates(p.candidates)) {
      const a = answerOf(need(cards.find((x) => x.key === candidateKey(c))));
      const e = defaultAnswer(c, table);
      expect(a.action).toBe(e.action);
      if (e.action === "replace" && a.action === "replace") {
        expect(a.entry).toBe(e.entry);
        expect(a.owner ?? "nobody").toBe(e.owner ?? "nobody");
      }
    }
    expect(replaceCount(cards)).toBe(3);
  });

  it("Besitzer nur aus der Struktur: die Nummer im Signaturblock hat einen Vorschlag, die der Zentrale „niemandem“", () => {
    const { plan: p } = plan("Viele Grüße\nErika Musterfrau\nTel. 030 7654321\n\nZentrale 030 5555555");
    const cards = buildCards(p.candidates, table);
    expect(cards.find((c) => c.value === "030 7654321")?.owner).toBe("suggested");
    expect(cards.find((c) => c.value === "030 5555555")?.owner).toBe("nobody");
    expect(cards.find((c) => c.value === "Erika Musterfrau")?.owner).toBe("new-person");
  });

  it("die Antworten folgen dem Weg und der Auswahl der Karte", () => {
    const { plan: p } = plan("Viele Grüße\nErika Musterfrau\nTel. 030 7654321");
    const [name, phone] = buildCards(p.candidates, table);
    if (!name || !phone) throw new Error("zwei Karten erwartet");
    expect(answerOf({ ...name, way: "keep-here" })).toEqual({ action: "keep-here" });
    expect(answerOf({ ...name, way: "keep-always" })).toEqual({ action: "keep-always" });
    expect(answerOf({ ...name, owner: "new-organisation" })).toEqual({ action: "replace", carrier: "organisation" });
    expect(answerOf({ ...name, owner: `entry:${PERSON}` })).toEqual({ action: "replace", entry: PERSON });
    expect(answerOf({ ...phone, owner: "nobody" })).toEqual({ action: "replace", owner: "nobody" });
    expect(answerOf({ ...phone, owner: `entry:${PERSON}` })).toEqual({ action: "replace", owner: { entry: PERSON } });
    expect(answersOf([name, { ...phone, way: "keep-always" }]).get(phone.key)).toEqual({ action: "keep-always" });
    expect(replaceCount([name, { ...phone, way: "keep-here" }])).toBe(1);
  });

  it("„Gehört zu“: ein Wert ohne Vorschlag bietet „suggested“ nicht an; Namen bieten neue Person und Organisation; vorhandene Einträge stehen dahinter", () => {
    const { plan: p } = plan("Tel 030 7654321.\nHallo Erika Musterfrau,\nbis bald");
    const cards = buildCards(p.candidates, table);
    const entries = ownerEntries(table, "de");
    expect(entries.map((e) => e.label)).toEqual(["Max Mustermann"]);
    expect(ownerOptions(need(cards.find((c) => c.value === "030 7654321")), entries).map((o) => o.id)).toEqual(["nobody", `entry:${PERSON}`]);
    expect(ownerOptions(need(cards.find((c) => c.value === "Erika Musterfrau")), entries).map((o) => o.id)).toEqual(["new-person", "new-organisation", `entry:${PERSON}`]);
  });

  it("auch: die Adresse aus dem Mail-Kopf hängt am Namen", () => {
    const { plan: p } = plan("x", { entities: [{ name: "Erika Musterfrau", email: "erika@example.org" }] });
    const cards = buildCards(p.candidates, table);
    expect(alsoOf(need(cards.find((c) => c.kind === "person")), cards)).toEqual(["erika@example.org"]);
  });
});

describe("Kontext", () => {
  const text = `${"x".repeat(60)}\nHallo Erika Musterfrau, willkommen ${"y".repeat(60)}\nnächste Zeile`;
  const parts = [{ id: "a", kind: "text" as const, value: text }];
  it("die Zeile der Stelle, gekürzt, der Treffer in der Schreibweise des Textes", () => {
    const { plan: p } = plan(text);
    const c = need(p.candidates.find((x) => x.value === "Erika Musterfrau"));
    const ctx = contextOf(parts, c, 10);
    expect(ctx.hit).toBe("Erika Musterfrau");
    expect(ctx.before).toBe("Hallo ");
    expect(ctx.after).toBe(", willkomm…");
    expect(`${ctx.before}${ctx.hit}${ctx.after}`).not.toContain("\n");
  });
  it("eine Stelle ohne Text (Wert aus dem Mail-Kopf) zeigt nur den Wert", () => {
    const { plan: p } = plan("x", { entities: [{ name: "Erika Musterfrau" }] });
    expect(contextOf([], need(p.candidates[0]))).toEqual({ before: "", hit: "Erika Musterfrau", after: "" });
  });
});

describe("Text ansehen", () => {
  it("zerlegt in gewöhnliche, offene und bekannte Stücke; eine überlappende spätere Stelle entfällt", () => {
    const part = { id: "a", kind: "text" as const, value: "Max und Erika, Erika" };
    const segs = textSegments(
      part,
      [{ partId: "a", start: 8, end: 13, key: "k" }, { partId: "a", start: 15, end: 20, key: "k" }, { partId: "a", start: 10, end: 12, key: "z" }],
      [{ partId: "a", start: 0, end: 3 }, { partId: "b", start: 0, end: 1 }],
    );
    expect(segs).toEqual([
      { kind: "known", text: "Max" },
      { kind: "plain", text: " und " },
      { kind: "open", text: "Erika", key: "k" },
      { kind: "plain", text: ", " },
      { kind: "open", text: "Erika", key: "k" },
    ]);
  });
});
