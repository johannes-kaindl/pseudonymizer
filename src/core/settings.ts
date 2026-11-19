import { normalizeRelPath } from "../vendor/kit/rel-path";

export type CopyMode = "placeholder" | "as-shown";
export type RuleGroup = "patterns" | "salutation" | "signature" | "header-lines" | "postal-address";

/** Alles, was in `data.json` steht. Nie ein Name, ein Wert oder ein Platzhalter-Klartext (Spec 8.2, 11.3);
 *  die Sprache der Platzhalter steht in der Gerätedatei, der Ausnahmekatalog in der Tabelle. */
export interface PseudonymizerSettings {
  folder: string;
  copyMode: CopyMode;
  statusBar: boolean;
  rules: Record<RuleGroup, boolean>;
}

export const RULE_GROUPS: readonly RuleGroup[] = ["patterns", "salutation", "signature", "header-lines", "postal-address"];

export const DEFAULT_SETTINGS: PseudonymizerSettings = {
  folder: "_pseudonymizer",
  copyMode: "placeholder",
  statusBar: true,
  rules: { patterns: true, salutation: true, signature: true, "header-lines": true, "postal-address": true },
};

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const bool = (x: unknown, d: boolean): boolean => (typeof x === "boolean" ? x : d);

/** Der Ordner der Tabelle: relativ zum Vault, ohne `..`, nicht leer, ohne Segment aus Leerraum und ohne versteckte Segmente (Punkt am Anfang).
 *  Obsidian führt versteckte Ordner nicht im Vault-Index; der Konfigurationsordner (`Vault#configDir`) ist einer davon, also deckt die Regel „nicht darunter“ ab,
 *  ohne dass der Kern ihn beim Namen kennen muss. Gibt den normalisierten Pfad oder `null`. */
function checkFolder(input: string): string | null {
  const r = normalizeRelPath(input.trim());
  if (!r.ok) return null;
  if (r.segments.some((s) => s.trim() === "" || s.startsWith("."))) return null;
  return r.path;
}

/** Liest gespeicherte Einstellungen Feld für Feld; ungültige Werte fallen einzeln auf die Vorgabe zurück, unbekannte Schlüssel fallen weg. */
export function loadSettings(raw: unknown): PseudonymizerSettings {
  const r = isObj(raw) ? raw : {};
  const rr = isObj(r.rules) ? r.rules : {};
  const d = DEFAULT_SETTINGS;
  const rules = { ...d.rules };
  for (const g of RULE_GROUPS) rules[g] = bool(rr[g], d.rules[g]);
  return {
    folder: (typeof r.folder === "string" ? checkFolder(r.folder) : null) ?? d.folder,
    copyMode: r.copyMode === "placeholder" || r.copyMode === "as-shown" ? r.copyMode : d.copyMode,
    statusBar: bool(r.statusBar, d.statusBar),
    rules,
  };
}

/** Setzt den Ordner der Tabelle, wenn er nach den Regeln gültig ist; sonst `{ error: "folder" }`. */
export function withFolder(s: PseudonymizerSettings, input: string): PseudonymizerSettings | { error: "folder" } {
  const folder = checkFolder(input);
  return folder === null ? { error: "folder" } : { ...s, rules: { ...s.rules }, folder };
}
