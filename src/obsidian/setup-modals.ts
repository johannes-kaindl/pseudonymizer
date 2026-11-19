import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type { PlaceholderLanguage } from "../core/payload";
import { t } from "../vendor/kit/i18n";
import { applyDestructive } from "../vendor/kit-obsidian/confirm";
import { buildSegmentedControl } from "../vendor/kit-obsidian/segmented-control";

/** Die zwei Fenster des Einrichtens (Spec 8.3, Plan Aufgabe 12). Beide speichern nichts; sie antworten nur, was gewählt wurde. */

type Choice = "enter-code" | "set-up-anyway";

/** Eine Frage mit Abbrechen links und den Antworten rechts (UI-STANDARD §2); Escape und Klick daneben sind Abbrechen. */
abstract class AnswerModal<A> extends Modal {
  private done: ((answer: A | null) => void) | null;

  constructor(app: App, done: (answer: A | null) => void) {
    super(app);
    this.done = done;
  }

  protected finish(answer: A | null): void {
    if (!this.done) return;
    const cb = this.done;
    this.done = null;
    cb(answer);
    this.close();
  }

  onClose(): void {
    this.finish(null);
    this.contentEl.empty();
  }
}

class ExistingFilesModal extends AnswerModal<Choice> {
  constructor(app: App, private readonly folder: string, done: (answer: Choice | null) => void) { super(app, done); }

  onOpen(): void {
    this.titleEl.setText(t("modal.setup.exists.title"));
    this.contentEl.createEl("p", { text: t("modal.setup.exists.message", this.folder) });
    this.contentEl.createEl("p", { text: t("modal.setup.exists.hint") });
    const btns = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(btns).setButtonText(t("modal.cancel")).onClick(() => { this.finish(null); });
    // Gleichwertig (Spec 9): kein Knopf trägt die Hervorhebung für „weiter“; der zerstörerische trägt die Warnfarbe UND den Wortlaut „trotzdem“.
    new ButtonComponent(btns).setButtonText(t("modal.setup.exists.enterCode")).onClick(() => { this.finish("enter-code"); });
    applyDestructive(new ButtonComponent(btns).setButtonText(t("modal.setup.exists.setUpAnyway")).onClick(() => { this.finish("set-up-anyway"); }));
  }
}

class SetUpModal extends AnswerModal<PlaceholderLanguage> {
  constructor(app: App, private readonly initial: PlaceholderLanguage, done: (answer: PlaceholderLanguage | null) => void) { super(app, done); }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(t("modal.setup.title"));
    contentEl.createEl("p", { text: t("modal.setup.intro") });

    contentEl.createEl("p", { text: t("modal.setup.language.label"), cls: "pseu-field-label" });
    const seg = buildSegmentedControl<PlaceholderLanguage>(contentEl, {
      options: [{ value: "de", label: t("modal.setup.language.de") }, { value: "en", label: t("modal.setup.language.en") }],
      value: this.initial,
      ariaLabel: t("modal.setup.language.label"),
      onChange: () => undefined,
    });
    contentEl.createEl("p", { text: t("modal.setup.language.hint"), cls: "pseu-note" });

    // Die Voraussetzung ist NICHT gemessen: Der Text sagt es so und verlangt die Bestätigung durch den Knopf.
    contentEl.createEl("p", { text: t("modal.setup.sync"), cls: "pseu-note" });
    contentEl.createEl("p", { text: t("modal.setup.loss") });

    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(btns).setButtonText(t("modal.cancel")).onClick(() => { this.finish(null); });
    new ButtonComponent(btns).setButtonText(t("modal.setup.confirm")).setCta().onClick(() => { this.finish(seg.value()); });
  }
}

/** Warnung „hier liegen schon Gerätedateien“; `null` heißt Abbrechen. */
export function askExistingFiles(app: App, folder: string): Promise<Choice | null> {
  return new Promise((resolve) => { new ExistingFilesModal(app, folder, resolve).open(); });
}

/** Sprache der Platzhalter und Sync-Voraussetzung; `null` heißt Abbrechen. */
export function askSetUp(app: App, defaultLanguage: PlaceholderLanguage): Promise<PlaceholderLanguage | null> {
  return new Promise((resolve) => { new SetUpModal(app, defaultLanguage, resolve).open(); });
}
