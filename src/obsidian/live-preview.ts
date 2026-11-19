import { editorLivePreviewField, MarkdownView } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { restoreZones, type RestoreZones } from "../core/restore-zones";
import type { CopyMode } from "../core/settings";
import { listAllFences } from "../vendor/kit/fences";
import { findPlaceholders } from "../vendor/kit/placeholder";
import type { TextSwapOptions } from "../vendor/kit-obsidian/text-swap";
import { textSwapEditorExtension, textSwapEditorRefresh } from "../vendor/kit-obsidian/text-swap-editor";
import { copyFassung } from "./copy";
import type { ReadingHandle } from "./reading";

/** Ein Bereich des Dokuments (`from` einschließlich, `to` ausschließlich). */
interface Span { from: number; to: number }

/** Die Codeblöcke je Dokumentstand: der Schlüssel ist das unveränderliche `Text`-Objekt des Zustands, das sich nur mit einer Änderung ändert. Cursor-Bewegung, Scrollen und Auswahl
 *  fragen also nie neu (Laufzeit, Spec 8.6); die Liste wird erst gerechnet, wenn eine Fundstelle sie braucht. */
const fenceCache = new WeakMap<object, Span[]>();

/** Die Bereiche aller Codeblöcke des Dokuments, flach und verschachtelt (Zitat, Callout, Listenpunkt), aufsteigend und ohne Überlappung: von der ersten Zeile des Zauns bis zur Schlusszeile,
 *  ein nicht geschlossener Zaun bis zum Ende. Rechnet `listAllFences` aus code-kit einmal je Dokumentstand (Entscheidung des Kit-Masters 2026-11-19: keine Code-Erkennung über `@codemirror/language`). */
export function fenceSpans(state: EditorState): Span[] {
  const doc = state.doc;
  const hit = fenceCache.get(doc);
  if (hit !== undefined) return hit;
  const spans: Span[] = [];
  for (const f of listAllFences(doc.toString())) {
    const open = Math.min(f.openLine + 1, doc.lines);
    const close = Math.min(f.closeLine + 1, doc.lines);
    spans.push({ from: doc.line(open).from, to: doc.line(close).to });
  }
  fenceCache.set(doc, spans);
  return spans;
}

/** Berührt `[from, to)` einen Codeblock? Binäre Suche in der gerechneten Liste. Eine Fundstelle, die einen Zaun auch nur anschneidet, bleibt Quelltext. */
export function inFence(state: EditorState, from: number, to: number): boolean {
  const spans = fenceSpans(state);
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (s === undefined) return false;
    if (s.to <= from) lo = mid + 1;
    else if (s.from >= to) hi = mid - 1;
    else return true;
  }
  return false;
}

/** Läuft der Editor gerade in Live Preview? Der Quelltextmodus und jeder Editor ohne das Feld zeigen Platzhalter. */
export function isLivePreview(state: EditorState): boolean {
  return state.field(editorLivePreviewField, false) === true;
}

/** Die Bereiche, in denen Klartext eingesetzt werden darf, je Dokumentstand (wie `fenceCache`): Kopieren ist selten, aber der Bereich über das ganze Dokument erkennt ein Code-Stück, das vor der Auswahl beginnt. */
const zonesCache = new WeakMap<object, RestoreZones>();

function zonesOf(state: EditorState): RestoreZones {
  const hit = zonesCache.get(state.doc);
  if (hit !== undefined) return hit;
  const zones = restoreZones(state.doc.toString());
  zonesCache.set(state.doc, zones);
  return zones;
}

/** Was der Editor in `range` zeigen würde, wenn nichts ausgewählt wäre, als Text: jede bekannte Fundstelle durch ihren Klartext ersetzt, aber nur dort, wo `transform` ersetzen würde (`restoreZones`, W1): in
 *  Code, Link-Zielen, Bild-URLs, nackten URLs, Kommentaren, Mathe und Wikilinks bleibt der Platzhalter; vergessene, nicht lesbare und unbekannte bleiben, wie sie standen. Rein bis auf den Aufruf der Auflösung. `count` ist die Zahl der Ersetzungen. */
export function plainRangeText(
  state: EditorState,
  range: Span,
  o: Pick<TextSwapOptions, "resolve" | "onError">,
): { text: string; count: number } {
  const doc = state.doc;
  // Die Zeilen der Auswahl tragen die Fundstellen (nur eine ganz in der Auswahl liegende zählt); ob eine Stelle ersetzbar ist, entscheidet der Bereich über das ganze Dokument.
  const ctxFrom = doc.lineAt(range.from).from;
  const ctxTo = doc.lineAt(range.to).to;
  const ctx = doc.sliceString(ctxFrom, ctxTo);
  const text = doc.sliceString(range.from, range.to);
  if (!text.includes("_")) return { text, count: 0 };
  const zones = zonesOf(state);
  let out = "";
  let at = 0;
  let count = 0;
  for (const ph of findPlaceholders(ctx)) {
    const from = ctxFrom + ph.start;
    const to = ctxFrom + ph.end;
    if (from < range.from || to > range.to) continue;
    if (!zones.inside(from, to)) continue;
    let res;
    try { res = o.resolve(ph); } catch (e) { o.onError?.(e); continue; }
    if (res === undefined || res.status !== "known") continue;
    out += text.slice(at, from - range.from) + res.value;
    at = to - range.from;
    count += 1;
  }
  return { text: out + text.slice(at), count };
}

