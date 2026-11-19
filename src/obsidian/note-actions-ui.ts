import { MarkdownView, SuggestModal } from "obsidian";
import type { App } from "obsidian";
import { filterPersons, type PersonOption } from "../core/forget-plan";
import type { CandidateKind } from "../core/transform";
import { t } from "../vendor/kit/i18n";
import { askChoice } from "../vendor/kit-obsidian/choice-modal";
import { obsidianWritePorts } from "../vendor/kit-obsidian/write-ports";
import { noticeNotify, type NoteHost, type NoteUi, type OwnerPick, type SelectionInfo } from "./note-actions";

/** Fenster und Editor für „Auswahl pseudonymisieren“ und „Diese Notiz pseudonymisieren“. Der Klartext steht nur in diesen Fenstern, solange sie offen sind. */

const KINDS: readonly CandidateKind[] = ["person", "organisation", "mail", "phone", "address", "iban"];

/** Ein Eintrag der Wahl: „neu“ (Beschriftung nach der Art) oder ein vorhandener. */
type OwnerRow = { kind: "new"; label: string } | { kind: "entry"; option: PersonOption };

const NEW_KEY: Record<CandidateKind, string> = {
  person: "modal.selection.owner.newPerson",
  organisation: "modal.selection.owner.newOrganisation",
  mail: "modal.selection.owner.nobody",
  phone: "modal.selection.owner.nobody",
  address: "modal.selection.owner.nobody",
  iban: "modal.selection.owner.nobody",
};

/** Vorschlagsdialog nach dem Muster von „Person vergessen“ (`key-actions-ui.ts`): die erste Zeile ist immer „neu“, danach die vorhandenen Einträge, gefiltert nach dem Suchtext.
 *  `onChooseSuggestion` kommt in Obsidian NACH `onClose`: Abbrechen wird deshalb erst danach gemeldet. */
class OwnerModal extends SuggestModal<OwnerRow> {
  private done: ((pick: OwnerPick | null) => void) | null;

  constructor(app: App, private readonly kind: CandidateKind, private readonly options: readonly PersonOption[], done: (pick: OwnerPick | null) => void) {
    super(app);
    this.done = done;
    this.setPlaceholder(t("modal.selection.owner.placeholder"));
    this.emptyStateText = t("modal.selection.owner.empty");
    this.setInstructions([{ command: "↵", purpose: t("modal.selection.owner.select") }]);
  }

  getSuggestions(query: string): OwnerRow[] {
    return [{ kind: "new", label: t(NEW_KEY[this.kind]) }, ...filterPersons(this.options, query).map((option): OwnerRow => ({ kind: "entry", option }))];
  }

  renderSuggestion(row: OwnerRow, el: HTMLElement): void {
    if (row.kind === "new") { el.createDiv({ cls: "pseu-suggest-label", text: row.label }); return; }
    el.createDiv({ cls: "pseu-suggest-label", text: row.option.label });
    el.createDiv({ cls: "pseu-suggest-meta", text: t("modal.selection.owner.values", row.option.values.length) });
  }

  onChooseSuggestion(row: OwnerRow): void {
    this.finish(row.kind === "new" ? { kind: "new" } : { kind: "entry", id: row.option.id });
  }

  onClose(): void {
    super.onClose();
    queueMicrotask(() => { this.finish(null); });
  }

  private finish(pick: OwnerPick | null): void {
    if (!this.done) return;
    const cb = this.done;
    this.done = null;
    cb(pick);
  }
}

export function createNoteUi(app: App): NoteUi {
  return {
    chooseKind: () => askChoice<CandidateKind>(app, {
      title: t("modal.selection.title"),
      message: t("modal.selection.message"),
      options: KINDS.map((k, i) => ({ value: k, label: t(`modal.review.kind.${k}`), ...(i === 0 ? { cta: true } : {}) })),
      cancelLabel: t("modal.cancel"),
    }),
    chooseOwner: (kind, options) => new Promise((resolve) => { new OwnerModal(app, kind, options, resolve).open(); }),
    notify: noticeNotify,
  };
}

/** Die Auswahl im aktiven Editor (Quelltext oder Live Preview); in der Lesesicht oder ohne Editor `null`. Die Spanne zählt Zeichen im Text des Editors, wie `editAtomic` ihn liest. */
export function activeSelection(app: App): SelectionInfo | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const path = view?.file?.path;
  if (view === null || path === undefined || view.getMode() !== "source") return null;
  const text = view.editor.getSelection();
  if (text === "") return null;
  const from = view.editor.posToOffset(view.editor.getCursor("from"));
  return { path, from, to: from + text.length, text };
}

/** Die aktive Markdown-Notiz. */
export function activeNote(app: App): { path: string; name: string } | null {
  const file = app.workspace.getActiveFile();
  return file !== null && file.extension === "md" ? { path: file.path, name: file.basename } : null;
}

/** Die Ports für `NoteHost` aus der Obsidian-Schicht (Fenster, Editor, Schreib-Ports des Kits). */
export function noteHostPorts(app: App): Pick<NoteHost, "ports" | "selection" | "activeNote" | "ui"> {
  return { ports: () => obsidianWritePorts(app), selection: () => activeSelection(app), activeNote: () => activeNote(app), ui: createNoteUi(app) };
}
