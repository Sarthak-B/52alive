/* Cloudflare Pages route: POST /api/courier-updates — Shiprocket tracking webhook → stock off the shop.
 * Same logic as the Workers deploy (src/worker.js). Needs SHIPROCKET_WEBHOOK_TOKEN and GITHUB_TOKEN. */
import { handleCourierUpdate } from "../../src/worker.js";

export const onRequestPost = ({ request, env, waitUntil }) => handleCourierUpdate(request, env, { waitUntil });
export const onRequestGet = () => new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
