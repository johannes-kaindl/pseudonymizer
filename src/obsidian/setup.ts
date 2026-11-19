// Einrichten, weiteres Gerät (Code eingeben) und Code anzeigen als Abläufe (Bauplan Aufgabe 12; Spec 8.3).
//
// Dieser Baustein entscheidet nur die REIHENFOLGE der Fragen und der Schreibvorgänge; öffnen, vordrehen und schreiben tut `table-store.ts`, die Fenster kommen als `SetupUi` herein (so prüfen
// Tests die Reihenfolge gegen Fakes, ohne Obsidian). Er importiert deshalb nichts aus `obsidian`.
//
// Einrichten, genau in dieser Reihenfolge (Plan Aufgabe 12 Schritt 1):
//   1. Ordner lesen. Liegt dort schon etwas (Gerätedatei oder Schlüssel), kommt eine Warnung, in der „Code eingeben“ gleichwertig neben „trotzdem neu einrichten“ steht; nie Neueinrichten als Vorgabe.
//   2. Sprache der Platzhalter wählen (mit der Sync-Voraussetzung im selben Fenster, als ungemessene Voraussetzung mit Bestätigung).
//   3. Neue Kette (Stand 0) NUR im Arbeitsspeicher.
//   4. Code zeigen, mit Pflicht-Kontrollkästchen. Abbruch bis hierher hinterlässt weder Datei noch Schlüssel.
//   5. Eigene Datei schreiben, dann Schlüssel ablegen (beides im Baustein, in dieser Reihenfolge).
// Weiteres Gerät: der Code wird nur auf Tippfehler geprüft (Fenster), dann öffnet der Baustein die Dateien; öffnet sich keine, bleibt alles, wie es war.

import { newChain } from "../vendor/kit/key-ratchet";
import type { RecoveryCodeContent } from "../vendor/kit/recovery-code";
import type { MemoryTable } from "../core/memory-table";
import type { PlaceholderLanguage } from "../core/payload";
import type { KeyStore } from "./key-store";
import type { TableStore } from "./table-store";

/** Die Fenster, die die Abläufe brauchen. Der Obsidian-Anschluss steht in `setup-ui.ts`. */
export interface SetupUi {
  /** Warnung, wenn im Ordner schon Gerätedateien oder ein Schlüssel liegen. `null` heißt Abbrechen. */
  existingFiles(): Promise<"enter-code" | "set-up-anyway" | null>;
  /** Sprache der Platzhalter wählen (Vorgabe nach der Sprache von Obsidian) und die Sync-Voraussetzung bestätigen. `null` heißt Abbrechen. */
  chooseSetUp(defaultLanguage: PlaceholderLanguage): Promise<PlaceholderLanguage | null>;
  /** Zeigt den Code; mit `requireConfirmation` geht es erst nach dem Kontrollkästchen weiter. `false` heißt Abbrechen. */
  showCode(content: RecoveryCodeContent, requireConfirmation: boolean): Promise<boolean>;
  /** Fragt nach dem Code und prüft ihn auf Tippfehler. `null` heißt Abbrechen. */
  enterCode(): Promise<RecoveryCodeContent | null>;
  /** Eine Meldung (Textschlüssel aus `strings.ts`); der Anschluss macht daraus eine Notice. */
  notify(key: string, ...args: (string | number)[]): void;
}

export interface SetupHost {
  store: Pick<TableStore, "refresh" | "adopt" | "setUp" | "markCodeShown">;
  memory: Pick<MemoryTable, "state" | "reason">;
  keys: Pick<KeyStore, "read">;
  ui: SetupUi;
  /** Der Ordner der Tabelle aus den Einstellungen (für Meldungen). */
  folder(): string;
  defaultLanguage(): PlaceholderLanguage;
  /** Ein frischer Schlüssel auf Stand 0; `null`, wenn die Plattform keinen Zufall liefert. Vorgabe: der Baustein des Kits. */
  newKey?(): RecoveryCodeContent | null;
  /** Sagt Statusleiste und Ansicht, dass sich etwas geändert hat. */
  changed(): void;
}

export type SetupOutcome = "done" | "cancelled" | "already" | "failed" | "switched";

const wipeKey = (c: RecoveryCodeContent): void => { c.key.fill(0); };

function freshKey(): RecoveryCodeContent | null {
  const r = newChain();
  if (!r.ok) return null;
  return { chainId: r.value.chainId, stand: r.value.stand, key: r.value.chainKey };
}

/** Richtet das erste Gerät ein. */
export async function runSetUp(h: SetupHost): Promise<SetupOutcome> {
  // 1. Ordner lesen und prüfen: auch hier gilt „erst lesen“, damit eine Warnung auf dem echten Stand beruht.
  await h.store.refresh();
  const state = h.memory.state();
  if (state === "ready") { h.ui.notify("notice.setup.already"); return "already"; }
  if (state === "locked") {
    if (h.memory.reason() === "storage-failed") { h.ui.notify("notice.setup.readFailed"); return "failed"; }
    const choice = await h.ui.existingFiles();
    if (choice === null) return "cancelled";
    if (choice === "enter-code") {
      await runEnterCode(h);
      return "switched";
    }
  }
  // 2. Sprache (und Sync-Voraussetzung).
  const language = await h.ui.chooseSetUp(h.defaultLanguage());
  if (language === null) return "cancelled";
  // 3. Neue Kette, nur im Arbeitsspeicher.
  const content = (h.newKey ?? freshKey)();
  if (content === null) { h.ui.notify("notice.failed"); return "failed"; }
  try {
    // 4. Code zeigen, mit Kontrollkästchen. Bis hierher ist nichts geschrieben.
    const confirmed = await h.ui.showCode(content, true);
    if (!confirmed) return "cancelled";
    // 5. Eigene Datei, dann Schlüssel.
    const r = await h.store.setUp(content, language);
    h.changed();
    if (r.ok) { h.ui.notify("notice.setup.done"); return "done"; }
    if (r.reason === "already-set-up") { h.ui.notify("notice.setup.already"); return "already"; }
    h.ui.notify(`notice.setup.failed.${r.reason}`);
    return "failed";
  } finally {
    wipeKey(content);
  }
}

/** Weiteres Gerät: nimmt den Code, öffnet damit die Dateien und legt erst dann den Schlüssel ab. */
export async function runEnterCode(h: SetupHost): Promise<SetupOutcome> {
  const content = await h.ui.enterCode();
  if (content === null) return "cancelled";
  try {
    const r = await h.store.adopt(content);
    h.changed();
    if (r.ok) { h.ui.notify("notice.code.accepted"); return "done"; }
    h.ui.notify(`notice.code.failed.${r.reason}`, h.folder());
    return "failed";
  } finally {
    wipeKey(content);
  }
}

/** Zeigt den Code des Schlüssels auf diesem Gerät und trägt ein, dass er bei diesem Stand angezeigt wurde (Stand des gesicherten Codes). */
export async function runShowCode(h: SetupHost): Promise<void> {
  const key = h.keys.read();
  if (key === null) { h.ui.notify("notice.code.noKey"); return; }
  if ("error" in key) { h.ui.notify("notice.code.keyCorrupt"); return; }
  try {
    const done = await h.ui.showCode(key, false);
    if (done) {
      await h.store.markCodeShown(key.stand);
      h.changed();
    }
  } finally {
    wipeKey(key);
  }
}
