// Lock & Scroll agent bridge: the MCP server Grok, Claude and ChatGPT connect
// to. Deploy steps are in ../README.md.
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { makeHandler } from './lib/http.js';

initializeApp();

export const agent = onRequest(
  {
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 60,
    // A cap on how many copies can run at once, so a runaway client cannot
    // run up the bill.
    maxInstances: 5,
    // Reachable without a Google sign-in: the access link in the URL is the
    // credential, checked on every request.
    invoker: 'public'
  },
  makeHandler(() => getFirestore())
);
