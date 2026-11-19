import { describe, expect, it } from "vitest";
import { buildDevicesModel, type DevicesInput } from "../src/core/devices-view";
import { emptyTable } from "../src/vendor/kit/placeholder-table";
import { forgetIn, personTable, ID_A } from "./helpers/store-fixtures";
import type { DeviceView } from "../src/core/protocol";

const dev = (deviceId: string, name: string, stand: number, opened = true, carriesMarks = true): DeviceView => ({ deviceId, name, opened, stand, carriesMarks });
const base = (over: Partial<DevicesInput> = {}): DevicesInput => ({
  state: "ready", reason: null, stand: 0, devices: [dev("own", "Mac Büro", 0)], ownDeviceId: "own", problems: [], codeStand: 0, table: emptyTable(), ...over,
});

describe("buildDevicesModel", () => {
  it("eine Zeile je Gerät, die eigene markiert, mit Stand und Status gelesen", () => {
    const m = buildDevicesModel(base({ devices: [dev("own", "Mac Büro", 2), dev("x1", "iPhone", 2)], stand: 2 }));
    expect(m.rows).toEqual([
      { deviceId: "own", name: "Mac Büro", own: true, stand: 2, status: "read", problemKind: null },
      { deviceId: "x1", name: "iPhone", own: false, stand: 2, status: "read", problemKind: null },
    ]);
  });

  it("eine ungeöffnete Datei mit Problem nennt den Grund; ohne Problem steht sie als nicht geöffnet da", () => {
    const m = buildDevicesModel(base({
      devices: [dev("own", "Mac", 1), dev("x1", "x1", 0, false, false), dev("x2", "x2", 0, false, false)],
      problems: [{ kind: "authentication", deviceId: "x1", path: "f/x1.pseudo" }],
    }));
    expect(m.rows[1]).toMatchObject({ status: "problem", problemKind: "authentication" });
    expect(m.rows[2]).toMatchObject({ status: "not-opened", problemKind: null });
  });

  it("Meldungen über die eigene Datei (beiseitegelegt, Schreibfehler) machen keine Zeile zum Problem", () => {
    const m = buildDevicesModel(base({ problems: [{ kind: "own-set-aside", deviceId: "own", path: "f/own.pseudo" }] }));
    expect(m.rows[0].status).toBe("read");
  });

  it("Dateien ohne Geräte-ID stehen getrennt mit Pfad und Grund", () => {
    const m = buildDevicesModel(base({ problems: [{ kind: "invalid-name", deviceId: null, path: "f/Konflikt (1).pseudo" }] }));
    expect(m.stray).toEqual([{ path: "f/Konflikt (1).pseudo", kind: "invalid-name" }]);
  });

  it("ohne vergessene Person gibt es keinen Fortschritt, mit Marken rechnet er den Stand aus (Spec 8.3)", () => {
    expect(buildDevicesModel(base()).progress).toBeNull();
    const table = forgetIn(personTable(ID_A, "Max Mustermann"), ID_A);
    const m = buildDevicesModel(base({
      stand: 1, codeStand: 0, table,
      devices: [dev("own", "Mac", 1), dev("x1", "iPhone", 0, true, false)],
    }));
    expect(m.anyForgotten).toBe(true);
    expect(m.progress).toMatchObject({ devicesDone: 1, devicesTotal: 2, pending: ["iPhone"], codeOutdated: true, complete: false });
  });

  it("gesperrt: keine Fortschrittsrechnung, aber die Zeilen und der Grund", () => {
    const m = buildDevicesModel(base({ state: "locked", reason: "foreign-chain", stand: null, table: null, codeStand: null, devices: [dev("x1", "x1", 3, false, false)] }));
    expect(m.progress).toBeNull();
    expect(m.reason).toBe("foreign-chain");
    expect(m.rows).toHaveLength(1);
  });
});
