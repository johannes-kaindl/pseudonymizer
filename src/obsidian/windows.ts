import type { App } from "obsidian";

/** Alle Fenster, in denen Obsidian gerade Notizen zeigt: das Hauptfenster und jedes Popout-Fenster, in dem ein Blatt hängt. Ein Popout hat ein eigenes `document`;
 *  was am Hauptfenster hängt (Kopier-Handler, Auffrischen), gilt dort nicht (Kit-Kopf von `text-swap`, B2). */
export function openDocuments(app: Pick<App, "workspace">): Document[] {
  const docs = new Set<Document>([app.workspace.containerEl.ownerDocument]);
  app.workspace.iterateAllLeaves((leaf) => { docs.add(leaf.view.containerEl.ownerDocument); });
  return [...docs];
}
