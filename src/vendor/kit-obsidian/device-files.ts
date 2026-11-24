// vendored from obsidian-kit@0.107.0, src/obsidian/device-files.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Gerätedateien-Ablage (Welle 36, kp1b, Teil D; Bestellung 10 der Design-Linie pseudonymizer, Spec 2026-11-18 § 8.2 und § 8.3 mit dem Nachtrag des Bestellers).
//
// Vertragssatz: Je Gerät eine Datei in einem Vault-Ordner. Nur das eigene Gerät schreibt seine Datei; gelesen werden alle. Ein abgebrochener Schreibvorgang zerstört die letzte gute Fassung nicht. Der Baustein
// kennt den Inhalt nicht (Bytes hinein, Bytes heraus); er prüft weder Format noch Schlüssel. Was beschädigt ist, entscheidet der Aufrufer, der die Bytes öffnet.
//
// ── Warum der Schreibweg so aussieht (gemessen, REGISTRY „Eine Datei ersetzen, ohne sie zerstören zu können“; seit Welle 36, h2b, Bestellung 13 liegt er in `replace-file-safely.ts`, hier gilt er unverändert) ────────────────────────────────────────────────────────────────
// `adapter.writeBinary` kürzt das Ziel auf 0 Bytes, bevor es die ersten Bytes liefert, und `adapter.rename` ersetzt kein vorhandenes Ziel (es wirft). Ein Schreiben in die Zieldatei oder ein `rename` über sie hinweg
// wäre also nicht abbruchsicher. Der Baustein schreibt deshalb nie in die Zieldatei:
//   1. `<id><ext>.tmp` schreiben, zurücklesen und Byte für Byte vergleichen (ein Fehler oder eine Abweichung bricht ab, die Zieldatei ist unberührt);
//   2. die bisherige Fassung per `rename` nach `<id><ext>.prev` beiseitelegen (eine vollständige Datei wechselt den Namen, es wird nichts geschrieben);
//   3. `.tmp` per `rename` auf den Zielnamen setzen (das Ziel fehlt jetzt, das `rename` ist erlaubt);
//   4. `.prev` entfernen.
// An jedem Abbruchpunkt liegt eine vollständige Fassung: vor 2 die Zieldatei, zwischen 2 und 3 nur `.prev` (die alte Fassung), nach 3 die Zieldatei. **Der Leser nimmt deshalb die Zieldatei, und fehlt sie, `.prev`.**
// Der Ausfallmodus „fehlt“ statt „korrupt“ ist der, den die REGISTRY für `remove` + `rename` beschreibt; hier fehlt die Zieldatei höchstens einen Augenblick, und `.prev` deckt ihn ab. Eine `.tmp`-Datei vertraut der
// Leser nie (sie kann halb geschrieben sein); sie wird beim nächsten Schreiben von `writeBinary` ersetzt (es kürzt ein vorhandenes Ziel), ein eigenes Entfernen wäre totes Gerät. `.prev` und `.tmp` enden nicht auf der Endung der Gerätedatei und zählen nicht als Gerät.
//
// ── Entscheidungen (jede mit Grund) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// - **Über `app.vault.adapter`, kein Node-`fs`** (Spec 8.2: sonst kostet es die Review-Note und geht am Telefon nicht). Alle Zugriffe laufen durch `DeviceFilePorts`, damit die Tests Abbrüche an jedem Punkt
//   einspielen können; der Fake-DOM der Tests sieht kein Dateisystem.
// - **Eine Warteschlange für alle Schreibvorgänge dieses Geräts** (`writeOwn`, `replaceDamagedOwn`, `setAsideOwn`, `removeForeign`): zwei gleichzeitige `writeOwn` würden sich sonst auf `.tmp` und `.prev` begegnen.
// - **Leere Bytes werden abgelehnt** (`invalid-input`): eine leere Datei ist von einer gekürzten nicht zu unterscheiden, und der Baustein hat keinen Grund, eine zu schreiben.
// - **Gelesen wird die Vereinigung aller Dateien einschließlich der unlesbaren**: `readAll` gibt je Datei einen Eintrag, auch bei einem Lesefehler und bei einem ungültigen Namen (`problem`), statt sie zu übergehen
//   (CORE-DATA-01: still verworfen ist der teurere Fehler; der Zustand des Plugins zählt jede Datei der Endung).
// - **Die Geräte-ID ist zufällig und liegt je Gerät und Vault lokal** (`loadOrCreateDeviceId`, `app.loadLocalStorage`, nie im Vault, nie synchronisiert). Format `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`: der Name der Datei.
// - **Beschädigte eigene Datei: beiseitelegen, nicht überschreiben** (`setAsideOwn`, `replaceDamagedOwn`): umbenannt nach `<id><ext>.damaged-<Stempel>`; scheitert das, wird **nichts geschrieben** und der Fehler als Wert
//   zurückgegeben (kein Datenverlust). Das Ergebnis der Namenswahl ist auch ein Name, der nicht auf die Endung der Gerätedatei endet und deshalb nie als Gerät gelesen wird.
// - **Eine fremde Gerätedatei zu löschen ist eine eigene Funktion** (`removeForeign`), die der Aufrufer bewusst nach der Übernahme ihres lesbaren Inhalts ruft, nie eine Nebenwirkung von `readAll` oder `writeOwn`.
//   Sie verweigert die eigene Datei und entfernt auch `.prev`, damit der Leser sie nicht aus `.prev` wiederbelebt.
// - **Änderungen** (`watch`): Vault-Ereignisse (`create`, `modify`, `delete`, `rename`) lösen eine Prüfung aus; dazu prüft ein Zeitgeber alle 30 Sekunden (Vorgabe), damit eine von außen geänderte Datei auch dann binnen
//   60 Sekunden bemerkt wird, wenn Obsidian für den Dateityp kein Ereignis meldet (offen, Messung der Sync-Endung in Etappe 0 des Bestellers). Die Prüfung vergleicht Größe und Änderungszeit je Datei, die eigenen Schreibvorgänge
//   setzen die Grundlinie der eigenen Dateien nach, damit sie sich nicht selbst melden.
// - **Der lesbare Kopf wird hier nicht gelesen.** Der Auftrag sagt „nur zur Anzeige“; die Anzeige (Gerätename, Schlüsselstand) gehört dem Umschlag aus code-kit, den der Aufrufer öffnet. Der Baustein liefert
//   Größe und Änderungszeit für eine Anzeige „zuletzt geändert“.
//
// Wirft nie bei Betrieb (Fehler sind Werte); nur falsch gebaute Optionen werfen beim Anlegen einen `RangeError` (Programmierfehler).

