// vendored from obsidian-kit@0.106.0, src/obsidian/text-swap.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Textersatz in der Lesesicht (Welle 36, kp1c, Bestellung 11 der Design-Linie pseudonymizer, Spec 2026-11-18 § 8.6): ein Markdown-Postprozessor ersetzt Fundstellen in Textknoten durch ein Element,
// das beide Fassungen kennt (Platzhalter und Klartext) und ohne Neuaufbau zwischen ihnen umschaltet; dazu ein Kopier-Handler, der die Fassung der Zwischenablage bestimmt.
//
// Der Baustein kennt die Pseudonymisierung nur über zwei Dinge: die Grammatik (`findPlaceholders` aus code-kit `pure/placeholder`, keine eigene) und eine Auflösung, die der Aufrufer
// hineingibt (`SwapResolver`, ein Port). Was ein Platzhalter bedeutet, entscheidet der Aufrufer; der Baustein entscheidet nur, wo und wie er ersetzt.
//
// Entscheidungen (am Vertrag der Bestellung, jede mit Grund):
// - **Nur Textknoten, nie Attribute.** Der Durchgang liest und schreibt `Text`-Knoten; `href`, `src`, `title`, `alt` fasst er nicht an. Ein Bild mit Platzhalter in der URL löst deshalb nie einen Abruf mit
//   Klartext aus (der Klartext käme sonst als Adresse zu einem fremden Server, Spec § 11.1, „vom Modell erzeugte Adressen“). Das eigene `title` des Ersatzes trägt nur den Platzhalter, nie den Klartext.
// - **Nie in Code und Formeln.** `code`, `pre`, `script`, `style`, `textarea`, `svg`, `math`/`.math` und bereits ersetzte Stellen bleiben unberührt: in Code steht der Platzhalter, weil er dort Text
//   über den Platzhalter ist, und eine Formel hat keinen Text, den man ersetzen dürfte.
// - **Klartext steht nur, solange er sichtbar ist.** Das Element trägt den Platzhalter im Attribut `data-okit-swap`, den Klartext nur als Text des Elements und nur in der Stellung „Klartext“; beim Ausblenden
//   wird er verworfen und beim Einblenden neu aufgelöst. Der Grund: ein Exporter (`outerHTML`, EPUB, Paperize) sieht sonst bei ausgeblendetem Klartext trotzdem einen Klartext im Attribut („was eingeblendet
//   ist, wird exportiert“ gilt nur für das Eingeblendete).
// - **Der Kopier-Handler arbeitet an Elementen, nicht an Text.** Er klont die Auswahl, ersetzt jedes `.okit-swap` des Klons anhand seines Attributs durch die gewünschte Fassung und baut Text und HTML
//   aus dem Klon. Zwei gleiche Texte nebeneinander (`Anna Beispiel` und `Anna Beispiel`) bleiben so zwei Stellen mit je ihrem Platzhalter; ein Textvergleich würde den zweiten Treffer anders behandeln
//   oder beide auf den ersten abbilden.
// - **Umschalten wirkt auch auf Abschnitte, die die Lesesicht aus dem DOM genommen hat (Review Runde 1, E4).** Obsidian hängt lange Notizen abschnittsweise aus und später unverändert wieder ein, ohne den
//   Postprozessor neu zu rufen; eine Abfrage am Dokument fände diese Stellen nicht, und nach Sperren, Umschalter aus oder Vergessen stünde beim Zurückscrollen wieder Klartext. Deshalb trägt jede erzeugte
//   Stelle in ein Register (schwach gehalten: ein verworfener Abschnitt wird frei), und `refreshTextSwap` zeichnet auch die Stellen, die gerade nicht im Dokument hängen. Gemessen im echten Obsidian 1.15.1
//   mit `pilot/text-swap-review.ts` (Gast `text-swap-gast.ts`, Notiz mit 1200 Zeilen, 29 ausgehängte Abschnitte mit Klartext): Umschalter aus, Sperren und Vergessen lassen nach dem Zurückscrollen 0 Klartext, am Stand
//   davor 1002; die Kontrolle ohne Auslöser sieht den Klartext (1002). Der Kit-Test hängt eine Stelle aus und wieder ein.
// - **Das Kopieren der Lesesicht fasst den Editor nie an (E5).** Der Postprozessor läuft auch für gerenderte Blöcke in Live Preview (Tabelle, Callout, Einbettung); liegt die Auswahl in einem `.cm-editor`, liefert
//   `swapSelection` `null`, und CodeMirror kopiert den Dateitext. Gemessen im echten Obsidian (derselbe Treiber): alles auswählen in Live Preview über
//   Tabelle, Callout und Einbettung, echte Taste, die Zwischenablage ist in beiden Fassungen der Dateitext; am Stand davor stand dort der gerenderte Text (Tabellenzellen auf eigenen Zeilen, in der Fassung „plain“ Klartext).
// - **Ein Wurf der Auflösung bricht die Darstellung nicht.** Die Lesesicht ist die Anzeige einer Notiz; wirft der Aufrufer (Tabelle nicht lesbar, Fehler im Plugin), bleibt die Stelle Text, und `onError`
//   meldet es. Kein stiller Fehler, kein leeres Fenster.
//
// Pflicht des Aufrufers (Review Runde 1, B2 und B4): Popout-Fenster haben ein eigenes `document`; der Kopier-Handler hängt je Fenster an dessen `document`, und `refreshTextSwap` läuft je Fenster mit dessen
// `body` (das Register deckt nur Stellen ab, die gerade aus allen Dokumenten gelöst sind, nicht Stellen in einem anderen Fenster). Gerenderte Blöcke in Live Preview folgen dem Postprozessor, nicht der
// Editor-Erweiterung: nach jedem Umschalten rufst du `refreshTextSwap` **und** `textSwapEditorRefresh`.
//
// Grenzen (benannt): Eine Fundstelle, die Obsidian über mehrere Textknoten verteilt (etwa durch Hervorhebung mitten im Wort), wird nicht erkannt; die Grammatik nimmt Platzhalter als ein Wort, das
// Rendering trennt sie in der Praxis nicht. Attribut-Daten (`data-okit-swap`) können Fremdtext selbst setzen (Obsidians Sanitizer lässt `data-*` und `class`): damit bekommt ein Fremder keine Fähigkeit, die
// er nicht schon hätte, denn der Platzhalter selbst als Text würde ersetzt, nur wird die Auflösung über das Attribut ebenfalls angewandt; der Aufrufer löst nur auf, was er auch im Text auflösen würde.

