import { decodeRecoveryCode, encodeRecoveryCode, type RecoveryCodeContent } from "../vendor/kit/recovery-code";
import type { SecretStore } from "../vendor/kit/secrets";

/** Name des Eintrags im Schlüsselbund. Der Schlüsselbund selbst trennt je Gerät, Profil und Vault (Spec 8.3); die ID ist die eines Obsidian-Geheimnisses (`[a-z0-9-]`). */
export const KEY_SECRET_ID = "pseudonymizer-key";

/** Ergebnis von `read`: der Schlüsselinhalt, `null` (nichts abgelegt) oder `corrupt` (etwas liegt da, ist aber kein gültiger Code). */
export type KeyReadResult = RecoveryCodeContent | null | { error: "corrupt" };
/** Ergebnis von `write`: nichts bei Erfolg, sonst der Grund. Der Wert trägt nie Schlüsselmaterial und nie den Text einer Ausnahme. */
export type KeyWriteResult = void | { error: "storage-failed" };

/** Der Schlüssel dieses Geräts im Schlüsselbund (Spec 8.3). Er steht in derselben Textform wie der Wiederherstellungs-Code, also mit Prüfzeichen auch beim Lesen.
 *
 *  Wer `write` ruft: nur Aufgabe 11 oder 12, nachdem eine Gerätedatei mit diesem Schlüssel geöffnet ist (Spec 8.3 „Erst öffnen, dann festschreiben“).
 *  Nie aus einer Code-Eingabe: das Prüfzeichen ist kein MAC, ein gültiger Code einer fremden Kette besteht es immer, zwei Tippfehler gehen mit 1 zu 37 durch (Kopf von `recovery-code.ts`). */
export interface KeyStore {
  /** Liest und prüft den abgelegten Schlüssel. Liefert nie einen Schlüssel aus einem Wert, der das Prüfzeichen oder das Format verfehlt; auch ein Schlüsselbund, der beim Lesen wirft, ergibt `corrupt`. */
  read(): KeyReadResult;
  /** Legt den Schlüssel ab und liest ihn zurück. Wirft nie; ein Fehler des Schlüsselbunds, ein nicht gehaltener Wert und ein nicht kodierbarer Inhalt sind `storage-failed`, und dann bleibt der bisherige Eintrag unberührt, soweit der Schlüsselbund das zusagt. */
  write(content: RecoveryCodeContent): KeyWriteResult;
  /** Überschreibt den Eintrag mit dem Leerstring (die Obsidian-API hat keinen Löschaufruf). Wirft, wenn der Schlüsselbund wirft: ein Löschen darf nicht still scheitern. */
  clear(): void;
}

const corrupt = (): { error: "corrupt" } => ({ error: "corrupt" });

export function createKeyStore(secrets: SecretStore): KeyStore {
  return {
    read(): KeyReadResult {
      let raw: string | null;
      try {
        raw = secrets.get(KEY_SECRET_ID);
      } catch {
        return corrupt();
      }
      if (raw === null || raw === "") return null;
      const decoded = decodeRecoveryCode(raw);
      if (!decoded.ok) return corrupt();
      return { chainId: decoded.chainId, stand: decoded.stand, key: decoded.key };
    },
    write(content: RecoveryCodeContent): KeyWriteResult {
      const encoded = encodeRecoveryCode(content);
      if (!encoded.ok) return { error: "storage-failed" };
      try {
        secrets.set(KEY_SECRET_ID, encoded.code);
        // Eigenes Rücklesen zusätzlich zum Vertrag des Kits: ein Schlüsselbund, der den Wert still verwirft, darf nie als gespeichert gelten.
        if (secrets.get(KEY_SECRET_ID) !== encoded.code) return { error: "storage-failed" };
      } catch {
        return { error: "storage-failed" };
      }
    },
    clear(): void {
      secrets.delete(KEY_SECRET_ID);
    },
  };
}
