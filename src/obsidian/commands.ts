import { MarkdownView, Notice } from "obsidian";
import type { App, Command, Plugin } from "obsidian";
import { COMMANDS, commandGate, type CommandGate, type CommandId, type CommandSpec, type ViewTab } from "../core/commands";
import type { MemoryTable } from "../core/memory-table";
import type { PseudonymizerSettings } from "../core/settings";
import type { PluginState } from "../core/status";
import { t } from "../vendor/kit/i18n";
import type { DeviceState } from "./device";
import { lookupPlaceholderCommand, searchPlaintextCommand } from "./lookup-commands";

/** Was die Befehle vom Plugin brauchen (`PseudonymizerPlugin` erfüllt es). */
export interface CommandHost {
  app: App;
  settings: PseudonymizerSettings;
  device: DeviceState;
  /** Die Tabelle im Arbeitsspeicher (Nachschlagen und Suchen lesen sie). */
  memory: MemoryTable;
  state(): PluginState;
  openView(tab?: ViewTab): Promise<void>;
  /** Sagt Statusleiste und Ansicht, dass sich etwas geändert hat. */
  emitChange(): void;
}

const notAvailable = (): void => { new Notice(t("notice.notAvailable")); };

/** Befehle, deren Funktion noch fehlt, zeigen die Notice „noch nicht verfügbar“; jede spätere Aufgabe ersetzt ihre Zeile. */
const HANDLERS: Record<CommandId, (host: CommandHost) => void> = {
  "toggle-plaintext": (h) => { h.device.setShowPlaintext(!h.device.showPlaintext); h.emitChange(); },
  "open-view": (h) => { void h.openView(); },
  "pseudonymize-selection": notAvailable,
  "pseudonymize-note": notAvailable,
  "search-plaintext": (h) => { void searchPlaintextCommand(h); },
  "lookup-placeholder": (h) => { void lookupPlaceholderCommand(h); },
  "copy-plaintext": notAvailable,
  "copy-placeholders": notAvailable,
  "forget-person": notAvailable,
  "show-recovery-code": notAvailable,
  "enter-recovery-code": notAvailable,
  "replace-key": notAvailable,
  "set-up": notAvailable,
};

function gateOf(host: CommandHost, spec: CommandSpec): CommandGate {
  const hasEditor = spec.needs === "editor" && host.app.workspace.getActiveViewOfType(MarkdownView)?.editor !== undefined;
  return commandGate(spec, { state: host.state(), hasEditor, copyMode: host.settings.copyMode });
}

/** Führt einen Befehl aus, wenn sein Tor offen ist; sonst sagt eine Notice den Grund. Statusleiste, Ansicht und Palette gehen alle hierdurch. */
export function runCommand(host: CommandHost, id: CommandId): void {
  const spec = COMMANDS.find((c) => c.id === id);
  if (!spec) return;
  const gate = gateOf(host, spec);
  if (gate === "locked") new Notice(t("notice.locked"));
  else if (gate === "not-set-up") new Notice(t("notice.notSetUp"));
  else if (gate === "run") HANDLERS[id](host);
}

/** Gemeinsamer Teil jedes Befehls: Symbol (damit er am Telefon erreichbar ist) und Tor. Die Palette versteckt nur, was nicht anwendbar ist (`hide`). */
function common(host: CommandHost, id: CommandId): Pick<Command, "icon" | "checkCallback"> {
  const spec = COMMANDS.find((c) => c.id === id);
  if (!spec) throw new Error(`unknown command ${id}`);
  return {
    icon: spec.icon,
    checkCallback: (checking: boolean): boolean => {
      if (checking) return gateOf(host, spec) !== "hide";
      if (gateOf(host, spec) === "hide") return false;
      runCommand(host, spec.id);
      return true;
    },
  };
}

/** Legt alle dreizehn Befehle an. Id und Namensschlüssel stehen je Befehl als Literal da, damit `tools/befehle_check.py` sie zählen kann;
 *  `tests/commands.test.ts` prüft, dass sie zu `COMMANDS` passen (Symbol und Tor kommen von dort). */
export function registerCommands(plugin: Pick<Plugin, "addCommand">, host: CommandHost): void {
  plugin.addCommand({ id: "toggle-plaintext", name: t("command.toggle-plaintext"), ...common(host, "toggle-plaintext") });
  plugin.addCommand({ id: "pseudonymize-selection", name: t("command.pseudonymize-selection"), ...common(host, "pseudonymize-selection") });
  plugin.addCommand({ id: "pseudonymize-note", name: t("command.pseudonymize-note"), ...common(host, "pseudonymize-note") });
  plugin.addCommand({ id: "search-plaintext", name: t("command.search-plaintext"), ...common(host, "search-plaintext") });
  plugin.addCommand({ id: "lookup-placeholder", name: t("command.lookup-placeholder"), ...common(host, "lookup-placeholder") });
  plugin.addCommand({ id: "copy-plaintext", name: t("command.copy-plaintext"), ...common(host, "copy-plaintext") });
  plugin.addCommand({ id: "copy-placeholders", name: t("command.copy-placeholders"), ...common(host, "copy-placeholders") });
  plugin.addCommand({ id: "forget-person", name: t("command.forget-person"), ...common(host, "forget-person") });
  plugin.addCommand({ id: "show-recovery-code", name: t("command.show-recovery-code"), ...common(host, "show-recovery-code") });
  plugin.addCommand({ id: "enter-recovery-code", name: t("command.enter-recovery-code"), ...common(host, "enter-recovery-code") });
  plugin.addCommand({ id: "replace-key", name: t("command.replace-key"), ...common(host, "replace-key") });
  plugin.addCommand({ id: "open-view", name: t("command.open-view"), ...common(host, "open-view") });
  plugin.addCommand({ id: "set-up", name: t("command.set-up"), ...common(host, "set-up") });
}
