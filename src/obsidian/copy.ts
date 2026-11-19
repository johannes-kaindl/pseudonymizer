import { MarkdownView, Notice } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { CopyMode } from "../core/settings";
import { t } from "../vendor/kit/i18n";
import { PSEUDONYMIZER_PLUGIN_ID, type PseudonymizerApi } from "../vendor/kit/pseudonymizer-source";
import { copyToClipboard } from "../vendor/kit-obsidian/clipboard";
import { textSwapCopyHandler, type SwapFassung, type TextSwapOptions } from "../vendor/kit-obsidian/text-swap";
import { openDocuments } from "./windows";

/** Die Fassung, die ein gewöhnliches Kopieren in der Lesesicht liefert (Spec 8.6, Review Runde 1 B1): Vorgabe Platzhalter; die Einstellung „Kopieren liefert, was ich sehe“ koppelt an den Umschalter,
 *  die Fassung `plain` gilt also nur, solange der Klartext auch gezeigt wird. Bei ausgeblendetem Klartext liefert das Kopieren Platzhalter, in beiden Einstellungen. */
export function copyFassung(mode: CopyMode, plaintextShown: boolean): SwapFassung {
  return mode === "as-shown" && plaintextShown ? "plain" : "placeholder";
}

export interface CopyHandlerDeps {
  options: TextSwapOptions;
  copyMode(): CopyMode;
}

/** Hängt den Kopier-Handler des Bausteins (und denselben für den Zug mit der Maus) an jedes Fenster: ein Popout hat ein eigenes `document` (B2), also je Fenster ein Handler, auch für Fenster, die erst später aufgehen
 *  (`window-open`) oder beim Start schon offen waren (`layout-ready`, `layout-change`). Der Handler liest Fassung und Auflösung bei jedem Kopieren frisch. Gibt den Abgleich zurück. */
export function registerCopyHandlers(
  plugin: Pick<Plugin, "registerDomEvent" | "registerEvent">,
  app: Pick<App, "workspace">,
  deps: CopyHandlerDeps,
): () => void {
  const handler = textSwapCopyHandler({
    resolve: deps.options.resolve,
    ...(deps.options.onError === undefined ? {} : { onError: deps.options.onError }),
    fassung: () => copyFassung(deps.copyMode(), deps.options.shown()),
  });
  // Ziehen markierten Texts aus der Lesesicht trägt sonst den eingeblendeten Klartext mit (Review Runde 1, nur am Code gelesen): `dragstart` setzt die Daten des Zugs wie das Kopieren.
  // Der Zug wird nie abgebrochen (`preventDefault` bleibt wirkungslos), nur seine Daten werden ersetzt.
  const drag = (ev: DragEvent): void => {
    handler({ clipboardData: ev.dataTransfer, target: ev.target, preventDefault: () => undefined } as unknown as ClipboardEvent);
  };
  const done = new WeakSet<Document>();
  const attach = (doc: Document): void => {
    if (done.has(doc)) return;
    done.add(doc);
    plugin.registerDomEvent(doc, "copy", handler);
    plugin.registerDomEvent(doc, "dragstart", drag);
  };
  const scan = (): void => { for (const doc of openDocuments(app)) attach(doc); };
  plugin.registerEvent(app.workspace.on("window-open", (_win, win) => { attach(win.document); }));
  plugin.registerEvent(app.workspace.on("layout-change", scan));
  app.workspace.onLayoutReady(scan);
  scan();
  return scan;
}

export type CopyKind = "plaintext" | "placeholders";

export interface CopyHost {
  app: Pick<App, "workspace">;
  api: Pick<PseudonymizerApi, "restore">;
}

/** Die Stellen, an denen die Befehle die Oberfläche berühren; Tests tauschen sie. */
export interface CopyUi {
  /** Der Text, den der Befehl kopiert: die Auswahl im Editor, sonst die ganze Notiz; `null` ohne offene Notiz. */
  source(app: Pick<App, "workspace">): string | null;
  write(text: string, copiedMessage: string): Promise<boolean>;
}

const DEFAULT_UI: CopyUi = {
  source: (app) => {
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (view === null) return null;
    // In der Lesesicht hält der Editor eine alte Auswahl (und ist ohne Quelltext-Ansicht womöglich leer); dort gilt die ganze Notiz aus den geladenen Daten.
    if (view.getMode() !== "source") return view.data;
    const selection = view.editor.getSelection();
    return selection !== "" ? selection : view.editor.getValue();
  },
  write: (text, copiedMessage) => copyToClipboard(text, { copiedMessage, failedMessage: t("notice.failed") }),
};

const SHOWN_UNKNOWN = 3;

/** Die Befehle „Mit Klartext kopieren“ und „Mit Platzhaltern kopieren“ (Spec 8.6, 8.7): Klartext geht nur hinaus, wenn `restore` nichts Unlesbares meldet; sonst nennt eine Notice die Platzhalter
 *  (nie einen Klartext) und nichts wird kopiert. Vergessene gehen als Platzhalter hinaus, mit Hinweis. Ein Fehler im Befehl heißt „hat nicht geklappt“: der Text einer Ausnahme könnte Klartext tragen. */
export async function copyCommand(host: CopyHost, kind: CopyKind, ui: CopyUi = DEFAULT_UI): Promise<void> {
  try {
    const text = ui.source(host.app);
    if (text === null) { new Notice(t("notice.copy.noNote")); return; }
    if (text === "") { new Notice(t("notice.copy.empty")); return; }
    if (kind === "placeholders") { await ui.write(text, t("notice.copy.placeholders")); return; }
    const res = host.api.restore(text, { caller: PSEUDONYMIZER_PLUGIN_ID });
    if ("error" in res) { new Notice(res.error === "locked" ? t("notice.locked") : t("notice.notSetUp")); return; }
    if (res.unknown.length > 0) {
      const names = [...new Set(res.unknown)];
      const list = names.slice(0, SHOWN_UNKNOWN).join(", ") + (names.length > SHOWN_UNKNOWN ? ", …" : "");
      new Notice(t("notice.copy.unknown", String(res.unknown.length), list));
      return;
    }
    const message = res.forgotten.length > 0
      ? t("notice.copy.plainForgotten", String(res.restored), String(res.forgotten.length))
      : t("notice.copy.plain", String(res.restored));
    await ui.write(res.text, message);
  } catch {
    new Notice(t("notice.failed"));
  }
}
