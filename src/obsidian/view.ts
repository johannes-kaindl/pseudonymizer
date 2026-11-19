import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { VIEW_TABS, VIEW_TYPE_PSEUDONYMIZER, stateIndicator, type CommandId, type ViewTab } from "../core/commands";
import type { PluginState } from "../core/status";
import { t } from "../vendor/kit/i18n";
import { buildHubInto, type HubController, type HubPanel } from "../vendor/kit-obsidian/hub";
import { buildStatus, paintStatus } from "../vendor/kit-obsidian/status-indicator";

/** Was die Ansicht vom Plugin braucht (`PseudonymizerPlugin` erfüllt es über Adapter in `main.ts`). */
export interface ViewHost {
  state(): PluginState;
  run(id: CommandId): void;
  onChange(cb: () => void): () => void;
}

const EMPTY_KEY: Record<ViewTab, string> = {
  persons: "view.empty.persons",
  exceptions: "view.empty.exceptions",
  devices: "view.empty.devices",
};

/** Ein Reiter: Zustand oben als Status-Indikator, darunter ein Leerzustand. Der Inhalt der Reiter folgt in den Aufgaben 12 bis 15. */
class TabPanel implements HubPanel<ViewTab> {
  private container: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
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
    if (!c) return;
    c.empty();
    c.addClass("pseu-panel");
    const state = this.host.state();

    const ind = stateIndicator(state);
    paintStatus(buildStatus(c), ind.phase, t(ind.textKey));

    const empty = c.createDiv({ cls: "pseu-empty" });
    if (state === "ready") {
      empty.createDiv({ text: t(EMPTY_KEY[this.tab.id]) });
      return;
    }
    empty.createDiv({ text: t(state === "locked" ? "view.empty.locked" : "view.empty.notSetUp") });
    const actions = empty.createDiv({ cls: "pseu-empty-actions" });
    // „Einrichten“ und „Code eingeben“ sind gleichwertig (Spec 9): kein `mod-cta`, beide gleich gewichtet.
    if (state === "not-set-up") this.button(actions, t("view.action.setUp"), "set-up");
    this.button(actions, t("view.action.enterCode"), "enter-recovery-code");
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
