// vendored from obsidian-kit@0.106.0, src/obsidian/text-swap-editor.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Inline-Ersatz in Live Preview (Welle 36, kp1c, Bestellung 12 der Design-Linie pseudonymizer, Spec 2026-11-18 § 8.6): eine CodeMirror-Erweiterung ersetzt Fundstellen mitten in der Zeile durch ein Widget,
// rechnet nur den sichtbaren Bereich und zeigt den Quelltext, sobald Cursor oder Auswahl die Stelle berühren. Das Dokument wird nie geändert; Kopieren liefert den Dateitext (CodeMirror kopiert aus dem
// Zustand, nicht aus dem Widget).
//
// **Nicht im Barrel — direkt importieren** (wie `critic-editor.ts`): wer keinen Editor braucht, bekommt keinen `@codemirror`-Import. Pins und Fallen: `.claude/rules/codemirror-pins.md`.
// Verwandt mit `text-swap.ts` (Lesesicht): dieselbe Grammatik (`findPlaceholders`), derselbe Port `SwapResolver`, dieselben Zustände; das Widget trägt aber die Klasse `okit-swap-inline`, **nicht**
// `okit-swap`, damit der Kopier-Handler und `refreshTextSwap` der Lesesicht den Editor nie anfassen (der Handler risse sonst CodeMirrors Kopieren des Dateitextes an sich).
// Gerenderte Blöcke in Live Preview (Tabelle, Callout, Einbettung) sind dagegen Stellen der Lesesicht (`okit-swap`): sie folgen `refreshTextSwap`, nicht `textSwapEditorRefresh`. Der Aufrufer ruft nach jedem Umschalten
// **beide** (Review Runde 1, B4); in Popout-Fenstern je Fenster (B2).
//
// Entscheidungen (am Vertrag der Bestellung, jede mit Grund):
// - **Ein `ViewPlugin`, kein `StateField`.** Ein Feld rechnet bei jeder Änderung und kennt den Bildschirm nicht (`critic-editor` rechnet so das ganze Dokument neu). Das Plugin liest `view.visibleRanges`, erweitert
//   jede auf ganze Zeilen (eine Fundstelle am Rand wird nicht zerschnitten) und liest nur diese Stücke mit `sliceString`; es ruft nie `doc.toString()`. Neu gerechnet wird bei Dokumentänderung, geänderter
//   Sicht, geänderter Auswahl und dem Effekt `textSwapEditorRefresh`.
// - **Linear in der Länge des gelesenen Stücks, auch bei einer einzigen langen Zeile (Review Runde 1, E6).** Je Spanne einmal rechnen: die Inline-Code-Bereiche in einem Durchgang (`inlineCodeRanges`) und die
//   Fundstellen mit einem zweiten Zeiger gegen diese Bereiche, nicht je Fundstelle die Zeile neu schneiden und neu absuchen (das war quadratisch: 50 000 Zeichen 145 ms je Durchgang). Belegt mit einem Zähltest
//   auf `RegExp.prototype.exec` (`tests/text-swap-editor.test.ts`), der die Mutante „je Fundstelle neu rechnen“ rot macht, und mit `pruefeLinear`.
// - **Inline-Code gilt je Absatz, nicht je Zeile (E7).** Ein Code-Stück darf über Zeilenumbrüche laufen (CommonMark); die Backtick-Läufe paaren sich deshalb über den Absatz der Spanne (bis zur Leerzeile, höchstens
//   `PARAGRAPH_LINES` Zeilen nach oben und unten, damit ein Absatz ohne Leerzeile nicht das Dokument liest). Die Paarung folgt CommonMark: ein Lauf schließt mit dem nächsten Lauf gleicher Länge; hat ein Lauf
//   kein Gegenstück, bleibt er Text und blockiert die späteren nicht; ein Backtick hinter einer ungeraden Zahl Backslashes ist ein Zeichen und öffnet nichts (R3). Grenze (benannt): Listenpunkte, Überschriften und Zitate beendet erst die Leerzeile; was der Syntaxbaum weiß, sperrt der Aufrufer mit `skip`.
// - **Berührt eine Auswahl oder der Cursor die Stelle (auch an ihrem Rand), bleibt sie Quelltext.** Der Rand zählt: ein Klick auf das Widget setzt den Cursor an eine Seite, und die Stelle öffnet sich.
// - **Im Quelltextmodus aus.** Der Aufrufer reicht Live Preview durch (`active: (state) => state.field(editorLivePreviewField)`); das Kit liest `editorLivePreviewField` nicht selbst (ein Import aus `obsidian` ist im
//   Test nicht auflösbar und im Fall eines anderen Editors falsch). Ohne `active` ist die Erweiterung immer an.
// - **Code bleibt Quelltext.** Der Syntaxbaum (`@codemirror/language`) ist im Kit nicht erreichbar (kein Peer von `obsidian`, nicht installiert): der Aufrufer kann über `skip(state, from, to)` Bereiche sperren (etwa
//   Codeblöcke aus dem Abschnittsverzeichnis des Metadaten-Caches); eingebaut und immer an ist die Absatz-Heuristik für Inline-Code (`skipInlineCode`, `inlineCodeRanges`); `skip` kommt dazu und ersetzt sie nicht (am Pilot gemessen: ein Aufrufer, der nur Codeblöcke sperrte, ersetzte sonst Stellen in Inline-Code).
// - **Die Widgets tragen den Klartext nur als Text.** Kein Klartext in einem Attribut; der Tooltip nennt den Platzhalter (wie in der Lesesicht).
// - **Ein Wurf der Auflösung bricht den Editor nicht.** Die Stelle bleibt Quelltext, `onError` meldet es.