import { findPlaceholders, type Placeholder } from "../kit/placeholder";

/** Was die Auflösung zu einem Platzhalter sagt: bekannt (Klartext), vergessen, oder noch nicht lesbar (gesperrt, Gerät hat noch nicht nachgezogen; `reason` steht im Tooltip). */
export type SwapResolution =
  | { status: "known"; value: string }
  | { status: "forgotten" }
  | { status: "unreadable"; reason: string };

/** Die Auflösung des Aufrufers. `undefined` heißt: unbekannt, die Stelle bleibt unverändert Text (kein Element). Eine `PlaceholderLookup` aus code-kit erfüllt den Vertrag. */
export type SwapResolver = (placeholder: Placeholder) => SwapResolution | undefined;

/** Die beiden Fassungen: der Platzhalter oder der Klartext. */
export type SwapFassung = "placeholder" | "plain";

/** Der Zustand des Elements; er steht als Klasse (`is-shown`, `is-forgotten`, `is-unreadable`) und im Tooltip. */
export type SwapState = "shown" | "hidden" | "forgotten" | "unreadable";

export interface TextSwapOptions {
  resolve: SwapResolver;
  /** Ist der Klartext gerade eingeblendet? Wird bei jeder Zeichnung frisch gelesen (der Stand gilt je Gerät und ändert sich zur Laufzeit). */
  shown: () => boolean;
  /** Der Tooltip (`title`) des Elements. Vorgabe: der Platzhalter, bei „vergessen“ und „nicht lesbar“ zusätzlich der Grund aus der Auflösung. Nie der Klartext. */
  title?: (info: { raw: string; state: SwapState; reason?: string }) => string;
  /** Ein Wurf der Auflösung; die Stelle bleibt Text. */
  onError?: (error: unknown) => void;
}

/** Klasse des Ersatz-Elements; der Griff für Selektoren, CSS und Treiber. */
export const SWAP_CLASS = "okit-swap";
/** Attribut mit dem Platzhalter, so wie er im Text stand. */
export const SWAP_ATTR = "data-okit-swap";

const SKIP = "code, pre, script, style, textarea, svg, math, .math, .okit-swap, [contenteditable='true'], .metadata-container, .cm-editor";

// Das Register der erzeugten Stellen (E4). Schwache Verweise: Obsidian hält einen ausgehängten Abschnitt selbst fest, solange er wiederkommen kann; wird er verworfen, wird die Stelle frei. Die Einträge
// toter Verweise räumt `refreshTextSwap` ab und `register` selbst, sobald die Zahl seit dem letzten Aufräumen auf das Doppelte gewachsen ist (sonst wüchse es in einer Sitzung ohne Umschalten unbegrenzt).
const registry = new Set<WeakRef<HTMLElement>>();
let prunedAt = 64;

function register(el: HTMLElement): void {
  registry.add(new WeakRef(el));
  if (registry.size >= prunedAt * 2) {
    prune();
    prunedAt = Math.max(64, registry.size);
  }
}

