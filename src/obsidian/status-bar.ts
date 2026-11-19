import { setIcon } from "obsidian";
import type { CommandId } from "../core/commands";
import { statusEntryModel } from "../core/commands";
import type { PluginState } from "../core/status";
import { t } from "../vendor/kit/i18n";
import { createStatusBarItem, type StatusBarHost, type StatusBarItemHandle } from "../vendor/kit-obsidian/status-bar-item";

export interface PluginStatusBarDeps {
  plugin: StatusBarHost;
  /** Schalter aus den Einstellungen (Vorgabe an). */
  visible: boolean;
  state(): PluginState;
  showPlaintext(): boolean;
  /** Ein Klick führt einen Befehl aus (Umschalten, Code eingeben, Einrichten). */
  run(id: CommandId): void;
  /** Meldet Änderungen von Zustand oder Schalter; die Rückgabe meldet wieder ab. */
  onChange(cb: () => void): () => void;
}

export interface PluginStatusBar { item: StatusBarItemHandle; dispose(): void }

/** Zustands-Knopf in der Statusleiste (UI-STANDARD §8): ein echter `<button>` (Tastatur und Fokus von selbst), Text UND Symbol zeigen den Ist-Zustand,
 *  `aria-pressed` nur dort, wo er umschaltet. Der Name für Hilfsmittel beginnt mit dem sichtbaren Text und hängt an, was ein Klick tut. */
export function createPluginStatusBar(deps: PluginStatusBarDeps): PluginStatusBar {
  let button: HTMLElement | null = null;
  const model = () => statusEntryModel(deps.state(), deps.showPlaintext());
  const item = createStatusBarItem({
    plugin: deps.plugin,
    visible: deps.visible,
    cls: "pseu-status",
    onCreate: (el) => {
      const b = el.createEl("button", { cls: "pseu-status-btn", attr: { type: "button" } });
      b.addEventListener("click", () => { deps.run(model().click); });
      button = b;
    },
    render: () => {
      const b = button;
      if (!b) return;
      const m = model();
      b.empty();
      setIcon(b.createSpan({ cls: "pseu-status-icon" }), m.icon);
      b.createSpan({ cls: "pseu-status-label", text: t(m.labelKey) });
      if (m.pressed === null) b.removeAttribute("aria-pressed");
      else b.setAttribute("aria-pressed", String(m.pressed));
      b.setAttribute("aria-label", `${t(m.labelKey)} — ${t(m.hintKey)}`);
    },
  });
  const unsubscribe = deps.onChange(() => { item.refresh(); });
  return { item, dispose: () => { unsubscribe(); item.destroy(); } };
}