import { Facet, StateEffect, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { findInlineCodeSpans } from "../kit/code-spans";
import { findPlaceholders } from "../kit/placeholder";
import type { SwapResolution, SwapResolver, SwapState } from "./text-swap";

export interface TextSwapEditorOptions {
  resolve: SwapResolver;
  /** Ist der Klartext gerade eingeblendet? Frisch gelesen bei jeder Zeichnung. */
  shown: () => boolean;
  /** Läuft die Erweiterung gerade (Live Preview)? Vorgabe: immer. Der Aufrufer reicht `state.field(editorLivePreviewField)` durch. */
  active?: (state: EditorState) => boolean;
  /** Sperrt weitere Bereiche (Codeblöcke): `true` heißt Quelltext lassen. Inline-Code der Zeile sperrt der Baustein immer selbst (`skipInlineCode`); `skip` kommt dazu, ersetzt ihn nicht. */
  skip?: (state: EditorState, from: number, to: number) => boolean;
  /** Tooltip (`title`) des Widgets; Vorgabe: der Platzhalter, bei „vergessen“ und „nicht lesbar“ mit Grund. Nie der Klartext. */
  title?: (info: { raw: string; state: SwapState; reason?: string }) => string;
  onError?: (error: unknown) => void;
}

/** Zeichnet alle Editoren neu (Umschalter, Entsperren, geänderte Tabelle): `view.dispatch({ effects: textSwapEditorRefresh.of(null) })`. */
export const textSwapEditorRefresh = StateEffect.define<null>();

const optionsFacet = Facet.define<TextSwapEditorOptions, TextSwapEditorOptions | null>({ combine: (v) => v[0] ?? null });

/** Klasse des Widgets; der Griff für Selektoren, CSS und Treiber. */
export const SWAP_INLINE_CLASS = "okit-swap-inline";
/** Der Platzhalter am Widget (nur dieser, nie der Klartext). */
export const SWAP_INLINE_ATTR = "data-okit-swap";

function defaultTitle(info: { raw: string; reason?: string }): string {
  return info.reason !== undefined && info.reason !== "" ? `${info.raw} — ${info.reason}` : info.raw;
}

/** Ein Inline-Code-Stück: der Inhalt zwischen den beiden Backtick-Läufen (`from` einschließlich, `to` ausschließlich). */
export interface CodeRange { from: number; to: number }

/** Die Inline-Code-Bereiche von `text` (aufsteigend, ohne Überlappung): der Inhalt zwischen den beiden Backtick-Läufen. Die Paarung ist `findInlineCodeSpans` aus code-kit (`code-spans`, seit 0.86.0), CommonMark:
 *  ein Lauf schließt mit dem nächsten Lauf gleicher Länge im selben Absatz, ein Lauf ohne Gegenstück bleibt Text, eine Leerzeile beendet den Absatz. **Ein Backtick hinter einer ungeraden Zahl Backslashes
 *  öffnet nichts** (`\`` ist ein Zeichen; im Code-Stück selbst maskiert der Backslash nicht), Review Runde 2, R3: vorher paarte der Baustein den maskierten Backtick und zeigte Klartext in echtem Code. Linear. */
export function inlineCodeRanges(text: string): CodeRange[] {
  if (!text.includes("`")) return [];
  return findInlineCodeSpans(text).map((c) => ({ from: c.start + c.run, to: c.end - c.run }));
}

/** Liegt `index` in einem Inline-Code-Stück von `text`? Für einen einzelnen Aufruf; `textSwapEditorDecorations` rechnet die Bereiche einmal je Spanne und ordnet die Fundstellen mit einem Zeiger zu. */
export function skipInlineCode(text: string, index: number): boolean {
  return inlineCodeRanges(text).some((r) => index >= r.from && index < r.to);
}

class SwapWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly text: string,
    readonly state: SwapState,
    readonly title: string,
  ) { super(); }
  eq(other: SwapWidget): boolean {
    return other.raw === this.raw && other.text === this.text && other.state === this.state && other.title === this.title;
  }
  toDOM(): HTMLElement {
    const el = createSpan({ cls: `${SWAP_INLINE_CLASS} is-${this.state}`, attr: { [SWAP_INLINE_ATTR]: this.raw, title: this.title } });
    el.textContent = this.text;
    return el;
  }
  // Ereignisse im Widget gehören CodeMirror (Klick setzt den Cursor an den Rand, die Stelle öffnet sich).
  ignoreEvent(): boolean { return false; }
}

