import type { Engine } from "../core/engine";
import type { PluginState } from "../core/status";
import type { ApiError as PseudonymizerApiError, RestoreResult, TransformRequest, TransformResult } from "../vendor/kit/pseudonymizer-source";

const NOT_SET_UP: PseudonymizerApiError = { error: "not-ready", message: "the table is not set up" };

/** Platzhalter-Engine bis zu den Aufgaben 9 und 11: nichts eingerichtet, nichts erkannt, nichts geschrieben. */
export class StubEngine implements Engine {
  state(): PluginState { return "not-set-up"; }
  transform(_req: TransformRequest): Promise<TransformResult | PseudonymizerApiError> { return Promise.resolve({ ...NOT_SET_UP }); }
  restore(_text: string, _caller: string): RestoreResult | PseudonymizerApiError { return { ...NOT_SET_UP }; }
  containsPlaceholder(_text: string): boolean { return false; }
}