import type { App, DataAdapter } from "obsidian";
import { errorMessage } from "../kit/error-message";
import { stampedName } from "../kit/rotation";
import { replaceFileSafely } from "./replace-file-safely";

/** Format der Geräte-ID und damit des Dateinamens. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface DeviceFilePorts {
  adapter: Pick<DataAdapter, "exists" | "mkdir" | "list" | "stat" | "readBinary" | "writeBinary" | "remove" | "rename">;
  now(): number;
  /** Meldet jeden Pfad, den Obsidian als erstellt, geändert, gelöscht oder umbenannt (alter und neuer Pfad) meldet; gibt die Abmeldung zurück. */
  onVaultEvent(cb: (path: string) => void): () => void;
  /** Ein wiederkehrender Zeitgeber; gibt die Abmeldung zurück. */
  setInterval(cb: () => void, ms: number): () => void;
}

/** Die Ports aus einer `App`: `vault.adapter`, `Date.now`, die vier Vault-Ereignisse, `window.setInterval`. */
export function defaultDeviceFilePorts(app: App): DeviceFilePorts {
  return {
    adapter: app.vault.adapter,
    now: () => Date.now(),
    onVaultEvent(cb) {
      const refs = [
        app.vault.on("create", (f) => { cb(f.path); }),
        app.vault.on("modify", (f) => { cb(f.path); }),
        app.vault.on("delete", (f) => { cb(f.path); }),
        app.vault.on("rename", (f, oldPath) => { cb(f.path); cb(oldPath); }),
      ];
      return () => { for (const r of refs) app.vault.offref(r); };
    },
    setInterval(cb, ms) {
      const id = window.setInterval(cb, ms);
      return () => { window.clearInterval(id); };
    },
  };
}

/** Die zufällige Geräte-ID dieses Geräts in diesem Vault, oder `null`, wenn sie sich nicht festhalten lässt. Liegt in `app.loadLocalStorage` (je Gerät und Vault, nie synchronisiert), nicht im Vault.
 *  Eine gespeicherte ID im falschen Format wird ersetzt. Nach dem Speichern wird zurückgelesen: eine ID, die beim nächsten Start eine andere wäre, wäre ein Gerät, das sich bei jedem Start eine neue Datei anlegt. */
