import type { CopyMode } from "./settings";
import type { PluginState } from "./status";

export type CommandId =
  | "toggle-plaintext" | "pseudonymize-selection" | "pseudonymize-note" | "search-plaintext"
  | "lookup-placeholder" | "copy-plaintext" | "copy-placeholders" | "forget-person"
  | "show-recovery-code" | "enter-recovery-code" | "replace-key" | "open-view" | "set-up";

/** Was ein Befehl voraussetzt: `ready` einen lesbaren Zustand, `editor` zusätzlich einen offenen Editor, `locked-or-ready` eine eingerichtete Tabelle
 *  (gesperrt oder bereit), `any` nichts. */
export interface CommandSpec { id: CommandId; nameKey: string; icon: string; needs: "ready" | "editor" | "any" | "locked-or-ready" }

export const VIEW_TYPE_PSEUDONYMIZER = "pseudonymizer-view";
export type ViewTab = "persons" | "exceptions" | "devices";

/** Die elf Befehle aus Spec 8.9, dazu `copy-placeholders` (Spec 8.6) und `set-up` (am Telefon gibt es keine Statusleiste). Symbole sind Lucide-Namen, gemessen im Bundle von Obsidian 1.14. */
export const COMMANDS: readonly CommandSpec[] = [
  { id: "toggle-plaintext", nameKey: "command.toggle-plaintext", icon: "eye", needs: "any" },
  { id: "pseudonymize-selection", nameKey: "command.pseudonymize-selection", icon: "replace", needs: "editor" },
  { id: "pseudonymize-note", nameKey: "command.pseudonymize-note", icon: "file-lock", needs: "ready" },
  { id: "search-plaintext", nameKey: "command.search-plaintext", icon: "user-search", needs: "ready" },
  { id: "lookup-placeholder", nameKey: "command.lookup-placeholder", icon: "book-user", needs: "ready" },
  { id: "copy-plaintext", nameKey: "command.copy-plaintext", icon: "clipboard-copy", needs: "ready" },
  { id: "copy-placeholders", nameKey: "command.copy-placeholders", icon: "copy", needs: "ready" },
  { id: "forget-person", nameKey: "command.forget-person", icon: "user-x", needs: "ready" },
  { id: "show-recovery-code", nameKey: "command.show-recovery-code", icon: "key-round", needs: "locked-or-ready" },
  { id: "enter-recovery-code", nameKey: "command.enter-recovery-code", icon: "key-square", needs: "any" },
  { id: "replace-key", nameKey: "command.replace-key", icon: "refresh-cw", needs: "locked-or-ready" },
  { id: "open-view", nameKey: "command.open-view", icon: "users", needs: "any" },
  { id: "set-up", nameKey: "command.set-up", icon: "shield-plus", needs: "any" },
];

export const VIEW_TABS: readonly { id: ViewTab; icon: string; labelKey: string }[] = [
  { id: "persons", icon: "users", labelKey: "view.tab.persons" },
  { id: "exceptions", icon: "list-x", labelKey: "view.tab.exceptions" },
  { id: "devices", icon: "monitor-smartphone", labelKey: "view.tab.devices" },
];

export type CommandGate = "run" | "hide" | "locked" | "not-set-up";

/** Ob ein Befehl läuft, aus der Palette verschwindet (`hide`: nicht anwendbar) oder mit Grund abgelehnt wird (`locked`, `not-set-up`; der Aufrufer sagt den Grund).
 *  Ein Zustand versteckt den Befehl nie, damit niemand vor einer leeren Palette steht, ohne zu wissen warum. */
export function commandGate(spec: CommandSpec, ctx: { state: PluginState; hasEditor: boolean; copyMode: CopyMode }): CommandGate {
  if (spec.id === "copy-placeholders" && ctx.copyMode !== "as-shown") return "hide";
  if (spec.needs === "editor" && !ctx.hasEditor) return "hide";
  if (spec.needs === "any") return "run";
  if (ctx.state === "not-set-up") return "not-set-up";
  if (spec.needs === "locked-or-ready") return "run";
  return ctx.state === "locked" ? "locked" : "run";
}

/** Was der Eintrag in der Statusleiste zeigt und tut. `pressed` gibt es nur, wo der Knopf wirklich umschaltet (`ready`); sonst ist er ein Weg zur Code-Eingabe oder zum Einrichten. */
export interface StatusEntryModel { labelKey: string; hintKey: string; icon: string; pressed: boolean | null; click: CommandId }

export function statusEntryModel(state: PluginState, showPlaintext: boolean): StatusEntryModel {
  if (state === "locked") return { labelKey: "statusBar.locked", hintKey: "statusBar.lockedHint", icon: "lock-keyhole", pressed: null, click: "enter-recovery-code" };
  if (state === "not-set-up") return { labelKey: "statusBar.notSetUp", hintKey: "statusBar.notSetUpHint", icon: "shield-plus", pressed: null, click: "set-up" };
  return showPlaintext
    ? { labelKey: "statusBar.on", hintKey: "statusBar.onHint", icon: "eye", pressed: true, click: "toggle-plaintext" }
    : { labelKey: "statusBar.off", hintKey: "statusBar.offHint", icon: "eye-off", pressed: false, click: "toggle-plaintext" };
}

/** Zustand für den Status-Indikator der Ansicht: Phase (Form und Klasse, nie Farbe allein) und Textschlüssel. */
export function stateIndicator(state: PluginState): { phase: "idle" | "ok" | "warning"; textKey: string } {
  if (state === "ready") return { phase: "ok", textKey: "view.state.ready" };
  if (state === "locked") return { phase: "warning", textKey: "view.state.locked" };
  return { phase: "idle", textKey: "view.state.notSetUp" };
}
