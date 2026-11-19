// Rüstzeug für die Tests der Reiter Personen und Ausnahmen: ein bereites Gerät (Fake-Platte, echtes WebCrypto), die echten Handlungen (`createPersonsApi`) mit gespielten Fenstern,
// und ein Leser, der die Gerätedatei von der Platte neu liest (so zeigt der Test, was wirklich geschrieben ist).
import { vi } from "vitest";
import { createPersonsApi, type PersonsApi, type PersonsHost, type PersonsUi } from "../../src/obsidian/persons-actions";
import { runForget } from "../../src/obsidian/forget";
import type { KeyActionsUi } from "../../src/obsidian/key-actions";
import { PseudonymizerEngine } from "../../src/obsidian/engine";
import type { ForgetPlan } from "../../src/core/forget-plan";
import { placeholderIdFromBytes } from "../../src/vendor/kit/placeholder";
import { tableAddEntry, type PlaceholderTable } from "../../src/vendor/kit/placeholder-table";
import { FakeFs } from "./fake-fs";
import { CHAIN, FOLDER, contentAt, makeDevice, seedFile, type Device } from "./store-fixtures";
import { PERSON, PERSON_B, must, sampleTable, withValue } from "./table-fixtures";
import { makeFakeEl } from "../vendor/kit/obsidian-mock";

export type El = ReturnType<typeof makeFakeEl>;

export const BERTA_IBAN = "DE89 3704 0044 0532 0130 00";
export const BERTA_ADDRESS = "Musterstraße 1, 10115 Berlin";

/** Max (Name, Kurzform, Mail, zwei Nummern) und Berta (Name, Mail, Adresse, IBAN): alles erfunden. */
export function richTable(): PlaceholderTable {
  let t = sampleTable();
  t = must(tableAddEntry(t, PERSON_B, "person"));
  t = withValue(t, PERSON_B, null, "Berta Beispiel");
  t = withValue(t, PERSON_B, "mail", "berta@example.org");
  t = withValue(t, PERSON_B, "address", BERTA_ADDRESS);
  t = withValue(t, PERSON_B, "iban", BERTA_IBAN);
  return t;
}

export interface Script {
  /** Wen „zusammenführen“ wählt: eine ID, `null` für Abbrechen; Vorgabe der erste Eintrag der Wahl. */
  partner?: string | null;
  confirm?: boolean;
  /** Läuft, während die Wahl des Partners offen ist (ein anderer Weg ändert die Tabelle zwischen Fragen und Schreiben). */
  during?: () => Promise<void>;
  /** Was der Ausnahme-Dialog liefert. */
  exception?: string | null;
}

export interface PersonsRig {
  fs: FakeFs;
  d: Device;
  api: PersonsApi;
  script: Script;
  notices: { key: string; args: (string | number)[] }[];
  /** Welche IDs `forget` bekam (der Ablauf läuft echt, mit gespieltem Warndialog). */
  forgets: string[];
  plans: ForgetPlan[];
  /** Zahl der Aufrufe der Wahl in „Person vergessen“: bei vorgewähltem Eintrag bleibt sie 0. */
  forgetChoices: { n: number };
  changes: { n: number };
  persistCalls: { n: number };
  /** Wartet auf alle angestoßenen Handlungen. */
  idle(): Promise<void>;
  table(): PlaceholderTable;
  /** Die Tabelle, wie ein anderes Gerät sie aus den Dateien liest. */
  fileTable(): Promise<PlaceholderTable>;
  restore(text: string): ReturnType<PseudonymizerEngine["restore"]>;
  /** Hängt einen Zeichner an: nach jeder Änderung wird neu gezeichnet. */
  mount(render: (parent: El) => void): El;
}

export function seqRandom(from = 100): (n: number) => Uint8Array {
  let n = from;
  return () => { n += 1; return Uint8Array.from({ length: 7 }, (_, i) => (i === 0 ? n : 0)); };
}
export const idFrom = (k: number): string => placeholderIdFromBytes(Uint8Array.from({ length: 7 }, (_, i) => (i === 0 ? k : 0))) ?? "";

