import { ButtonComponent, Modal, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { LookupForm, LookupOutcome } from "../core/lookup";
import type { PlaceholderField } from "../vendor/kit/placeholder";
import type { EntryKind } from "../vendor/kit/placeholder-table";
import { t } from "../vendor/kit/i18n";

/** Der Klartext steht nur in diesem Fenster, solange es offen ist; beim Schließen wird der Inhalt geleert. Nichts davon geht in `console` oder in eine Notice. */
const KIND_KEY: Record<EntryKind, string> = {
  person: "modal.lookup.kind.person",
  organisation: "modal.lookup.kind.organisation",
  none: "modal.lookup.kind.none",
};
const FIELD_KEY: Record<PlaceholderField, string> = {
  mail: "modal.lookup.field.mail",
  phone: "modal.lookup.field.phone",
  address: "modal.lookup.field.address",
  iban: "modal.lookup.field.iban",
};
const fieldKey = (field: PlaceholderField | null): string => (field === null ? "modal.lookup.field.name" : FIELD_KEY[field]);

/** Status immer als Symbol UND Text (UI-STANDARD), nie nur über die Farbe. */
const STATUS: Record<Exclude<LookupOutcome["status"], "invalid">, { icon: string; key: string }> = {
  known: { icon: "check-circle-2", key: "modal.lookup.known" },
  forgotten: { icon: "user-x", key: "modal.lookup.forgotten" },
  unknown: { icon: "help-circle", key: "modal.lookup.unknown" },
  conflict: { icon: "alert-triangle", key: "modal.lookup.conflict" },
};

/** Das Ergebnis von „Platzhalter nachschlagen“ (Spec 8.9): Wert, Art und weitere Formen des Eintrags; vergessen und unbekannt mit Grund;
 *  ein Konflikt mit beiden Werten, ohne einen zu bevorzugen. */
export class LookupModal extends Modal {
  constructor(app: App, private readonly outcome: LookupOutcome) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, outcome } = this;
    if (outcome.status === "invalid") return;
    this.titleEl.setText(t("modal.lookup.title"));

    const status = contentEl.createDiv({ cls: "pseu-lookup-status", attr: { role: "status" } });
    setIcon(status.createSpan({ cls: "pseu-lookup-status-icon", attr: { "aria-hidden": "true" } }), STATUS[outcome.status].icon);
    status.createSpan({ cls: "pseu-lookup-status-text", text: t(STATUS[outcome.status].key) });

    const rows = contentEl.createEl("dl", { cls: "pseu-lookup-rows" });
    const row = (label: string, value: string, cls?: string): void => {
      rows.createEl("dt", { text: label });
      rows.createEl("dd", { text: value, cls });
    };
    row(t("modal.lookup.placeholderLabel"), outcome.placeholder, "pseu-lookup-placeholder");

    switch (outcome.status) {
      case "known":
        row(t("modal.lookup.valueLabel"), outcome.value);
        row(t("modal.lookup.kindLabel"), t(KIND_KEY[outcome.kind]));
        row(t("modal.lookup.fieldLabel"), t(fieldKey(outcome.field)));
        this.forms(outcome.forms);
        break;
      case "conflict":
        contentEl.createEl("p", { text: t("modal.lookup.conflictText") });
        rows.createEl("dt", { text: t("modal.lookup.valuesLabel") });
        for (const v of outcome.values) rows.createEl("dd", { text: v });
        row(t("modal.lookup.kindLabel"), t(KIND_KEY[outcome.kind]));
        row(t("modal.lookup.fieldLabel"), t(fieldKey(outcome.field)));
        this.forms(outcome.forms);
        break;
      case "forgotten":
        contentEl.createEl("p", { text: t("modal.lookup.forgottenText") });
        break;
      case "unknown":
        contentEl.createEl("p", { text: t(`modal.lookup.unknown.${outcome.reason}`) });
        break;
    }

    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(btns).setButtonText(t("modal.close")).setCta().onClick(() => { this.close(); });
  }

  private forms(forms: readonly LookupForm[]): void {
    if (forms.length === 0) return;
    const { contentEl } = this;
    contentEl.createEl("h4", { text: t("modal.lookup.formsLabel") });
    const list = contentEl.createEl("ul", { cls: "pseu-lookup-forms" });
    for (const f of forms) {
      const item = list.createEl("li");
      item.createSpan({ cls: "pseu-lookup-form-placeholder", text: f.placeholder });
      item.createSpan({ text: ` ${f.value}` });
      if (f.conflict) item.createSpan({ cls: "pseu-lookup-form-conflict", text: ` (${t("modal.lookup.formConflict")})` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