export function loadOrCreateDeviceId(
  app: Pick<App, "loadLocalStorage" | "saveLocalStorage">,
  storageKey: string,
  random: (bytes: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string | null {
  try {
    const stored: unknown = app.loadLocalStorage(storageKey);
    if (typeof stored === "string" && DEVICE_ID_PATTERN.test(stored)) return stored;
    const id = Array.from(random(8), (b) => b.toString(16).padStart(2, "0")).join("");
    app.saveLocalStorage(storageKey, id);
    return app.loadLocalStorage(storageKey) === id ? id : null;
  } catch {
    return null;
  }
}

export type DeviceFileError = "storage-failed" | "invalid-input" | "own-device";
export type WriteResult = { ok: true } | { ok: false; error: DeviceFileError; message: string };
export type SetAsideResult = { ok: true; movedTo: string | null } | { ok: false; error: DeviceFileError; message: string };
export type RemoveResult = { ok: true; removed: boolean } | { ok: false; error: DeviceFileError; message: string };

/** Eine Datei der Ablage. `source: "previous"`: die Zieldatei fehlt (ein Schreibvorgang wurde zwischen Beiseitelegen und Umbenennen abgebrochen), gelesen wurde die letzte gute Fassung aus `.prev`. */
export type DeviceFileEntry =
  | { deviceId: string; own: boolean; path: string; source: "file" | "previous"; bytes: Uint8Array; mtime: number; size: number }
  | { deviceId: string | null; own: false; path: string; problem: "invalid-name" | "read-failed"; message: string };

export type ReadAllResult = { ok: true; entries: DeviceFileEntry[] } | { ok: false; error: "storage-failed"; message: string };

export interface DeviceFileChange { deviceId: string; kind: "added" | "modified" | "removed"; own: boolean }

export interface DeviceFilesOptions {
  /** Der Ordner im Vault, ohne Schrägstrich am Anfang und Ende (etwa `_pseudonymizer`). */
  folder: string;
  /** Die Endung der Gerätedatei mit Punkt (etwa `.pseudo`); nur Kleinbuchstaben und Ziffern. */
  extension: string;
  /** Die ID dieses Geräts (`DEVICE_ID_PATTERN`). */
  deviceId: string;
  ports: DeviceFilePorts;
}

export interface DeviceFiles {
  readonly deviceId: string;
  /** Der Pfad der eigenen Gerätedatei. */
  readonly ownPath: string;
  /** Schreibt die eigene Datei abbruchsicher (siehe Kopf). Fremde Dateien fasst es nie an. */
  writeOwn(bytes: Uint8Array): Promise<WriteResult>;
  /** Liest alle Gerätedateien (die eigene und die fremden), je Datei ein Eintrag, auch bei Lesefehlern. Ein fehlender Ordner ist eine leere Liste. */
  readAll(): Promise<ReadAllResult>;
  /** Legt die eigene Datei beiseite (`<id><ext>.damaged-<Stempel>`), ohne etwas zu schreiben. `movedTo: null`: es gab sie nicht. */
  setAsideOwn(): Promise<SetAsideResult>;
  /** Beiseitelegen, dann neu schreiben. Scheitert das Beiseitelegen, wird NICHTS geschrieben. */
  replaceDamagedOwn(bytes: Uint8Array): Promise<WriteResult>;
  /** Löscht die Datei eines FREMDEN Geräts samt `.prev`; der Aufrufer ruft es bewusst, nachdem er ihren lesbaren Inhalt übernommen hat. Die eigene Datei verweigert es (`own-device`). */
  removeForeign(deviceId: string): Promise<RemoveResult>;
  /** Meldet Änderungen an den Gerätedateien (Vault-Ereignis oder Zeitgeber, Vorgabe alle 30 Sekunden). Gibt die Abmeldung zurück; nach ihr kommt kein Aufruf mehr. */
  watch(onChange: (changes: DeviceFileChange[]) => void, opts?: { intervalMs?: number }): () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_ASIDE_TRIES = 20;

function fail(error: DeviceFileError, message: string): { ok: false; error: DeviceFileError; message: string } {
  return { ok: false, error, message };
}

export function createDeviceFiles(o: DeviceFilesOptions): DeviceFiles {
  if (!DEVICE_ID_PATTERN.test(o.deviceId)) throw new RangeError(`Ungültige Geräte-ID: ${o.deviceId}`);
  if (!/^\.[a-z0-9]{1,16}$/.test(o.extension)) throw new RangeError(`Ungültige Endung: ${o.extension}`);
  if (o.folder === "" || o.folder.startsWith("/") || o.folder.endsWith("/") || o.folder.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new RangeError(`Ungültiger Ordner: ${o.folder}`);
  }
  const { ports } = o;
  const adapter = ports.adapter;
  const ext = o.extension;
  const fileOf = (id: string): string => `${o.folder}/${id}${ext}`;
  const ownPath = fileOf(o.deviceId);

  // Alle Schreibvorgänge nacheinander; ein Fehler in einem Glied hält die Kette nicht an.
  let tail: Promise<unknown> = Promise.resolve();
  function queued<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function writeNow(bytes: Uint8Array): Promise<WriteResult> {
    if (bytes.byteLength === 0) return fail("invalid-input", "Eine leere Gerätedatei wird nicht geschrieben.");
    // Der Schreibweg (`.tmp`, Zurücklesen, `.prev`, `rename`) liegt in `replaceFileSafely`; hier bleibt die Warteschlange und die Übersetzung des Fehlers.
    const r = await replaceFileSafely(adapter, ownPath, bytes);
    return r.ok ? { ok: true } : fail("storage-failed", r.message);
  }

  async function setAsideNow(): Promise<SetAsideResult> {
    try {
      if (!(await adapter.exists(ownPath))) return { ok: true, movedTo: null };
      const base = `${ownPath}.damaged-${stampedName(ports.now())}`;
      for (let i = 1; i <= MAX_ASIDE_TRIES; i++) {
        const to = i === 1 ? base : `${base}-${String(i)}`;
        if (await adapter.exists(to)) continue;
        await adapter.rename(ownPath, to);
        return { ok: true, movedTo: to };
      }
      return fail("storage-failed", "Kein freier Name zum Beiseitelegen der beschädigten Datei.");
    } catch (e) {
      return fail("storage-failed", errorMessage(e));
    }
  }

  async function listFolder(): Promise<string[]> {
    if (!(await adapter.exists(o.folder))) return [];
    return (await adapter.list(o.folder)).files;
  }

  const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

  /** Zerlegt einen Dateinamen der Ablage: `<id><ext>` (Zieldatei) oder `<id><ext>.prev`; alles andere (`.tmp`, `.damaged-…`, Fremdes) ist keine Gerätedatei. */
  function classify(name: string): { stem: string; kind: "file" | "previous" } | null {
    if (name.endsWith(`${ext}.prev`)) return { stem: name.slice(0, name.length - ext.length - 5), kind: "previous" };
    if (name.endsWith(ext)) return { stem: name.slice(0, name.length - ext.length), kind: "file" };
    return null;
  }

  async function readAllNow(): Promise<ReadAllResult> {
    let files: string[];
    try {
      files = await listFolder();
    } catch (e) {
      return { ok: false, error: "storage-failed", message: errorMessage(e) };
    }
    const byStem = new Map<string, { file?: string; previous?: string }>();
    for (const path of files) {
      const c = classify(baseName(path));
      if (c === null) continue;
      const slot = byStem.get(c.stem) ?? {};
      slot[c.kind === "file" ? "file" : "previous"] = path;
      byStem.set(c.stem, slot);
    }
    const entries: DeviceFileEntry[] = [];
    for (const [stem, slot] of [...byStem].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      const path = slot.file ?? slot.previous;
      if (path === undefined) continue;
      const source = slot.file !== undefined ? "file" : "previous";
      if (!DEVICE_ID_PATTERN.test(stem)) {
        entries.push({ deviceId: null, own: false, path, problem: "invalid-name", message: `Der Dateiname ${baseName(path)} ist keine gültige Geräte-ID.` });
        continue;
      }
      try {
        const bytes = new Uint8Array(await adapter.readBinary(path));
        const st = await adapter.stat(path);
        entries.push({ deviceId: stem, own: stem === o.deviceId, path, source, bytes, mtime: st?.mtime ?? 0, size: st?.size ?? bytes.byteLength });
      } catch (e) {
        entries.push({ deviceId: stem, own: false, path, problem: "read-failed", message: errorMessage(e) });
      }
    }
    return { ok: true, entries };
  }

  // ── Änderungen ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  type Signatures = Map<string, string>; // Name (Zieldatei oder .prev) → "mtime:size"

  async function scan(): Promise<Signatures> {
    const sig: Signatures = new Map();
    for (const path of await listFolder()) {
      const name = baseName(path);
      if (classify(name) === null) continue;
      const st = await adapter.stat(path);
      sig.set(name, st === null ? "gone" : `${String(st.mtime)}:${String(st.size)}`);
    }
    return sig;
  }

  const idOfName = (name: string): string => classify(name)?.stem ?? name;

  function diff(before: Signatures, after: Signatures): DeviceFileChange[] {
    const byId = new Map<string, DeviceFileChange["kind"]>();
    const note = (id: string, kind: DeviceFileChange["kind"]): void => { if (!byId.has(id)) byId.set(id, kind); };
    for (const [name, s] of after) {
      const b = before.get(name);
      if (b === undefined) note(idOfName(name), "added");
      else if (b !== s) note(idOfName(name), "modified");
    }
    for (const name of before.keys()) if (!after.has(name)) note(idOfName(name), "removed");
    return [...byId].map(([deviceId, kind]) => ({ deviceId, kind, own: deviceId === o.deviceId }));
  }

  let baselines: Array<{ set(sig: Signatures): void; get(): Signatures | null }> = [];

  /** Nach einem eigenen Schreibvorgang gilt der neue Stand der eigenen Dateien als gesehen. */
  async function rebaselineOwn(): Promise<void> {
    if (baselines.length === 0) return;
    let now: Signatures;
    try { now = await scan(); } catch { return; }
    for (const b of baselines) {
      const cur = b.get();
      if (cur === null) continue;
      const next: Signatures = new Map([...cur].filter(([name]) => idOfName(name) !== o.deviceId));
      for (const [name, s] of now) if (idOfName(name) === o.deviceId) next.set(name, s);
      b.set(next);
    }
  }

  return {
    deviceId: o.deviceId,
    ownPath,
    async writeOwn(bytes) {
      const r = await queued(() => writeNow(bytes));
      await rebaselineOwn();
      return r;
    },
    readAll: () => readAllNow(),
    async setAsideOwn() {
      const r = await queued(() => setAsideNow());
      await rebaselineOwn();
      return r;
    },
    async replaceDamagedOwn(bytes) {
      const r = await queued(async (): Promise<WriteResult> => {
        const aside = await setAsideNow();
        if (!aside.ok) return aside; // nichts geschrieben: die beschädigte Datei bleibt, wo sie war
        return writeNow(bytes);
      });
      await rebaselineOwn();
      return r;
    },
    async removeForeign(deviceId) {
      if (!DEVICE_ID_PATTERN.test(deviceId)) return fail("invalid-input", `Ungültige Geräte-ID: ${deviceId}`);
      if (deviceId === o.deviceId) return fail("own-device", "Die eigene Gerätedatei wird hier nicht gelöscht.");
      return queued(async (): Promise<RemoveResult> => {
        try {
          let removed = false;
          for (const p of [fileOf(deviceId), `${fileOf(deviceId)}.prev`]) {
            if (await adapter.exists(p)) { await adapter.remove(p); removed = true; }
          }
          return { ok: true, removed };
        } catch (e) {
          return fail("storage-failed", errorMessage(e));
        }
      });
    },
    watch(onChange, opts) {
      let stopped = false;
      let current: Signatures | null = null;
      let running = false;
      let again = false;
      const handle = { set: (s: Signatures): void => { current = s; }, get: (): Signatures | null => current };
      baselines.push(handle);
      const baseline = scan().then((s) => { if (current === null) current = s; }, () => undefined);

      async function check(): Promise<void> {
        if (stopped) return;
        if (running) { again = true; return; }
        running = true;
        try {
          await baseline;
          do {
            again = false;
            let after: Signatures;
            try { after = await scan(); } catch { break; } // der nächste Zeitgeber versucht es wieder
            const before = current ?? new Map<string, string>();
            const changes = diff(before, after);
            current = after;
            if (!stopped && changes.length > 0) onChange(changes);
          } while (again && !stopped);
        } finally {
          running = false;
        }
      }

      const prefix = `${o.folder}/`;
      const offEvents = ports.onVaultEvent((path) => {
        if (path.startsWith(prefix) && classify(baseName(path)) !== null) void check();
      });
      const offTimer = ports.setInterval(() => { void check(); }, opts?.intervalMs ?? DEFAULT_INTERVAL_MS);
      return () => {
        if (stopped) return;
        stopped = true;
        offEvents();
        offTimer();
        baselines = baselines.filter((b) => b !== handle);
      };
    },
  };
}
