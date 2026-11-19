// Gerätedateien öffnen, vereinigen und abbruchsicher schreiben (Bauplan Aufgabe 11; Spec 8.2, 8.3, 11.2).
//
// Dies ist die sicherheitstragende Schicht des Plugins. Sie verbindet vier Dinge, die sie nicht selbst können muss: die Ablage (Kit `device-files`: Bytes hinein und heraus,
// die eigene Datei abbruchsicher), den Umschlag und die Ratsche (code-kit `key-envelope`, `key-ratchet`), den Schlüsselbund (`key-store`) und die Tabelle (Kit `placeholder-table`).
// Was hier steht, ist die Reihenfolge, in der sie benutzt werden, und die Fälle, in denen nichts geschrieben wird.
//
// ── Die Regeln, die dieser Baustein hält ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. **Erst öffnen, dann festschreiben** (Spec 8.3). Ein Kopf ist lesbar, aber erst das Öffnen beweist ihn. Das Gerät dreht deshalb nur im Arbeitsspeicher vor, öffnet damit die Dateien,
//    und überschreibt den Schlüssel im Schlüsselbund erst, wenn mindestens eine Datei des neuen Standes sich öffnen ließ UND die eigene Datei unter dem neuen Stand geschrieben ist.
//    Der Schlüssel kommt in diesem Baustein nur dann in den Schlüsselbund, und nie aus einer Eingabe.
// 2. **Reihenfolge beim Vordrehen** (Spec 8.3 Regel 1): erst die neue Gerätedatei vollständig, dann der Schlüssel. Bricht es dazwischen ab, liegt der alte Schlüssel vor, und der führt zum neuen:
//    Beim nächsten Lesen ist die eigene Datei „voraus“, das Gerät dreht wieder vor und schreibt nur noch den Schlüssel.
// 3. **Sprungdeckel** (Spec 8.3): ein Kopf mit einem Stand weiter als `maxJump` voraus wird nicht geöffnet, sondern als beschädigt gemeldet. Eine gefälschte Datei kostet höchstens `maxJump` Ableitungen.
// 4. **Nie eine leere Tabelle als eigene Fassung** (Review-Fokus 1, Spec 11.2). Ein Schlüssel ohne eine einzige geöffnete Gerätedatei heißt `locked`, mit dem Grund; geschrieben wird dann nichts,
//    auch nicht auf Anforderung (`persist` gibt `locked` zurück). Das gilt für einen leeren Ordner (`table-missing`), für Dateien einer fremden Kette und für Dateien, die sich nicht öffnen lassen.
// 5. **Was sich nicht lesen lässt, wird gemeldet und nie verworfen oder überschrieben** (CORE-DATA-01). Eine beschädigte fremde Datei bleibt, wo sie ist, und kommt als `FileProblem`;
//    die übrigen Dateien werden gelesen. Eine eigene Datei, die sich nicht öffnen lässt, wird vor dem Schreiben beiseitegelegt (`replaceDamagedOwn`), scheitert das, wird nichts geschrieben.
// 6. **Alle Schreibvorgänge laufen durch eine Warteschlange** (Spec 2, Anti-Ziel 2), und jeder Lauf liest die Ablage frisch, vereinigt in den Arbeitsspeicher und schreibt die Vereinigung, nie einen
//    Schnappschuss vom Beginn des Aufrufs. `refresh` ersetzt den Arbeitsspeicher nie, es vereinigt.
// 7. **Alles oder nichts** (Spec 8.7, Review-Fokus 5): Die Änderung eines `persist` kommt erst in den Arbeitsspeicher, wenn die Datei geschrieben ist. Was nur gelesen wurde, ist schon vorher drin.
// 8. **Nie zweimal unter demselben Stand** (Spec 8.3 Regel 2, `mustAdvanceBeforeWrite`): Trägt die zu schreibende Fassung eine Vergessen-Marke für eine ID, die dieses Gerät unter diesem Stand schon lebend
//    geschrieben hat, wird vor dem Schreiben um einen Stand weitergedreht. Das gilt für gelesene Marken (`refresh`) genauso wie für eine, die ein `persist` selbst mitbringt.
// 9. **Der alte Kettenzustand wird geleert** (`wipe`), sobald der neue im Schlüsselbund steht. Jeder Zustand, den ein Lauf ableitet, wird am Ende des Laufs geleert, auch bei einem Fehler.
//
// Kein Klartext in Meldungen: `FileProblem` trägt Art, Geräte-ID und Dateipfad (der Name der Datei ist die Geräte-ID), nie Inhalt, Namen oder Schlüsselmaterial.

