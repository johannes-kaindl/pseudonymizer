import { Notice } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { MemoryTable } from "../core/memory-table";
import { t } from "../vendor/kit/i18n";
import { lookupTablePlaceholder } from "../vendor/kit/placeholder-table";
import { refreshTextSwap, textSwapPostProcessor, type SwapResolver, type TextSwapOptions } from "../vendor/kit-obsidian/text-swap";
import { openDocuments } from "./windows";

/** Die Auflösung für den Textersatz (Spec 8.6), gelesen aus der Tabelle im Arbeitsspeicher bei jeder Frage (die Tabelle wechselt zur Laufzeit: Sperren, Entsperren, Sync):
 *  bekannt, vergessen; gesperrt, ein Wert, der auf diesem Gerät noch fehlt (Eintrag da, Platz leer: ein anderes Gerät hat noch nicht nachgezogen) und ein Konflikt sind „nicht lesbar“
 *  mit einem Grund, der nie einen Wert nennt; alles andere (fremder oder nie vergebener Platzhalter, nicht eingerichtet) bleibt Text. */
export function createSwapResolver(memory: MemoryTable): SwapResolver {
  return (placeholder) => {
    const table = memory.table();
    if (table === null) return memory.state() === "locked" ? { status: "unreadable", reason: t("reading.reason.locked") } : undefined;
    const found = lookupTablePlaceholder(table, placeholder);
    switch (found.status) {
      case "known": return { status: "known", value: found.value };
      case "forgotten": return { status: "forgotten" };
      case "conflict": return { status: "unreadable", reason: t("reading.reason.conflict") };
      case "unknown": return found.reason === "no-slot" ? { status: "unreadable", reason: t("reading.reason.pending") } : undefined;
    }
  };
}

/** Was der Tooltip der eingeblendeten Stelle sagt: der Platzhalter, bei „vergessen“ und „nicht lesbar“ mit dem Grund. Nie ein Klartext (Spec 8.6, 11.3). */
export function swapTitle(info: { raw: string; state: string; reason?: string }): string {
  if (info.state === "forgotten") return `${info.raw} — ${t("reading.reason.forgotten")}`;
  return info.reason !== undefined && info.reason !== "" ? `${info.raw} — ${info.reason}` : info.raw;
}

/** Die Optionen des Bausteins, gemeinsam für die Lesesicht und den Kopier-Handler. Ein Wurf der Auflösung bleibt nicht stumm: eine Notice je Sitzung, ohne Inhalt. */
export function swapOptions(memory: MemoryTable, showPlaintext: () => boolean): TextSwapOptions {
  let warned = false;
  return {
    resolve: createSwapResolver(memory),
    shown: showPlaintext,
    title: swapTitle,
    onError: () => { if (!warned) { warned = true; new Notice(t("notice.reading.failed")); } },
  };
}

export interface ReadingDeps {
  app: Pick<App, "workspace">;
  options: TextSwapOptions;
  /** Meldet Änderungen von Zustand, Schalter oder Tabelle; die Rückgabe meldet wieder ab. */
  onChange(cb: () => void): () => void;
}

export interface ReadingHandle {
  /** Zeichnet jede eingeblendete Stelle in jedem offenen Fenster neu (Hauptfenster und Popouts), ohne die Notiz neu zu öffnen. Gibt die Zahl der gezeichneten Stellen zurück. */
  refresh(): number;
  /** Ein Haken, der nach jedem Auffrischen läuft: Aufgabe 17 hängt hier `textSwapEditorRefresh` ein (gerenderte Blöcke der Live Preview folgen dem Postprozessor, B4). */
  onRefresh(cb: () => void): () => void;
  /** Meldet ab und nimmt den Klartext aus jeder gezeigten Stelle (Plugin wird entladen). */
  dispose(): void;
}

/** Die Lesesicht: der Postprozessor des Bausteins, dazu das Auffrischen bei jeder Änderung. Beim Entladen (`dispose`) geht der Klartext aus jeder gezeigten Stelle, sonst bliebe er
 *  bis zum nächsten Rendern im Fenster stehen. */
export function setUpReading(plugin: Pick<Plugin, "registerMarkdownPostProcessor">, deps: ReadingDeps): ReadingHandle {
  const hooks = new Set<() => void>();
  const paintAll = (o: TextSwapOptions): number => {
    let n = 0;
    for (const doc of openDocuments(deps.app)) n += refreshTextSwap(doc.body, o);
    return n;
  };
  const refresh = (): number => {
    const n = paintAll(deps.options);
    for (const cb of [...hooks]) cb();
    return n;
  };
  plugin.registerMarkdownPostProcessor(textSwapPostProcessor(deps.options));
  const unsubscribe = deps.onChange(() => { refresh(); });
  return {
    refresh,
    onRefresh: (cb) => { hooks.add(cb); return () => { hooks.delete(cb); }; },
    dispose: () => {
      unsubscribe();
      hooks.clear();
      paintAll({ ...deps.options, resolve: () => undefined, shown: () => false });
    },
  };
}
