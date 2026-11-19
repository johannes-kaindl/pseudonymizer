// Was der Dialog „Person vergessen“ zeigt (Spec 8.3): Werte des Eintrags, nicht lesbare Geräte, Ausnahmeliste. Rein, nur erfundene Werte.
import { describe, expect, it } from "vitest";
import { filterPersons, listPersons, planForget, unreadableDeviceNames } from "../src/core/forget-plan";
import { PERSON, PERSON_B, ORG, must, sampleTable, withValue } from "./helpers/table-fixtures";
import { emptyTable, tableAddEntry, tableLinkEntries, tableSetException, tableForget } from "../src/vendor/kit/placeholder-table";
import type { DeviceView } from "../src/core/protocol";

const dev = (deviceId: string, name: string, opened: boolean): DeviceView => ({ deviceId, name, opened, stand: 0, carriesMarks: opened });

describe("listPersons", () => {
  it("nennt je Eintrag den ersten Namen als Bezeichnung und alle Werte mit Platzhalter in der Sprache des Vaults", () => {
    const list = listPersons(sampleTable(), "en");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(PERSON);
    expect(list[0].kind).toBe("person");
    expect(list[0].label).toBe("Max Mustermann");
    const placeholders = list[0].values.map((v) => v.placeholder);
    expect(placeholders).toContain(`Person_${PERSON}`);
    expect(placeholders).toContain(`Person_${PERSON}_Mail`);
    expect(placeholders).toContain(`Person_${PERSON}_Phone`);
    expect(placeholders).toContain(`Person_${PERSON}_Phone_2`);
    expect(list[0].values.map((v) => v.text)).toEqual(expect.arrayContaining(["Max Mustermann", "max@example.org", "030 1234567", "0171 2345678"]));
    expect(listPersons(sampleTable(), "de")[0].values.map((v) => v.placeholder)).toContain(`Person_${PERSON}_Telefon`);
  });

  it("vergessene Einträge stehen nicht darin; zusammengeführte Einträge sind einer, vertreten durch die kleinste ID", () => {
    let t = must(tableAddEntry(sampleTable(), PERSON_B, "person"));
    t = withValue(t, PERSON_B, null, "Berta Beispiel");
    t = must(tableAddEntry(t, ORG, "organisation"));
    t = withValue(t, ORG, null, "Verein Beispiel e. V.");
    expect(listPersons(t, "de").map((o) => o.label)).toEqual(["Max Mustermann", "Berta Beispiel", "Verein Beispiel e. V."]);
    const linked = must(tableLinkEntries(t, PERSON, PERSON_B));
    const list = listPersons(linked, "de");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe([PERSON, PERSON_B].sort()[0]);
    expect(list[0].values.map((v) => v.text)).toEqual(expect.arrayContaining(["Max Mustermann", "Berta Beispiel"]));
    const gone = must(tableForget(t, PERSON));
    expect(listPersons(gone, "de").map((o) => o.label)).toEqual(["Berta Beispiel", "Verein Beispiel e. V."]);
    expect(listPersons(emptyTable(), "de")).toEqual([]);
  });

  it("ein Eintrag ohne Werte bekommt seinen Platzhalter als Bezeichnung", () => {
    const t = must(tableAddEntry(emptyTable(), PERSON, "person"));
    expect(listPersons(t, "de")[0].label).toBe(`Person_${PERSON}`);
  });

  it("markiert Werte, die auf der Ausnahmeliste stehen", () => {
    const t = must(tableSetException(sampleTable(), "030 1234567", true));
    const values = listPersons(t, "de")[0].values;
    expect(values.filter((v) => v.onExceptionList).map((v) => v.text)).toEqual(["030 1234567"]);
  });
});

describe("filterPersons", () => {
  it("findet über Namen, Werte und Platzhalter ohne Rücksicht auf Groß und Klein; leere Suche zeigt alle", () => {
    const list = listPersons(sampleTable(), "de");
    expect(filterPersons(list, "")).toHaveLength(1);
    expect(filterPersons(list, "mustermann")).toHaveLength(1);
    expect(filterPersons(list, "MAX@EXAMPLE")).toHaveLength(1);
    expect(filterPersons(list, "person_k3x9")).toHaveLength(1);
    expect(filterPersons(list, "berta")).toHaveLength(0);
  });
});

describe("planForget", () => {
  it("der Plan nennt die Werte, die nicht lesbaren Geräte (ohne dieses) und ob ein Wert auf der Ausnahmeliste steht", () => {
    const t = must(tableSetException(sampleTable(), "max@example.org", true));
    const plan = planForget(t, "de", PERSON, [dev("a", "Mac", true), dev("b", "iPhone", false), dev("c", "Büro-PC", false)], "a");
    expect(plan).not.toBeNull();
    expect(plan?.option.values.length).toBe(5);
    expect(plan?.unreadableDevices).toEqual(["Büro-PC", "iPhone"]);
    expect(plan?.exceptionListed).toBe(true);
  });

  it("ohne Ausnahme und ohne ungelesene Geräte sind beide Listen leer; ein unbekannter Eintrag gibt null", () => {
    const plan = planForget(sampleTable(), "de", PERSON, [dev("a", "Mac", true)], "a");
    expect(plan?.unreadableDevices).toEqual([]);
    expect(plan?.exceptionListed).toBe(false);
    expect(planForget(sampleTable(), "de", PERSON_B, [], "a")).toBeNull();
  });

  it("dieses Gerät zählt nie als nicht lesbar", () => {
    expect(unreadableDeviceNames([dev("a", "Mac", false)], "a")).toEqual([]);
  });
});
