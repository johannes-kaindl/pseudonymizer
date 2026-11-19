// Modell des Prüffensters (Bauplan Aufgabe 14, Spec 8.5; UI-STANDARD §6: Zustand → Ansichtsmodell rein, die Obsidian-Schicht zeichnet nur).
//
// Rein: kein `obsidian`-Import. Aus den Fundstellen (alle Stellen, nicht nur je Wert) werden Karten gebaut, eine je Wert (`candidateKey`), mit Kontextzeile der ersten Stelle,
// Weg (Ersetzen, Hier lassen, Immer lassen) und „Gehört zu“. Das Fenster ändert nur den Zustand der Karten; erst `answersOf` macht daraus die Antworten, die die Engine in EINEM `persist` ablegt.
//
// Setzungen [Plan]:
//  - Die Vorgabe jeder Karte ist die Vorgabe der Engine (`defaultAnswer`): Ersetzen, Besitzer nur aus der Struktur, sonst „niemandem“ (Spec 8.1 Leitplanke 1). Ein Fenster, an dem niemand etwas ändert, liefert
//    also genau das, was die Engine ohne Fenster täte.
//  - „Gehört zu“ bei einem Namen: neue Person, neue Organisation oder ein vorhandener Eintrag (dann ist der Name eine weitere Schreibweise). Bei einem Wert (Mail, Telefon, Adresse, IBAN): der Vorschlag
//    aus der Struktur (nur wenn es einen gibt), niemandem oder ein vorhandener Eintrag. Ein Name, der in diesem Fenster neu ist, lässt sich keinem anderen neuen Namen zuordnen (das geht danach in der Ansicht Personen).
//  - Die Zahl im Knopf „N ersetzen, übernehmen“ zählt Werte (Karten mit dem Weg Ersetzen), nicht Stellen.
import { clipContext } from "../vendor/kit/clip-context";
import { normalizeTableValue, type PlaceholderTable } from "../vendor/kit/placeholder-table";
import { candidateKey, defaultAnswer, type Answer, type Candidate, type CandidateKind } from "./transform";
import { listPersons, type PersonOption } from "./forget-plan";
import type { PlaceholderLanguage } from "./payload";

/** Die drei Wege einer Karte, in der Reihenfolge des Schalters. */
export type Way = "replace" | "keep-here" | "keep-always";
export const WAYS: readonly Way[] = ["replace", "keep-here", "keep-always"];

/** Die Wahl bei „Gehört zu“: `suggested` (nur mit Vorschlag), `nobody`, `new-person`, `new-organisation` oder `entry:<ID>` (ein vorhandener Eintrag). */
export type OwnerChoice = string;

export const isNameKind = (kind: CandidateKind): boolean => kind === "person" || kind === "organisation";

export interface ReviewCard {
  key: string;
  value: string;
  kind: CandidateKind;
  /** Die Stellen im Text in der Reihenfolge des Textes, dahinter die Stellen ohne Text (ein Wert aus dem Mail-Kopf). Mindestens eine. */
  places: readonly Candidate[];
  suggestedOwner: string | null;
  way: Way;
  owner: OwnerChoice;
}

/** Die Fundstellen, je Wert eine Karte, in der Reihenfolge des ersten Auftretens, mit der Vorgabe der Engine. */
export function buildCards(places: readonly Candidate[], table: PlaceholderTable): ReviewCard[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of places) {
    const key = candidateKey(c);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [c]);
    else list.push(c);
  }
  const cards: ReviewCard[] = [];
  for (const [key, list] of groups) {
    const ordered = [...list.filter((c) => c.partId !== ""), ...list.filter((c) => c.partId === "")];
    const first = ordered[0];
    if (first === undefined) continue;
    const suggestedOwner = list.find((c) => c.suggestedOwner !== null)?.suggestedOwner ?? null;
    const base = { ...first, suggestedOwner };
    cards.push({ key, value: first.value, kind: first.kind, places: ordered, suggestedOwner, way: "replace", owner: choiceOf(defaultAnswer(base, table), first.kind) });
  }
  return cards;
}

/** Die Wahl „Gehört zu“, die zu einer Antwort der Engine gehört. */
function choiceOf(answer: Answer, kind: CandidateKind): OwnerChoice {
  if (answer.action !== "replace") return "nobody";
  if (isNameKind(kind)) {
    if (answer.entry !== undefined) return `entry:${answer.entry}`;
    return (answer.carrier ?? (kind === "organisation" ? "organisation" : "person")) === "organisation" ? "new-organisation" : "new-person";
  }
  const owner = answer.owner ?? "nobody";
  return typeof owner === "string" ? owner : `entry:${owner.entry}`;
}

/** Die Antwort zu einer Karte. */
export function answerOf(card: ReviewCard): Answer {
  if (card.way === "keep-here") return { action: "keep-here" };
  if (card.way === "keep-always") return { action: "keep-always" };
  const entry = card.owner.startsWith("entry:") ? card.owner.slice("entry:".length) : null;
  if (isNameKind(card.kind)) {
    if (entry !== null) return { action: "replace", entry };
    return { action: "replace", carrier: card.owner === "new-organisation" ? "organisation" : "person" };
  }
  if (entry !== null) return { action: "replace", owner: { entry } };
  return { action: "replace", owner: card.owner === "suggested" && card.suggestedOwner !== null ? "suggested" : "nobody" };
}

