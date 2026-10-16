import { z } from "zod";

// The browser entry imports this before application modules construct any schemas.
if ("window" in globalThis) z.config({ jitless: true });
