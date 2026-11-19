// vendored from obsidian-kit@0.102.0, src/obsidian/replace-file-safely.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Eine Datei ersetzen, ohne sie zerstören zu können (Welle 36, h2b, Bestellung 13; gehoben aus `device-files.ts`, Welle 36, kp1b, Teil D).
//
// Messung (REGISTRY „Eine Datei ersetzen, ohne sie zerstören zu können“, gemessen an Obsidian 1.13.7): `adapter.writeBinary` kürzt das Ziel auf 0 Bytes, bevor es die ersten Bytes liefert, und `adapter.rename`
// ersetzt kein vorhandenes Ziel (es wirft `Destination file already exists!`). Ein Schreiben in die Zieldatei oder ein `rename` über sie hinweg ist deshalb kein sicherer Weg. Der Weg hier:
//   1. `<pfad>.tmp` schreiben, zurücklesen und Byte für Byte vergleichen (ein Fehler oder eine Abweichung bricht ab, die Zieldatei ist unberührt);
//   2. die bisherige Fassung per `rename` nach `<pfad>.prev` beiseitelegen (eine vollständige Datei wechselt den Namen, es wird nichts geschrieben);
//   3. `.tmp` per `rename` auf den Zielnamen setzen (das Ziel fehlt jetzt, das `rename` ist erlaubt);
//   4. `.prev` entfernen.
// An jedem Abbruchpunkt liegt eine vollständige Fassung: vor 2 die Zieldatei, zwischen 2 und 3 nur `.prev` (die alte Fassung), nach 3 die Zieldatei. **Wer liest, nimmt deshalb die Zieldatei, und fehlt sie, `.prev`.**
// Der Ausfallmodus „fehlt“ statt „korrupt“ ist der, den die REGISTRY für `remove` + `rename` beschreibt; hier fehlt die Zieldatei höchstens einen Augenblick, und `.prev` deckt ihn ab. Eine `.tmp`-Datei vertraut ein
// Leser nie (sie kann halb geschrieben sein); sie wird beim nächsten Schreiben von `writeBinary` ersetzt (es kürzt ein vorhandenes Ziel), ein eigenes Entfernen wäre totes Gerät.
//
// - **Keine Warteschlange hier.** Zwei gleichzeitige Aufrufe für DENSELBEN Pfad begegnen sich auf `.tmp` und `.prev`; wer das kann (ein Gerät schreibt seine Datei aus mehreren Stellen), reiht die Aufrufe selbst
//   hintereinander (`createDeviceFiles` tut es). Ein Export schreibt einmal je Lauf.
// - **Wirft nie.** Jeder Fehler (auch des Adapters) kommt als `{ ok: false, message }`; nach einem Fehler vor Schritt 3 ist die Zieldatei unberührt, scheitert Schritt 3, kommt die alte Fassung zurück.
// - **Der Ordner wird angelegt** (`ensureDir`, auch mehrstufig), bevor etwas geschrieben wird.
// - **Leere Bytes werden geschrieben, wie sie sind.** Ob eine leere Datei sinnvoll ist, entscheidet der Aufrufer (`createDeviceFiles` lehnt sie ab).
import type { DataAdapter } from "obsidian";
import { errorMessage } from "../kit/error-message";
import { vaultDirname } from "../kit/vault-path";
import { ensureDir } from "./file-snapshot";

/** Die Adapter-Aufrufe, die der Weg braucht. Ein Test gibt eine Fake-Platte hinein. */
export type ReplaceFileAdapter = Pick<DataAdapter, "exists" | "mkdir" | "readBinary" | "writeBinary" | "remove" | "rename">;

export type ReplaceFileResult = { ok: true } | { ok: false; message: string };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Ein Aufruf, dessen Scheitern der Weg verschmerzt (Aufräumen, Zurückrollen). `await` im `try` fängt auch einen Adapter, der synchron wirft, statt eine Zusage abzulehnen. */
async function quietly(job: () => Promise<unknown>): Promise<void> {
  try { await job(); } catch { /* verschmerzt: die Zieldatei oder .prev trägt eine vollständige Fassung */ }
}

/** Der Name der Zwischendatei und der beiseitegelegten Fassung zu einem Zielpfad; die Leser (`device-files`) kennen die Endungen. */
export const REPLACE_TMP_SUFFIX = ".tmp";
export const REPLACE_PREV_SUFFIX = ".prev";

/** Schreibt `bytes` nach `path` und ersetzt dabei eine vorhandene Datei, ohne dass ein Abbruch eine halbe oder fehlende Datei ohne Ersatz hinterlässt (siehe Kopf). */
export async function replaceFileSafely(adapter: ReplaceFileAdapter, path: string, bytes: Uint8Array): Promise<ReplaceFileResult> {
  const tmp = `${path}${REPLACE_TMP_SUFFIX}`;
  const prev = `${path}${REPLACE_PREV_SUFFIX}`;
  try {
    const dir = vaultDirname(path);
    if (dir !== "") await ensureDir(adapter, dir);
    // 1. vollständig in .tmp schreiben und zurücklesen
    await adapter.writeBinary(tmp, toArrayBuffer(bytes));
    const back = new Uint8Array(await adapter.readBinary(tmp));
    if (!sameBytes(back, bytes)) {
      await quietly(() => adapter.remove(tmp));
      return { ok: false, message: "Die geschriebene Datei stimmt beim Zurücklesen nicht mit den Bytes überein." };
    }
    // 2. die bisherige Fassung beiseitelegen (eine vollständige Datei wechselt den Namen)
    const hadTarget = await adapter.exists(path);
    if (hadTarget) {
      if (await adapter.exists(prev)) await adapter.remove(prev);
      await adapter.rename(path, prev);
    }
    // 3. .tmp wird die Zieldatei
    try {
      await adapter.rename(tmp, path);
    } catch (e) {
      if (hadTarget) await quietly(() => adapter.rename(prev, path));
      return { ok: false, message: errorMessage(e) };
    }
    // 4. .prev aufräumen (bleibt es liegen, ist es harmlos: die Zieldatei geht vor)
    await quietly(async () => { if (await adapter.exists(prev)) await adapter.remove(prev); });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}
