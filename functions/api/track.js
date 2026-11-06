/* Cloudflare Pages route: POST /api/track → where a customer's order is, from Shiprocket.
 * Same logic as the Workers deploy (src/worker.js); uses the same SHIPROCKET_* secrets. */
import { handleTrack } from "../../src/worker.js";

export const onRequestPost = ({ request, env }) => handleTrack(request, env);
