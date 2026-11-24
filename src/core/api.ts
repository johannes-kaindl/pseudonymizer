import {
  PSEUDONYMIZER_API_VERSION,
  type ApiError as PseudonymizerApiError,
  type PseudonymizerApi,
  type RestoreResult,
  type TransformRequest,
  type TransformResult,
} from "../vendor/kit/pseudonymizer-source";
import type { Engine } from "./engine";
import { restoreInZones } from "./restore-zones";
import type { PluginState } from "./status";

const KINDS: ReadonlySet<unknown> = new Set(["text", "line", "filename"]);

const invalid = (message: string): PseudonymizerApiError => ({ error: "invalid-input", message });
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isFilled = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

/** Prüft die Form einer Anfrage; liefert den Fehlerwert oder `null`. Keine Meldung nennt einen Wert aus der Anfrage (er könnte Klartext sein). */
function checkRequest(req: unknown): PseudonymizerApiError | null {
  if (!isObject(req)) return invalid("request must be an object");
  if (!isFilled(req.caller)) return invalid("caller must be a non-empty string");
  if (!isFilled(req.documentKey)) return invalid("documentKey must be a non-empty string");
  if (typeof req.interactive !== "boolean") return invalid("interactive must be a boolean");
  if (req.title !== undefined && typeof req.title !== "string") return invalid("title must be a string");
  if (!Array.isArray(req.parts)) return invalid("parts must be an array");
  const ids = new Set<string>();
  for (const p of req.parts as unknown[]) {
    if (!isObject(p)) return invalid("each part must be an object");
    if (!isFilled(p.id)) return invalid("part id must be a non-empty string");
    if (ids.has(p.id)) return invalid("part ids must be unique");
    ids.add(p.id);
    if (!KINDS.has(p.kind)) return invalid("part kind must be \"text\", \"line\" or \"filename\"");
    if (typeof p.value !== "string") return invalid("part value must be a string");
  }
  if (req.entities !== undefined) {
    if (!Array.isArray(req.entities)) return invalid("entities must be an array");
    for (const e of req.entities as unknown[]) {
      if (!isObject(e) || (e.name !== undefined && typeof e.name !== "string") || (e.email !== undefined && typeof e.email !== "string")) {
        return invalid("each entity must be an object with optional string name and email");
      }
    }
  }
  if (req.keep !== undefined && (!Array.isArray(req.keep) || (req.keep as unknown[]).some((k) => typeof k !== "string"))) {
    return invalid("keep must be an array of strings");
  }
  return null;
}

/** Plugin-API v1 als Hülle (Spec 8.7): prüft Eingaben und Zustand, ruft erst dann die Engine. Wirft nie; Fehler sind Werte.
 *  Die Meldungen nennen nie den Text einer gefangenen Ausnahme oder einen Wert der Anfrage, beides könnte Klartext tragen.
 *  `engine` ist eine Funktion, damit `main.ts` die Engine tauschen kann, ohne die API neu zu setzen.
 *  Grenze (Spec 8.7, Vorgabe unverändert): `restore` setzt ohne Schalter überall zurück, auch in Link-Zielen, Bild-URLs, HTML-Attributen und Code; der Aufrufer
 *  verantwortet, wohin der Text danach geht. Mit dem optionalen Feld `skipAddressesAndCode: true` (Entscheidung Johannes 2026-11-20, additiv zu v1) setzt es nur dort zurück,
 *  wo `transform` ersetzen würde, also in denselben Bereichen wie die eigenen Flächen des Plugins (Lesesicht, Live Preview, Kopierwege; `core/restore-zones.ts`);
 *  Platzhalter außerhalb bleiben stehen und zählen weder in `unknown` noch in `forgotten`. */
export function createApi(engine: () => Engine): PseudonymizerApi {
  /** Zustand der Engine; wirft sie, gilt der Zustand als unbekannt (`null`). */
  const stateOf = (): PluginState | null => {
    try { return engine().state(); } catch { return null; }
  };
  return {
    version: PSEUDONYMIZER_API_VERSION,
    status() {
      // Eine Engine, die beim Fragen wirft, lässt nichts hinaus: gesperrt ist die vorsichtige Antwort.
      return { state: stateOf() ?? "locked" };
    },
    async transform(req: TransformRequest): Promise<TransformResult | PseudonymizerApiError> {
      const bad = checkRequest(req);
      if (bad) return bad;
      try {
        const e = engine();
        const state = e.state();
        if (state === "not-set-up") return { error: "not-ready", message: "the table is not set up" };
        if (state !== "ready") return { error: "locked", message: "the table is locked" };
        return await e.transform(req);
      } catch {
        return { error: "storage-failed", message: "the request could not be completed" };
      }
    },
    restore(text: string, opts: { caller: string; skipAddressesAndCode?: boolean }): RestoreResult | PseudonymizerApiError {
      if (typeof text !== "string") return invalid("text must be a string");
      const caller: unknown = isObject(opts) ? opts.caller : undefined;
      if (!isFilled(caller)) return invalid("caller must be a non-empty string");
      const skip: unknown = isObject(opts) ? opts.skipAddressesAndCode : undefined;
      if (skip !== undefined && typeof skip !== "boolean") return invalid("skipAddressesAndCode must be a boolean");
      try {
        const e = engine();
        const state = e.state();
        if (state === "locked") return { error: "locked", message: "the table is locked" };
        if (state !== "ready") return { error: "not-ready", message: "the table is not set up" };
        if (skip !== true) return e.restore(text, caller);
        const r = restoreInZones(text, (segment) => e.restore(segment, caller));
        if ("error" in r) return r;
        return { text: r.text, restored: r.restored, unknown: r.unknown, forgotten: r.forgotten };
      } catch {
        return { error: "not-ready", message: "the text could not be restored" };
      }
    },
    containsPlaceholder(text: string): boolean {
      if (typeof text !== "string") return false;
      try { return engine().containsPlaceholder(text); } catch { return false; }
    },
  };
}