import type { DeviceFileEntry, DeviceFiles } from "../vendor/kit-obsidian/device-files";
import { openEnvelope, readEnvelopeHeader, sealEnvelope } from "../vendor/kit/key-envelope";
import type { RecoveryCodeContent } from "../vendor/kit/recovery-code";
import {
  RATCHET_MAX_JUMP,
  advance,
  advanceTo,
  encryptionKey,
  wipe,
  type ChainState,
} from "../vendor/kit/key-ratchet";
import {
  emptyTable,
  mergeAllTables,
  mergeTables,
  parseTable,
  serializeTable,
  tableForgotten,
  type PlaceholderTable,
} from "../vendor/kit/placeholder-table";
import type { MemoryTable } from "../core/memory-table";
import { decodePayload, encodePayload, type DevicePayload, type PlaceholderLanguage } from "../core/payload";
import { classifyFile, codeStandOf, mustAdvanceBeforeWrite, type DeviceView, type FileHead, type WrittenAtStand } from "../core/protocol";
import { deriveStatus, type LockReason } from "../core/status";
import type { KeyStore } from "./key-store";

// ── Typen ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Was an einer Datei nicht in Ordnung ist. Die Art nennt den Grund, nie einen Inhalt. */
export type FileProblemKind =
  | "unreadable-header" //  der Kopf ist kein Kopf dieses Formats (beschädigt, abgeschnitten, fremde Datei)
  | "newer-format" //       neuere Fassung des Umschlags oder des Inhalts, dieses Plugin kann sie nicht lesen
  | "authentication" //     der Kopf stimmt, die Datei lässt sich mit dem behaupteten Stand nicht öffnen: beschädigt oder gefälscht
  | "too-far" //           der behauptete Stand liegt weiter voraus als der Sprungdeckel erlaubt; nicht geöffnet
  | "bad-content" //        geöffnet, aber der Inhalt ist nicht lesbar
  | "read-failed" //        die Ablage konnte die Datei nicht lesen
  | "invalid-name" //       der Dateiname ist keine Geräte-ID (etwa eine Konfliktkopie des Sync)
  | "own-set-aside" //      die eigene Datei ließ sich nicht öffnen und wurde beiseitegelegt (`.damaged-<zeit>`), dann neu geschrieben
  | "write-failed" //       die eigene Datei konnte nicht geschrieben werden
  | "key-write-failed"; //  die Datei ist geschrieben, der Schlüssel im Schlüsselbund konnte nicht nachgezogen werden (der nächste Lauf holt es nach)

export interface FileProblem { kind: FileProblemKind; deviceId: string | null; path: string }

/** Die Ratsche als Anschluss: der Standardwert ist das Kit, ein Test reicht Hüllen um die echten Aufrufe, um Reihenfolge und Leeren zu sehen. */
export interface RatchetPort {
  advance: typeof advance;
  advanceTo: typeof advanceTo;
  encryptionKey: typeof encryptionKey;
  wipe: typeof wipe;
  /** Sprungdeckel nach oben (Spec 8.3); Standard `RATCHET_MAX_JUMP`. */
  maxJump: number;
}

const DEFAULT_RATCHET: RatchetPort = { advance, advanceTo, encryptionKey, wipe, maxJump: RATCHET_MAX_JUMP };

export interface TableStoreOptions {
  files: DeviceFiles;
  keys: KeyStore;
  memory: MemoryTable;
  /** Name dieses Geräts für „Geräte und Schlüssel“; geht bei jedem Schreiben in die Gerätedatei. */
  deviceName(): string;
  /** Sprache der Platzhalter, wenn noch keine Gerätedatei eine nennt (Spec 8.1). */
  defaultLanguage(): PlaceholderLanguage;
  /** Meldet ein Problem einmal, solange es besteht. */
  onProblem?(p: FileProblem): void;
  ratchet?: RatchetPort;
}

