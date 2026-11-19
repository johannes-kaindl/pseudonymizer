// Fake-Platte für die Tests der Gerätedateien, nach dem Muster von obsidian-kit/tests/helpers/fake-adapter-fs.ts (dort nicht vendort, weil Testhilfe):
// bildet die gemessenen Eigenheiten von Obsidians `DataAdapter` nach (`writeBinary` kürzt zuerst, `rename` ersetzt kein Ziel, `list` wirft auf einem fehlenden Ordner).
// Mehrere Geräte teilen sich eine `FakeFs`, das ist der gemeinsame Vault-Ordner.
import type { DeviceFilePorts } from "../../src/vendor/kit-obsidian/device-files";

type FakeAdapter = DeviceFilePorts["adapter"];
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export class FakeFs {
  constructor(readonly folder: string) {}
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  folders = new Set<string>();
  clock = 1_000;
  mutations = 0;
  failRenameFrom = new Set<string>();
  failRenameTo = new Set<string>();
  failRead = new Set<string>();
  /** Jedes `writeBinary` scheitert (Platte voll). */
  failWrites = false;
  listThrows = false;
  /** Läuft vor jedem `writeBinary`; ein Test hält hier den Schreibvorgang an. */
  beforeWrite: ((path: string) => Promise<void>) | null = null;
  /** Alle verändernden Aufrufe in der Reihenfolge, in der sie geschahen (`write:<pfad>`, `rename:<von>-><nach>`, `remove:<pfad>`, `mkdir:<pfad>`). */
  log: string[] = [];

  adapter: FakeAdapter = {
    exists: (p) => Promise.resolve(this.files.has(p) || this.folders.has(p)),
    mkdir: (p) => { this.mutations++; this.log.push(`mkdir:${p}`); this.folders.add(p); return Promise.resolve(); },
    list: (dir) => {
      if (this.listThrows) return Promise.reject(new Error("list kaputt"));
      if (!this.folders.has(dir)) return Promise.reject(new Error("ENOENT: no such file or directory"));
      const files = [...this.files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"));
      return Promise.resolve({ files, folders: [] });
    },
    stat: (p) => {
      const f = this.files.get(p);
      return Promise.resolve(f === undefined ? null : { type: "file", ctime: f.mtime, mtime: f.mtime, size: f.bytes.byteLength });
    },
    readBinary: (p) => {
      const f = this.files.get(p);
      if (f === undefined || this.failRead.has(p)) return Promise.reject(new Error(`ENOENT: ${p}`));
      return Promise.resolve(f.bytes.slice().buffer);
    },
    writeBinary: async (p, data) => {
      if (this.beforeWrite !== null) await this.beforeWrite(p);
      if (this.failWrites) throw new Error("Platte voll");
      const incoming = new Uint8Array(data);
      this.mutations++;
      this.log.push(`write:${p}`);
      this.files.set(p, { bytes: incoming.slice(), mtime: ++this.clock });
    },
    remove: (p) => { this.mutations++; this.log.push(`remove:${p}`); this.files.delete(p); return Promise.resolve(); },
    rename: (from, to) => {
      this.mutations++;
      this.log.push(`rename:${from}->${to}`);
      if (this.failRenameFrom.has(from) || this.failRenameTo.has(to)) return Promise.reject(new Error("rename kaputt"));
      if (this.files.has(to)) return Promise.reject(new Error("Destination file already exists!"));
      const f = this.files.get(from);
      if (f === undefined) return Promise.reject(new Error("ENOENT"));
      this.files.delete(from);
      this.files.set(to, { bytes: f.bytes, mtime: ++this.clock });
      return Promise.resolve();
    },
  };

  path(name: string): string { return `${this.folder}/${name}`; }
  put(name: string, content: string | Uint8Array): void {
    this.folders.add(this.folder);
    this.files.set(this.path(name), { bytes: typeof content === "string" ? bytes(content) : content.slice(), mtime: ++this.clock });
  }
  get(name: string): Uint8Array | undefined { return this.files.get(this.path(name))?.bytes.slice(); }
  names(): string[] { return [...this.files.keys()].map((p) => p.slice(this.folder.length + 1)).sort(); }
  /** Setzt das Protokoll zurück (nach dem Aufbau eines Zustands, vor der Messung). */
  clearLog(): void { this.log = []; this.mutations = 0; }
}

/** Handbetätigte Ports: Vault-Ereignisse und Zeitgeber löst der Test selbst aus. */
export class ManualPorts {
  listeners = new Set<(path: string) => void>();
  timers: { cb: () => void; ms: number; live: boolean }[] = [];
  constructor(private readonly fs: FakeFs) {}
  ports(): DeviceFilePorts {
    return {
      adapter: this.fs.adapter,
      now: () => 1_700_000_000_000,
      onVaultEvent: (cb) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; },
      setInterval: (cb, ms) => { const t = { cb, ms, live: true }; this.timers.push(t); return () => { t.live = false; }; },
    };
  }
  emit(path: string): void { for (const l of [...this.listeners]) l(path); }
  tick(): void { for (const t of this.timers) if (t.live) t.cb(); }
}
