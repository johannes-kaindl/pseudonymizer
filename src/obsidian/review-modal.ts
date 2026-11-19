import { ButtonComponent, Modal, Notice, Platform } from "obsidian";
import type { App } from "obsidian";
import {
  alsoOf,
  answersOf,
  buildCards,
  contextOf,
  ownerEntries,
  ownerOptions,
  replaceCount,
  textSegments,
  WAYS,
  type OwnerOption,
  type PlaceRef,
  type ReviewCard,
  type Way,
} from "../core/review-model";
import { candidateKey, type Candidate, type CandidateKind, type Mark } from "../core/transform";
import { t } from "../vendor/kit/i18n";
import { buildReviewList, type ReviewCandidate, type ReviewListStrings } from "../vendor/kit-obsidian/review-list";
import type { ReviewContext, ReviewFn, ReviewResult } from "./engine";

/** Das Prüffenster für neue Fundstellen (Bauplan Aufgabe 14, Spec 8.5): ein natives Modal über `buildReviewList` (Kandidatenkarten) und `buildSegmentedControl` (die drei Wege).
 *  Hülle nach `settings-assistant/src/obsidian/apply-modal.ts`: Ergebnis oder `null`, Escape und Abbrechen schreiben nichts; der Ablauf nach `filename-sanitizer/src/obsidian/view.ts`:
 *  die Karten setzen nur eine Auswahl, erst „übernehmen“ gibt sie zurück (die Engine legt alles in EINEM `persist` ab). Das Fenster schreibt selbst nichts. */

const KIND_KEY: Readonly<Record<CandidateKind, string>> = {
  person: "modal.review.kind.person",
  organisation: "modal.review.kind.organisation",
  mail: "modal.review.kind.mail",
  phone: "modal.review.kind.phone",
  address: "modal.review.kind.address",
  iban: "modal.review.kind.iban",
};
const MARK_KINDS: readonly CandidateKind[] = ["person", "organisation", "mail", "phone", "address", "iban"];
const WAY_KEY: Readonly<Record<Way, string>> = {
  replace: "modal.review.way.replace",
  "keep-here": "modal.review.way.keepHere",
  "keep-always": "modal.review.way.keepAlways",
};

/** `.one` bei genau 1, sonst `.other` (Englisch und Deutsch haben beide diese zwei Formen). */
const plural = (key: string, n: number): string => t(n === 1 ? `${key}.one` : `${key}.other`, n);

/** Die Beschriftungen der Kandidatenkarte. Die übrigen Felder verlangt der Typ von `buildReviewList`, werden für Kandidaten aber nie angezeigt. */
function listStrings(): ReviewListStrings {
  return {
    accept: "", reject: "", comment: "", reply: "", resolve: "", reopen: "", acceptAll: "", rejectAll: "", empty: "", stale: "", orphan: "",
    openCount: () => "",
    kind: { insertion: "", deletion: "", substitution: "" },
    candidate: {
      places: (n) => plural("modal.review.places", n),
      showAll: t("modal.review.showAll"),
      hideAll: t("modal.review.hideAll"),
      owner: t("modal.review.owner"),
      also: t("modal.review.also"),
      waysLabel: t("modal.review.ways"),
    },
  };
}

function ownerLabel(o: OwnerOption): string {
  switch (o.kind) {
    case "suggested": return t("modal.review.owner.suggested", o.text ?? "");
    case "nobody": return t("modal.review.owner.nobody");
    case "new-person": return t("modal.review.owner.newPerson");
    case "new-organisation": return t("modal.review.owner.newOrganisation");
    default: return t("modal.review.owner.entry", o.text ?? "", o.entryKind === "organisation" ? t("modal.review.kind.organisation") : t("modal.review.kind.person"));
  }
}

export interface ReviewModalOptions {
  /** Der Text, der im Fenster ausgewählt ist; Vorgabe: die letzte Auswahl im Text des Fensters. Nur für Tests austauschbar. */
  selection?: () => string;
}

class ReviewModal extends Modal {
  private done: ((result: ReviewResult | null) => void) | null;
  private cards: ReviewCard[];
  private marks: Mark[] = [];
  private markPlaces: readonly Candidate[] = [];
  private readonly entries;
  private applyBtn: ButtonComponent | null = null;
  private listHost: HTMLElement | null = null;
  private textHost: HTMLElement | null = null;
  private textOpen = false;
  private markKind: CandidateKind = "person";
  private lastSelection = "";
  private selectionCleanup: (() => void) | null = null;
  /** Kennung im DOM je Karte: eine laufende Nummer (`c0`, `c1`, …); die Zuordnung zum `candidateKey` (er trägt den Klartext) liegt nur hier im Speicher, nie in einem Attribut (K1). */
  private readonly domIds = new Map<string, string>();
  private readonly keyByDomId = new Map<string, string>();

  private domId(key: string): string {
    const known = this.domIds.get(key);
    if (known !== undefined) return known;
    const id = `c${String(this.domIds.size)}`;
    this.domIds.set(key, id);
    this.keyByDomId.set(id, key);
    return id;
  }

