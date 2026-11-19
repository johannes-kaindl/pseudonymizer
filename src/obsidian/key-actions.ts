// Schlüssel ersetzen und Gerät entfernen als Abläufe, dazu die gemeinsamen Anschlüsse für „Person vergessen“ (Bauplan Aufgabe 12; Spec 8.3).
//
// Dieser Baustein entscheidet nur die REIHENFOLGE der Fragen und der Schreibvorgänge; Lesen, Vordrehen und Schreiben tut `table-store.ts`, die Fenster kommen als `KeyActionsUi` herein
// (so prüfen Tests die Reihenfolge gegen Fakes, ohne Obsidian). Er importiert deshalb nichts aus `obsidian`. Keine Meldung nennt einen Namen, Wert oder Code.
//
// Schlüssel ersetzen: frisch lesen, bestätigen (die anderen Geräte sind danach gesperrt), neue Kette NUR im Arbeitsspeicher, Code zeigen mit Pflicht-Kontrollkästchen, dann Datei, dann Schlüssel.
// Gerät entfernen: frisch lesen, bestätigen (mit Warnung, wenn dessen Fassung nicht lesbar ist), dann übernehmen und löschen.

import { newChain } from "../vendor/kit/key-ratchet";
import type { RecoveryCodeContent } from "../vendor/kit/recovery-code";
import type { ForgetPlan, PersonOption } from "../core/forget-plan";
import type { MemoryTable } from "../core/memory-table";
import type { TableStore } from "./table-store";

/** Die Fenster der drei Abläufe. Der Obsidian-Anschluss steht in `key-actions-ui.ts`. */
export interface KeyActionsUi {
  /** Wählt einen Eintrag zum Vergessen; gibt dessen ID zurück, `null` heißt Abbrechen. */
  choosePerson(options: readonly PersonOption[]): Promise<string | null>;
  /** Der Warndialog vor dem Vergessen; `false` heißt Abbrechen. */
  confirmForget(plan: ForgetPlan): Promise<boolean>;
  /** Warnt, dass alle anderen Geräte danach gesperrt sind, bis sie den neuen Code haben; `false` heißt Abbrechen. */
  confirmReplaceKey(): Promise<boolean>;
  /** Fragt vor dem Entfernen; `readable: false` heißt, die Fassung des Geräts lässt sich nicht lesen und was nur dort stand, geht verloren. */
  confirmRemoveDevice(device: { name: string; readable: boolean }): Promise<boolean>;
  /** Zeigt den Code; mit `requireConfirmation` geht es erst nach dem Kontrollkästchen weiter. `false` heißt Abbrechen. */
  showCode(content: RecoveryCodeContent, requireConfirmation: boolean): Promise<boolean>;
  /** Eine Meldung (Textschlüssel aus `strings.ts`); der Anschluss macht daraus eine Notice. */
  notify(key: string, ...args: (string | number)[]): void;
}

export interface KeyActionsHost {
  store: Pick<TableStore, "refresh" | "forget" | "replaceKey" | "removeDevice">;
  memory: Pick<MemoryTable, "state" | "table" | "language" | "devices">;
  /** Die Geräte-ID dieses Geräts (ihre Zeile bekommt keinen Knopf „Entfernen“). */
  ownDeviceId(): string;
  ui: KeyActionsUi;
  /** Ein frischer Schlüssel auf Stand 0; `null`, wenn die Plattform keinen Zufall liefert. Vorgabe: der Baustein des Kits. */
  newKey?(): RecoveryCodeContent | null;
  /** Sagt Statusleiste und Ansicht, dass sich etwas geändert hat. */
  changed(): void;
}

export type KeyActionOutcome = "done" | "cancelled" | "failed" | "nothing";

const wipeKey = (c: RecoveryCodeContent): void => { c.key.fill(0); };

function freshKey(): RecoveryCodeContent | null {
  const r = newChain();
  if (!r.ok) return null;
  return { chainId: r.value.chainId, stand: r.value.stand, key: r.value.chainKey };
}

/** Liest die Ablage frisch und sagt, ob das Gerät bereit ist; sonst nennt eine Meldung den Grund (gesperrt oder nicht eingerichtet). */
export async function readyAfterRefresh(h: Pick<KeyActionsHost, "store" | "memory" | "ui">): Promise<boolean> {
  await h.store.refresh();
  const state = h.memory.state();
  if (state === "ready") return true;
  h.ui.notify(state === "locked" ? "notice.locked" : "notice.notSetUp");
  return false;
}

/** Schlüssel ersetzen. */
export async function runReplaceKey(h: KeyActionsHost): Promise<KeyActionOutcome> {
  if (!(await readyAfterRefresh(h))) return "failed";
  if (!(await h.ui.confirmReplaceKey())) return "cancelled";
  const content = (h.newKey ?? freshKey)();
  if (content === null) { h.ui.notify("notice.failed"); return "failed"; }
  try {
    // Der neue Code wird gezeigt, ehe etwas geschrieben ist; Abbruch bis zum Kontrollkästchen hinterlässt weder Datei noch Schlüssel.
    if (!(await h.ui.showCode(content, true))) return "cancelled";
    const r = await h.store.replaceKey(content);
    h.changed();
    if (r.ok) { h.ui.notify("notice.replace.done"); return "done"; }
    h.ui.notify(r.reason === "locked" ? "notice.locked" : r.reason === "not-ready" ? "notice.notSetUp" : `notice.replace.failed.${r.reason}`);
    return "failed";
  } finally {
    wipeKey(content);
  }
}

/** Gerät entfernen. */
export async function runRemoveDevice(h: KeyActionsHost, deviceId: string): Promise<KeyActionOutcome> {
  if (deviceId === h.ownDeviceId()) { h.ui.notify("notice.device.own"); return "failed"; }
  if (!(await readyAfterRefresh(h))) return "failed";
  const row = h.memory.devices().find((d) => d.deviceId === deviceId);
  if (row === undefined) { h.ui.notify("notice.device.gone"); return "failed"; }
  if (!(await h.ui.confirmRemoveDevice({ name: row.name, readable: row.opened }))) return "cancelled";
  const r = await h.store.removeDevice(deviceId);
  h.changed();
  if (r.ok) {
    h.ui.notify(r.wasReadable ? "notice.device.removed" : "notice.device.removed.lost");
    return "done";
  }
  h.ui.notify(r.reason === "locked" ? "notice.locked" : r.reason === "not-ready" ? "notice.notSetUp" : `notice.device.failed.${r.reason}`);
  return "failed";
}
