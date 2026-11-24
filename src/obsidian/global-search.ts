import type { App } from "obsidian";

/** Der Zugriff auf Obsidians eingebaute Suche (Kernplugin `global-search`). Die Schnittstelle ist nicht öffentlich dokumentiert, deshalb steht der Zugriff allein hier,
 *  trägt jeden Schritt als Möglichkeit und meldet ein Fehlen als `false`, nie als Ausnahme. Sie ist auch ausgeschaltet, wenn der Nutzer das Kernplugin abgeschaltet hat. */
interface GlobalSearchLike { openGlobalSearch?: (query: string) => void }
interface InternalPluginsLike { getPluginById?: (id: string) => { enabled?: boolean; instance?: GlobalSearchLike } | null | undefined }

/** Öffnet die Suche mit `query`. `false`, wenn Obsidian den Zugriff nicht (mehr) bietet oder er scheitert; der Aufrufer sagt es dann in einer Notice. */
export function openGlobalSearch(app: App, query: string): boolean {
  try {
    const internal = (app as unknown as { internalPlugins?: InternalPluginsLike }).internalPlugins;
    const plugin = internal?.getPluginById?.("global-search");
    // Ausgeschaltet bleibt `instance` stehen und `openGlobalSearch` läuft ohne Wirkung (gemessen in Obsidian 1.15.1: `enabled` false, keine Ansicht, keine Meldung): dann `false`, damit der Aufrufer die Kennungen nennt.
    if (plugin?.enabled === false) return false;
    const instance = plugin?.instance;
    if (typeof instance?.openGlobalSearch !== "function") return false;
    instance.openGlobalSearch(query);
    return true;
  } catch {
    return false;
  }
}
