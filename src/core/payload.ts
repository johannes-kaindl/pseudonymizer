export type PlaceholderLanguage = "de" | "en";

/** Klartext im Umschlag der Gerätedatei (Spec 8.2): Name des Geräts und Stand des zuletzt angezeigten Codes
 *  stehen hier, weil der Kit-Umschlag sie nicht kennt; die Tabelle selbst bleibt das Format des Kit-Bausteins. */
export interface DevicePayload {
  format: "pseudonymizer-device";
  version: 1;
  device: { name: string; codeShownAtStand: number | null };
  vault: { language: PlaceholderLanguage };
  /** Serialisierung der Kit-Tabelle, hier undurchsichtig. */
  table: unknown;
}

const FORMAT = "pseudonymizer-device";

/** UTF-8-JSON, Schlüssel in fester Reihenfolge, damit gleiche Eingabe gleiche Bytes ergibt. */
export function encodePayload(p: DevicePayload): Uint8Array {
  const ordered = {
    format: p.format,
    version: p.version,
    device: { name: p.device.name, codeShownAtStand: p.device.codeShownAtStand },
    vault: { language: p.vault.language },
    table: p.table,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** Liest die Bytes zurück. Fehler sind Werte mit einem Code, nie mit Inhalt (kein Klartext in Meldungen, Spec 11.3):
 *  `json` (kein gültiges UTF-8-JSON), `format` (kein Inhalt dieses Plugins oder beschädigter Aufbau), `version` (neuere oder unbekannte Fassung). */
export function decodePayload(bytes: Uint8Array): DevicePayload | { error: "format" | "version" | "json" } {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { error: "json" };
  }
  if (!isObj(raw) || raw.format !== FORMAT) return { error: "format" };
  if (raw.version !== 1) return { error: "version" };
  const { device, vault } = raw;
  if (!isObj(device) || typeof device.name !== "string") return { error: "format" };
  const shown = device.codeShownAtStand;
  if (shown !== null && !(typeof shown === "number" && Number.isInteger(shown) && shown >= 0)) return { error: "format" };
  if (!isObj(vault) || (vault.language !== "de" && vault.language !== "en")) return { error: "format" };
  if (!("table" in raw)) return { error: "format" };
  return {
    format: FORMAT,
    version: 1,
    device: { name: device.name, codeShownAtStand: shown },
    vault: { language: vault.language },
    table: raw.table,
  };
}
