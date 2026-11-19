import { Platform } from "obsidian";
import type { App } from "obsidian";
import { DEVICE_KEY_PREFIX } from "../core/constants";

export const KEY_SHOW_PLAINTEXT = `${DEVICE_KEY_PREFIX}show-plaintext`;
export const KEY_DEVICE_NAME = `${DEVICE_KEY_PREFIX}device-name`;
export const KEY_REPLACE_PENDING = `${DEVICE_KEY_PREFIX}replace-pending`;

export interface DeviceState {
  /** Klartext zeigen: je Gerät, nicht synchronisiert (Spec 8.6, Setzung 4). Ohne gespeicherten Wert an. */
  readonly showPlaintext: boolean;
  setShowPlaintext(on: boolean): void;
  /** Lesbarer Name für „Geräte und Schlüssel“; ohne gespeicherten Wert `Desktop-xxxx` oder `Mobile-xxxx`, danach stabil. */
  readonly deviceName: string;
  setDeviceName(name: string): void;
  /** Marke „Schlüssel ersetzen läuft“: die Kennung der alten Kette (hex), solange die Abschlussdatei liegt und der neue Schlüssel noch nicht abgelegt ist; sonst `null`. Nur die Heilung der eigenen Abschlussdatei liest sie. */
  readonly replacePending: string | null;
  setReplacePending(chainId: string | null): void;
}

type RandomFill = (array: Uint16Array) => Uint16Array;

/** Geräteeigene Werte: nur im lokalen Speicher von Obsidian, nie in `data.json` (sie wird mitsynchronisiert, Spec 8.2). */
export function createDeviceState(app: App, getRandomValues: RandomFill = (a) => crypto.getRandomValues(a)): DeviceState {
  const read = (key: string): unknown => { try { return app.loadLocalStorage(key); } catch { return null; } };
  const write = (key: string, value: unknown): void => { try { app.saveLocalStorage(key, value); } catch { /* ohne Speicher gilt der Vorgabewert */ } };
  const suffix = (): string => getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, "0");
  return {
    get showPlaintext(): boolean {
      // Als Text gespeichert: Obsidian verwirft `false` beim Speichern (gemessen in filename-sanitizer, 1.15.1), „aus“ ginge verloren und der Vorgabewert „an“ käme zurück.
      return read(KEY_SHOW_PLAINTEXT) !== "off";
    },
    setShowPlaintext: (on) => { write(KEY_SHOW_PLAINTEXT, on ? "on" : "off"); },
    get deviceName(): string {
      const v = read(KEY_DEVICE_NAME);
      if (typeof v === "string" && v.trim() !== "") return v;
      const generated = `${Platform.isMobile ? "Mobile" : "Desktop"}-${suffix()}`;
      write(KEY_DEVICE_NAME, generated);
      return generated;
    },
    setDeviceName: (name) => { write(KEY_DEVICE_NAME, name.trim() === "" ? null : name.trim()); },
    get replacePending(): string | null {
      const v = read(KEY_REPLACE_PENDING);
      return typeof v === "string" && v !== "" ? v : null;
    },
    // Als Text gespeichert, nie als Boolean (siehe oben); `null` löscht.
    setReplacePending: (chainId) => { write(KEY_REPLACE_PENDING, chainId); },
  };
}