/** Eine Änderung der Tabelle: neue Tatsachen (werden vereinigt) oder eine Funktion, die aus dem aktuellen Stand die neuen Tatsachen macht (läuft in der Warteschlange, sieht den frischen Stand). */
export type TableChange = PlaceholderTable | ((current: PlaceholderTable) => PlaceholderTable);

/** Nichts bei Erfolg, sonst der Grund: `locked` und `not-ready` (kein geöffneter Stand, nichts geschrieben), `storage-failed` (die Datei ließ sich nicht schreiben, der Arbeitsspeicher trägt die Änderung nicht). */
export type PersistResult = void | { error: "locked" | "not-ready" | "storage-failed" };

/** Warum ein eingegebener Code nichts öffnet oder nichts gespeichert wurde. Die Gründe des Zustands (Spec 8.3) plus die beiden Schreibfehler. */
export type AdoptFailure = Extract<LockReason, "table-missing" | "unreadable" | "foreign-chain" | "key-opens-nothing"> | "storage-failed" | "key-write-failed";
/** Ergebnis von `adopt`: bei einem Fehlschlag ist der Schlüsselbund unberührt (außer bei `key-write-failed`, dort ist die Datei geschrieben und der Schlüssel nicht abgelegt). */
export type AdoptResult = { ok: true } | { ok: false; reason: AdoptFailure };
/** Ergebnis von `setUp`: `already-set-up` heißt, dieses Gerät ist bereit und es wurde nichts geschrieben. */
export type SetUpResult = { ok: true } | { ok: false; reason: "storage-failed" | "key-write-failed" | "already-set-up" };

export interface TableStore {
  /** Liest alle Gerätedateien neu, vereinigt in den Arbeitsspeicher, dreht bei Bedarf vor und schreibt die eigene Fassung, wenn sie vom Vereinigten abweicht. Wirft nie. */
  refresh(): Promise<void>;
  /** Vereinigt `change` mit dem frischen Stand und schreibt die eigene Gerätedatei. Erst nach dem Schreiben trägt der Arbeitsspeicher die Änderung. Wirft nie. */
  persist(change?: TableChange): Promise<PersistResult>;
  /** Frischt auf, sobald die Ablage eine Änderung meldet (Vault-Ereignis oder Zeitgeber des Kits); `onChange` läuft nach dem Auffrischen. Gibt die Abmeldung zurück. */
  watch(onChange?: () => void): () => void;
  /** Weiteres Gerät (Spec 8.3): öffnet die Gerätedateien mit dem eingegebenen Code, dreht bis zur neuesten lesbaren Datei vor, schreibt die eigene Datei und legt DANACH den Schlüssel ab.
   *  Öffnet sich keine Datei, wird nichts geschrieben und der Schlüsselbund bleibt, wie er war. Verändert die Bytes von `content` nicht. Wirft nie. */
  adopt(content: RecoveryCodeContent): Promise<AdoptResult>;
  /** Erstes Gerät (Spec 8.3): schreibt die eigene Datei mit leerer Tabelle unter der neuen Kette (eine vorhandene eigene Datei wird beiseitegelegt) und legt DANACH den Schlüssel ab.
   *  Der Aufrufer hat den Code vorher gezeigt und bestätigen lassen; hier wird er als „angezeigt“ eingetragen. Verändert die Bytes von `content` nicht. Wirft nie. */
  setUp(content: RecoveryCodeContent, language: PlaceholderLanguage): Promise<SetUpResult>;
  /** Trägt ein, dass bei `stand` ein Code angezeigt wurde, und schreibt die eigene Datei (Stand des gesicherten Codes, Spec 8.3 „Stand anzeigen“). Ein kleinerer Stand senkt den Eintrag nie. */
  markCodeShown(stand: number): Promise<PersistResult>;
  /** Die Probleme des letzten Laufs. */
  problems(): readonly FileProblem[];
}

// ── Hilfen ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