  constructor(app: App, private readonly ctx: ReviewContext, private readonly opts: ReviewModalOptions, done: (result: ReviewResult | null) => void) {
    super(app);
    this.done = done;
    this.cards = buildCards(ctx.places, ctx.table);
    this.entries = ownerEntries(ctx.table, ctx.lang);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("pseu-review-modal");
    if (Platform.isPhone) modalEl.addClass("pseu-review-full");
    this.titleEl.setText(this.ctx.title === undefined ? t("modal.review.title.plain") : t("modal.review.title", this.ctx.title));
    contentEl.addClass("pseu-review");

    const known = this.ctx.known;
    const head = contentEl.createDiv({ cls: "pseu-review-head" });
    // Die Kopfzeile zählt Werte: die offenen (eine Karte je Wert) und die bekannten (nur als Zahl, aufklappbar).
    head.createSpan({ cls: "pseu-review-summary", text: `${plural("modal.review.new", this.cards.length)} · ${plural("modal.review.known", known.length)}` });
    if (known.length > 0) this.knownList(head);

    const scroll = contentEl.createDiv({ cls: "pseu-review-scroll" });
    this.listHost = scroll.createDiv({ cls: "pseu-review-cards" });
    this.textHost = scroll.createDiv({ cls: "pseu-review-textview" });
    this.drawCards();
    this.drawText();

    // Kanon (UI-STANDARD §8 Confirm-Modal): Abbrechen links, Bestätigen rechts als `mod-cta`.
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(btns).setButtonText(t("modal.cancel")).onClick(() => { this.finish(null); });
    this.applyBtn = new ButtonComponent(btns).setCta().onClick(() => { this.finish({ answers: answersOf(this.cards), marks: [...this.marks] }); });
    this.updateApply();

    // Die Auswahl im Text merken, solange sie im Text des Fensters liegt (ein Tipp auf einen Knopf nimmt sie am Telefon sonst weg).
    const doc = contentEl.ownerDocument as Document | undefined;
    if (doc !== undefined) {
      const onSelection = (): void => {
        const sel = doc.getSelection();
        const host = this.textHost;
        if (sel === null || host === null || sel.isCollapsed || sel.anchorNode === null || !host.contains(sel.anchorNode)) return;
        this.lastSelection = sel.toString();
      };
      doc.addEventListener("selectionchange", onSelection);
      this.selectionCleanup = () => { doc.removeEventListener("selectionchange", onSelection); };
    }
  }

  onClose(): void {
    this.selectionCleanup?.();
    this.selectionCleanup = null;
    this.finish(null);
    this.contentEl.empty();
  }

  /** Das Ergebnis genau einmal melden; ein Callback VOR dem Schließen nullen, weil `close()` `onClose` ruft (und `onClose` ist Abbrechen). */
  private finish(result: ReviewResult | null): void {
    if (!this.done) return;
    const cb = this.done;
    this.done = null;
    cb(result);
    this.close();
  }

  private updateApply(): void {
    const n = replaceCount(this.cards);
    this.applyBtn?.setButtonText(n > 0 ? t("modal.review.applyCount", n) : t("modal.review.apply"));
  }

  /** Die bekannten Werte nur als Zahl; ein Knopf klappt die Liste auf (Wert und Platzhalter, ohne Rückfrage ersetzt). */
  private knownList(head: HTMLElement): void {
    const list = head.createEl("ul", { cls: "pseu-review-known-list" });
    list.hide();
    for (const k of this.ctx.known) list.createEl("li", { text: t("modal.review.known.line", k.value, k.placeholder) });
    let open = false;
    const toggle = head.createEl("button", { cls: "pseu-review-toggle", text: t("modal.review.known.show"), attr: { type: "button", "aria-expanded": "false" } });
    toggle.addEventListener("click", () => {
      open = !open;
      toggle.setText(open ? t("modal.review.known.hide") : t("modal.review.known.show"));
      toggle.setAttribute("aria-expanded", String(open));
      if (open) list.show(); else list.hide();
    });
  }

  private allPlaces(): Candidate[] { return [...this.ctx.places, ...this.markPlaces]; }

  private items(): ReviewCandidate[] {
    return this.cards.map((card): ReviewCandidate => {
      const textPlaces = card.places.filter((p) => p.partId !== "");
      const shown = textPlaces.length > 0 ? textPlaces : card.places.slice(0, 1);
      const also = alsoOf(card, this.cards);
      return {
        kind: "candidate",
        id: this.domId(card.key),
        found: card.value,
        type: t(KIND_KEY[card.kind]),
        places: shown.map((p) => contextOf(this.ctx.parts, p)),
        placeCount: shown.length,
        ways: WAYS.map((w) => ({ id: w, label: t(WAY_KEY[w]), title: t(`${WAY_KEY[w]}.title`) })),
        way: card.way,
        owner: { options: ownerOptions(card, this.entries).map((o) => ({ id: o.id, label: ownerLabel(o) })), value: card.owner },
        ...(also.length > 0 ? { also } : {}),
      };
    });
  }

