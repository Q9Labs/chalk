import { z } from "zod";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import type { Engine } from "./engine";
import { clearSeatCookies } from "./cookies";
import { DashboardError, json, query } from "./http";
import { callMutation, callPage, callStatus, callMetadata, callInvite } from "./call";
import { connectMutation, connectPage, connectionsMutation, connectionsPage } from "./connect";
import { developerMutation, developerPage } from "./developer";
import { homeMutation, homePage, homeStatus } from "./home";
import { ownerAccess } from "./owner-access";
import { viewerSeat } from "./owner-seats";
import { pastMutation, pastSessionPage, pastTranscriptText } from "./past-session";
import { recordingsPage, sessionsPage } from "./sessions";
import {
  callAction,
  callMetadataQuery,
  callQuery,
  callStatusQuery,
  connectAction,
  connectQuery,
  connectionsAction,
  developerAction,
  developerQuery,
  homeAction,
  homeStatusQuery,
  pageQuery,
  pastAction,
  pastQuery,
  recordingsQuery,
  sessionsQuery,
  transcriptTextQuery,
} from "../src/lib/dashboard/contracts";
import type { ActionResult, DashboardPage, DashboardPages } from "../src/lib/dashboard/contracts";

export type Context = { engine: Engine; request: Request; env: DashboardEnvironment; person: Identity };

/** What a page's handlers answer: its contract's data, or the response itself when the page streams something else. */
type PageName = DashboardPage | "transcript-text";
type Data<N extends PageName> = N extends DashboardPage ? DashboardPages[N]["data"] : Response;

type Page<N extends PageName, Q extends z.ZodType, A extends z.ZodType> = {
  query: Q;
  read: (context: Context, query: z.output<Q>) => Promise<Data<N>>;
  action?: A;
  act?: (context: Context, action: z.output<A>) => Promise<Response | ActionResult<Extract<z.output<A>, { action: string }>>>;
};

/** A page as the dispatcher runs it: input parsed by the page's own schemas, the answer sent as JSON unless it is already a response. */
type Route = {
  read: (context: Context) => Promise<Response>;
  act: (context: Context, input: unknown) => Promise<Response>;
};

const reply = (answer: unknown): Response => (answer instanceof Response ? answer : json(answer));

function page<N extends PageName>() {
  return <Q extends z.ZodType, A extends z.ZodType = z.ZodNever>(definition: Page<N, Q, A>): Route => ({
    read: async (context) => reply(await definition.read(context, definition.query.parse(query(context.request)))),
    act: async (context, input) => {
      if (!definition.action || !definition.act) throw new DashboardError(404, "route_not_found");
      return reply(await definition.act(context, definition.action.parse(input)));
    },
  });
}

/** The dashboard's pages, one entry each. `functions/dashboard-api/<name>.ts` exists for every name here, as `routes.test.ts` checks. */
export const pages: Record<PageName, Route> = {
  home: page<"home">()({ query: pageQuery, read: ({ engine }, q) => homePage(engine, q.cursor), action: homeAction, act: ({ engine }, a) => homeMutation(engine, a) }),
  "home-status": page<"home-status">()({ query: homeStatusQuery, read: ({ engine }, q) => homeStatus(engine, q) }),
  call: page<"call">()({
    query: callQuery,
    read: ({ engine }, q) => callPage(engine, q.spaceId, q.cursor),
    action: callAction,
    act: async ({ engine, request, env, person }, a) => {
      if (a.action === "join" || a.action === "refresh-access") return ownerAccess(request, env, engine, person, a);
      const response = json(await callMutation(engine, a));
      if (a.action === "end-for-everyone") clearSeatCookies(response, request, env);
      return response;
    },
  }),
  "call-status": page<"call-status">()({ query: callStatusQuery, read: ({ engine }, q) => callStatus(engine, q.spaceId) }),
  "call-invite": page<"call-invite">()({ query: callStatusQuery, read: ({ engine }, q) => callInvite(engine, q.spaceId) }),
  "call-metadata": page<"call-metadata">()({ query: callMetadataQuery, read: ({ engine }, q) => callMetadata(engine, q) }),
  "past-session": page<"past-session">()({
    query: pastQuery,
    read: async ({ engine, request, env, person }, q) => pastSessionPage(engine, q.spaceId, q.episodeId, q.cursor, await viewerSeat(request, env, person, q.spaceId, q.episodeId)),
    action: pastAction,
    act: ({ engine }, a) => pastMutation(engine, a),
  }),
  "transcript-text": page<"transcript-text">()({ query: transcriptTextQuery, read: ({ engine, env }, q) => pastTranscriptText(engine, env, q) }),
  sessions: page<"sessions">()({ query: sessionsQuery, read: ({ engine }, q) => sessionsPage(engine, q) }),
  recordings: page<"recordings">()({ query: recordingsQuery, read: ({ engine }, q) => recordingsPage(engine, q) }),
  developer: page<"developer">()({ query: developerQuery, read: ({ engine }, q) => developerPage(engine, q), action: developerAction, act: ({ engine }, a) => developerMutation(engine, a) }),
  connect: page<"connect">()({ query: connectQuery, read: ({ engine }, q) => connectPage(engine, q.request), action: connectAction, act: ({ engine }, a) => connectMutation(engine, a) }),
  connections: page<"connections">()({ query: pageQuery, read: ({ engine }, q) => connectionsPage(engine, q.cursor), action: connectionsAction, act: ({ engine }, a) => connectionsMutation(engine, a) }),
};
