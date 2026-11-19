import { MarkdownView, Notice } from "obsidian";
import type { App, Editor } from "obsidian";
import { lookupOutcome, searchPlan, type LookupOutcome } from "../core/lookup";
import type { MemoryTable } from "../core/memory-table";
import { findPlaceholders, parsePlaceholder } from "../vendor/kit/placeholder";
import { t } from "../vendor/kit/i18n";
import { promptText, type PromptTextOptions } from "../vendor/kit-obsidian/prompt-text";
import { openGlobalSearch } from "./global-search";
import { LookupModal } from "./lookup-modal";

/** Was die beiden Befehle vom Plugin brauchen. */
export interface LookupHost { app: App; memory: MemoryTable }

/** Die Stellen, an denen die Befehle die Oberfläche berühren; Tests tauschen sie. */
export interface LookupUi {
  editor(app: App): Editor | null;
  prompt(app: App, opts: PromptTextOptions): Promise<string | null>;
  show(app: App, outcome: LookupOutcome): void;
  openSearch(app: App, query: string): boolean;
}

const DEFAULT_UI: LookupUi = {
  editor: (app) => app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null,
  prompt: (app, opts) => promptText(app, opts),
  show: (app, outcome) => { new LookupModal(app, outcome).open(); },
  openSearch: (app, query) => openGlobalSearch(app, query),
};

/** Der Platzhalter in der Auswahl (der erste) oder unter dem Cursor, so geschrieben, wie er im Text steht; sonst `null`. */
export function placeholderTextAt(editor: Editor): string | null {
  const selection = editor.getSelection();
  if (selection !== "") return findPlaceholders(selection)[0]?.raw ?? null;
  const { line, ch } = editor.getCursor();
  return findPlaceholders(editor.getLine(line)).find((p) => p.start <= ch && ch <= p.end)?.raw ?? null;
}

/** Sagt, warum ohne lesbare Tabelle nichts geht; `true`, wenn eine da ist. */
function haveTable(memory: MemoryTable): boolean {
  if (memory.table() !== null) return true;
  new Notice(memory.state() === "locked" ? t("notice.locked") : t("notice.notSetUp"));
  return false;
}

/** Ein Fehler im Befehl heißt „hat nicht geklappt“: der Text der Ausnahme könnte Klartext tragen und bleibt weg. */
function failed(): void {
  new Notice(t("notice.failed"));
}

const lookupError = (value: string): string | null => (parsePlaceholder(value.trim()) === null ? t("notice.lookup.invalid") : null);

/** Befehl „Platzhalter nachschlagen“ (Spec 8.9): der Platzhalter am Cursor oder in der Auswahl, sonst die Eingabe; das Ergebnis im Fenster. */
export async function lookupPlaceholderCommand(host: LookupHost, ui: LookupUi = DEFAULT_UI): Promise<void> {
  try {
    if (!haveTable(host.memory)) return;
    const editor = ui.editor(host.app);
    let text = editor === null ? null : placeholderTextAt(editor);
    if (text === null) {
      text = await ui.prompt(host.app, {
        title: t("modal.lookup.title"),
        message: t("modal.lookup.message"),
        placeholder: t("modal.lookup.placeholder"),
        okLabel: t("modal.lookup.ok"),
        cancelLabel: t("modal.cancel"),
        validate: lookupError,
      });
      if (text === null) return;
    }
    // Die Tabelle erst jetzt lesen: während der Eingabe kann sie sich geändert haben oder gesperrt worden sein.
    const table = host.memory.table();
    if (table === null) { haveTable(host.memory); return; }
    const outcome = lookupOutcome(table, text.trim(), host.memory.language());
    if (outcome.status === "invalid") new Notice(t("notice.lookup.invalid"));
    else ui.show(host.app, outcome);
  } catch {
    failed();
  }
}

/** Befehl „Suchen mit Klarnamen“ (Spec 8.9): Name oder Wert eingeben, Obsidians Suche öffnet mit den Kennungen aller zusammengeführten Einträge.
 *  Der Name selbst geht nie in die Suche, und keine Meldung wiederholt ihn. */
export async function searchPlaintextCommand(host: LookupHost, ui: LookupUi = DEFAULT_UI): Promise<void> {
  try {
    if (!haveTable(host.memory)) return;
    const input = await ui.prompt(host.app, {
      title: t("modal.search.title"),
      message: t("modal.search.message"),
      placeholder: t("modal.search.placeholder"),
      okLabel: t("modal.search.ok"),
      cancelLabel: t("modal.cancel"),
    });
    if (input === null) return;
    const table = host.memory.table();
    if (table === null) { haveTable(host.memory); return; }
    const plan = searchPlan(table, input);
    if (plan === null) { new Notice(t("notice.search.noMatch")); return; }
    if (!ui.openSearch(host.app, plan.query)) new Notice(t("notice.search.unavailable", plan.query));
  } catch {
    failed();
  }
}
