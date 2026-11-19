import { Notice, Plugin, getLanguage } from "obsidian";
import "./i18n/strings";
import { createApi } from "./core/api";
import type { Engine } from "./core/engine";
import type { PluginState } from "./core/status";
import type { CommandId, ViewTab } from "./core/commands";
import { VIEW_TYPE_PSEUDONYMIZER } from "./core/commands";
import { DEVICE_KEY_PREFIX } from "./core/constants";
import { MemoryTable } from "./core/memory-table";
import { loadSettings, type PseudonymizerSettings } from "./core/settings";
import { pickLang, setLang, t } from "./vendor/kit/i18n";
import { createDeviceFiles, defaultDeviceFilePorts, loadOrCreateDeviceId } from "./vendor/kit-obsidian/device-files";
import { obsidianSecretStore } from "./vendor/kit-obsidian/secrets";
import type { PseudonymizerApi } from "./vendor/kit/pseudonymizer-source";
import { PseudonymizerEngine } from "./obsidian/engine";
import { registerCommands, runCommand } from "./obsidian/commands";
import { createDeviceState, type DeviceState } from "./obsidian/device";
import { createKeyStore } from "./obsidian/key-store";
import { createTableStore, type FileProblem, type TableStore } from "./obsidian/table-store";
import { createPluginStatusBar, type PluginStatusBar } from "./obsidian/status-bar";
import { PseudonymizerView } from "./obsidian/view";
import { PseudonymizerSettingTab } from "./obsidian/settings-tab";

/** Auffrischen spätestens jede Minute (Spec 8.2: eine Marke, die per Sync ankommt, wirkt binnen einer Minute). */
const REFRESH_MS = 60_000;
/** Endung der Gerätedatei (Etappe 0: Obsidian führt `.pseudo` als Datei wie `.md`). */
const DEVICE_FILE_EXTENSION = ".pseudo";

/** Eine Meldung je Problem, ohne Inhalt: Art und Name der Datei (die Geräte-ID), nie ein Wert aus der Tabelle (Spec 11.3). */
function announceProblem(p: FileProblem): void {
  const name = p.deviceId ?? p.path;
  switch (p.kind) {
    case "newer-format": new Notice(t("notice.file.newer", name)); break;
    case "own-set-aside": new Notice(t("notice.file.setAside")); break;
    case "write-failed": new Notice(t("notice.file.writeFailed")); break;
    case "key-write-failed": new Notice(t("notice.file.keyFailed")); break;
    default: new Notice(t("notice.file.unreadable", name));
  }
}

function safeGetLanguage(): string | null {
  try { return getLanguage(); } catch { return null; }
}

export default class PseudonymizerPlugin extends Plugin {
  settings: PseudonymizerSettings = loadSettings(null);
  device!: DeviceState;
  /** Öffentliche Plugin-API v1 (`app.plugins.plugins.pseudonymizer.api`). */
  api!: PseudonymizerApi;
  /** Die Tabelle im Arbeitsspeicher; die Gerätedateien füllen sie ab Aufgabe 11, bis dahin bleibt sie leer (`not-set-up`). */
  readonly memory = new MemoryTable();
  /** Die Maschine hinter der API (Aufgabe 9: zurücksetzen und erkennen; Aufgabe 11 öffnet und schreibt, Aufgabe 13 pseudonymisiert). */
  engine: Engine = new PseudonymizerEngine(this.memory, () => this.tableStore);
  /** Öffnet, vereinigt und schreibt die Gerätedateien (Aufgabe 11); `null`, solange sich keine Geräte-ID festhalten lässt. */
  tableStore: TableStore | null = null;
  private stopWatching: (() => void) | null = null;
  private tablesFolder: string | null = null;
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
    // Auffrischen: bei jedem Ereignis für eine Datei im Ordner (Watcher des Kits) und spätestens jede Minute über alle Dateien. Gemessen 2026-11-19 (Obsidian 1.15.1):
    // `.pseudo` ist ein TFile wie `.md`, create/modify/rename/delete feuern auch beim Schreiben von außen; ein Umbenennen von außen kommt als create plus delete.
    this.registerInterval(window.setInterval(() => { void this.refreshTables(); }, REFRESH_MS));
    this.app.workspace.onLayoutReady(() => { this.startTables(); });
  }

  onunload(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.tableStore = null;
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

  /** Legt den Baustein der Gerätedateien für den Ordner aus den Einstellungen an und liest zum ersten Mal. Ein Ordner, der nicht passt, ist kein Fehler: dann ist die Tabelle dort nicht da (`locked`/`table-missing`). */
  private startTables(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.tableStore = null;
    this.tablesFolder = this.settings.folder;
    const deviceId = loadOrCreateDeviceId(this.app, `${DEVICE_KEY_PREFIX}device-id`);
    if (deviceId === null) {
      this.memory.lock("storage-failed");
      this.emitChange();
      return;
    }
    const files = createDeviceFiles({ folder: this.settings.folder, extension: DEVICE_FILE_EXTENSION, deviceId, ports: defaultDeviceFilePorts(this.app) });
    const store = createTableStore({
      files,
      keys: createKeyStore(obsidianSecretStore(this.app)),
      memory: this.memory,
      deviceName: () => this.device.deviceName,
      defaultLanguage: () => (safeGetLanguage()?.startsWith("de") === true ? "de" : "en"),
      onProblem: (p) => { announceProblem(p); },
    });
    this.tableStore = store;
    this.stopWatching = store.watch(() => { this.emitChange(); });
    void this.refreshTables();
  }

  /** Liest die Gerätedateien neu (Zeitgeber, Start, Ordnerwechsel) und meldet die Änderung des Zustands. */
  async refreshTables(): Promise<void> {
    const store = this.tableStore;
    if (store === null) return;
    await store.refresh();
    this.emitChange();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.tablesFolder !== null && this.tablesFolder !== this.settings.folder) this.startTables();
    this.statusBar?.item.setVisible(this.settings.statusBar);
    this.emitChange();
  }

  /** Ob der Ordner der Tabelle nicht mehr frei änderbar ist, weil die Tabelle eingerichtet ist.
   *  Bis das Einrichten (Aufgabe 12) den Zustand kennt, ist der Ordner frei. */
  folderLocked(): boolean {
    return false;
  }
}
