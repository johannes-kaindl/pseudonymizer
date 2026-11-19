import { tableForgotten, type PlaceholderTable } from "../vendor/kit/placeholder-table";
import { forgetProgress, type DeviceView, type ForgetProgress } from "./protocol";
import type { LockReason, PluginState } from "./status";

/** Ein Problem mit einer Gerätedatei, wie der Baustein der Dateien es meldet (Art und Geräte-ID, nie ein Inhalt). */
export interface DeviceProblem { kind: string; deviceId: string | null; path: string }

export interface DevicesInput {
  state: PluginState;
  reason: LockReason | null;
  /** Eigener Schlüsselstand. */
  stand: number | null;
  devices: readonly DeviceView[];
  ownDeviceId: string;
  problems: readonly DeviceProblem[];
  /** Stand des gesicherten Codes (höchster `codeShownAtStand`); `null`, wenn keiner bekannt ist. */
  codeStand: number | null;
  /** Die geöffnete Tabelle, falls bereit (für die Marken); sonst `null`. */
  table: PlaceholderTable | null;
}

/** Wie eine Gerätedatei dasteht: gelesen, mit Problem (der Grund steht in `problemKind`) oder nicht geöffnet (älterer Stand oder andere Kette, kein Befund). */
export type DeviceRowStatus = "read" | "problem" | "not-opened";

export interface DeviceRow {
  deviceId: string;
  name: string;
  own: boolean;
  stand: number;
  status: DeviceRowStatus;
  problemKind: string | null;
}

/** Dateien ohne Geräte-ID (ungültiger Name, etwa eine Konfliktkopie des Sync): sie stehen mit Pfad und Grund da und gehören keinem Gerät. */
export interface StrayFile { path: string; kind: string }

export interface DevicesModel {
  state: PluginState;
  reason: LockReason | null;
  stand: number | null;
  rows: DeviceRow[];
  stray: StrayFile[];
  /** Ob irgendeine Person vergessen wurde; nur dann sagt der Fortschritt etwas. */
  anyForgotten: boolean;
  progress: ForgetProgress | null;
  codeStand: number | null;
}

/** Das Modell für „Geräte und Schlüssel“ (Spec 8.3 „Stand anzeigen“): welche Gerätedateien angekommen sind, mit Grund bei den unlesbaren, Stand je Gerät,
 *  der Fortschritt des Vergessens und der Stand des gesicherten Codes. Rechnet nur; die Texte setzt die Ansicht. */
export function buildDevicesModel(i: DevicesInput): DevicesModel {
  const problemOf = (id: string): DeviceProblem | undefined => i.problems.find((p) => p.deviceId === id && p.kind !== "own-set-aside" && p.kind !== "key-write-failed" && p.kind !== "write-failed");
  const rows: DeviceRow[] = i.devices.map((d) => {
    const p = d.opened ? undefined : problemOf(d.deviceId);
    return {
      deviceId: d.deviceId,
      name: d.name,
      own: d.deviceId === i.ownDeviceId,
      stand: d.stand,
      status: d.opened ? "read" : p !== undefined ? "problem" : "not-opened",
      problemKind: p?.kind ?? null,
    };
  });
  const stray: StrayFile[] = i.problems.filter((p) => p.deviceId === null).map((p) => ({ path: p.path, kind: p.kind }));
  const anyForgotten = i.table !== null && tableForgotten(i.table).length > 0;
  const progress = i.state === "ready" && i.stand !== null && anyForgotten ? forgetProgress([...i.devices], i.stand, i.codeStand) : null;
  return { state: i.state, reason: i.reason, stand: i.stand, rows, stray, anyForgotten, progress, codeStand: i.codeStand };
}
