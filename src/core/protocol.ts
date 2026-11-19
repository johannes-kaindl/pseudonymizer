/** Plugin-eigene Sicht auf den Kopf einer Gerätedatei. Der Kit-Umschlag liefert die Ketten-Kennung als Uint8Array (4 Byte);
 *  die Umwandlung in 8 Hex-Kleinbuchstaben geschieht einmal im Adapter der Obsidian-Schicht, hier ist sie nur ein String. */
export interface FileHead { deviceId: string; chainId: string; stand: number }
export interface OwnKey { chainId: string; stand: number }
export type FileClass = "same" | "behind" | "ahead" | "too-far" | "foreign-chain";

/** Spec 8.3 „Erst öffnen, dann festschreiben“: Einordnung eines Kopfes gegen den eigenen Schlüssel.
 *  `maxJump` begrenzt den Sprung nach oben (obere Grenze `own.stand + maxJump` einschließlich). */
export function classifyFile(own: OwnKey, head: FileHead, maxJump: number): FileClass {
  if (head.chainId !== own.chainId) return "foreign-chain";
  if (head.stand === own.stand) return "same";
  if (head.stand < own.stand) return "behind";
  return head.stand > own.stand + maxJump ? "too-far" : "ahead";
}

/** Stände, auf die das Gerät im Arbeitsspeicher vordrehen soll, höchster zuerst; nur aus Dateien der eigenen Kette, höchstens own.stand + maxJump. */
export function advanceCandidates(own: OwnKey, heads: FileHead[], maxJump: number): number[] {
  const stands = new Set<number>();
  for (const h of heads) if (classifyFile(own, h, maxJump) === "ahead") stands.add(h.stand);
  return [...stands].sort((a, b) => b - a);
}

export interface DeviceView { deviceId: string; name: string; opened: boolean; stand: number; carriesMarks: boolean }
export interface ForgetProgress {
  devicesDone: number;
  devicesTotal: number;
  pending: string[];
  codeStand: number | null;
  currentStand: number;
  codeOutdated: boolean;
  complete: boolean;
}

/** Spec 8.3 „Stand anzeigen“. „Nachgezogen“ heißt: Die Fassung des Geräts lässt sich öffnen und trägt die Marke,
 *  nicht „gleicher Schlüsselstand“. Vollständig ist das Vergessen erst, wenn jedes Gerät nachgezogen ist, alle auf demselben Stand
 *  stehen und der gesicherte Code vom aktuellen Stand ist; ein fehlender Code-Stand zählt als veraltet, ohne Geräte ist nichts gemessen. */
export function forgetProgress(devices: DeviceView[], currentStand: number, codeStand: number | null): ForgetProgress {
  const done = (d: DeviceView): boolean => d.opened && d.carriesMarks;
  const pending = devices.filter((d) => !done(d)).map((d) => d.name);
  const codeOutdated = codeStand === null || codeStand < currentStand;
  const sameStand = devices.every((d) => d.stand === currentStand);
  return {
    devicesDone: devices.length - pending.length,
    devicesTotal: devices.length,
    pending,
    codeStand,
    currentStand,
    codeOutdated,
    complete: devices.length > 0 && pending.length === 0 && sameStand && !codeOutdated,
  };
}

/** Spec 8.3 Regel 2: Darf das Gerät seine Fassung unter `stand` schreiben, ohne vorher vorzudrehen? Nein, sobald es unter diesem Stand
 *  schon eine Fassung geschrieben hat, die eine ID trug, die jetzt eine Vergessen-Marke hat. */
/** Was dieses Gerät zuletzt geschrieben hat: unter welchem Stand und mit welchen Eintrags-IDs. */
export interface WrittenAtStand { stand: number; ids: ReadonlySet<string> }

export function mustAdvanceBeforeWrite(
  writtenAtStand: WrittenAtStand | null,
  stand: number,
  forgottenIds: ReadonlySet<string>,
): boolean {
  if (writtenAtStand === null || writtenAtStand.stand !== stand) return false;
  for (const id of writtenAtStand.ids) if (forgottenIds.has(id)) return true;
  return false;
}

/** Stand des gesicherten Codes: höchster `codeShownAtStand` unter den geöffneten Fassungen der aktuellen Kette, null wenn keiner. */
/** Aus einer geöffneten Gerätedatei: Kette und Stand, bei dem dort zuletzt ein Code gesichert wurde. */
export interface PayloadCodeStand { chainId: string; codeShownAtStand: number | null }

export function codeStandOf(payloads: readonly PayloadCodeStand[], chainId: string): number | null {
  let best: number | null = null;
  for (const p of payloads) {
    if (p.chainId !== chainId || p.codeShownAtStand === null) continue;
    if (best === null || p.codeShownAtStand > best) best = p.codeShownAtStand;
  }
  return best;
}
