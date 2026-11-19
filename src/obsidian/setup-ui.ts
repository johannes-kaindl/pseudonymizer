import { Notice } from "obsidian";
import type { App } from "obsidian";
import { t } from "../vendor/kit/i18n";
import { enterRecoveryCode, showRecoveryCode } from "./code-modals";
import { askExistingFiles, askSetUp } from "./setup-modals";
import type { SetupUi } from "./setup";

/** Die Fenster und Meldungen von Obsidian für die Abläufe in `setup.ts`. `folder` ist der Ordner aus den Einstellungen (für die Warnung). */
export function createSetupUi(app: App, folder: () => string): SetupUi {
  return {
    existingFiles: () => askExistingFiles(app, folder()),
    chooseSetUp: (lang) => askSetUp(app, lang),
    showCode: (content, requireConfirmation) => showRecoveryCode(app, content, { requireConfirmation }),
    enterCode: () => enterRecoveryCode(app),
    notify: (key, ...args) => { new Notice(t(key, ...args)); },
  };
}
