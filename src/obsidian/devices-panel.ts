import { Setting } from "obsidian";
import type { CommandId } from "../core/commands";
import type { DeviceRow, DevicesModel } from "../core/devices-view";
import { t } from "../vendor/kit/i18n";
import { buildStatus, paintStatus } from "../vendor/kit-obsidian/status-indicator";

/** Was der Reiter „Geräte und Schlüssel“ vom Plugin braucht. */
export interface DevicesHost {
  devices(): DevicesModel;
  deviceName(): string;
  setDeviceName(name: string): void;
  run(id: CommandId): void;
  /** Entfernt ein fremdes Gerät. */
  removeDevice(deviceId: string): void;
}

const PROBLEM_KEYS = new Set(["unreadable-header", "newer-format", "authentication", "too-far", "bad-content", "read-failed", "invalid-name"]);

/** Der Satz zum Zustand einer Gerätedatei: nie ein Inhalt, nur Art und Grund. */
function rowStatus(r: DeviceRow): { phase: "ok" | "warning" | "idle"; text: string } {
  if (r.status === "read") return { phase: "ok", text: t("view.devices.status.read") };
  if (r.status === "problem") return { phase: "warning", text: t(`view.devices.problem.${PROBLEM_KEYS.has(r.problemKind ?? "") ? String(r.problemKind) : "other"}`) };
  return { phase: "idle", text: t("view.devices.status.notOpened") };
}

/** Die Liste der Gerätedateien, die im Ordner angekommen sind: Name, Stand, und ob sie sich lesen ließen (Text und Symbol, nie nur Farbe). Auch im gesperrten Zustand. */
export function renderDeviceFiles(parent: HTMLElement, m: DevicesModel, onRemove?: (row: DeviceRow) => void): void {
  parent.createEl("h4", { text: t("view.devices.files") });
  if (m.rows.length === 0 && m.stray.length === 0) {
    parent.createDiv({ cls: "pseu-note", text: t("view.devices.noFiles") });
    return;
  }
  const list = parent.createEl("ul", { cls: "pseu-devices" });
  for (const r of m.rows) {
    const li = list.createEl("li", { cls: "pseu-device" });
    const head = li.createDiv({ cls: "pseu-device-head" });
    head.createSpan({ cls: "pseu-device-name", text: r.name });
    if (r.own) head.createSpan({ cls: "pseu-device-own", text: ` (${t("view.devices.own")})` });
    li.createDiv({ cls: "pseu-device-meta", text: t("view.devices.stand", r.stand) });
    const s = rowStatus(r);
    paintStatus(buildStatus(li), s.phase, s.text);
    // Fremde Geräte lassen sich entfernen, das eigene nie; nur wo der Aufrufer es anbietet (bereit).
    if (onRemove !== undefined && !r.own) {
      const b = li.createEl("button", { cls: "pseu-device-remove", text: t("view.devices.remove"), attr: { type: "button", "aria-label": t("view.devices.removeLabel", r.name) } });
      b.addEventListener("click", () => { onRemove(r); });
    }
  }
  if (m.stray.length > 0) {
    parent.createDiv({ cls: "pseu-note", text: t("view.devices.stray") });
    const stray = parent.createEl("ul", { cls: "pseu-devices-stray" });
    for (const f of m.stray) stray.createEl("li", { text: `${f.path}` });
  }
}

function renderKey(parent: HTMLElement, m: DevicesModel, host: DevicesHost): void {
  parent.createEl("h4", { text: t("view.devices.key") });
  const lines = parent.createDiv({ cls: "pseu-devices-key" });
  if (m.progress === null) {
    lines.createDiv({ text: t("view.devices.progress.none") });
  } else {
    const p = m.progress;
    const some = t("view.devices.progress.some", p.devicesDone, p.devicesTotal);
    lines.createDiv({ text: p.pending.length > 0 ? `${some} (${t("view.devices.progress.pending", p.pending.join(", "))})` : some });
    if (p.complete) lines.createDiv({ text: t("view.devices.progress.complete") });
  }
  if (m.codeStand === null) {
    lines.createDiv({ cls: "pseu-warning", text: t("view.devices.code.none") });
  } else if (m.stand !== null && m.codeStand < m.stand) {
    lines.createDiv({ cls: "pseu-warning", text: t("view.devices.code.outdated", m.codeStand, m.stand) });
  } else {
    lines.createDiv({ text: t("view.devices.code.current", m.codeStand) });
  }
  parent.createDiv({ cls: "pseu-note", text: t("view.devices.loss") });
  const actions = parent.createDiv({ cls: "pseu-devices-actions" });
  const b = actions.createEl("button", { text: t("view.devices.showCode"), attr: { type: "button" } });
  b.addEventListener("click", () => { host.run("show-recovery-code"); });
  const replace = actions.createEl("button", { text: t("view.devices.replaceKey"), attr: { type: "button" } });
  replace.addEventListener("click", () => { host.run("replace-key"); });
  const forget = actions.createEl("button", { text: t("view.devices.forget"), attr: { type: "button" } });
  forget.addEventListener("click", () => { host.run("forget-person"); });
}

function renderName(parent: HTMLElement, host: DevicesHost, onEditing: (editing: boolean) => void): void {
  new Setting(parent).setName(t("view.devices.name.name")).setDesc(t("view.devices.name.desc")).addText((tx) => {
    tx.setValue(host.deviceName());
    tx.inputEl.setAttribute("aria-label", t("view.devices.name.name"));
    // `change` kommt beim Verlassen des Feldes und bei Enter; ein leerer Name setzt den Vorgabenamen zurück.
    tx.inputEl.addEventListener("focus", () => { onEditing(true); });
    tx.inputEl.addEventListener("blur", () => { onEditing(false); });
    tx.inputEl.addEventListener("change", () => {
      host.setDeviceName(tx.getValue());
      tx.setValue(host.deviceName());
    });
  });
}

/** Der Reiter „Geräte und Schlüssel“ im Zustand `ready` (Spec 8.3 „Stand anzeigen“, Schlüsselverlust).  Knöpfe: Code anzeigen, Schlüssel ersetzen, Person vergessen und je fremdem Gerät „Gerät entfernen“. */
export function renderDevices(parent: HTMLElement, host: DevicesHost, onEditing: (editing: boolean) => void = () => undefined): void {
  const m = host.devices();
  const root = parent.createDiv({ cls: "pseu-devices-panel" });
  renderName(root, host, onEditing);
  renderDeviceFiles(root, m, (row) => { host.removeDevice(row.deviceId); });
  renderKey(root, m, host);
}
