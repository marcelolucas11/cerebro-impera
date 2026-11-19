import { config } from 'zod';

/*
 * Imported first by the page. Zod can speed up checks by writing code at run
 * time, and probes for that with `Function('')`. The page's security policy
 * (Trusted Types) forbids turning text into code, so the probe would only be
 * blocked and reported; this says up front not to try.
 */
config({ jitless: true });
