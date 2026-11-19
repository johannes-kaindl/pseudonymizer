// Wo Klartext beim Kopieren eingesetzt werden darf (Sicherheits-Lesung Runde 1, W1): nur dort, wo `transform` ersetzen würde.
import { describe, expect, it } from "vitest";
import { createApi } from "../src/core/api";
import { MemoryTable } from "../src/core/memory-table";
import { restoreInZones, restoreZones } from "../src/core/restore-zones";
import { PseudonymizerEngine } from "../src/obsidian/engine";
import { PERSON, sampleTable } from "./helpers/table-fixtures";

const NAME = `Person_${PERSON}`;
const MAIL = `Person_${PERSON}_Mail`;
const CLEAR = "Max Mustermann";

function restorer() {
  const memory = new MemoryTable();
  memory.open(sampleTable());
  const api = createApi(() => new PseudonymizerEngine(memory));
  return (text: string) => restoreInZones(text, (segment) => api.restore(segment, { caller: "test" }));
}

/** Formen aus dem Bericht: je Text, in dem der Platzhalter NICHT ersetzt werden darf. */
const PROTECTED: [string, string][] = [
  ["Bild-URL", `![x](https://evil.example/p?n=${NAME})`],
  ["Link-Ziel", `[l](https://evil.example/${NAME})`],
  ["HTML-Attribut", `<img src="https://evil.example/${NAME}.png">`],
  ["nackte URL", `https://evil.example/u/${NAME}`],
  ["Inline-Code", `Text \`${NAME}\` Ende`],
  ["Codeblock", `Vorher\n\`\`\`\n${NAME}\n\`\`\`\nNachher`],
  ["Codeblock mit Tilde", `Vorher\n~~~\n${NAME}\n\n${NAME}\n~~~\nNachher`],
];

describe("restoreInZones", () => {
  for (const [name, text] of PROTECTED) {
    it(`${name}: der Platzhalter bleibt, der Text ist byte-gleich, die Stelle wird gezählt`, () => {
      const r = restorer()(text);
      expect("error" in r).toBe(false);
      if ("error" in r) return;
      expect(r.text).toBe(text);
      expect(r.restored).toBe(0);
      expect(r.kept).toBeGreaterThan(0);
    });
  }

  it("Fließtext und das Ziel von mailto: werden aufgelöst, daneben bleibt ein Platzhalter in einer Adresse stehen", () => {
    const text = `Hallo ${NAME}, [Mail](mailto:${MAIL}) und ![x](https://evil.example/${NAME}) sowie \`${NAME}\`.`;
    const r = restorer()(text);
    if ("error" in r) throw new Error("unerwartet");
    expect(r.text).toBe(`Hallo ${CLEAR}, [Mail](mailto:max@example.org) und ![x](https://evil.example/${NAME}) sowie \`${NAME}\`.`);
    expect(r.restored).toBe(2);
    expect(r.kept).toBe(2);
  });

  it("Code, der vor einer Auswahlgrenze beginnt, gilt für den ganzen Text: ein Codeblock über mehrere Zeilen schützt auch seine späten Zeilen", () => {
    const text = `\`\`\`\nzeile 1\nzeile 2 ${NAME}\n\`\`\`\n${NAME}`;
    const r = restorer()(text);
    if ("error" in r) throw new Error("unerwartet");
    expect(r.text).toBe(`\`\`\`\nzeile 1\nzeile 2 ${NAME}\n\`\`\`\n${CLEAR}`);
    expect(r.kept).toBe(1);
  });

  it("ein Platzhalter im Frontmatter wird aufgelöst (transform ersetzt dort ebenfalls)", () => {
    const r = restorer()(`---\nfrom: ${NAME}\n---\nText`);
    if ("error" in r) throw new Error("unerwartet");
    expect(r.text).toBe(`---\nfrom: ${CLEAR}\n---\nText`);
  });

  it("ein Fehler der Plugin-API kommt unverändert zurück", () => {
    const r = restoreInZones(`Hallo ${NAME}`, () => ({ error: "locked", message: "x" }));
    expect(r).toEqual({ error: "locked", message: "x" });
  });

  it("ein unbekannter Platzhalter außerhalb sperrt nichts (er bleibt ohnehin stehen), innerhalb steht er in `unknown`", () => {
    const foreign = "Person_m4t8c6r2vp";
    const r = restorer()(`[l](https://x.example/${foreign}) und ${foreign}`);
    if ("error" in r) throw new Error("unerwartet");
    expect(r.unknown).toEqual([foreign]);
    expect(r.kept).toBe(1);
  });
});

describe("restoreZones", () => {
  it("inside liegt ganz in einem Bereich, nicht über eine Schutzstelle hinweg", () => {
    const text = "abc `code` def";
    const z = restoreZones(text);
    expect(z.inside(0, 3)).toBe(true);
    expect(z.inside(4, 10)).toBe(false);
    expect(z.inside(2, 6)).toBe(false);
    expect(z.inside(11, 14)).toBe(true);
  });
});
