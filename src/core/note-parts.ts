// Eine Notiz in die Teile für `transform` zerlegen und das Ergebnis zu EINEM neuen Gesamttext zusammensetzen (Bauplan Aufgabe 15; Spec 8.9 „Diese Notiz pseudonymisieren“).
// Rein: kein `obsidian`-Import, kein Schreiben. Das Schreiben (ein `swapNote`) macht `src/obsidian/note-actions.ts`.
//
// Zerlegung: der Text hinter dem Frontmatter-Block ist ein Teil (`kind: "text"`, Id `text`); jede Text-Eigenschaft ist ein Teil (`kind: "line"`), eine Liste ein Teil je Eintrag.
// Gelesen wird mit dem Kit-Leser `parseFrontmatter` (flache Skalare und einfache Listen); verschachtelte Werte, Blockskalare, Fortsetzungszeilen und Kommentare im Wert liest er nur teilweise, `patchFrontmatter`
// beim Schreiben aber ganz (es ersetzte den ganzen Wert und löschte die ungelesenen Zeilen: Sicherheits-Lesung Runde 1, B1). Darum gilt je Eigenschaft: der gelesene Wert muss der ganze Wert sein, belegt durch
// Gleichheit mit dem Wert, den Obsidians `parseYaml` für denselben Block liefert (Skalar oder flache Textliste; alles andere, auch ein Block, den `parseYaml` nicht liest, heißt „nicht flach“). Der Block ist genau der des Texts, der
// gelesen und gepatcht wird, nicht der `metadataCache`, der dem Editor um Sekunden nachläuft (Runde 2, N3). Eine solche
// Eigenschaft wird ausgelassen (nicht an `transform` gesendet, nicht gepatcht) und in `skipped` gemeldet (nur der Name, nie der Wert). Nicht gesendet werden Werte, die ein YAML-Leser nicht als Text liest (Datum, Uhrzeit, Wahrheitswert, `null`) und leere Werte.
//
// Zusammensetzen: nur Eigenschaften, deren Wert sich geändert hat, gehen durch `patchFrontmatter` (zeilenweise, fremde Zeilen byte-gleich, geschrieben über `serializeFrontmatter`, das einen Wert nur
// quotet, wenn YAML es verlangt: `Person_k3x9m2ab7q <Person_k3x9m2ab7q_Mail>` bleibt ungequotet, gemessen in Etappe 0 (b), 2026-11-19). Eine Eigenschaft wie `up: "[[Max Mustermann]]"` bleibt, weil `transform`
// sie nicht ändert und sie dann gar nicht angefasst wird. Eine Blockliste bleibt eine Blockliste, eine Flow-Liste eine Flow-Liste.
//
// Zeilenenden und BOM: gearbeitet wird auf der Vergleichsform (ohne BOM, LF). `swapNote` des Kits schreibt in den Zeilenenden und mit dem BOM der Notiz zurück. Ein BOM vor dem ersten Zaun heißt für Obsidian
// „kein Frontmatter-Block“ (Kit `frontmatter.ts`); dann ist die ganze Notiz Text.
import { locateFrontmatter, parseFrontmatter, type FmValue } from "../vendor/kit/frontmatter";
import { patchFrontmatter } from "../vendor/kit/frontmatter-patch";
import type { TransformPart } from "../vendor/kit/pseudonymizer-source";

const BOM = "﻿";

/** Wohin ein Teil gehört: eine Eigenschaft (`index` `null` bei einem Skalar, sonst der Platz in der Liste) oder der Text. */
export type PartTarget = { kind: "text" } | { kind: "property"; key: string; index: number | null };

/** Die Notiz, zerlegt. `work` ist der Text in der Vergleichsform; `parts` gehen an `transform`, `targets` sagt je Teil, wohin sein Ergebnis gehört. */
export interface NoteSplit {
  work: string;
  /** Hat die Notiz einen Frontmatter-Block (ohne BOM davor). */
  hasFrontmatter: boolean;
  /** Der Text hinter dem Block (die ganze Notiz ohne Block). */
  body: string;
  /** Die Notiz trägt `mail_id`: sie gehört mailstone und wird nicht angefasst. */
  mailNote: boolean;
  parts: TransformPart[];
  targets: ReadonlyMap<string, PartTarget>;
  /** Namen der Eigenschaften, die ausgelassen wurden, weil der gelesene Wert nicht der ganze Wert ist (B1). Nie ein Wert. */
  skipped: string[];
  /** Eigenschaften mit ihrem gelesenen Wert; Listen, die als Blockliste geschrieben stehen, in `blockLists`. */
  data: Readonly<Record<string, FmValue>>;
  blockLists: ReadonlySet<string>;
}

/** Was ein YAML-Leser nicht als Text liest: Datum, Datum mit Uhrzeit, Uhrzeit, Wahrheitswert, `null`. Diese Werte gehen nie an `transform`. */
const NOT_TEXT = /^(?:true|false|null|yes|no|on|off|~|\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|[+-]\d{2}(?::?\d{2})?))?)?|\d{1,2}:\d{2}(?::\d{2})?)$/i;
const isText = (v: string): boolean => v.trim() !== "" && !NOT_TEXT.test(v.trim());

/** Die Vergleichsform eines Notiztexts: ohne BOM, `\r\n` als `\n` (dieselbe wie im Kit-`swapNote`). */
function plain(text: string): string {
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, "\n");
}