/** Die lebenden Stellen des Registers; tote Verweise fallen heraus. */
function prune(): HTMLElement[] {
  const live: HTMLElement[] = [];
  for (const ref of registry) {
    const el = ref.deref();
    if (el === undefined) registry.delete(ref);
    else live.push(el);
  }
  return live;
}

function defaultTitle(info: { raw: string; state: SwapState; reason?: string }): string {
  return info.reason !== undefined && info.reason !== "" ? `${info.raw} — ${info.reason}` : info.raw;
}

function parseWhole(raw: string): Placeholder | null {
  const found = findPlaceholders(raw);
  const first = found[0];
  return found.length === 1 && first !== undefined && first.start === 0 && first.end === raw.length ? first : null;
}

function safeResolve(o: Pick<TextSwapOptions, "resolve" | "onError">, p: Placeholder): SwapResolution | undefined {
  try {
    return o.resolve(p);
  } catch (e) {
    o.onError?.(e);
    return undefined;
  }
}

/** Zeichnet ein Ersatz-Element in der Stellung, die `shown` und die Auflösung ergeben. Ändert nie Attribute außer `title`, Klassen und dem Text des Elements. Ein Element, dessen Attribut kein
 *  einzelner Platzhalter ist, bleibt unverändert. */
function paint(el: HTMLElement, o: TextSwapOptions): void {
  const raw = el.getAttribute(SWAP_ATTR) ?? "";
  const ph = parseWhole(raw);
  if (ph === null) return;
  const res = safeResolve(o, ph);
  let state: SwapState;
  let text = raw;
  let reason: string | undefined;
  if (res === undefined) {
    state = "hidden";
  } else if (res.status === "known") {
    if (o.shown()) {
      state = "shown";
      text = res.value;
    } else {
      state = "hidden";
    }
  } else if (res.status === "forgotten") {
    state = "forgotten";
  } else {
    state = "unreadable";
    reason = res.reason;
  }
  el.textContent = text;
  el.classList.toggle("is-shown", state === "shown");
  el.classList.toggle("is-forgotten", state === "forgotten");
  el.classList.toggle("is-unreadable", state === "unreadable");
  const info = reason === undefined ? { raw, state } : { raw, state, reason };
  el.setAttribute("title", (o.title ?? defaultTitle)(info));
}

function swapElement(ph: Placeholder, o: TextSwapOptions): HTMLElement {
  // Obsidians globales `createSpan` (Regel `prefer-create-el`); die Tests stellen es im happy-dom bereit.
  const el = createSpan({ cls: SWAP_CLASS, attr: { [SWAP_ATTR]: ph.raw } });
  paint(el, o);
  register(el);
  return el;
}

/** Ersetzt in den Textknoten von `root` jede aufgelöste Fundstelle durch ein Ersatz-Element. Gibt die Zahl der Elemente zurück. */
export function applyTextSwap(root: HTMLElement, o: TextSwapOptions): number {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) nodes.push(n as Text);
  let count = 0;
  for (const node of nodes) {
    const text = node.data;
    if (!text.includes("_")) continue; // jeder Platzhalter trägt einen Unterstrich: sonst kein Regex je Knoten
    const parent = node.parentElement;
    if (parent === null || parent.closest(SKIP) !== null) continue;
    const parts: Array<Text | HTMLElement> = [];
    let at = 0;
    for (const ph of findPlaceholders(text)) {
      const res = safeResolve(o, ph);
      if (res === undefined) continue;
      if (ph.start > at) parts.push(doc.createTextNode(text.slice(at, ph.start)));
      parts.push(swapElement(ph, o));
      at = ph.end;
      count += 1;
    }
    if (parts.length === 0) continue;
    if (at < text.length) parts.push(doc.createTextNode(text.slice(at)));
    node.replaceWith(...parts);
  }
  return count;
}

/** Der Postprozessor für `plugin.registerMarkdownPostProcessor(...)`. */
export function textSwapPostProcessor(o: TextSwapOptions): (el: HTMLElement) => void {
  return (el) => {
    applyTextSwap(el, o);
  };
}

/** Zeichnet jedes Ersatz-Element unter `root` neu (Umschalter, Sperren, Entsperren, Vergessen, geänderte Tabelle): kein Neuaufbau, die Knoten bleiben. Dazu jede Stelle des Registers, die gerade in keinem
 *  Dokument hängt (ein von der Lesesicht ausgehängter Abschnitt, E4). Gibt die Zahl der gezeichneten Elemente zurück. */
export function refreshTextSwap(root: ParentNode, o: TextSwapOptions): number {
  const els = new Set<HTMLElement>(Array.from(root.querySelectorAll<HTMLElement>(`.${SWAP_CLASS}`)));
  for (const el of prune()) if (!el.isConnected) els.add(el);
  els.forEach((el) => paint(el, o));
  return els.size;
}