export async function personsRig(opts: { table?: PlaceholderTable; script?: Script } = {}): Promise<PersonsRig> {
  const fs = new FakeFs(FOLDER);
  await seedFile(fs, { deviceId: "dev-a", stand: 0, table: opts.table ?? richTable() });
  const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
  await d.store.refresh();
  const script: Script = opts.script ?? {};
  const notices: PersonsRig["notices"] = [];
  const forgets: string[] = [];
  const plans: ForgetPlan[] = [];
  const forgetChoices = { n: 0 };
  const changes = { n: 0 };
  const persistCalls = { n: 0 };
  const pending: Promise<unknown>[] = [];
  let repaint: (() => void) | null = null;

  const ui: PersonsUi = {
    choosePartner: async (_from, options) => { await script.during?.(); return script.partner === undefined ? (options[0]?.id ?? null) : script.partner; },
    confirmMerge: () => Promise.resolve(script.confirm ?? true),
    confirmDetach: () => Promise.resolve(script.confirm ?? true),
    askException: () => Promise.resolve(script.exception === undefined ? null : script.exception),
    notify: (key, ...args) => { notices.push({ key, args }); },
  };
  const keyUi: KeyActionsUi = {
    choosePerson: () => { forgetChoices.n++; return Promise.resolve(null); },
    confirmForget: (plan) => { plans.push(plan); return Promise.resolve(script.confirm ?? true); },
    confirmReplaceKey: () => Promise.resolve(true),
    confirmRemoveDevice: () => Promise.resolve(true),
    showCode: () => Promise.resolve(true),
    notify: (key, ...args) => { notices.push({ key, args }); },
  };
  const host: PersonsHost = {
    memory: d.memory,
    persist: (change) => { persistCalls.n++; return d.store.persist(change); },
    forget: async (id) => {
      forgets.push(id);
      await runForget({ store: d.store, memory: d.memory, ownDeviceId: () => d.id, ui: keyUi, changed: () => { changes.n++; repaint?.(); } }, id);
    },
    ui,
    changed: () => { changes.n++; repaint?.(); },
    random: seqRandom(),
  };
  const real = createPersonsApi(host);
  // Jeder angestoßene Ablauf wird gemerkt, damit der Test auf ihn warten kann (die Ansicht ruft sie mit `void`).
  const track = <A extends unknown[]>(f: (...a: A) => Promise<void>) => (...a: A): Promise<void> => { const p = f(...a); pending.push(p); return p; };
  const api: PersonsApi = {
    list: real.list,
    exceptions: real.exceptions,
    merge: track(real.merge),
    detach: track(real.detach),
    forget: track(real.forget),
    addException: track(real.addException),
    removeException: track(real.removeException),
  };
  const engine = new PseudonymizerEngine(d.memory, () => d.store);
  return {
    fs, d, api, script, notices, forgets, plans, forgetChoices, changes, persistCalls,
    idle: async () => { while (pending.length > 0) await pending.shift(); await vi.waitFor(() => undefined); },
    table: () => d.memory.table() as PlaceholderTable,
    fileTable: async () => {
      const r = makeDevice(fs, { deviceId: "dev-reader", content: await contentAt(CHAIN, 0) });
      await r.store.refresh();
      return r.memory.table() as PlaceholderTable;
    },
    restore: (text) => engine.restore(text, "test"),
    mount: (render) => {
      const parent = makeFakeEl();
      repaint = () => { parent.empty(); render(parent); };
      render(parent);
      return parent;
    },
  };
}

// ---- Bedienung der gezeichneten Reiter (Fake-DOM) -------------------------------------------------------------------------------------------------

export const textOf = (el: El): string => String((el as unknown as { textContent?: string }).textContent ?? "");
export const all = (el: El, sel: string): El[] => el.querySelectorAll(sel) as El[];
export const one = (el: El, sel: string): El => { const r = all(el, sel)[0]; if (r === undefined) throw new Error(`nichts für ${sel}`); return r; };
export const click = (el: El): void => { el.click(); };
export const type = (input: El, value: string): void => { input.value = value; for (const cb of input._listeners.input ?? []) cb(new Event("input")); };
export const personLabels = (parent: El): string[] => all(parent, ".pseu-person-label").map(textOf);
export const buttonTexts = (el: El): string[] => all(el, "button").map(textOf);
export const noticeKeys = (r: PersonsRig): string[] => r.notices.map((n) => n.key);
export { PERSON, PERSON_B };
