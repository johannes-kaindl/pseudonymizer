import { Notice, Plugin, getLanguage } from "obsidian";
import "./i18n/strings";
import { createApi } from "./core/api";
import type { Engine } from "./core/engine";
import type { PluginState } from "./core/status";
import type { CommandId, ViewTab } from "./core/commands";
import { VIEW_TYPE_PSEUDONYMIZER } from "./core/commands";
import { DEVICE_KEY_PREFIX } from "./core/constants";
import { buildDevicesModel, type DevicesModel } from "./core/devices-view";
import { MemoryTable } from "./core/memory-table";
import { loadSettings, type PseudonymizerSettings } from "./core/settings";
import { pickLang, setLang, t } from "./vendor/kit/i18n";
import { createDeviceFiles, defaultDeviceFilePorts, loadOrCreateDeviceId } from "./vendor/kit-obsidian/device-files";
import { obsidianSecretStore } from "./vendor/kit-obsidian/secrets";
import type { PseudonymizerApi } from "./vendor/kit/pseudonymizer-source";
import { PseudonymizerEngine } from "./obsidian/engine";
import { createReviewFn } from "./obsidian/review-modal";
import { registerCommands, runCommand } from "./obsidian/commands";
import { createDeviceState, type DeviceState } from "./obsidian/device";
import { createKeyStore, type KeyStore } from "./obsidian/key-store";
import { runForget } from "./obsidian/forget";
import { createPersonsApi, type PersonsApi } from "./obsidian/persons-actions";
import { createPersonsUi } from "./obsidian/persons-ui";
import { runRemoveDevice, runReplaceKey, type KeyActionsHost } from "./obsidian/key-actions";
import { createKeyActionsUi } from "./obsidian/key-actions-ui";
import { pseudonymizeNote, pseudonymizeSelection, type NoteHost } from "./obsidian/note-actions";
import { noteHostPorts } from "./obsidian/note-actions-ui";
import { runEnterCode, runSetUp, runShowCode, type SetupHost } from "./obsidian/setup";
import { createSetupUi } from "./obsidian/setup-ui";
import { createTableStore, type FileProblem, type TableStore } from "./obsidian/table-store";
import { createPluginStatusBar, type PluginStatusBar } from "./obsidian/status-bar";
import { registerCopyHandlers } from "./obsidian/copy";
import { setUpReading, swapOptions, type ReadingHandle } from "./obsidian/reading";
import { setUpLivePreview } from "./obsidian/live-preview";
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
  engine: Engine = new PseudonymizerEngine(this.memory, () => this.tableStore, { rules: () => this.settings.rules, review: (candidates, ctx) => createReviewFn(this.app)(candidates, ctx) });
  /** Öffnet, vereinigt und schreibt die Gerätedateien (Aufgabe 11); `null`, solange sich keine Geräte-ID festhalten lässt. */
  tableStore: TableStore | null = null;
  /** Der Schlüssel dieses Geräts im Schlüsselbund; angelegt beim Laden. */
  keys!: KeyStore;
  private deviceId = "";
  private stopWatching: (() => void) | null = null;
  private tablesFolder: string | null = null;
  private statusBar: PluginStatusBar | null = null;
  /** Die Lesesicht: Postprozessor und Auffrischen (Aufgabe 16); `setUpLivePreview` hängt die Live Preview über `onRefresh` an (Aufgabe 17). */
  reading!: ReadingHandle;
  private readonly changeListeners = new Set<() => void>();

  async onload(): Promise<void> {
    setLang(pickLang(safeGetLanguage()));
    this.settings = loadSettings(await this.loadData());
    this.device = createDeviceState(this.app);
    this.keys = createKeyStore(obsidianSecretStore(this.app));
    this.api = createApi(() => this.engine);
    this.registerView(VIEW_TYPE_PSEUDONYMIZER, (leaf) => new PseudonymizerView(leaf, {
      state: () => this.state(),
      run: (id) => { this.run(id); },
      onChange: (cb) => this.onChange(cb),
      lockReason: () => this.memory.reason(),
      folder: () => this.settings.folder,
      devices: () => this.devicesModel(),
      deviceName: () => this.device.deviceName,
      setDeviceName: (name) => { this.setDeviceName(name); },
      removeDevice: (deviceId) => { void this.runRemoveDevice(deviceId); },
      persons: this.persons(),
    }));
    registerCommands(this, this);
    // Einblenden in der Lesesicht und Kopieren (Spec 8.6): ein Postprozessor, ein Kopier-Handler je Fenster, Auffrischen bei jeder Änderung von Schalter, Zustand und Tabelle.
    const swap = swapOptions(this.memory, () => this.device.showPlaintext);
    this.reading = setUpReading(this, { app: this.app, options: swap, onChange: (cb) => this.onChange(cb) });
    registerCopyHandlers(this, this.app, { options: swap, copyMode: () => this.settings.copyMode });
    // Einblenden in Live Preview (Aufgabe 17): dieselben Optionen; das Auffrischen der Lesesicht zeichnet auch die Editoren neu (Kit-Kopf, B4).
    setUpLivePreview(this, this.reading, { app: this.app, options: swap, copyMode: () => this.settings.copyMode });
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
    this.reading.dispose();
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
    this.deviceId = deviceId;
    const ports = defaultDeviceFilePorts(this.app);
    const folder = this.settings.folder;
    const files = createDeviceFiles({ folder, extension: DEVICE_FILE_EXTENSION, deviceId, ports });
    const store = createTableStore({
      files,
      closingFiles: (id) => createDeviceFiles({ folder, extension: DEVICE_FILE_EXTENSION, deviceId: id, ports }),
      keys: this.keys,
      memory: this.memory,
      deviceName: () => this.device.deviceName,
      replacePending: { read: () => this.device.replacePending, write: (chainId) => { this.device.setReplacePending(chainId); } },
      defaultLanguage: () => this.defaultPlaceholderLanguage(),
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

  /** Ob der Ordner der Tabelle nicht mehr frei änderbar ist, weil dieses Gerät eingerichtet ist: ein Schlüssel liegt im Schlüsselbund (auch ein beschädigter und auch dann,
   *  wenn der Ordner gerade nichts hergibt; dann ist der Ordner ja der Ausweg). Ohne Schlüssel ist der Ordner frei. */
  folderLocked(): boolean {
    return this.keys.read() !== null;
  }

  /** Sprache der Platzhalter, wenn noch keine Gerätedatei eine nennt: nach der Sprache von Obsidian. */
  private defaultPlaceholderLanguage(): "de" | "en" {
    return safeGetLanguage()?.startsWith("de") === true ? "de" : "en";
  }

  /** Das Modell für den Reiter „Geräte und Schlüssel“. */
  devicesModel(): DevicesModel {
    return buildDevicesModel({
      state: this.state(),
      reason: this.memory.reason(),
      stand: this.memory.stand(),
      devices: this.memory.devices(),
      ownDeviceId: this.deviceId,
      problems: this.tableStore?.problems() ?? [],
      codeStand: this.memory.codeStand(),
      table: this.memory.table(),
    });
  }

  /** Speichert den Gerätenamen und schreibt ihn sofort in die eigene Gerätedatei (gesperrt oder nicht eingerichtet wird nichts geschrieben; der Name gilt dann ab dem nächsten Schreiben). */
  private setDeviceName(name: string): void {
    this.device.setDeviceName(name);
    void (this.tableStore?.persist() ?? Promise.resolve()).then(() => { this.emitChange(); });
  }

  /** Die Abläufe für Einrichten, Code eingeben und Code anzeigen brauchen den Baustein der Gerätedateien; ohne ihn (keine Geräte-ID) sagt eine Meldung, dass es nicht geht. */
  private setupHost(): SetupHost | null {
    const store = this.tableStore;
    if (store === null) { new Notice(t("notice.failed")); return null; }
    return {
      store,
      memory: this.memory,
      keys: this.keys,
      ui: createSetupUi(this.app, () => this.settings.folder),
      folder: () => this.settings.folder,
      defaultLanguage: () => this.defaultPlaceholderLanguage(),
      changed: () => { this.emitChange(); },
    };
  }

  /** Die Abläufe Vergessen, Schlüssel ersetzen und Gerät entfernen brauchen ebenfalls den Baustein der Gerätedateien. */
  private keyActionsHost(): KeyActionsHost | null {
    const store = this.tableStore;
    if (store === null) { new Notice(t("notice.failed")); return null; }
    return { store, memory: this.memory, ownDeviceId: () => this.deviceId, ui: createKeyActionsUi(this.app), changed: () => { this.emitChange(); } };
  }

  /** Die Handlungen der Ansicht Personen und Ausnahmen: Schreiben über `persist` des Bausteins der Gerätedateien (dieselbe Warteschlange wie `engine.persist`), Vergessen über den vorhandenen Ablauf. */
  private persons(): PersonsApi {
    return createPersonsApi({
      memory: this.memory,
      persist: (change) => this.tableStore?.persist(change) ?? Promise.resolve({ error: "not-ready" }),
      forget: async (id) => { const h = this.keyActionsHost(); if (h !== null) await runForget(h, id); },
      ui: createPersonsUi(this.app),
      changed: () => { this.emitChange(); },
    });
  }

  /** Die Befehle für Auswahl und Notiz: Schreiben der Tabelle über den Baustein der Gerätedateien (Warteschlange), die Notiz über die Schreib-Ports des Kits. */
  private noteHost(): NoteHost {
    return {
      memory: this.memory,
      api: this.api,
      persist: (change) => this.tableStore?.persist(change) ?? Promise.resolve({ error: "not-ready" }),
      changed: () => { this.emitChange(); },
      ...noteHostPorts(this.app),
    };
  }

  async runPseudonymizeSelection(): Promise<void> { await pseudonymizeSelection(this.noteHost()); }
  async runPseudonymizeNote(): Promise<void> { await pseudonymizeNote(this.noteHost()); }
  async runForget(): Promise<void> { const h = this.keyActionsHost(); if (h !== null) await runForget(h); }
  async runReplaceKey(): Promise<void> { const h = this.keyActionsHost(); if (h !== null) await runReplaceKey(h); }
  async runRemoveDevice(deviceId: string): Promise<void> { const h = this.keyActionsHost(); if (h !== null) await runRemoveDevice(h, deviceId); }
  async runSetUp(): Promise<void> { const h = this.setupHost(); if (h !== null) await runSetUp(h); }
  async runEnterCode(): Promise<void> { const h = this.setupHost(); if (h !== null) await runEnterCode(h); }
  async runShowCode(): Promise<void> { const h = this.setupHost(); if (h !== null) await runShowCode(h); }
}