export interface LivePreviewDeps {
  app: Pick<App, "workspace">;
  /** Dieselben Optionen wie die Lesesicht: derselbe Auflöser, derselbe Schalter, derselbe Tooltip. */
  options: TextSwapOptions;
  copyMode(): CopyMode;
  /** Läuft der Editor in Live Preview? Vorgabe: das Feld von Obsidian; Tests reichen ihre Antwort durch. */
  active?: (state: EditorState) => boolean;
}

/** Was der Kopier-Handler vom Editor braucht (die Ansicht von CodeMirror erfüllt es). */
export interface CopyView {
  state: EditorState;
  dispatch(spec: { changes: Array<{ from: number; to: number }>; scrollIntoView: boolean; userEvent: string }): void;
}

/** Der Handler für `copy` und `cut` im Editor (Spec 8.6): Vorgabe Platzhalter, dann kopiert CodeMirror den Dateitext und der Handler tut nichts. Mit „Kopieren liefert, was ich sehe“ und eingeblendetem Klartext
 *  in Live Preview liefert er den Text der Auswahl mit den eingeblendeten Stellen als Klartext; eine Stelle, die nicht bekannt ist (vergessen, nicht lesbar, unbekannt), und alles in Code bleibt Platzhalter, ohne
 *  Notice (wie in der Lesesicht). Der Handler greift nur bei einer Auswahl, die eine Stelle ersetzt; sonst läuft CodeMirrors eigenes Kopieren, auch das der ganzen Zeile ohne Auswahl. `cut` löscht die Auswahl wie
 *  CodeMirror selbst (`delete.cut`): die Datei wird nicht anders geschrieben als ohne das Plugin, nur die Zwischenablage trägt eine andere Fassung. */
export function editorCopyHandler(deps: LivePreviewDeps): (ev: ClipboardEvent, view: CopyView) => boolean {
  const active = deps.active ?? isLivePreview;
  return (ev, view) => {
    const state = view.state;
    if (!active(state)) return false;
    if (copyFassung(deps.copyMode(), deps.options.shown()) !== "plain") return false;
    const data = ev.clipboardData;
    if (data === null) return false;
    const ranges = state.selection.ranges.filter((r) => !r.empty);
    if (ranges.length === 0) return false;
    let count = 0;
    const parts = ranges.map((r) => {
      const p = plainRangeText(state, r, deps.options);
      count += p.count;
      return p.text;
    });
    if (count === 0) return false;
    data.clearData();
    data.setData("text/plain", parts.join(state.lineBreak));
    ev.preventDefault();
    if (ev.type === "cut" && !state.readOnly) view.dispatch({ changes: ranges.map((r) => ({ from: r.from, to: r.to })), scrollIntoView: true, userEvent: "delete.cut" });
    return true;
  };
}

/** Wechselt der Editor zwischen Live Preview und Quelltext, ohne dass Dokument, Sicht oder Auswahl sich ändern, rechnet der Baustein nicht neu (er rechnet nur bei diesen Anlässen und dem Effekt): der Wächter
 *  schickt den Effekt nach dem Wechsel selbst. Gesendet wird nach der Aktualisierung, nie in ihr (CodeMirror verbietet das). */
function modeWatcher(active: (state: EditorState) => boolean): Extension {
  return EditorView.updateListener.of((u) => {
    if (active(u.startState) === active(u.state)) return;
    const view = u.view;
    queueMicrotask(() => {
      try { view.dispatch({ effects: textSwapEditorRefresh.of(null) }); } catch { /* ein Editor, der gerade zerstört wurde */ }
    });
  });
}

/** Die Editor-Erweiterung: Ersatz in Live Preview, Kopier-Handler, Wächter für den Moduswechsel. */
export function livePreviewExtension(deps: LivePreviewDeps): Extension {
  const active = deps.active ?? isLivePreview;
  const o = deps.options;
  const handler = editorCopyHandler(deps);
  return [
    textSwapEditorExtension({
      resolve: o.resolve,
      shown: o.shown,
      active,
      skip: (state, from, to) => inFence(state, from, to),
      ...(o.title === undefined ? {} : { title: o.title }),
      ...(o.onError === undefined ? {} : { onError: o.onError }),
    }),
    EditorView.domEventHandlers({
      copy: (ev, view) => handler(ev, view),
      cut: (ev, view) => handler(ev, view),
    }),
    modeWatcher(active),
  ];
}

/** Zeichnet jeden offenen Editor in jedem Fenster neu (Hauptfenster und Popouts: `iterateAllLeaves` kennt beide). Gibt die Zahl der Editoren zurück. */
export function refreshEditors(app: Pick<App, "workspace">): number {
  let n = 0;
  app.workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    if (cm === undefined) return;
    try {
      cm.dispatch({ effects: textSwapEditorRefresh.of(null) });
      n += 1;
    } catch { /* ein Editor, der gerade zerstört wird, ist nichts zu zeichnen */ }
  });
  return n;
}

/** Verdrahtet Live Preview: die Erweiterung an jeden Editor, und das Auffrischen der Lesesicht (bei Umschalter, Sperren, Entsperren, neuer Tabelle) zeichnet auch die Editoren neu. Beides ruft der Aufrufer
 *  laut Kit-Kopf nach jedem Umschalten (B4): gerenderte Blöcke in Live Preview folgen dem Postprozessor, der Text der Zeile der Erweiterung. */
export function setUpLivePreview(
  plugin: Pick<Plugin, "registerEditorExtension">,
  reading: Pick<ReadingHandle, "onRefresh">,
  deps: LivePreviewDeps,
): void {
  plugin.registerEditorExtension(livePreviewExtension(deps));
  reading.onRefresh(() => { refreshEditors(deps.app); });
}
