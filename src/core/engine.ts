import type { ApiError as PseudonymizerApiError, RestoreResult, TransformRequest, TransformResult } from "../vendor/kit/pseudonymizer-source";
import type { PluginState } from "./status";

/** Was die Plugin-API von der Maschine hinter ihr braucht. Die API (`api.ts`) prüft Eingaben und Zustand, die Engine tut die Arbeit;
 *  so sind Hülle und Kern getrennt prüfbar. Die Engine darf werfen, die API fängt es und gibt einen Fehlerwert zurück. */
export interface Engine {
  state(): PluginState;
  transform(req: TransformRequest): Promise<TransformResult | PseudonymizerApiError>;
  restore(text: string, caller: string): RestoreResult | PseudonymizerApiError;
  containsPlaceholder(text: string): boolean;
}