/** Alle Antworten nach `candidateKey`. */
export function answersOf(cards: readonly ReviewCard[]): Map<string, Answer> {
  return new Map(cards.map((c) => [c.key, answerOf(c)]));
}

/** Wie viele Werte ersetzt werden (die Zahl im Knopf). */
export const replaceCount = (cards: readonly ReviewCard[]): number => cards.filter((c) => c.way === "replace").length;

/** Eine Zeile der Auswahl „Gehört zu“: `text` ist der Name, der in der Beschriftung vorkommt (Vorschlag, vorhandener Eintrag). */
export interface OwnerOption { id: OwnerChoice; kind: "suggested" | "nobody" | "new-person" | "new-organisation" | "entry"; text?: string; entryKind?: PersonOption["kind"] }

/** Die vorhandenen Einträge, denen etwas zugeordnet werden darf: Personen und Organisationen, nach Name sortiert; Einträge ohne Träger nicht (ein Wert gehört dann „niemandem“). */
export function ownerEntries(table: PlaceholderTable, lang: PlaceholderLanguage): PersonOption[] {
  return listPersons(table, lang).filter((o) => o.kind !== "none").sort((a, b) => a.label.localeCompare(b.label));
}

/** Die Optionen von „Gehört zu“ für eine Karte. Die gewählte Option steht immer darunter (auch ein Eintrag, der nicht mehr in der Liste ist, fällt so nicht still auf eine andere). */
export function ownerOptions(card: ReviewCard, entries: readonly PersonOption[]): OwnerOption[] {
  const out: OwnerOption[] = [];
  if (isNameKind(card.kind)) out.push({ id: "new-person", kind: "new-person" }, { id: "new-organisation", kind: "new-organisation" });
  else {
    if (card.suggestedOwner !== null) out.push({ id: "suggested", kind: "suggested", text: card.suggestedOwner });
    out.push({ id: "nobody", kind: "nobody" });
  }
  for (const e of entries) out.push({ id: `entry:${e.id}`, kind: "entry", text: e.label, entryKind: e.kind });
  if (!out.some((o) => o.id === card.owner)) out.push({ id: card.owner, kind: "nobody" });
  return out;
}

/** „auch: …“: die anderen Werte, die an diesem hängen (die Adresse zum Namen und umgekehrt, wo die Struktur sie paart). */
export function alsoOf(card: ReviewCard, cards: readonly ReviewCard[]): string[] {
  const out: string[] = [];
  if (isNameKind(card.kind)) {
    if (card.suggestedOwner !== null) out.push(card.suggestedOwner);
    const me = normalizeTableValue(null, card.value);
    for (const o of cards) if (o !== card && !isNameKind(o.kind) && o.suggestedOwner !== null && normalizeTableValue(null, o.suggestedOwner) === me) out.push(o.value);
  }
  return [...new Set(out)];
}

// ---- Kontext -------------------------------------------------------------------------------------------------------------------------------------

export interface ReviewPart { id: string; kind: "text" | "line" | "filename"; value: string }
export interface PlaceRef { partId: string; start: number; end: number }

/** Die Stelle mit dem Text davor und danach, auf die Zeile begrenzt und gekürzt. Eine Stelle ohne Text (Wert aus dem Mail-Kopf) zeigt nur den Wert. */
export function contextOf(parts: readonly ReviewPart[], place: Candidate, radius = 40): { before: string; hit: string; after: string } {
  const part = place.partId === "" ? undefined : parts.find((p) => p.id === place.partId);
  if (part === undefined) return { before: "", hit: place.value, after: "" };
  const text = part.value;
  const lineStart = text.lastIndexOf("\n", place.start - 1) + 1;
  const nl = text.indexOf("\n", place.end);
  const lineEnd = nl < 0 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  const clip = clipContext(line, place.start - lineStart, place.end - lineStart, radius);
  return { before: clip.lead, hit: text.slice(place.start, place.end), after: clip.lag };
}

/** Ein Stück des Textes für die Ansicht „Text ansehen“: gewöhnlicher Text, eine offene Fundstelle (`open`, mit dem Schlüssel ihrer Karte) oder ein bekannter Wert (`known`). */
export type TextSegment = { kind: "plain"; text: string } | { kind: "open"; text: string; key: string } | { kind: "known"; text: string };

/** Zerlegt einen Teil in Stücke; Stellen, die sich überlappen, zählt die frühere, die spätere entfällt. */
export function textSegments(part: ReviewPart, open: readonly (PlaceRef & { key: string })[], known: readonly PlaceRef[]): TextSegment[] {
  const marks: { start: number; end: number; key: string | null }[] = [
    ...open.filter((o) => o.partId === part.id).map((o) => ({ start: o.start, end: o.end, key: o.key })),
    ...known.filter((k) => k.partId === part.id).map((k) => ({ start: k.start, end: k.end, key: null })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: TextSegment[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start < at || m.end <= m.start || m.end > part.value.length) continue;
    if (m.start > at) out.push({ kind: "plain", text: part.value.slice(at, m.start) });
    const text = part.value.slice(m.start, m.end);
    out.push(m.key === null ? { kind: "known", text } : { kind: "open", text, key: m.key });
    at = m.end;
  }
  if (at < part.value.length) out.push({ kind: "plain", text: part.value.slice(at) });
  return out;
}
