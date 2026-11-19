import { PluginSettingTab, Setting, type App, type SettingDefinitionControl, type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";
import type PseudonymizerPlugin from "../main";
import { RULE_GROUPS, withFolder, type CopyMode, type RuleGroup } from "../core/settings";
import { getLang, t } from "../vendor/kit/i18n";
import { confirmAction, type ConfirmOptions } from "../vendor/kit-obsidian/confirm";
import { FolderSuggest } from "../vendor/kit-obsidian/folder-suggest";
import { githubHelpUrls, helpSettingDefinition, type HelpSettingOptions } from "../vendor/kit-obsidian/help-setting";
import { buildSegmentedControl } from "../vendor/kit-obsidian/segmented-control";
import { statusBarSettingDefinition } from "../vendor/kit-obsidian/status-bar-item";

/** Doku-Index und Issues auf GitHub; `open` nur für Tests. */
export function helpOptions(open?: (url: string) => void): HelpSettingOptions {
  return {
    ...githubHelpUrls("pseudonymizer"),
    texts: { name: t("settings.help.name"), desc: t("settings.help.desc"), openDocs: t("settings.help.openDocs"), reportIssue: t("settings.help.reportIssue") },
    ...(open ? { open } : {}),
  };
}

type ItemDef = SettingDefinitionRender | SettingDefinitionControl;
type GroupDef = { type: "group"; heading: string; items: ItemDef[] };

const RULE_PREFIX = "rules.";
const isRuleGroup = (x: string): x is RuleGroup => (RULE_GROUPS as readonly string[]).includes(x);

export type FolderResult = { ok: true } | { ok: false; reason: "invalid" | "declined" };

export class PseudonymizerSettingTab extends PluginSettingTab {
  constructor(app: App, readonly plugin: PseudonymizerPlugin, private readonly confirm: (opts: ConfirmOptions) => Promise<boolean> = (opts) => confirmAction(app, opts)) {
    super(app, plugin);
  }

  /** Deklarativ: Obsidian rendert die Definitionen selbst. Die Hilfe-Zeile (UI-STANDARD §8) ist immer das ERSTE Element. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const defs: (GroupDef | ReturnType<typeof helpSettingDefinition>)[] = [
      helpSettingDefinition(helpOptions()),
      { type: "group", heading: t("settings.group.table"), items: [
        { name: t("settings.folder.name"), desc: t("settings.folder.desc"), render: (s) => { this.renderFolder(s); } },
      ] },
      { type: "group", heading: t("settings.group.copy"), items: [
        { name: t("settings.copy.name"), desc: t("settings.copy.desc"), render: (s) => { this.renderCopyMode(s); } },
      ] },
      { type: "group", heading: t("settings.group.display"), items: [
        statusBarSettingDefinition({
          value: this.plugin.settings.statusBar,
          onChange: (v) => this.setControlValue("statusBar", v),
          strings: { lang: getLang(), name: t("settings.statusBar.name"), desc: t("settings.statusBar.desc") },
        }),
      ] },
      { type: "group", heading: t("settings.group.rules"), items: RULE_GROUPS.map((g): ItemDef => ({
        name: t(`settings.rule.${g}`), desc: t(`settings.rule.${g}Desc`), control: { type: "toggle", key: RULE_PREFIX + g },
      })) },
    ];
    return defs;
  }

  /** Host-Vertrag der deklarativen Controls (nativ ab 1.13 und im Kit-Walker). */
  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key.startsWith(RULE_PREFIX)) {
      const g = key.slice(RULE_PREFIX.length);
      return isRuleGroup(g) ? s.rules[g] : undefined;
    }
    switch (key) {
      case "statusBar": return s.statusBar;
      case "copyMode": return s.copyMode;
      case "folder": return s.folder;
      default: return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    if (key.startsWith(RULE_PREFIX)) {
      const g = key.slice(RULE_PREFIX.length);
      if (!isRuleGroup(g)) return;
      s.rules[g] = Boolean(value);
    } else if (key === "statusBar") {
      s.statusBar = Boolean(value);
    } else if (key === "copyMode") {
      if (value !== "placeholder" && value !== "as-shown") return;
      s.copyMode = value;
    } else {
      return;
    }
    await this.plugin.saveSettings();
  }

  /** Setzt den Ordner der Tabelle. Ist die Tabelle schon eingerichtet, fragt es zuerst und sagt, dass nichts verschoben wird. */
  async setFolder(raw: string): Promise<FolderResult> {
    const next = withFolder(this.plugin.settings, raw);
    if ("error" in next) return { ok: false, reason: "invalid" };
    if (next.folder === this.plugin.settings.folder) return { ok: true };
    if (this.plugin.folderLocked()) {
      const yes = await this.confirm({ title: t("modal.folder.title"), message: t("modal.folder.message"), confirmLabel: t("modal.folder.confirm"), cancelLabel: t("modal.cancel"), warning: false });
      if (!yes) return { ok: false, reason: "declined" };
    }
    this.plugin.settings.folder = next.folder;
    await this.plugin.saveSettings();
    return { ok: true };
  }

  private renderFolder(setting: Setting): void {
    setting.setName(t("settings.folder.name")).setDesc(t("settings.folder.desc"));
    const note = setting.descEl.createDiv({ cls: "pseu-note" });
    if (this.plugin.folderLocked()) note.setText(t("settings.folder.locked"));
    setting.addText((tx) => {
      tx.setValue(this.plugin.settings.folder);
      tx.inputEl.setAttribute("aria-label", t("settings.folder.name"));
      new FolderSuggest(this.app, tx.inputEl);
      tx.inputEl.addEventListener("blur", () => {
        if (tx.getValue().trim() === this.plugin.settings.folder) return;
        const raw = tx.getValue();
        void this.setFolder(raw).then((r) => {
          const bad = !r.ok && r.reason === "invalid";
          note.setText(bad ? t("settings.folder.invalid", raw.trim()) : this.plugin.folderLocked() ? t("settings.folder.locked") : "");
          note.toggleClass("pseu-warning", bad);
          note.toggleClass("pseu-note", !bad);
          if (!r.ok) tx.setValue(this.plugin.settings.folder);
        });
      });
    });
  }

  private renderCopyMode(setting: Setting): void {
    setting.setName(t("settings.copy.name")).setDesc(t("settings.copy.desc"));
    buildSegmentedControl<CopyMode>(setting.controlEl, {
      options: [{ value: "placeholder", label: t("settings.copy.placeholder") }, { value: "as-shown", label: t("settings.copy.asShown") }],
      value: this.plugin.settings.copyMode,
      ariaLabel: t("settings.copy.name"),
      onChange: (v) => { void this.setControlValue("copyMode", v); },
    });
  }
}
