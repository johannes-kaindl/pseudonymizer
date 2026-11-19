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

// ── Abschlussdatei einer ersetzten Kette (Spec 8.3 „Schlüssel ersetzen“; Nachtrag zu Aufgabe 12) ──────────────────────────────────────
// Das Kit-Format kennt keine Nachfolge-Kette (der Umschlag `key-envelope` ist abgenommen und bleibt, wie er ist). Das ersetzende Gerät legt deshalb unter der ALTEN Kette eine eigene Datei ab,
// die nur sagt: diese Kette ist ersetzt. Ein Gerät, das sie mit seinem Schlüssel öffnet, sperrt sich. Sie trägt eine eigene `format`-Kennung statt eines Geräteinhalts mit Marke:
// ein Leser, der sie nicht kennt, scheitert in `decodePayload` mit `format` und wertet sie nie als leere Tabelle (CORE-DATA-01). Kein Feld für Tabelle, Werte oder Namen.

const CLOSING_FORMAT = "pseudonymizer-closed";
const CLOSING_PREFIX = "closed-";
const CLOSING_ID = /^closed-[A-Za-z0-9_-]+-[0-9a-f]{8}$/;

/** Die Bytes der Markierung „Kette ersetzt“. */
export function encodeClosing(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ format: CLOSING_FORMAT, version: 1, replaced: true }));
}

/** Liest die Markierung. Fehler wie bei `decodePayload`, nie mit Inhalt: `json`, `format` (kein Abschluss dieses Plugins, auch jeder Geräteinhalt), `version`. */
export function decodeClosing(bytes: Uint8Array): { closed: true } | { error: "format" | "version" | "json" } {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { error: "json" };
  }
  if (!isObj(raw) || raw.format !== CLOSING_FORMAT) return { error: "format" };
  if (raw.version !== 1) return { error: "version" };
  return raw.replaced === true ? { closed: true } : { error: "format" };
}

/** Der Name der Abschlussdatei (ohne Endung), zugleich ihre „Geräte-ID“ in der Ablage: das ersetzende Gerät und die ersetzte Kette stecken darin, damit jede ersetzte Kette genau eine Datei hat,
 *  ein zweites Ersetzen die erste nicht überschreibt und nur das ersetzende Gerät sie wegräumt. Höchstens 64 Zeichen (Format der Geräte-ID). */
export function closingDeviceId(ownDeviceId: string, chainIdHex: string): string {
  const room = 64 - CLOSING_PREFIX.length - 1 - chainIdHex.length;
  return `${CLOSING_PREFIX}${ownDeviceId.slice(0, room)}-${chainIdHex}`;
}

/** Ob ein Dateiname der Ablage der einer Abschlussdatei ist. Nur zum Weglassen aus Geräteliste und Befunden; ob eine Datei wirklich eine ist, entscheidet ihr geöffneter Inhalt. */
export function isClosingId(deviceId: string): boolean {
  return CLOSING_ID.test(deviceId);
}
