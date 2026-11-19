// Wo der Klartext beim Kopieren zurückgesetzt werden darf (Sicherheits-Lesung Runde 1, W1; Spec 2 Anti-Ziel, Spec 8.6): nur dort, wo `transform` ersetzen würde, also in `listReplaceableSpans` (Kit `replaceable-spans`).
// Ein Platzhalter in einem Link-Ziel, einer Bild-URL, einer nackten URL, einem Code-Stück, einem Kommentar, in Mathe oder einem Wikilink bleibt Platzhalter: sonst setzte das Kopieren den Klarnamen in eine Adresse, die ein
// Markdown-Editor mit Vorschau von selbst abruft (ein Agent mit Schreibzugriff legt eine solche Adresse in die Notiz). EINE Stelle für beide Kopierwege: der Befehl „Mit Klartext kopieren“ (`copy.ts`, über die Plugin-API)
// und das Kopieren in Live Preview mit „was ich sehe“ (`live-preview.ts`, über den Auflöser der Anzeige). Rein, ohne `obsidian`-Import.
//
// Freigegeben sind das Ziel von `mailto:` (Spec 8.4, wie in `transform.ts`) und der Frontmatter-Block: `transform` zerlegt ihn in Eigenschaftswerte, die es als Zeile ersetzt; hier steht er im Text, also gilt er als Text
// (Inhalt eines Werts, der selbst eine Adresse oder ein Code-Stück ist, schützt die Erkennung weiter).
import { findPlaceholders } from "../vendor/kit/placeholder";
import { listReplaceableSpans, type TextRange } from "../vendor/kit/replaceable-spans";
import type { ApiError, RestoreResult } from "../vendor/kit/pseudonymizer-source";

/** Die Bereiche eines Texts, in denen Klartext eingesetzt werden darf. */
export interface RestoreZones {
  /** Aufsteigend und ohne Überlappung (`[start, end)`). */
  readonly spans: readonly TextRange[];
  /** Liegt `[start, end)` ganz in einem Bereich? */
  inside(start: number, end: number): boolean;
}

/** Die Bereiche für `text`. Ein Text ohne Schutzstellen ist ein Bereich. */
export function restoreZones(text: string): RestoreZones {
  const spans = listReplaceableSpans(text, { allow: ["mailto-target", "frontmatter"] });
  return {
    spans,
    inside(start, end) {
      let lo = 0;
      let hi = spans.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = spans[mid];
        if (s === undefined) return false;
        if (s.end <= start) lo = mid + 1;
        else if (s.start > start) hi = mid - 1;
        else return end <= s.end;
      }
      return false;
    },
  };
}

/** Der Rückweg eines Texts, auf die Bereiche begrenzt. `kept` ist die Zahl der Platzhalter außerhalb, die als Platzhalter stehen blieben. */
export interface ZonedRestore {
  text: string;
  restored: number;
  unknown: string[];
  forgotten: string[];
  kept: number;
}

/** Setzt den Klartext nur in den Bereichen ein: jeder Bereich, der einen Platzhalter trägt, geht durch `restore` (die Plugin-API), alles andere bleibt, wie es stand. Ein Fehler der API (`locked`, `not-ready`)
 *  kommt unverändert zurück. `unknown` und `forgotten` nennen nur Platzhalter in Bereichen: einer außerhalb bleibt ohnehin stehen. */
export function restoreInZones(text: string, restore: (segment: string) => RestoreResult | ApiError): ZonedRestore | ApiError {
  const zones = restoreZones(text);
  const kept = findPlaceholders(text).filter((p) => !zones.inside(p.start, p.end)).length;
  let out = "";
  let at = 0;
  let restored = 0;
  const unknown: string[] = [];
  const forgotten: string[] = [];
  for (const s of zones.spans) {
    const segment = text.slice(s.start, s.end);
    if (findPlaceholders(segment).length === 0) continue;
    const res = restore(segment);
    if ("error" in res) return res;
    out += text.slice(at, s.start) + res.text;
    at = s.end;
    restored += res.restored;
    unknown.push(...res.unknown);
    forgotten.push(...res.forgotten);
  }
  return { text: out + text.slice(at), restored, unknown, forgotten, kept };
}