/** Der Wert des Kit-Lesers ist der ganze Wert, wenn der Cache von Obsidian dasselbe liefert: gleicher Text oder gleiche flache Liste von Texten. Alles andere (anderer Wert, anderer Typ, fehlt) ist „nicht flach“. */
function isWholeValue(read: FmValue, cached: unknown): boolean {
  if (typeof read === "string") return typeof cached === "string" && cached === read;
  if (Array.isArray(read)) return Array.isArray(cached) && cached.length === read.length && read.every((x, i) => typeof cached[i] === "string" && cached[i] === x);
  return false;
}

/** Das gelesene Objekt des Blocks, sonst `null` (kein Block, Leser wirft, Ergebnis ist kein Objekt). */
function readCache(reader: ((yaml: string) => unknown) | Readonly<Record<string, unknown>> | null | undefined, block: string | null): Readonly<Record<string, unknown>> | null {
  if (reader === null || reader === undefined) return null;
  let v: unknown = reader;
  if (typeof reader === "function") {
    if (block === null) return null;
    try { v = reader(block); } catch { return null; }
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `reader` liest den YAML-Text des Blocks (Obsidians `parseYaml`), oder es ist schon das geparste Objekt (Tests); `undefined`/`null`, ein Wurf und alles, was kein Objekt ist, heißen: keine Eigenschaft ist belegt flach. */
export function splitNote(text: string, reader: ((yaml: string) => unknown) | Readonly<Record<string, unknown>> | null | undefined): NoteSplit {
  const work = plain(text);
  const span = text.startsWith(BOM) ? null : locateFrontmatter(work);
  const cache = readCache(reader, span === null ? null : span.raw);
  const fm = span === null ? { data: {} as Record<string, FmValue>, order: [] as string[] } : parseFrontmatter(work);
  const body = span === null ? work : work.slice(span.bodyFrom);
  const parts: TransformPart[] = [];
  const targets = new Map<string, PartTarget>();
  const blockLists = new Set<string>();
  const skipped: string[] = [];
  fm.order.forEach((key, i) => {
    const v = fm.data[key];
    if (v === undefined) return;
    const sendable = Array.isArray(v) ? v.some(isText) : typeof v === "string" && isText(v);
    if (!sendable) return;
    const cached = cache !== null && cache !== undefined && Object.hasOwn(cache, key) ? cache[key] : undefined;
    if (!isWholeValue(v, cached)) { skipped.push(key); return; }
    if (Array.isArray(v)) {
      if (span !== null && new RegExp(`^${escapeRegExp(key)}:[ \\t]*$`, "m").test(span.raw)) blockLists.add(key);
      v.forEach((item, n) => {
        if (!isText(item)) return;
        const id = `p${String(i)}.${String(n)}`;
        parts.push({ id, kind: "line", value: item });
        targets.set(id, { kind: "property", key, index: n });
      });
    } else if (typeof v === "string" && isText(v)) {
      const id = `p${String(i)}`;
      parts.push({ id, kind: "line", value: v });
      targets.set(id, { kind: "property", key, index: null });
    }
  });
  if (body.trim() !== "") {
    parts.push({ id: "text", kind: "text", value: body });
    targets.set("text", { kind: "text" });
  }
  return { work, hasFrontmatter: span !== null, body, mailNote: span !== null && "mail_id" in fm.data, parts, targets, skipped, data: fm.data, blockLists };
}

export type Rewritten = { ok: true; text: string } | { ok: false };

/** Der neue Gesamttext aus den Ergebnissen von `transform` (in der Vergleichsform). `{ ok: false }`, wenn eine Eigenschaft sich nicht sicher umschreiben lässt: dann wird gar nichts geschrieben.
 *  Ein Ergebnis, das dem Original gleicht, ändert nichts (der Text kommt dann unverändert zurück). */
export function rewriteNote(split: NoteSplit, results: readonly { id: string; value: string }[]): Rewritten {
  const lists = new Map<string, string[]>();
  const scalars = new Map<string, string>();
  let body = split.body;
  for (const r of results) {
    const target = split.targets.get(r.id);
    if (target === undefined) continue;
    if (target.kind === "text") { body = r.value; continue; }
    const original = split.data[target.key];
    if (target.index === null) {
      if (r.value !== original) scalars.set(target.key, r.value);
      continue;
    }
    if (!Array.isArray(original)) continue;
    const current = lists.get(target.key) ?? [...original];
    current[target.index] = r.value;
    lists.set(target.key, current);
  }
  const changedLists = [...lists].filter(([key, value]) => {
    const original = split.data[key];
    return Array.isArray(original) && (original.length !== value.length || original.some((x, i) => x !== value[i]));
  });

  let text = split.work;
  if (scalars.size > 0 || changedLists.length > 0) {
    // Schlüssel, die der Schreiber nicht ausnimmt (`created` etc.), gehen hier durch: ein Text-Wert, der sich ändert, wird geschrieben.
    const flow: Record<string, FmValue> = Object.fromEntries(scalars);
    const block: Record<string, FmValue> = {};
    for (const [key, value] of changedLists) (split.blockLists.has(key) ? block : flow)[key] = value;
    for (const [set, listStyle] of [[flow, "flow"], [block, "block"]] as const) {
      if (Object.keys(set).length === 0) continue;
      const r = patchFrontmatter(text, { set, protect: [], onlyExisting: true, listStyle });
      if (!r.ok) return { ok: false };
      text = r.content;
    }
  }
  const bodyFrom = split.hasFrontmatter ? (locateFrontmatter(text)?.bodyFrom ?? -1) : 0;
  if (bodyFrom < 0) return { ok: false };
  return { ok: true, text: text.slice(0, bodyFrom) + body };
}
