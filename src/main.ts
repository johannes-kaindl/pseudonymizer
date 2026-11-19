import { Plugin, getLanguage } from "obsidian";
import "./i18n/strings";
import { createApi } from "./core/api";
import type { Engine } from "./core/engine";
import type { PluginState } from "./core/status";
import type { CommandId, ViewTab } from "./core/commands";
import { VIEW_TYPE_PSEUDONYMIZER } from "./core/commands";
import { loadSettings, type PseudonymizerSettings } from "./core/settings";
import { pickLang, setLang } from "./vendor/kit/i18n";
import type { PseudonymizerApi } from "./vendor/kit/pseudonymizer-source";
import { registerCommands, runCommand } from "./obsidian/commands";
import { createDeviceState, type DeviceState } from "./obsidian/device";
import { createPluginStatusBar, type PluginStatusBar } from "./obsidian/status-bar";
import { StubEngine } from "./obsidian/stub-engine";
import { PseudonymizerView } from "./obsidian/view";
import { PseudonymizerSettingTab } from "./obsidian/settings-tab";

function safeGetLanguage(): string | null {
  try { return getLanguage(); } catch { return null; }
}

export default class PseudonymizerPlugin extends Plugin {
  settings: PseudonymizerSettings = loadSettings(null);
  device!: DeviceState;
  /** Öffentliche Plugin-API v1 (`app.plugins.plugins.pseudonymizer.api`). */
  api!: PseudonymizerApi;
  /** Die Maschine hinter der API; bis zu den Aufgaben 9 und 11 die Platzhalter-Engine. */
  engine: Engine = new StubEngine();
  private statusBar: PluginStatusBar | null = null;
  private readonly changeListeners = new Set<() => void>();

  async onload(): Promise<void> {
    setLang(pickLang(safeGetLanguage()));
    this.settings = loadSettings(await this.loadData());
    this.device = createDeviceState(this.app);
    this.api = createApi(() => this.engine);
    this.registerView(VIEW_TYPE_PSEUDONYMIZER, (leaf) => new PseudonymizerView(leaf, {
      state: () => this.state(),
      run: (id) => { this.run(id); },
      onChange: (cb) => this.onChange(cb),
    }));
    registerCommands(this, this);
    this.addSettingTab(new PseudonymizerSettingTab(this.app, this));
    this.statusBar = createPluginStatusBar({
      plugin: this,
      visible: this.settings.statusBar,
      state: () => this.state(),
      showPlaintext: () => this.device.showPlaintext,
      run: (id) => { this.run(id); },
      onChange: (cb) => this.onChange(cb),
    });
  }

  onunload(): void {
    this.statusBar?.dispose();
    this.statusBar = null;
    this.changeListeners.clear();
  }

  /** Zustand für Statusleiste, Ansicht und Befehle: immer über die API, die nie wirft. */
  state(): PluginState {
    return this.api.status().state;
  }

  /** Führt einen Befehl aus, wie die Palette es täte (Statusleiste und Ansicht rufen das). */
  run(id: CommandId): void {
    runCommand(this, id);
  }

  /** Meldet sich für Änderungen von Zustand oder Schalter an; die Rückgabe meldet wieder ab. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => { this.changeListeners.delete(cb); };
  }

  emitChange(): void {
    for (const cb of [...this.changeListeners]) cb();
  }

  /** Öffnet die eine Ansicht (legt sie an, wenn es sie noch nicht gibt) und wählt den Reiter. */
  async openView(tab: ViewTab = "persons"): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PSEUDONYMIZER)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_PSEUDONYMIZER, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof PseudonymizerView) leaf.view.showTab(tab);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.statusBar?.item.setVisible(this.settings.statusBar);
    this.emitChange();
  }

  /** Ob der Ordner der Tabelle nicht mehr frei änderbar ist, weil die Tabelle eingerichtet ist.
   *  Bis das Einrichten (Aufgabe 12) den Zustand kennt, ist der Ordner frei. */
  folderLocked(): boolean {
    return false;
  }
}
