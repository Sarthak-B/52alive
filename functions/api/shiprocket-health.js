/* Cloudflare Pages route: GET /api/shiprocket-health — yes/no checks of the Shiprocket connection. */
import { handleHealth } from "../../src/worker.js";

export const onRequestGet = ({ request, env }) => handleHealth(request, env);
