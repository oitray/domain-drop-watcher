import type { Env } from "./types.js";

export default {
  async fetch(
    _request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },

  async scheduled(
    _event: ScheduledEvent,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    return undefined;
  },
};
