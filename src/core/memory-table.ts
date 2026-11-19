import type { PlaceholderTable } from "../vendor/kit/placeholder-table";
import type { PlaceholderLanguage } from "./payload";
import type { DeviceView } from "./protocol";
import type { LockReason, PluginState } from "./status";

/** Was ein Öffnen der Tabelle mitbringt, außer der Tabelle selbst. Aufgabe 11 füllt es aus den Gerätedateien. */
export interface OpenInfo {
  /** Eigener Schlüsselstand (Ratsche); `null`, solange kein Schlüssel im Spiel ist. */
  stand?: number | null;
  /** Sprache der Platzhalter im Vault (steht in der Gerätedatei, Spec 8.1). */
  language?: PlaceholderLanguage;
  /** Alle bekannten Geräte mit Stand und Marken-Stand (für „Geräte und Schlüssel“). */
  devices?: readonly DeviceView[];
  /** Höchster Stand, bei dem unter den geöffneten Fassungen ein Code gesichert (angezeigt) wurde; `null`, wenn keine einen nennt. */
  codeStand?: number | null;
}

/** Der plugin-eigene Zustand rund um die geöffnete Tabelle im Arbeitsspeicher: die vereinigte Tabelle, der Zustand des Plugins, der Stand der Kette
 *  und die Geräteliste. Er rechnet nichts; Rücksetzen, Nachschlagen und Vereinigen gehören den Kit-Bausteinen, Öffnen und Schreiben der Gerätedateien
 *  der Aufgabe 11. Gesperrt heißt: keine Tabelle im Speicher, damit nichts mehr eingeblendet oder hinausgegeben werden kann. */
export class MemoryTable {
  private current: PlaceholderTable | null = null;
  private currentState: PluginState = "not-set-up";
  private currentReason: LockReason | null = null;
  private currentStand: number | null = null;
  private currentLanguage: PlaceholderLanguage = "de";
  private currentDevices: readonly DeviceView[] = [];
  private currentCodeStand: number | null = null;

  /** Die geöffnete Tabelle, solange der Zustand `ready` ist; sonst `null`. */
  table(): PlaceholderTable | null { return this.current; }
  state(): PluginState { return this.currentState; }
  /** Der Grund der Sperre; `null`, wenn nicht gesperrt. */
  reason(): LockReason | null { return this.currentReason; }
  stand(): number | null { return this.currentStand; }
  language(): PlaceholderLanguage { return this.currentLanguage; }
  devices(): readonly DeviceView[] { return this.currentDevices; }
  /** Stand des gesicherten Codes (Spec 8.3 „Stand anzeigen“); `null`, wenn keiner bekannt ist. */
  codeStand(): number | null { return this.currentCodeStand; }

  /** Setzt eine geöffnete Tabelle ein (Zustand `ready`). Die Tabelle ist unveränderlich; wer vereinigt, übergibt die neue Fassung. */
  open(table: PlaceholderTable, info: OpenInfo = {}): void {
    this.current = table;
    this.currentState = "ready";
    this.currentReason = null;
    this.currentStand = info.stand ?? null;
    this.currentLanguage = info.language ?? this.currentLanguage;
    this.currentDevices = info.devices ?? [];
    this.currentCodeStand = info.codeStand ?? null;
  }

  /** Sperrt: die Tabelle verlässt den Speicher, der Grund bleibt für die Anzeige. `devices` sind die Dateien, die angekommen sind (alle ungeöffnet),
   *  damit „Geräte und Schlüssel“ auch im gesperrten Zustand zeigt, was im Ordner liegt. */
  lock(reason: LockReason, devices: readonly DeviceView[] = []): void {
    this.current = null;
    this.currentState = "locked";
    this.currentReason = reason;
    this.currentDevices = devices;
    this.currentCodeStand = null;
  }

  /** Zurück auf „nicht eingerichtet“ (nach Vergessen des Schlüssels auf diesem Gerät, Aufgabe 12). */
  reset(): void {
    this.current = null;
    this.currentState = "not-set-up";
    this.currentReason = null;
    this.currentStand = null;
    this.currentDevices = [];
    this.currentCodeStand = null;
  }
}