type ReadEntry = Extract<DeviceFileEntry, { bytes: Uint8Array }>;

interface Opened {
  entry: ReadEntry;
  stand: number;
  payload: DevicePayload;
  table: PlaceholderTable;
}

/** Die IDs, die eine Fassung lebend trägt: Einträge, die in ihr nicht vergessen sind. Maßgeblich für Spec 8.3 Regel 2. */
function liveIds(table: PlaceholderTable): Set<string> {
  const gone = new Set(tableForgotten(table));
  return new Set(table.entries.map((e) => e.id).filter((id) => !gone.has(id)));
}

function laterRecord(a: WrittenAtStand | null, b: WrittenAtStand | null): WrittenAtStand | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.stand !== b.stand) return a.stand > b.stand ? a : b;
  return { stand: a.stand, ids: new Set([...a.ids, ...b.ids]) };
}

const maxOrNull = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** Die Dateien, die im Ordner liegen, solange sich keine öffnen lässt: je Datei mit Geräte-ID eine Zeile, Name nur, soweit ein früherer Lauf ihn kannte. */
function unopenedRows(entries: readonly DeviceFileEntry[], heads: readonly { entry: ReadEntry; head: FileHead }[]): DeviceView[] {
  const ids = new Set<string>();
  for (const e of entries) if (e.deviceId !== null) ids.add(e.deviceId);
  return [...ids].sort().map((id) => ({ deviceId: id, name: id, opened: false, stand: heads.find((h) => h.head.deviceId === id)?.head.stand ?? 0, carriesMarks: false }));
}

