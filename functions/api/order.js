/* Cloudflare Pages route: POST /api/order → create the order in Shiprocket.
 * Same logic as the Workers deploy (src/worker.js). Set SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD,
 * SHIPROCKET_PICKUP and SHIPROCKET_FALLBACK_EMAIL in Pages → Settings → Variables and Secrets. */
import { handleOrder } from "../../src/worker.js";

export const onRequestPost = ({ request, env }) => handleOrder(request, env);