/** Text und HTML der Auswahl in der gewünschten Fassung, oder `null`, wenn die Auswahl leer ist oder keine Ersatz-Stelle enthält (dann gilt das Kopieren des Browsers).
 *  Eine Stelle, die nur teilweise ausgewählt ist, geht ganz in die Auswahl ein (der Klon trägt das Attribut). Ist die Fassung „Klartext“ und die Stelle nicht bekannt, steht der Platzhalter. */
export function swapSelection(
  doc: Document,
  fassung: SwapFassung,
  o: Pick<TextSwapOptions, "resolve" | "onError">,
): { text: string; html: string } | null {
  const sel = doc.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
  // Im Editor kopiert CodeMirror den Dateitext (E5): gerenderte Blöcke der Live Preview tragen auch Ersatz-Stellen, ihr gerenderter Text wäre aber nicht der Dateitext.
  const inEditor = (n: Node): boolean => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(".cm-editor") != null;
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (inEditor(r.commonAncestorContainer) || inEditor(r.startContainer) || inEditor(r.endContainer)) return null;
  }
  const frag = createFragment();
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const anc = range.commonAncestorContainer;
    // Liegt die ganze Auswahl innerhalb einer Stelle, klont `cloneContents` nur den Text und das Element ginge verloren: dann zählt die ganze Stelle.
    const inside = (anc.nodeType === 1 ? (anc as Element) : anc.parentElement)?.closest(`.${SWAP_CLASS}`) ?? null;
    frag.appendChild(inside !== null ? inside.cloneNode(true) : range.cloneContents());
  }
  const swaps = Array.from(frag.querySelectorAll<HTMLElement>(`.${SWAP_CLASS}`));
  if (swaps.length === 0) return null;
  for (const el of swaps) {
    const raw = el.getAttribute(SWAP_ATTR) ?? "";
    let out = raw;
    if (fassung === "plain") {
      const ph = parseWhole(raw);
      const res = ph === null ? undefined : safeResolve(o, ph);
      if (res !== undefined && res.status === "known") out = res.value;
    }
    el.replaceWith(doc.createTextNode(out));
  }
  // Zeilenumbrüche zwischen Blöcken liefert nur `innerText` eines gezeichneten Knotens: der Klon liegt kurz außerhalb des Bildes im Dokument.
  const host = createDiv({ cls: "okit-swap-measure" });
  host.appendChild(frag);
  doc.body.appendChild(host);
  try {
    return { text: host.innerText, html: host.innerHTML };
  } finally {
    host.remove();
  }
}

export interface TextSwapCopyOptions extends Pick<TextSwapOptions, "resolve" | "onError"> {
  /** Die Fassung, die ein gewöhnliches Kopieren liefert; frisch gelesen bei jedem Kopieren (die Einstellung „Kopieren liefert, was ich sehe“ ändert sich zur Laufzeit). */
  fassung: () => SwapFassung;
}

/** Der Kopier-Handler für `plugin.registerDomEvent(document, "copy", handler)`. Er greift nur, wenn die Auswahl eine Ersatz-Stelle enthält; sonst läuft das Kopieren des Browsers unverändert. */
export function textSwapCopyHandler(o: TextSwapCopyOptions): (ev: ClipboardEvent) => void {
  return (ev) => {
    const data = ev.clipboardData;
    if (data === null) return;
    const doc = (ev.target as Node | null)?.ownerDocument ?? activeDocument;
    const out = swapSelection(doc, o.fassung(), o);
    if (out === null) return;
    data.setData("text/plain", out.text);
    data.setData("text/html", out.html);
    ev.preventDefault();
  };
}

/** Das CSS der Kennzeichnung. Die Unterscheidung steht in der Form, nicht in der Farbe: Eingeblendet = gepunktete Linie unter dem Text, nicht lesbar = gestrichelte, vergessen = doppelte.
 *  Die Linie ist ein Rand, keine Textdekoration: der Store-Lint meldet jede Eigenschaft `text-decoration` (auch die Einzelteile) als teilweise unterstützt (gemessen 2026-11-19). Ein Rand an
 *  einem Inline-Element ändert die Zeilenhöhe nicht. */
export const TEXT_SWAP_CSS = `
.okit-swap.is-shown { border-bottom: 1px dotted currentcolor; }
.okit-swap.is-unreadable { border-bottom: 1px dashed currentcolor; opacity: 0.7; }
.okit-swap.is-forgotten { border-bottom: 3px double currentcolor; opacity: 0.7; }
.okit-swap-measure { position: fixed; left: -99999px; top: 0; width: 1px; overflow: hidden; }
`;
