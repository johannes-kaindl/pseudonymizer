// vendored from code-kit@0.91.1, src/ts/pure/replaceable-spans.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Origin: lifted from vault-rag `src/protect_markup.ts` (vault-rag@09d73bc, "Wikilinks, Einbettungen und Code beim Umformulieren schützen", Welle 14; that file took its
// wikilink/embed expressions from wikijs-maintainer `src/core/links.ts`), Welle 36, kp2d, order 7 of the pseudonymizer design (spec sections 7.2 and 8.4).
//
// WHAT WAS LIFTED, AND WHAT WAS NOT. vault-rag's file does three jobs: it finds the places a model must not touch (`maskProtected`), it hides them behind tokens and puts them
// back (`maskProtected` / `restore`), and it counts links before and after (`extractLinks`, `compareLinks`, `integrityProblem`). Only the first is the pseudonymizer's question
// ("where may text be replaced?"), and only the first is here: the kind of place it protects (wikilink, embed, inline code, fenced block) and the answer "a span of the text".
// The token round trip and the link count stay in vault-rag, where they belong to the reformat flow. The function names the places, it replaces nothing and masks nothing
// (the contract of the order): a caller replaces only inside {@link listReplaceableSpans}.
//
// THREE DEVIATIONS from the original, each measured (tests/replaceable-spans.test.ts):
//  1. The fence reader is `listAllFences` of `fences.ts`, not vault-rag's `replaceFences`: it knows a fence in a quote, in a callout and under a list marker, which the original line
//     loop did not (a fence in a callout was ordinary text for it and the code in it would have been replaced).
//  2. Inline code is `codeSpans` of `critic-markup.ts` (a backtick run closed by a run of the same length inside the same paragraph), run on the text with the fences blanked. The
//     original expression (a lazy run behind a back reference) is quadratic on one long run of backticks (measured 2026-11-19: 35-fold for a 5-fold input).
//  3. The wikilink and embed expressions read `[^\[\]\n]+` where the original read `[^\]]+`: with the original, `[[[[[…` scans to the end from every start (quadratic), and a
//     target with a bracket or a line break is no target in Obsidian either. The text a link holds is the same for every link the original found and Obsidian accepts.
//
// WHAT IS PROTECTED (the kinds in {@link ProtectedKind}); the stages run in this order and a place that an earlier stage holds is blanked for the later ones, so a `$` in code is
// no math and a `#tag` in a comment is no tag:
//  - `frontmatter`: a leading `---` block (to the line `---` or `...`).
//  - `fence`: every fenced block, flat and nested, an unclosed one to the end of the text.
//  - `comment`: `<!-- … -->` and `%% … %%` (an unclosed one is NOT protected: a stray `<!--` or `%%` must not hide the rest of a note from the pseudonymizer).
//  - `inline-code`.
//  - `math`: `$$ … $$` (over lines) and `$…$` in one line (Obsidian's rule: the opening `$` is not followed by a blank, the closing one is not preceded by a blank nor followed by a digit).
//  - `embed`: the whole `![[…]]`. `wikilink`: the whole `[[…]]`, or with `wikilinkAlias: "free"` only `[[target|` and `]]`, so the alias (the display text) stays replaceable.
//  - `link-target`: the `](target "title")` of a Markdown link or image (the text in front of it, or the alt text, stays replaceable), the `][ref]` of a reference use and the
//    `[ref]: url` of a definition. `mailto-target`: the same for a target that starts with `mailto:` — its own kind so the pseudonymizer can allow it (spec 8.4: an e-mail address is replaced in a `mailto:` target).
//  - `url`: a bare `http://…`, `https://…`, `ftp://…`, `file://…`, `obsidian://…` or `www.…` up to a blank, `<`, `>` or a quote; trailing `.,;:!?` and an unbalanced `)` stay outside.
//  - `tag`: `#tag` (with at least one non-digit, as Obsidian has it; `# Heading` and `#2024` are none).
// An e-mail address in `<max@example.org>` (an autolink) is not protected at all: it is replaceable, as the spec says.
//
// NAMED LIMITS: an HTML comment that contains a fence marker is read as a fence (the fences are read first); an indented code block is not code; a fence inside a nested fence
// of a different quote depth is the business of `listAllFences`; footnote definitions, wiki-style `[[a|b]]` inside a table cell with an escaped pipe (`\|`) are read as written (the
// alias then starts at `\|`); HTML tags with attributes (`<a href="…">`) are not protected, only autolinks' URLs are (a URL up to `>`).
// A Markdown link target is read to its closing parenthesis within 2 000 characters and the same line; longer ones are not protected.
//
// LINEAR: every stage is one pass or a pass over a bounded window per start; `tests/replaceable-spans.test.ts` counts the string work and runs the clock over the shapes that
// reach the expensive path, and a mutant with the original expressions turns it red. Nothing throws; a non-string gives no spans.

