import { Plugin, getLanguage } from "obsidian";
import "./i18n/strings";
import { loadSettings, type PseudonymizerSettings } from "./core/settings";
import { pickLang, setLang } from "./vendor/kit/i18n";
import { createDeviceState, type DeviceState } from "./obsidian/device";
import { PseudonymizerSettingTab } from "./obsidian/settings-tab";

function safeGetLanguage(): string | null {
  try { return getLanguage(); } catch { return null; }
}

export default class PseudonymizerPlugin extends Plugin {
  settings: PseudonymizerSettings = loadSettings(null);
  device!: DeviceState;

  async onload(): Promise<void> {
    setLang(pickLang(safeGetLanguage()));
    this.settings = loadSettings(await this.loadData());
    this.device = createDeviceState(this.app);
    this.addSettingTab(new PseudonymizerSettingTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Ob der Ordner der Tabelle nicht mehr frei änderbar ist, weil die Tabelle eingerichtet ist.
   *  Bis das Einrichten (Aufgabe 12) den Zustand kennt, ist der Ordner frei. */
  folderLocked(): boolean {
    return false;
  }
}