function stateOf(res: SwapResolution, shown: boolean): { state: SwapState; text: string | null; reason?: string } {
  if (res.status === "known") return shown ? { state: "shown", text: res.value } : { state: "hidden", text: null };
  if (res.status === "forgotten") return { state: "forgotten", text: null };
  return { state: "unreadable", text: null, reason: res.reason };
}

/** Zeilen über und unter einer Spanne, die zum Absatz für die Inline-Code-Paarung zählen, höchstens (E7). */
const PARAGRAPH_LINES = 20;
/** Eine Zeile bis zu dieser Länge gilt als leer, wenn sie nur Leerraum trägt; eine längere nie (kein Zeichen-für-Zeichen-Lesen langer Nachbarzeilen). */
const BLANK_MAX = 256;

/** Die Zeilen, die zu `ranges` gehören, zusammengefasst: jede Spanne auf ganze Zeilen erweitert, überlappende vereinigt. */
function lineSpans(state: EditorState, ranges: ReadonlyArray<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const r of ranges) {
    const from = state.doc.lineAt(r.from).from;
    const to = state.doc.lineAt(r.to).to;
    const last = out[out.length - 1];
    if (last !== undefined && from <= last.to) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}

function blankLine(state: EditorState, n: number): boolean {
  const line = state.doc.line(n);
  return line.length === 0 || (line.length <= BLANK_MAX && state.doc.sliceString(line.from, line.to).trim() === "");
}

/** Der Absatz um die Spanne für die Inline-Code-Paarung: bis zur Leerzeile, höchstens `PARAGRAPH_LINES` Zeilen nach oben und unten. */
function paragraphBounds(state: EditorState, span: { from: number; to: number }): { from: number; to: number } {
  const doc = state.doc;
  let first = doc.lineAt(span.from).number;
  for (let k = 0; k < PARAGRAPH_LINES && first > 1 && !blankLine(state, first - 1); k++) first -= 1;
  let last = doc.lineAt(span.to).number;
  for (let k = 0; k < PARAGRAPH_LINES && last < doc.lines && !blankLine(state, last + 1); k++) last += 1;
  return { from: doc.line(first).from, to: doc.line(last).to };
}