import { codeSpans } from "./critic-markup";
import { listAllFences } from "./fences";

/** Where a protected place comes from. */
export type ProtectedKind =
  | "frontmatter"
  | "fence"
  | "comment"
  | "inline-code"
  | "math"
  | "embed"
  | "wikilink"
  | "link-target"
  | "mailto-target"
  | "url"
  | "tag";

/** A half-open range `[start, end)` of the text. */
export interface TextRange {
  start: number;
  end: number;
}

/** A place in which nothing may be replaced. */
export interface ProtectedSpan extends TextRange {
  kind: ProtectedKind;
}

export interface ReplaceableOptions {
  /** Kinds that are NOT protected. The pseudonymizer passes `["mailto-target"]` so an address in a `mailto:` target is replaced (spec 8.4). Default none. */
  allow?: readonly ProtectedKind[];
  /** `"free"` (default): in `[[target|alias]]` only the target is protected, the alias is display text. `"protected"`: the whole link is, as in vault-rag. */
  wikilinkAlias?: "free" | "protected";
}

const MAX_TARGET = 2000;

// ---- helpers ----------------------------------------------------------------------------------

/** `text` with the characters of `spans` replaced by blanks (line breaks stay, so lines and paragraphs keep their places). */
function blank(text: string, spans: readonly TextRange[]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const s of sorted) {
    const start = Math.max(s.start, at);
    if (s.end <= start) continue;
    parts.push(text.slice(at, start));
    parts.push(text.slice(start, s.end).replace(/[^\n]/g, " "));
    at = s.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** Offsets of the first character of every line (split at `\n`, as `listAllFences` splits). */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/** All occurrences of `re` (copied: a global expression carries `lastIndex`) as `[index, match]`. */
function allMatches(re: RegExp, s: string): RegExpExecArray[] {
  const copy = new RegExp(re.source, re.flags);
  const out: RegExpExecArray[] = [];
  for (let m = copy.exec(s); m !== null; m = copy.exec(s)) {
    out.push(m);
    if (m[0] === "") copy.lastIndex++;
  }
  return out;
}

// ---- the stages -----------------------------------------------------------------------------------

function frontmatterSpan(text: string): ProtectedSpan | null {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const re = /^(?:---|\.\.\.)[ \t]*$/gm;
  re.lastIndex = text.indexOf("\n") + 1;
  const m = re.exec(text);
  return m ? { start: 0, end: m.index + m[0].length, kind: "frontmatter" } : null;
}

function fenceSpans(text: string): ProtectedSpan[] {
  const starts = lineStarts(text);
  const out: ProtectedSpan[] = [];
  for (const f of listAllFences(text)) {
    const start = starts[f.openLine];
    if (start === undefined) continue;
    const next = starts[f.closeLine + 1];
    out.push({ start, end: next === undefined ? text.length : next - 1, kind: "fence" });
  }
  return out;
}

/** The ranges from each `open` to the next `close` behind it, whole delimiters included. The first `open` that finds no `close` ends the search: no later one has a `close` either, so a
 *  text full of unclosed openers costs one pass (a lazy `[\s\S]*?` expression would read to the end from every one of them). */
function delimited(text: string, open: string, close: string): TextRange[] {
  const out: TextRange[] = [];
  let from = 0;
  for (;;) {
    const a = text.indexOf(open, from);
    if (a < 0) break;
    const b = text.indexOf(close, a + open.length);
    if (b < 0) break;
    out.push({ start: a, end: b + close.length });
    from = b + close.length;
  }
  return out;
}

function commentSpans(text: string): ProtectedSpan[] {
  return [...delimited(text, "<!--", "-->"), ...delimited(text, "%%", "%%")].map((r) => ({ ...r, kind: "comment" as const }));
}

function inlineCodeSpans(work: string): ProtectedSpan[] {
  return codeSpans(work).inline.map(([start, end]) => ({ start, end, kind: "inline-code" as const }));
}

function mathSpans(work: string): ProtectedSpan[] {
  const out: ProtectedSpan[] = delimited(work, "$$", "$$").map((r) => ({ ...r, kind: "math" as const }));
  // inline `$…$` on the rest, from `$` to `$` (a search per line would read to the end of the text from every line that has none); `nl` is the end of the line of `i`
  const rest = blank(work, out);
  let i = rest.indexOf("$");
  let nl = -1;
  while (i >= 0) {
    if (i >= nl) {
      const k = rest.indexOf("\n", i);
      nl = k < 0 ? rest.length : k;
    }
    const next = rest.charAt(i + 1);
    if ((i > 0 && rest.charAt(i - 1) === "\\") || next === "" || next === "$" || next === " " || next === "\t" || next === "\n") {
      i = rest.indexOf("$", i + 1);
      continue;
    }
    // the closing `$`: not escaped, not behind a blank, not in front of a digit
    let end = -1;
    for (let j = rest.indexOf("$", i + 1); j >= 0 && j < nl; j = rest.indexOf("$", j + 1)) {
      const before = rest.charAt(j - 1);
      const after = rest.charAt(j + 1);
      if (before !== "\\" && before !== " " && before !== "\t" && !(after >= "0" && after <= "9")) {
        end = j + 1;
        break;
      }
    }
    // a closer is valid or not whatever the opener: none for this one means none for any later one in the line
    if (end >= 0) out.push({ start: i, end, kind: "math" });
    i = rest.indexOf("$", end < 0 ? nl : end);
  }
  return out;
}

const EMBED_RE = /!\[\[([^[\]\n]+)\]\]/g;
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

function wikilinkSpans(work: string, aliasFree: boolean): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  for (const m of allMatches(EMBED_RE, work)) out.push({ start: m.index, end: m.index + m[0].length, kind: "embed" });
  // a wikilink inside an embed (`![[a]]` holds `[[a]]`) overlaps it and is merged into it at the end: no need to blank the embeds first
  for (const m of allMatches(WIKILINK_RE, work)) {
    const start = m.index;
    const end = start + m[0].length;
    const bar = (m[1] ?? "").indexOf("|");
    if (!aliasFree || bar < 0) out.push({ start, end, kind: "wikilink" });
    else {
      // `[[target|` and `]]` are protected, the alias between them is display text
      out.push({ start, end: start + 2 + bar + 1, kind: "wikilink" });
      out.push({ start: end - 2, end, kind: "wikilink" });
    }
  }
  return out;
}

