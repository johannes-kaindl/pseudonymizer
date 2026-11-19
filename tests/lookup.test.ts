import { describe, expect, it } from "vitest";
import { lookupOutcome, searchPlan } from "../src/core/lookup";
import { forgetPerson, linkedTable, conflictTable, must, ORG, PERSON, PERSON_B, sampleTable, withValue } from "./helpers/table-fixtures";
import { emptyTable, tableAddEntry } from "../src/vendor/kit/placeholder-table";

describe("lookupOutcome", () => {
  it("shows value, kind, field and the other forms of the entry", () => {
    const o = lookupOutcome(sampleTable(), `Person_${PERSON}_Mail`, "de");
    expect(o).toMatchObject({ status: "known", placeholder: `Person_${PERSON}_Mail`, value: "max@example.org", kind: "person", field: "mail" });
    if (o.status !== "known") throw new Error("not known");
    expect(o.forms.map((f) => [f.placeholder, f.field, f.value])).toEqual([
      [`Person_${PERSON}`, null, "Max Mustermann"],
      [`Person_${PERSON}_2`, null, "Max"],
      [`Person_${PERSON}_Mail`, "mail", "max@example.org"],
      [`Person_${PERSON}_Telefon`, "phone", "030 1234567"],
      [`Person_${PERSON}_Telefon_2`, "phone", "0171 2345678"],
    ]);
    expect(o.forms.every((f) => !f.conflict)).toBe(true);
  });

  it("names the forms in the language of the vault", () => {
    const o = lookupOutcome(sampleTable(), `Person_${PERSON}`, "en");
    if (o.status !== "known") throw new Error("not known");
    expect(o.forms.map((f) => f.placeholder)).toContain(`Person_${PERSON}_Phone_2`);
  });

  it("reads the placeholder in any spelling and keeps the spelling it was asked in", () => {
    const o = lookupOutcome(sampleTable(), `person_${PERSON.toUpperCase()}_phone_2`, "de");
    expect(o).toMatchObject({ status: "known", value: "0171 2345678", field: "phone", placeholder: `person_${PERSON.toUpperCase()}_phone_2` });
  });

  it("an entry without a carrier shows kind none", () => {
    const t = withValue(must(tableAddEntry(emptyTable(), ORG, null)), ORG, "phone", "030 7654321");
    expect(lookupOutcome(t, `Telefon_${ORG}`, "de")).toMatchObject({ status: "known", kind: "none", value: "030 7654321" });
  });

  it("is invalid for text that is no placeholder as a whole", () => {
    for (const text of ["", "Max", `Person_${PERSON}_Mailbox`, `Hallo Person_${PERSON}`, `Person_${PERSON} Person_${PERSON}_2`]) {
      expect(lookupOutcome(sampleTable(), text, "de"), text).toEqual({ status: "invalid" });
    }
  });

  it("forgotten: says so and shows no value and no forms", () => {
    const o = lookupOutcome(forgetPerson(sampleTable()), `Person_${PERSON}_Mail`, "de");
    expect(o).toEqual({ status: "forgotten", placeholder: `Person_${PERSON}_Mail` });
  });

  it("unknown: gives the reason", () => {
    const t = sampleTable();
    expect(lookupOutcome(t, `Person_${ORG}`, "de")).toEqual({ status: "unknown", placeholder: `Person_${ORG}`, reason: "no-entry" });
    expect(lookupOutcome(t, `Organisation_${PERSON}`, "de")).toEqual({ status: "unknown", placeholder: `Organisation_${PERSON}`, reason: "carrier" });
    expect(lookupOutcome(t, `Person_${PERSON}_Adresse`, "de")).toEqual({ status: "unknown", placeholder: `Person_${PERSON}_Adresse`, reason: "no-slot" });
  });

  it("conflict: shows both values, sorted, without preferring one, and marks the forms", () => {
    const o = lookupOutcome(conflictTable(), `Person_${PERSON}_Mail_2`, "de");
    expect(o).toMatchObject({ status: "conflict", placeholder: `Person_${PERSON}_Mail_2`, values: ["max.a@example.org", "max.b@example.org"] });
    if (o.status !== "conflict") throw new Error("not a conflict");
    expect(o.forms.filter((f) => f.conflict).map((f) => f.value)).toEqual(["max.a@example.org", "max.b@example.org"]);
    // a placeholder of the same entry beside the conflict still resolves
    expect(lookupOutcome(conflictTable(), `Person_${PERSON}_Mail`, "de")).toMatchObject({ status: "known", value: "max@example.org" });
  });
});

describe("searchPlan", () => {
  it("finds the entry through any of its spellings, without regard to case, and quotes the ID", () => {
    expect(searchPlan(sampleTable(), "max mustermann")).toEqual({ ids: [PERSON], query: `"${PERSON}"` });
    expect(searchPlan(sampleTable(), "  MAX ")).toEqual({ ids: [PERSON], query: `"${PERSON}"` });
  });

  it("finds an entry by a value of another field, read the way the field is read", () => {
    expect(searchPlan(sampleTable(), "MAX@Example.org")?.ids).toEqual([PERSON]);
    expect(searchPlan(sampleTable(), "030  1234567")?.ids).toEqual([PERSON]);
  });

  it("takes the IDs of every merged entry, sorted, joined with OR", () => {
    const plan = searchPlan(linkedTable(), "m. mustermann");
    expect(plan).toEqual({ ids: [PERSON, PERSON_B], query: `"${PERSON}" OR "${PERSON_B}"` });
    expect(searchPlan(linkedTable(), "Max Mustermann")?.ids).toEqual([PERSON, PERSON_B]);
  });

  it("is null when nothing matches, for a forgotten person and for empty input", () => {
    expect(searchPlan(sampleTable(), "Erika Musterfrau")).toBeNull();
    expect(searchPlan(forgetPerson(sampleTable()), "Max Mustermann")).toBeNull();
    expect(searchPlan(sampleTable(), "")).toBeNull();
    expect(searchPlan(sampleTable(), "   ")).toBeNull();
  });

  it("does not match part of a value", () => {
    expect(searchPlan(sampleTable(), "Mustermann")).toBeNull();
  });

  it("the query carries IDs only, never a value", () => {
    const plan = searchPlan(sampleTable(), "Max Mustermann");
    expect(plan?.query).not.toMatch(/Max|Mustermann|example/i);
  });
});