/** Die Ersetzungen für die gegebenen Bereiche (Vorgabe: das ganze Dokument; die Erweiterung gibt `view.visibleRanges`). Liest die Zeilen dieser Bereiche und den Absatz darum (nur für die Inline-Code-Paarung). Rein bis auf den Aufruf von `opts`. */
export function textSwapEditorDecorations(
  state: EditorState,
  opts: TextSwapEditorOptions,
  ranges: ReadonlyArray<{ from: number; to: number }> = [{ from: 0, to: state.doc.length }],
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = [];
  if (opts.active !== undefined && !opts.active(state)) return out;
  const skip = opts.skip;
  const sel = state.selection.ranges;
  const shown = opts.shown();
  for (const span of lineSpans(state, ranges)) {
    // Ein Stück Text je Spanne: der Absatz (Kontext für den Inline-Code), darin die Zeilen der Spanne. Fundstellen zählen nur in den Zeilen der Spanne.
    const ctx = paragraphBounds(state, span);
    const text = state.doc.sliceString(ctx.from, ctx.to);
    const coreFrom = span.from - ctx.from;
    const coreTo = span.to - ctx.from;
    if (!text.includes("_")) continue; // jeder Platzhalter trägt einen Unterstrich
    const code = inlineCodeRanges(text);
    let c = 0; // zweiter Zeiger: die Fundstellen kommen aufsteigend, die Bereiche auch
    for (const ph of findPlaceholders(text)) {
      if (ph.start < coreFrom || ph.end > coreTo) continue;
      const from = ctx.from + ph.start;
      const to = ctx.from + ph.end;
      if (sel.some((r) => r.from <= to && r.to >= from)) continue;
      while (c < code.length && (code[c]?.to ?? 0) <= ph.start) c += 1;
      const inCode = code[c];
      if (inCode !== undefined && ph.start >= inCode.from) continue;
      if (skip !== undefined && skip(state, from, to)) continue;
      let res: SwapResolution | undefined;
      try { res = opts.resolve(ph); } catch (e) { opts.onError?.(e); continue; }
      if (res === undefined) continue;
      const st = stateOf(res, shown);
      const info = st.reason === undefined ? { raw: ph.raw, state: st.state } : { raw: ph.raw, state: st.state, reason: st.reason };
      const title = (opts.title ?? defaultTitle)(info);
      out.push(Decoration.replace({ widget: new SwapWidget(ph.raw, st.text ?? ph.raw, st.state, title) }).range(from, to));
    }
  }
  return out;
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(textSwapEditorRefresh)))) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const opts = view.state.facet(optionsFacet);
      if (opts === null) return Decoration.none;
      return Decoration.set(textSwapEditorDecorations(view.state, opts, view.visibleRanges), true);
    }
  },
  {
    decorations: (v) => v.decorations,
    // Das Widget ersetzt Text: Cursor-Bewegung und Auswahl springen als Ganzes darüber (ein Zeichen = eine Stelle).
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
  },
);

/** Die Erweiterung für `plugin.registerEditorExtension(textSwapEditorExtension({ resolve, shown, active }))`. */
export function textSwapEditorExtension(opts: TextSwapEditorOptions): Extension {
  return [optionsFacet.of(opts), plugin];
}

/** Das CSS der Kennzeichnung im Editor, wie `TEXT_SWAP_CSS` in der Lesesicht (Rand statt Textdekoration, der Store-Lint meldet `text-decoration`): gepunktet eingeblendet, gestrichelt nicht lesbar, doppelt vergessen. */
export const TEXT_SWAP_EDITOR_CSS = `
.okit-swap-inline.is-shown { border-bottom: 1px dotted currentcolor; }
.okit-swap-inline.is-unreadable { border-bottom: 1px dashed currentcolor; opacity: 0.7; }
.okit-swap-inline.is-forgotten { border-bottom: 3px double currentcolor; opacity: 0.7; }
`;
