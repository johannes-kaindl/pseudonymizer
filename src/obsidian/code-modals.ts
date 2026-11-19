import { ButtonComponent, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import { t } from "../vendor/kit/i18n";
import { decodeRecoveryCode, encodeRecoveryCode, type RecoveryCodeContent, type RecoveryCodeDecodeResult } from "../vendor/kit/recovery-code";
import { copyToClipboard } from "../vendor/kit-obsidian/clipboard";
import { promptText } from "../vendor/kit-obsidian/prompt-text";

/** Die beiden Fenster rund um den Wiederherstellungs-Code (Spec 8.3). Beide speichern NICHTS: weder den Schlüsselbund noch eine Datei.
 *  Wer den Code eingibt, bekommt nur den decodierten Inhalt zurück; festgeschrieben wird er erst, nachdem eine Gerätedatei damit geöffnet ist
 *  (Aufgabe 11 und 12, Spec 8.3 „Erst öffnen, dann festschreiben“). Kein Code und kein Schlüssel geht in `console`, in eine Notice oder in eine Fehlermeldung. */

/** Warum ein eingegebener Code abgelehnt wird: Länge, Zeichen, Prüfzeichen oder Version. Trägt nie ein Zeichen der Eingabe, nur Zahlen. */
export type CodeInputProblem = Extract<RecoveryCodeDecodeResult, { ok: false }>;

/** Ergebnis der Prüfung einer Eingabe auf Tippfehler (das Prüfzeichen ist kein MAC: ein gültiger Code einer fremden Kette besteht es immer). */
export type CodeInputResult = { ok: true; content: RecoveryCodeContent } | { ok: false; problem: CodeInputProblem };

/** Liest eine getippte oder eingefügte Eingabe; Groß- und Kleinschreibung, Bindestriche und Leerzeichen spielen keine Rolle. */
export function checkRecoveryCodeInput(raw: string): CodeInputResult {
  const r = decodeRecoveryCode(raw);
  if (!r.ok) return { ok: false, problem: r };
  return { ok: true, content: { chainId: r.chainId, stand: r.stand, key: r.key } };
}

/** Der Satz zum Grund; nennt Zahlen (Anzahl, Stelle, Format), nie ein Zeichen der Eingabe. */
function problemText(p: CodeInputProblem): string {
  switch (p.reason) {
    case "length": return t("modal.code.enter.error.length", p.got, p.expected);
    case "character": return t("modal.code.enter.error.character", p.at + 1);
    case "checksum": return t("modal.code.enter.error.checksum");
    case "version": return t("modal.code.enter.error.version", p.found);
  }
}

/** Fenster „Code eingeben“ (Kit `promptText`). Bleibt bei einem Tippfehler offen und sagt den Grund; so geht die Eingabe nicht verloren und ein falscher Code kommt nie beim Aufrufer an.
 *  Antwort: der decodierte Inhalt oder `null` (Abbrechen, Escape, Klick daneben). */
export async function enterRecoveryCode(app: App): Promise<RecoveryCodeContent | null> {
  const raw = await promptText(app, {
    title: t("modal.code.enter.title"),
    message: t("modal.code.enter.message"),
    placeholder: t("modal.code.enter.placeholder"),
    okLabel: t("modal.code.enter.ok"),
    cancelLabel: t("modal.cancel"),
    validate: (value) => {
      const r = checkRecoveryCodeInput(value);
      return r.ok ? null : problemText(r.problem);
    },
  });
  if (raw === null) return null;
  const r = checkRecoveryCodeInput(raw);
  return r.ok ? r.content : null;
}

export interface ShowCodeOptions {
  /** `true` (nach dem Einrichten, Spec 8.3): das Kontrollkästchen „Ich habe den Code gesichert“ muss gesetzt sein, erst dann geht „Weiter“. */
  requireConfirmation: boolean;
}

class ShowCodeModal extends Modal {
  private done: ((confirmed: boolean) => void) | null;
  private code: string | null;

  constructor(app: App, code: string, private readonly opts: ShowCodeOptions, done: (confirmed: boolean) => void) {
    super(app);
    this.code = code;
    this.done = done;
  }

  onOpen(): void {
    const { contentEl, code } = this;
    if (code === null) return;
    this.titleEl.setText(t("modal.code.show.title"));
    contentEl.createEl("p", { text: t("modal.code.show.intro") });
    contentEl.createEl("p", { text: t("modal.code.show.loss") });

    // In Gruppen, die am Zeilenende umbrechen; die Bindestriche stehen zwischen den Gruppen, damit eine Auswahl den Code wie kopiert zeigt.
    const box = contentEl.createDiv({ cls: "pseu-code", attr: { role: "group", "aria-label": t("modal.code.show.groupLabel") } });
    code.split("-").forEach((group, i) => {
      if (i > 0) box.createSpan({ cls: "pseu-code-sep", text: "-", attr: { "aria-hidden": "true" } });
      box.createSpan({ cls: "pseu-code-group", text: group });
    });

    const copy = new ButtonComponent(contentEl.createDiv({ cls: "pseu-code-actions" }))
      .setButtonText(t("modal.code.show.copy"))
      .onClick(() => { void copyToClipboard(code, { copiedMessage: t("modal.code.show.copied"), failedMessage: t("modal.code.show.copyFailed") }); });
    copy.buttonEl.addClass("pseu-code-copy");
    contentEl.createEl("p", { text: t("modal.code.show.clipboardHint"), cls: "pseu-code-hint" });

    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    if (!this.opts.requireConfirmation) {
      new ButtonComponent(btns).setButtonText(t("modal.code.show.done")).setCta().onClick(() => { this.finish(true); });
      return;
    }
    const row = contentEl.createEl("label", { cls: "pseu-code-confirm" });
    const box2 = row.createEl("input", { attr: { type: "checkbox" } });
    row.createSpan({ text: t("modal.code.show.saved") });
    // Abbrechen links, Weiter rechts (UI-STANDARD §2); Weiter geht erst mit gesetztem Kästchen.
    new ButtonComponent(btns).setButtonText(t("modal.cancel")).onClick(() => { this.finish(false); });
    const next = new ButtonComponent(btns).setButtonText(t("modal.code.show.continue")).setCta().setDisabled(true);
    next.onClick(() => { if (box2.checked) this.finish(true); });
    box2.addEventListener("change", () => { next.setDisabled(!box2.checked); });
  }

  onClose(): void {
    this.finish(false);
    // Der Code soll nach dem Schließen nicht im Dokument liegen bleiben.
    this.code = null;
    this.contentEl.empty();
  }

  private finish(confirmed: boolean): void {
    if (!this.done) return;
    const cb = this.done;
    this.done = null;
    cb(confirmed);
    this.close();
  }
}

/** Fenster „Code anzeigen“: der Code in Gruppen, Kopieren über das Kit, Hinweis auf den Passwortmanager.
 *  Antwort: `true`, wenn der Nutzer bestätigt hat („Weiter“ nach gesetztem Kästchen, oder „Fertig“ ohne Pflichtkästchen); `false` bei Abbrechen, Escape, Klick daneben
 *  und wenn sich der Inhalt nicht als Code darstellen lässt (dann öffnet sich nichts und eine Notice sagt es, ohne Schlüsselmaterial). */
export function showRecoveryCode(app: App, content: RecoveryCodeContent, opts: ShowCodeOptions): Promise<boolean> {
  const encoded = encodeRecoveryCode(content);
  if (!encoded.ok) {
    new Notice(t("modal.code.show.unavailable"));
    return Promise.resolve(false);
  }
  const code = encoded.code;
  return new Promise((resolve) => {
    new ShowCodeModal(app, code, opts, resolve).open();
  });
}
