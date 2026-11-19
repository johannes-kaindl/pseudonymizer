import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { VIEW_TABS, VIEW_TYPE_PSEUDONYMIZER, stateIndicator, type CommandId, type ViewTab } from "../core/commands";
import type { DevicesModel } from "../core/devices-view";
import type { LockReason, PluginState } from "../core/status";
import { t } from "../vendor/kit/i18n";
import { buildHubInto, type HubController, type HubPanel } from "../vendor/kit-obsidian/hub";
import { buildStatus, paintStatus } from "../vendor/kit-obsidian/status-indicator";
import { renderDeviceFiles, renderDevices } from "./devices-panel";

/** Was die Ansicht vom Plugin braucht (`PseudonymizerPlugin` erfüllt es über Adapter in `main.ts`). */
export interface ViewHost {
  state(): PluginState;
  run(id: CommandId): void;
  onChange(cb: () => void): () => void;
  /** Warum das Plugin gesperrt ist (`null`, wenn nicht gesperrt). */
  lockReason(): LockReason | null;
  /** Der Ordner der Tabelle aus den Einstellungen. */
  folder(): string;
  /** Das Modell für „Geräte und Schlüssel“. */
  devices(): DevicesModel;
  deviceName(): string;
  setDeviceName(name: string): void;
  /** Entfernt ein fremdes Gerät (Dialog, Übernehmen, Löschen). */
  removeDevice(deviceId: string): void;
}

const EMPTY_KEY: Record<Exclude<ViewTab, "devices">, string> = {
  persons: "view.empty.persons",
  exceptions: "view.empty.exceptions",
};

const LOCK_REASONS: readonly LockReason[] = ["no-key", "table-missing", "foreign-chain", "key-opens-nothing", "unreadable", "key-corrupt", "storage-failed", "key-replaced"];

/** Ein Reiter: Zustand oben als Status-Indikator, darunter der Inhalt. „Geräte und Schlüssel“ ist seit Aufgabe 12 gefüllt, Personen und Ausnahmen zeigen bis Aufgabe 15 und 18 einen Leerzustand. */
class TabPanel implements HubPanel<ViewTab> {
  private container: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Solange das Namensfeld den Fokus hat, malt eine Änderung die Seite nicht neu (sonst ginge die Eingabe verloren). */
  private editing = false;
  constructor(private readonly tab: (typeof VIEW_TABS)[number], private readonly host: ViewHost) {}

  get id(): ViewTab { return this.tab.id; }
  get icon(): string { return this.tab.icon; }
  get label(): string { return t(this.tab.labelKey); }

  mount(container: HTMLElement): void {
    this.container = container;
    this.unsubscribe = this.host.onChange(() => { this.render(); });
    this.render();
  }

  onShow(): void { this.render(); }

  destroy(): void { this.unsubscribe?.(); this.unsubscribe = null; }

  private render(): void {
    const c = this.container;
    if (!c || this.editing) return;
    c.empty();
    c.addClass("pseu-panel");
    const state = this.host.state();

    const ind = stateIndicator(state);
    paintStatus(buildStatus(c), ind.phase, t(ind.textKey));

    if (state === "ready") {
      if (this.tab.id === "devices") renderDevices(c, this.host, (on) => { this.editing = on; if (!on) this.render(); });
      else c.createDiv({ cls: "pseu-empty" }).createDiv({ text: t(EMPTY_KEY[this.tab.id]) });
      return;
    }
    const empty = c.createDiv({ cls: "pseu-empty" });
    const actions = (): HTMLElement => empty.createDiv({ cls: "pseu-empty-actions" });
    if (state === "locked") {
      // Der Ausweg aus `locked`: Hinweis auf die Ordner-Einstellung und „Code eingeben“; nie „neu einrichten“ als Vorgabe (Plan Aufgabe 12).
      const reason = this.host.lockReason();
      const key = reason !== null && LOCK_REASONS.includes(reason) ? `view.locked.${reason}` : "view.empty.locked";
      empty.createDiv({ text: t(key, this.host.folder()) });
      this.button(actions(), t("view.action.enterCode"), "enter-recovery-code");
      if (this.tab.id === "devices") renderDeviceFiles(c, this.host.devices());
      return;
    }
    empty.createDiv({ text: t("view.empty.notSetUp") });
    const box = actions();
    // „Einrichten“ und „Code eingeben“ sind gleichwertig (Spec 9): kein `mod-cta`, beide gleich gewichtet.
    this.button(box, t("view.action.setUp"), "set-up");
    this.button(box, t("view.action.enterCode"), "enter-recovery-code");
  }

  private button(parent: HTMLElement, text: string, id: CommandId): void {
    const b = parent.createEl("button", { text, attr: { type: "button" } });
    b.addEventListener("click", () => { this.host.run(id); });
  }
}

/** Genau eine Ansicht mit drei Reitern über die Hub-Tab-Leiste des Kits (Spec 8.9). */
export class PseudonymizerView extends ItemView {
  private hub: HubController<ViewTab> | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly host: ViewHost) { super(leaf); }

  getViewType(): string { return VIEW_TYPE_PSEUDONYMIZER; }
  getDisplayText(): string { return t("view.title"); }
  getIcon(): string { return "users"; }

  onOpen(): Promise<void> {
    this.contentEl.addClass("pseu-root");
    this.hub = buildHubInto<ViewTab>(this.contentEl, VIEW_TABS.map((tab) => new TabPanel(tab, this.host)), "persons");
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.hub?.destroy();
    this.hub = null;
    return Promise.resolve();
  }

  showTab(tab: ViewTab): void { this.hub?.setTab(tab); }
}