// ── Der Baustein ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function createTableStore(o: TableStoreOptions): TableStore {
  const ratchet = o.ratchet ?? DEFAULT_RATCHET;
  const { files, keys, memory } = o;

  // Eine Warteschlange für jeden Lauf, der liest oder schreibt: zwei gleichzeitige Läufe würden sich auf der Datei und im Arbeitsspeicher begegnen.
  let tail: Promise<unknown> = Promise.resolve();
  function queued<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Was dieses Gerät zuletzt unter welchem Stand geschrieben hat (lebende IDs); ergänzt den Blick auf die eigene Datei, falls sie sich nicht öffnen lässt. */
  let written: WrittenAtStand | null = null;
  const knownNames = new Map<string, string>();
  const reported = new Set<string>();
  let lastProblems: FileProblem[] = [];

  function publish(problems: FileProblem[]): void {
    lastProblems = problems;
    const now = new Set(problems.map((p) => `${p.kind}|${p.path}`));
    for (const k of [...reported]) if (!now.has(k)) reported.delete(k);
    for (const p of problems) {
      const k = `${p.kind}|${p.path}`;
      if (reported.has(k)) continue;
      reported.add(k);
      o.onProblem?.(p);
    }
  }

  /** Was ein Lauf mit einem eingegebenen Code zusätzlich braucht und meldet: der Code selbst (statt des Schlüsselbunds) und der Grund, falls er nichts öffnet. */
  interface AdoptRun { content: RecoveryCodeContent; failure: AdoptFailure | null }

  async function exec(change: TableChange | undefined, persisting: boolean, adoptRun: AdoptRun | null = null, codeShown: number | null = null): Promise<PersistResult> {
    const problems: FileProblem[] = [];
    const toWipe: ChainState[] = [];
    try {
      return await run(change, persisting, problems, toWipe, adoptRun, codeShown);
    } catch {
      // Eine unerwartete Ausnahme sagt nichts über Inhalte aus und wird nicht weitergereicht (ihr Text könnte Klartext tragen).
      if (adoptRun !== null) adoptRun.failure = "storage-failed";
      return { error: "storage-failed" };
    } finally {
      for (const s of toWipe) ratchet.wipe(s);
      publish(problems);
    }
  }

  async function run(
    change: TableChange | undefined, persisting: boolean, problems: FileProblem[], toWipe: ChainState[], adoptRun: AdoptRun | null, codeShown: number | null,
  ): Promise<PersistResult> {
    // Bei einem eingegebenen Code kommt der Schlüssel aus der Eingabe und nicht aus dem Schlüsselbund; der Zustand des Geräts bleibt bei einem Fehlschlag, wie er war.
    const failAdopt = (reason: AdoptFailure): PersistResult => {
      if (adoptRun !== null) adoptRun.failure = reason;
      return persisting ? { error: reason === "storage-failed" || reason === "key-write-failed" ? "storage-failed" : "locked" } : undefined;
    };
    const read = await files.readAll();
    if (!read.ok) {
      if (adoptRun !== null) return failAdopt("storage-failed");
      memory.lock("storage-failed");
      return persisting ? { error: "storage-failed" } : undefined;
    }
    const ownId = files.deviceId;
    const keyRead = adoptRun !== null ? adoptRun.content : keys.read();
    const keyCorrupt = keyRead !== null && "error" in keyRead;
    const content = keyRead !== null && !("error" in keyRead) ? keyRead : null;

    // 1. Jede Datei einordnen: Kopf lesen. Was nicht einmal einen Kopf hat, wird gemeldet und bleibt liegen.
    const heads: { entry: ReadEntry; head: FileHead }[] = [];
    for (const e of read.entries) {
      if (!("bytes" in e)) {
        problems.push({ kind: e.problem, deviceId: e.deviceId, path: e.path });
        continue;
      }
      const h = readEnvelopeHeader(e.bytes);
      if (!h.ok) {
        problems.push({ kind: h.reason === "version" ? "newer-format" : "unreadable-header", deviceId: e.deviceId, path: e.path });
        continue;
      }
      heads.push({ entry: e, head: { deviceId: e.deviceId, chainId: toHex(h.header.chainId), stand: h.header.stand } });
    }

    // 2. Kein Schlüssel: nichts zu öffnen. Dateien ohne Schlüssel heißen `locked`, nie `not-set-up` (sonst baute ein Gerät mit älterer Fassung eine zweite Kette).
    if (content === null) {
      const st = deriveStatus({
        deviceFiles: read.entries.length, readableHeads: heads.length, hasKey: false, keyCorrupt,
        openedFiles: 0, ownChainMatches: false, storageError: false,
      });
      if (st.state === "not-set-up") memory.reset();
      else if (st.reason !== null) memory.lock(st.reason, unopenedRows(read.entries, heads));
      return persisting ? { error: st.state === "not-set-up" ? "not-ready" : "locked" } : undefined;
    }

    // 3. Mit Schlüssel: jeden Kopf gegen den eigenen Schlüssel einordnen (Sprungdeckel) und die Schlüssel der Stände ableiten, nur im Arbeitsspeicher.
    // Aus dem Schlüsselbund gelesene Bytes gehören diesem Lauf und werden mit ihm geleert; ein eingegebener Code gehört dem Aufrufer, dort arbeitet der Lauf auf einer Kopie.
    const baseState: ChainState = adoptRun === null
      ? { chainId: content.chainId, stand: content.stand, chainKey: content.key }
      : { chainId: Uint8Array.from(content.chainId), stand: content.stand, chainKey: Uint8Array.from(content.key) };
    toWipe.push(baseState);
    const own = { chainId: toHex(content.chainId), stand: content.stand };
    const wanted = new Set<number>([own.stand]);
    for (const h of heads) {
      const c = classifyFile(own, h.head, ratchet.maxJump);
      if (c === "same" || c === "ahead") wanted.add(h.head.stand);
    }
    const states = new Map<number, ChainState>();
    const cryptoKeys = new Map<number, CryptoKey>();
    let prev = baseState;
    for (const s of [...wanted].sort((a, b) => a - b)) {
      const r = await ratchet.advanceTo(prev, s);
      if (!r.ok) continue;
      toWipe.push(r.value);
      states.set(s, r.value);
      prev = r.value;
      const k = await ratchet.encryptionKey(r.value);
      if (k.ok) cryptoKeys.set(s, k.value);
    }

    // 4. Öffnen. Älter oder fremde Kette: nicht geöffnet, kein Befund (das Gerät dort hat noch nicht nachgezogen, oder die Kette wurde ersetzt). Zu weit voraus: beschädigt.
    const opened: Opened[] = [];
    for (const h of heads) {
      const c = classifyFile(own, h.head, ratchet.maxJump);
      if (c === "behind" || c === "foreign-chain") continue;
      if (c === "too-far") {
        problems.push({ kind: "too-far", deviceId: h.entry.deviceId, path: h.entry.path });
        continue;
      }
      const ck = cryptoKeys.get(h.head.stand);
      const bad = (kind: FileProblemKind): void => { problems.push({ kind, deviceId: h.entry.deviceId, path: h.entry.path }); };
      if (ck === undefined) { bad("authentication"); continue; }
      const r = await openEnvelope(ck, h.entry.bytes);
      if (!r.ok) { bad(r.reason === "truncated" ? "bad-content" : "authentication"); continue; }
      const p = decodePayload(r.plaintext);
      if ("error" in p) { bad(p.error === "version" ? "newer-format" : "bad-content"); continue; }
      const t = typeof p.table === "string" ? parseTable(p.table) : null;
      if (t === null || !t.ok) { bad("bad-content"); continue; }
      opened.push({ entry: h.entry, stand: h.head.stand, payload: p, table: t.table });
    }

    // 5. Nichts geöffnet: gesperrt, mit Grund, und es wird nichts geschrieben (Regel 4).
    if (opened.length === 0) {
      const st = deriveStatus({
        deviceFiles: read.entries.length, readableHeads: heads.length, hasKey: true, keyCorrupt: false,
        openedFiles: 0, ownChainMatches: heads.some((h) => h.head.chainId === own.chainId), storageError: false,
      });
      if (adoptRun !== null) {
        const r = st.reason;
        return failAdopt(r === "table-missing" || r === "unreadable" || r === "foreign-chain" ? r : "key-opens-nothing");
      }
      if (st.reason !== null) memory.lock(st.reason, unopenedRows(read.entries, heads));
      return persisting ? { error: "locked" } : undefined;
    }

    // 6. Vereinigen: der Arbeitsspeicher bleibt, was er war, und bekommt dazu, was die Dateien wissen.
    const previous = memory.table();
    const base = mergeAllTables(previous === null ? opened.map((x) => x.table) : [previous, ...opened.map((x) => x.table)]);
    const target = Math.max(...opened.map((x) => x.stand));
    const ownOpened = opened.find((x) => x.entry.deviceId === ownId);
    const ownPresent = read.entries.some((e) => e.deviceId === ownId);
    const language: PlaceholderLanguage = ownOpened?.payload.vault.language
      ?? [...opened].sort((a, b) => (a.entry.deviceId ?? "").localeCompare(b.entry.deviceId ?? ""))[0]?.payload.vault.language
      ?? o.defaultLanguage();
    for (const x of opened) if (x.entry.deviceId !== null) knownNames.set(x.entry.deviceId, x.payload.device.name);

    const devicesOf = (table: PlaceholderTable, ownView: DeviceView | null): DeviceView[] => {
      const merged = tableForgotten(table);
      const rows: DeviceView[] = [];
      const ids = new Set<string>();
      for (const e of read.entries) if (e.deviceId !== null) ids.add(e.deviceId);
      for (const id of [...ids].sort()) {
        if (id === ownId && ownView !== null) continue;
        const op = opened.find((x) => x.entry.deviceId === id);
        const head = heads.find((x) => x.head.deviceId === id)?.head;
        const theirs = op === undefined ? null : new Set(tableForgotten(op.table));
        rows.push({
          deviceId: id,
          name: op?.payload.device.name ?? knownNames.get(id) ?? id,
          opened: op !== undefined,
          stand: op?.stand ?? head?.stand ?? 0,
          carriesMarks: theirs !== null && merged.every((m) => theirs.has(m)),
        });
      }
      if (ownView !== null) rows.push(ownView);
      return rows.sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
    };
    const ownView = (stand: number): DeviceView => ({ deviceId: ownId, name: o.deviceName(), opened: true, stand, carriesMarks: true });

    // Was gelesen wurde, steht ab jetzt im Arbeitsspeicher, auch wenn das Schreiben danach scheitert.
    const openedCodeStand = codeStandOf(opened.map((x) => ({ chainId: own.chainId, codeShownAtStand: x.payload.device.codeShownAtStand })), own.chainId);
    const codeStand = maxOrNull(openedCodeStand, codeShown);
    if (adoptRun === null) memory.open(base, { stand: ownOpened?.stand ?? content.stand, language, devices: devicesOf(base, ownOpened === undefined ? null : ownView(ownOpened.stand)), codeStand });

    // 7. Die neue Fassung: gelesenes Vereinigtes plus Änderung (erst nach dem Schreiben im Arbeitsspeicher).
    let next = base;
    if (change !== undefined) next = mergeTables(base, typeof change === "function" ? change(base) : change);
    const nextText = serializeTable(next);
    const differs = ownOpened === undefined || ownOpened.stand !== target || serializeTable(ownOpened.table) !== nextText || ownOpened.payload.device.name !== o.deviceName();
    const needFile = persisting || differs;

    let finalState = states.get(target);
    if (finalState === undefined) return failAdopt("storage-failed");
    let finalStand = target;

    if (needFile) {
      // Regel 8: nie zweimal unter demselben Stand, wenn eine ID dieser Fassung inzwischen vergessen ist.
      const fromDisk: WrittenAtStand | null = ownOpened === undefined ? null : { stand: ownOpened.stand, ids: liveIds(ownOpened.table) };
      const record = laterRecord(written, fromDisk);
      if (mustAdvanceBeforeWrite(record, target, new Set(tableForgotten(next)))) {
        const adv = await ratchet.advance(finalState);
        if (!adv.ok) {
          problems.push({ kind: "write-failed", deviceId: ownId, path: files.ownPath });
          return failAdopt("storage-failed");
        }
        toWipe.push(adv.value);
        finalState = adv.value;
        finalStand = adv.value.stand;
      }
    }

    // 8. Schreiben: erst die Datei vollständig, dann (nur wenn der Stand sich geändert hat) der Schlüssel (Regel 2).
    let fileOk = !needFile;
    if (needFile) {
      const ck = await ratchet.encryptionKey(finalState);
      if (!ck.ok) {
        problems.push({ kind: "write-failed", deviceId: ownId, path: files.ownPath });
        return failAdopt("storage-failed");
      }
      const payload: DevicePayload = {
        format: "pseudonymizer-device",
        version: 1,
        device: { name: o.deviceName(), codeShownAtStand: maxOrNull(ownOpened?.payload.device.codeShownAtStand ?? null, codeShown) },
        vault: { language },
        table: nextText,
      };
      const sealed = await sealEnvelope(ck.value, { deviceId: ownId, chainId: finalState.chainId, stand: finalStand }, encodePayload(payload));
      if (!sealed.ok) {
        problems.push({ kind: "write-failed", deviceId: ownId, path: files.ownPath });
        return failAdopt("storage-failed");
      }
      // Eine eigene Datei, die wir nicht öffnen konnten, wird nie überschrieben: erst beiseitelegen, scheitert das, wird nichts geschrieben (Regel 5).
      const setAside = ownPresent && ownOpened === undefined;
      const w = setAside ? await files.replaceDamagedOwn(sealed.bytes) : await files.writeOwn(sealed.bytes);
      if (!w.ok) {
        problems.push({ kind: "write-failed", deviceId: ownId, path: files.ownPath });
        return failAdopt("storage-failed");
      }
      if (setAside) problems.push({ kind: "own-set-aside", deviceId: ownId, path: files.ownPath });
      fileOk = true;
      written = { stand: finalStand, ids: liveIds(next) };
    } else if (ownOpened !== undefined) {
      written = laterRecord(written, { stand: ownOpened.stand, ids: liveIds(ownOpened.table) });
    }

    // Ein eingegebener Code kommt immer in den Schlüsselbund (erst jetzt, nachdem eine Datei mit ihm geöffnet und die eigene geschrieben ist); ein Schlüssel von dort nur, wenn er vorgedreht wurde.
    let keyFailed = false;
    if (fileOk && (adoptRun !== null || content.stand < finalStand)) {
      const kw = keys.write({ chainId: finalState.chainId, stand: finalStand, key: finalState.chainKey });
      if (kw !== undefined) { problems.push({ kind: "key-write-failed", deviceId: ownId, path: files.ownPath }); keyFailed = true; }
    }

    if (fileOk) memory.open(next, { stand: finalStand, language, devices: devicesOf(next, ownView(finalStand)), codeStand: maxOrNull(openedCodeStand, maxOrNull(codeShown, ownOpened?.payload.device.codeShownAtStand ?? null)) });
    if (keyFailed && adoptRun !== null) adoptRun.failure = "key-write-failed";
    return undefined;
  }

  async function adopt(content: RecoveryCodeContent): Promise<AdoptResult> {
    const ctx: AdoptRun = { content, failure: null };
    await queued(() => exec(undefined, true, ctx));
    return ctx.failure === null ? { ok: true } : { ok: false, reason: ctx.failure };
  }

  async function setUpJob(content: RecoveryCodeContent, language: PlaceholderLanguage): Promise<SetUpResult> {
    const problems: FileProblem[] = [];
    const toWipe: ChainState[] = [];
    try {
      if (memory.state() === "ready") return { ok: false, reason: "already-set-up" };
      const read = await files.readAll();
      if (!read.ok) return { ok: false, reason: "storage-failed" };
      const ownId = files.deviceId;
      // Die neue Kette lebt nur im Arbeitsspeicher, bis die Datei steht (Spec 8.3: erst die Datei, dann der Schlüssel).
      const state: ChainState = { chainId: Uint8Array.from(content.chainId), stand: content.stand, chainKey: Uint8Array.from(content.key) };
      toWipe.push(state);
      const ck = await ratchet.encryptionKey(state);
      if (!ck.ok) return { ok: false, reason: "storage-failed" };
      const table = emptyTable();
      const payload: DevicePayload = {
        format: "pseudonymizer-device",
        version: 1,
        device: { name: o.deviceName(), codeShownAtStand: content.stand },
        vault: { language },
        table: serializeTable(table),
      };
      const sealed = await sealEnvelope(ck.value, { deviceId: ownId, chainId: state.chainId, stand: state.stand }, encodePayload(payload));
      if (!sealed.ok) return { ok: false, reason: "storage-failed" };
      // Eine vorhandene eigene Datei gehört einer anderen Kette oder ist unlesbar: beiseitelegen, nie überschreiben (Regel 5).
      const setAside = read.entries.some((e) => e.deviceId === ownId);
      const w = setAside ? await files.replaceDamagedOwn(sealed.bytes) : await files.writeOwn(sealed.bytes);
      if (!w.ok) {
        problems.push({ kind: "write-failed", deviceId: ownId, path: files.ownPath });
        return { ok: false, reason: "storage-failed" };
      }
      if (setAside) problems.push({ kind: "own-set-aside", deviceId: ownId, path: files.ownPath });
      written = { stand: state.stand, ids: new Set() };
      const kw = keys.write({ chainId: Uint8Array.from(content.chainId), stand: content.stand, key: Uint8Array.from(content.key) });
      if (kw !== undefined) {
        problems.push({ kind: "key-write-failed", deviceId: ownId, path: files.ownPath });
        return { ok: false, reason: "key-write-failed" };
      }
      memory.open(table, {
        stand: state.stand,
        language,
        devices: [{ deviceId: ownId, name: o.deviceName(), opened: true, stand: state.stand, carriesMarks: true }],
        codeStand: content.stand,
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: "storage-failed" };
    } finally {
      for (const s of toWipe) ratchet.wipe(s);
      publish(problems);
    }
  }

  return {
    refresh: async () => { await queued(() => exec(undefined, false)); },
    persist: (change) => queued(() => exec(change, true)),
    adopt,
    setUp: (content, language) => queued(() => setUpJob(content, language)),
    markCodeShown: (stand) => queued(() => exec(undefined, true, null, stand)),
    watch(onChange) {
      return files.watch(() => { void queued(() => exec(undefined, false)).then(() => { onChange?.(); }); });
    },
    problems: () => lastProblems,
  };
}