/** The end (exclusive) of the target that opens at `open` (the index just behind `(`): to the balanced `)`, within the same line and {@link MAX_TARGET} characters; -1 when it does not close. */
function targetEnd(s: string, open: number): number {
  let depth = 1;
  const limit = Math.min(s.length, open + MAX_TARGET);
  for (let i = open; i < limit; i++) {
    const ch = s.charAt(i);
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const REF_USE_RE = /\]\[([^[\]\n]*)\]/g;
const REF_DEF_RE = /^ {0,3}\[[^[\]\n]+\]:[ \t]*(\S+)/gm;

function linkTargetSpans(work: string): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  // inline links and images: `](target)`
  for (let i = work.indexOf("]("); i >= 0; i = work.indexOf("](", i + 2)) {
    const end = targetEnd(work, i + 2);
    if (end < 0) continue;
    const target = work.slice(i + 2, end - 1).trimStart();
    out.push({ start: i + 1, end, kind: /^<?mailto:/i.test(target) ? "mailto-target" : "link-target" });
  }
  for (const m of allMatches(REF_USE_RE, work)) out.push({ start: m.index + 1, end: m.index + m[0].length, kind: "link-target" });
  for (const m of allMatches(REF_DEF_RE, work)) {
    const url = m[1] ?? "";
    const start = m.index + m[0].length - url.length;
    out.push({ start, end: start + url.length, kind: /^<?mailto:/i.test(url) ? "mailto-target" : "link-target" });
  }
  return out;
}

