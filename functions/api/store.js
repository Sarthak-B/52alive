/* Cloudflare Pages route: POST /api/store — the NOWORA dashboard's orders list and "Ship now".
 * Same logic as the Workers deploy (src/worker.js). Key: STORE_KEY, or SHIPROCKET_WEBHOOK_TOKEN if unset. */
import { handleStore } from "../../src/worker.js";

export const onRequest = ({ request, env, waitUntil }) => handleStore(request, env, { waitUntil });
