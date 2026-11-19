// Entscheidungen „hier im Klartext lassen“ über drei Gerätefassungen (code-kit 0.84.0, Aufruferpflicht `tableBindDecisions` nach jedem Lesen fremder Fassungen).
// Echtes WebCrypto, echte Kit-Bausteine; gefälscht sind Ablage und Schlüsselbund. Nur erfundene Werte.
import { describe, expect, it } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import { CHAIN, EXT, FOLDER, ID_A, ID_C, contentAt, forgetIn, makeDevice, personTable, seedFile, stateAt } from "./helpers/store-fixtures";
import { openEnvelope, readEnvelopeHeader } from "../src/vendor/kit/key-envelope";
import { encryptionKey } from "../src/vendor/kit/key-ratchet";
import { decodePayload } from "../src/core/payload";
import { emptyTable, parseTable, serializeTable, tableIsPlain, tableSetPlain, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";

const MAX = "Max Mustermann";
const DOC = "mail.md";

/** Die Tabelle, die ein Gerät zuletzt in seine Datei geschrieben hat. */
async function writtenTable(fs: FakeFs, deviceId: string): Promise<{ table: PlaceholderTable; text: string }> {
  const bytes = fs.get(`${deviceId}${EXT}`);
  if (bytes === undefined) throw new Error(`keine Datei ${deviceId}`);
  const h = readEnvelopeHeader(bytes);
  if (!h.ok) throw new Error("Kopf");
  const k = await encryptionKey(await stateAt(CHAIN, h.header.stand));
  if (!k.ok) throw new Error("Schlüssel");
  const o = await openEnvelope(k.value, bytes);
  if (!o.ok) throw new Error("öffnen");
  const p = decodePayload(o.plaintext);
  if ("error" in p) throw new Error("Inhalt");
  const t = typeof p.table === "string" ? parseTable(p.table) : null;
  if (t === null || !t.ok) throw new Error("Tabelle");
  return { table: t.table, text: p.table as string };
}

describe("Entscheidungen „im Klartext lassen“ und Vergessen über drei Geräte", () => {
  it("die Entscheidung von Gerät 1 (ohne die Person zu kennen) trifft bei Gerät 2 auf ihren Halter, die Marke von Gerät 3 kommt danach: Name und Entscheidung sind weg", async () => {
    const fs = new FakeFs(FOLDER);
    // Gerät 2 kennt die Person und ist das Gerät, das liest und schreibt.
    await seedFile(fs, { deviceId: "dev-2", stand: 0, table: personTable(ID_A, MAX) });
    const two = makeDevice(fs, { deviceId: "dev-2", content: await contentAt(CHAIN, 0), name: "dev-2" });
    await two.store.refresh();
    expect(two.memory.state()).toBe("ready");

    // Gerät 1 entscheidet, ohne die Person zu kennen: die Entscheidung ist an niemanden gebunden.
    const decided = tableSetPlain(emptyTable(), DOC, MAX, true, { id: ID_C });
    if (!decided.ok) throw new Error("fixture");
    await seedFile(fs, { deviceId: "dev-1", stand: 0, table: decided.table });

    // Erste Lesung bei Gerät 2: Entscheidung und Halter treffen sich in seiner Tabelle.
    expect(await two.store.persist()).toBeUndefined();
    const mid = await writtenTable(fs, "dev-2");
    expect(tableIsPlain(mid.table, DOC, MAX)).toBe(true);

    // Gerät 3 vergisst die Person; seine Fassung (die Marke) trifft erst jetzt ein.
    await seedFile(fs, { deviceId: "dev-3", stand: 1, table: forgetIn(personTable(ID_A, MAX), ID_A) });
    expect(await two.store.persist()).toBeUndefined();

    const own = await writtenTable(fs, "dev-2");
    expect(own.text).not.toContain(MAX);
    expect(serializeTable(own.table)).not.toContain(MAX);
    expect(tableIsPlain(own.table, DOC, MAX)).toBe(false);
    const memory = two.memory.table();
    expect(memory).not.toBeNull();
    expect(tableIsPlain(memory as PlaceholderTable, DOC, MAX)).toBe(false);
    expect(serializeTable(memory as PlaceholderTable)).not.toContain(MAX);
  });

  it("auch eine Änderung, die eine fremde Tabelle mitbringt (`persist(change)`), wird gebunden, bevor geschrieben wird", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-2", stand: 0, table: personTable(ID_A, MAX) });
    const two = makeDevice(fs, { deviceId: "dev-2", content: await contentAt(CHAIN, 0), name: "dev-2" });
    await two.store.refresh();
    const decided = tableSetPlain(emptyTable(), DOC, MAX, true, { id: ID_C });
    if (!decided.ok) throw new Error("fixture");
    expect(await two.store.persist(decided.table)).toBeUndefined();
    expect(tableIsPlain((await writtenTable(fs, "dev-2")).table, DOC, MAX)).toBe(true);

    await seedFile(fs, { deviceId: "dev-3", stand: 1, table: forgetIn(personTable(ID_A, MAX), ID_A) });
    await two.store.refresh();
    const own = await writtenTable(fs, "dev-2");
    expect(own.text).not.toContain(MAX);
    expect(tableIsPlain(own.table, DOC, MAX)).toBe(false);
  });
});
