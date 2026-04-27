# Demo spend alert response

When the $5/mo spend alert fires:
1. Confirm the spend in CF dashboard → Billing → Usage. If <$5, false alarm.
2. If real, disable the demo:
   - `wrangler delete --env demo` (removes the worker entirely), OR
   - In CF dashboard: Workers & Pages → domain-drop-watcher-demo → Triggers → Delete `ddw.oitlabs.com` route
3. Update README banner: replace "Try it: ddw.oitlabs.com" with "Demo temporarily offline pending cost review."
4. Post-mortem: identify what caused the spike (RDAP polls? webhook fanout? abuse?). Add the mitigation (rate limit, daily quota, etc.) before re-enabling.
