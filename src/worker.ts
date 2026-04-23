import type { Env } from "./types.js";
import { handleAdmin } from "./admin.js";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleAdmin(req, env, ctx);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "internal", message: String(err) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    return undefined;
  },
};