  /** Baut die Karten neu (nur wenn Stellen hinzukamen); die Lage der Liste bleibt. */
  private drawCards(): void {
    const host = this.listHost;
    if (host === null) return;
    const top = host.parentElement?.scrollTop ?? 0;
    host.empty();
    buildReviewList(host, {
      items: this.items(),
      strings: listStrings(),
      onAction: () => undefined,
      onBulk: () => undefined,
      onWay: (id, way) => {
        const card = this.cards.find((c) => c.key === this.keyByDomId.get(id));
        if (card !== undefined && (WAYS as readonly string[]).includes(way)) { card.way = way as Way; this.updateApply(); }
      },
      onOwner: (id, owner) => {
        const card = this.cards.find((c) => c.key === this.keyByDomId.get(id));
        if (card !== undefined) card.owner = owner;
      },
      onError: () => { new Notice(t("notice.failed")); },
    });
    const scroller = host.parentElement;
    if (scroller !== null && scroller !== undefined) scroller.scrollTop = top;
  }

  /** „Text ansehen und weitere Stellen markieren“: der Text mit den Fundstellen, darunter die Auswahl der Art und der Knopf „Auswahl hinzufügen“. */
  private drawText(): void {
    const host = this.textHost;
    if (host === null) return;
    host.empty();
    const toggle = host.createEl("button", { cls: "pseu-review-toggle", text: this.textOpen ? t("modal.review.text.hide") : t("modal.review.text.show"), attr: { type: "button", "aria-expanded": String(this.textOpen) } });
    toggle.addEventListener("click", () => { this.textOpen = !this.textOpen; this.drawText(); });
    if (!this.textOpen) return;

    host.createDiv({ cls: "pseu-note", text: t("modal.review.text.hint") });
    host.createDiv({ cls: "pseu-note", text: t("modal.review.text.legend") });
    const open: (PlaceRef & { key: string })[] = this.allPlaces().filter((p) => p.partId !== "").map((p) => ({ partId: p.partId, start: p.start, end: p.end, key: candidateKey(p) }));
    const known: PlaceRef[] = this.ctx.known.flatMap((k) => [...k.places]);
    for (const part of this.ctx.parts) {
      if (this.ctx.parts.length > 1) host.createDiv({ cls: "pseu-review-part", text: t("modal.review.text.part", part.id) });
      const body = host.createDiv({ cls: "pseu-review-text" });
      for (const seg of textSegments(part, open, known)) {
        if (seg.kind === "plain") body.createSpan({ text: seg.text });
        else if (seg.kind === "open") body.createEl("mark", { cls: "pseu-review-open", text: seg.text, attr: { "data-key": this.domId(seg.key) } });
        else body.createSpan({ cls: "pseu-review-known", text: seg.text });
      }
    }

    const row = host.createDiv({ cls: "pseu-review-mark" });
    const label = row.createEl("label", { cls: "pseu-review-mark-label" });
    label.createSpan({ text: t("modal.review.mark.as") });
    const select = label.createEl("select", { cls: "dropdown pseu-review-mark-kind" });
    for (const kind of MARK_KINDS) select.createEl("option", { text: t(KIND_KEY[kind]), attr: { value: kind } });
    select.value = this.markKind;
    select.addEventListener("change", () => { this.markKind = select.value as CandidateKind; });
    const add = row.createEl("button", { cls: "pseu-review-mark-add", text: t("modal.review.mark.add"), attr: { type: "button" } });
    add.addEventListener("click", () => { this.addSelection(); });
  }

  /** Macht die Auswahl zur Markierung: alle freien Stellen dieses Wortlauts werden Karten. Ohne Auswahl oder ohne freie Stelle bleibt alles, wie es ist. */
  private addSelection(): void {
    const raw = (this.opts.selection?.() ?? this.lastSelection).trim();
    if (raw === "") { new Notice(t("modal.review.mark.none")); return; }
    const marks = [...this.marks, { value: raw, kind: this.markKind }];
    const places = this.ctx.mark(marks);
    if (places.length === this.markPlaces.length) { new Notice(t("modal.review.mark.notFound")); return; }
    this.marks = marks;
    this.markPlaces = places;
    // Die Karten neu bauen, die Entscheidungen zu den schon vorhandenen bleiben.
    const before = new Map(this.cards.map((c) => [c.key, c]));
    this.cards = buildCards(this.allPlaces(), this.ctx.table).map((c) => {
      const had = before.get(c.key);
      return had === undefined ? c : { ...c, way: had.way, owner: had.owner };
    });
    this.lastSelection = "";
    this.drawCards();
    this.drawText();
    this.updateApply();
  }
}

/** Das Prüffenster als `ReviewFn` der Engine. */
export function createReviewFn(app: App, opts: ReviewModalOptions = {}): ReviewFn {
  return (_candidates, ctx) => new Promise((resolve) => { new ReviewModal(app, ctx, opts, resolve).open(); });
}
