# Balise Nissan of Warwick: Tekion RO status service (Bland webhook backend)

One endpoint. Bland's `lookup_ro` webhook node calls it during the live call.

    POST /ro-status
    Authorization: Bearer <WEBHOOK_SECRET>
    { "ro_number": "0142368" }

    -> { "found": true, "ro_number": "0142368", "status": "IN_PROGRESS",
         "spoken": "a technician is working on the vehicle right now",
         "tag_number": "67922", "promise_time_spoken": "Tuesday, September 15 at 4:30 PM",
         "dealer": "Balise Nissan of Warwick" }

The service owns the Tekion token exchange (form-encoded POST to /public/tokens, 24h expiry,
20 tokens per 15 minutes) and caches the token in memory, refreshing on 401.

## Deploy on Render
1. Push this folder to a Git repo (GitHub, GitLab, or Bitbucket) that Render can see.
2. Create a Web Service from the repo. `render.yaml` sets runtime, build/start commands, region and
   the non-secret env vars. Or create it via the Render MCP with the same values.
3. In the Render dashboard, set the two secrets (marked `sync: false` in render.yaml):
   - `TEKION_SECRET_KEY`: the Tekion secret key for app 1818f9b3-45c6-4bcb-9eee-2c0d1b0217c1
   - `WEBHOOK_SECRET`: any long random string (e.g. `openssl rand -hex 32`)
4. Confirm `TEKION_DEALER_ID`. Two IDs were mentioned: `baliseautogroup_7746_0` (labelled Dealer ID) and
   `baliseautogroup_7772_0`. render.yaml uses 7746_0; change it if the Dealer Dashboard says otherwise.
5. `TEKION_BASE` starts on sandbox. Switch to `https://api.tekioncloud.com/openapi` after the dealer
   requests connection in Tekion's Integration Hub and you mark them onboarded.
6. Test: `curl https://<service>.onrender.com/health`, then
   `curl -X POST https://<service>.onrender.com/ro-status -H "Authorization: Bearer $WEBHOOK_SECRET" -H "Content-Type: application/json" -d '{"ro_number":"5142"}'`
   If the first real call returns `lookup_failed`, check the Render logs: the token response field
   name is inferred (`access_token` / `token` / ...) and may need pinning in `server.js`.

## Bland side
- Create a Bland Secret named `balise_ro_webhook_secret` with the same value as `WEBHOOK_SECRET`.
  The pathway references it as `{{ SECRET.balise_ro_webhook_secret }}` in the webhook node's auth.
- Import `balise_nissan_warwick_ro_status_pathway.json`, then replace `DID_TBD_BALISE_SERVICE` on the
  three transfer nodes with the real service DID, and set the webhook URL to your Render URL.
- Plan note: the free Render plan spins down after 15 minutes idle and the first call takes 30 to 60 s
  to wake, which is longer than the 12 s webhook timeout. Use `starter` or above for anything a caller hears.
