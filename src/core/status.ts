export type PluginState = "ready" | "locked" | "not-set-up";
export type LockReason = "no-key" | "key-opens-nothing" | "table-missing" | "foreign-chain" | "unreadable" | "key-corrupt" | "storage-failed" | "key-replaced";

export interface StatusInput {
  /** JEDE Datei mit Endung .pseudo im Ordner, auch mit unlesbarem oder neuerem Kopf. */
  deviceFiles: number;
  /** Davon mit lesbarem Kopf. */
  readableHeads: number;
  /** Der Schlüsselbund trägt einen lesbaren Code. */
  hasKey: boolean;
  /** Der Schlüsselbund trägt etwas, das kein gültiger Code ist. */
  keyCorrupt: boolean;
  /** Davon mit dem Schlüssel geöffnet. */
  openedFiles: number;
  /** Mindestens eine Datei trägt die Ketten-Kennung des Schlüssels. */
  ownChainMatches: boolean;
  /** Lesen des Ordners scheiterte. */
  storageError: boolean;
  /** Eine mit dem Schlüssel lesbare Abschlussdatei der eigenen Kette liegt im Ordner: ein anderes Gerät hat den Schlüssel ersetzt (Spec 8.3). */
  chainReplaced?: boolean;
}

const locked = (reason: LockReason): { state: PluginState; reason: LockReason } => ({ state: "locked", reason });

/** Zustand des Plugins aus dem, was auf dem Gerät liegt (Spec 8.3). Die Reihenfolge der Prüfungen ist der Inhalt:
 *  Ein Lesefehler geht allem vor; „nicht eingerichtet“ gilt nur, wenn weder Datei noch Schlüssel da sind
 *  (sonst baute ein Gerät mit älterer Fassung eine zweite Kette auf); mit Schlüssel aber ohne geöffnete Datei
 *  ist das Plugin nie `ready`, damit nie eine leere Tabelle als vollständige eigene Fassung gilt.
 *  Eine Abschlussdatei der eigenen Kette sperrt, auch wenn die eigene alte Datei noch lesbar ist: der Schlüssel wurde ersetzt. */
export function deriveStatus(i: StatusInput): { state: PluginState; reason: LockReason | null } {
  if (i.storageError) return locked("storage-failed");
  if (i.keyCorrupt) return locked("key-corrupt");
  if (!i.hasKey) {
    return i.deviceFiles > 0 ? locked("no-key") : { state: "not-set-up", reason: null };
  }
  if (i.chainReplaced === true) return locked("key-replaced");
  if (i.deviceFiles === 0) return locked("table-missing");
  if (i.readableHeads === 0) return locked("unreadable");
  if (i.openedFiles > 0) return { state: "ready", reason: null };
  return locked(i.ownChainMatches ? "key-opens-nothing" : "foreign-chain");
}
