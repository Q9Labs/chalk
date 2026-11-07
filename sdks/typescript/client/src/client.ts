import { ChalkApi } from "./generated/http-api";
import { makeChalkEffectClient, type ChalkEffectClientOptions } from "./effect-client";
export type { ChalkAuth, ChalkBearerAuth, ChalkClientHeaders, ChalkEffectClientOptions } from "./effect-client";
export const createChalkEffectClient = (options: ChalkEffectClientOptions) => makeChalkEffectClient(ChalkApi, options);
