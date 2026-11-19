/** Hilfen für Tests mit echtem DOM (happy-dom, `// @vitest-environment happy-dom` am Kopf der Testdatei). Obsidians globale Hilfen (`createSpan`, `createDiv`, `createFragment`,
 *  `activeDocument`) gibt es im happy-dom nicht; der Baustein `text-swap` ruft sie. */
export function installDomGlobals(): void {
  const make = (tag: string) => (o?: { cls?: string; attr?: Record<string, string> }): HTMLElement => {
    const el = document.createElement(tag);
    if (o?.cls !== undefined) el.className = o.cls;
    for (const [k, v] of Object.entries(o?.attr ?? {})) el.setAttribute(k, v);
    return el;
  };
  Object.assign(globalThis, { createSpan: make("span"), createDiv: make("div"), createFragment: () => document.createDocumentFragment(), activeDocument: document });
}

/** Ein Wurzelelement mit diesem HTML, im Dokument `doc` aufgehängt. */
export function root(html: string, doc: Document = document): HTMLElement {
  const el = doc.createElement("div");
  el.innerHTML = html;
  doc.body.appendChild(el);
  return el;
}

/** Wählt den Bereich aus, wie es eine Maus täte. */
export function select(from: Node, fromOff: number, to: Node, toOff: number, doc: Document = document): void {
  const range = doc.createRange();
  range.setStart(from, fromOff);
  range.setEnd(to, toOff);
  const sel = doc.getSelection();
  if (sel === null) throw new Error("no selection");
  sel.removeAllRanges();
  sel.addRange(range);
}