const URL_RE = /(^|[^A-Za-z0-9+.-])((?:(?:https?|ftp|sftp|ssh|git|file|obsidian):\/\/|www\.)[^\s<>"'`\]]+)/gi;

function urlSpans(work: string): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  for (const m of allMatches(URL_RE, work)) {
    const start = m.index + (m[1] ?? "").length;
    let hit = m[2] ?? "";
    // trailing punctuation belongs to the sentence; a `)` only when the URL has no `(` for it
    for (;;) {
      const last = hit.charAt(hit.length - 1);
      if (last !== "" && ".,;:!?".includes(last)) hit = hit.slice(0, -1);
      else if (last === ")" && countChar(hit, ")") > countChar(hit, "(")) hit = hit.slice(0, -1);
      else break;
    }
    if (hit.length > 0) out.push({ start, end: start + hit.length, kind: "url" });
  }
  return out;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = s.indexOf(ch); i >= 0; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

const TAG_RE = /(^|[^A-Za-z0-9_#&/\\À-ÖØ-öø-ÿĀ-ſ])(#[A-Za-z0-9_/\-À-ÖØ-öø-ÿĀ-ſ]+)/g;

function tagSpans(work: string): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  for (const m of allMatches(TAG_RE, work)) {
    const tag = m[2] ?? "";
    if (!/[^0-9]/.test(tag.slice(1))) continue; // `#2024` is no tag
    const start = m.index + (m[1] ?? "").length;
    out.push({ start, end: start + tag.length, kind: "tag" });
  }
  return out;
}

// ---- the answer -------------------------------------------------------------------------------------

/** The places of `text` in which nothing may be replaced, sorted by start; places that overlap are merged (the kind of the one that starts first stays), places that touch stay apart.
 *  Reports the places, masks nothing. A non-string gives `[]`. */
export function listProtectedSpans(text: string, opts: ReplaceableOptions = {}): ProtectedSpan[] {
  if (typeof text !== "string" || text === "") return [];
  const all: ProtectedSpan[] = [];
  let work = text;
  // each stage reads the text with what the stages before it hold blanked
  const stage = (found: ProtectedSpan[]): void => {
    for (const s of found) all.push(s);
    work = blank(work, found);
  };
  const fm = frontmatterSpan(text);
  stage(fm ? [fm] : []);
  stage(fenceSpans(text));
  stage(commentSpans(work));
  stage(inlineCodeSpans(work));
  stage(mathSpans(work));
  stage(wikilinkSpans(work, opts.wikilinkAlias !== "protected"));
  stage(linkTargetSpans(work));
  stage(urlSpans(work));
  stage(tagSpans(work));

  const allow = new Set<ProtectedKind>(opts.allow ?? []);
  const kept = all.filter((s) => s.end > s.start && !allow.has(s.kind)).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: ProtectedSpan[] = [];
  for (const s of kept) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** The places of `text` in which text may be replaced: what {@link listProtectedSpans} leaves, sorted, disjoint, never empty. A text without protected places is one span
 *  over all of it; an empty or non-string text has none. */
export function listReplaceableSpans(text: string, opts: ReplaceableOptions = {}): TextRange[] {
  if (typeof text !== "string" || text === "") return [];
  const out: TextRange[] = [];
  let at = 0;
  for (const p of listProtectedSpans(text, opts)) {
    if (p.start > at) out.push({ start: at, end: p.start });
    at = Math.max(at, p.end);
  }
  if (at < text.length) out.push({ start: at, end: text.length });
  return out;
}
