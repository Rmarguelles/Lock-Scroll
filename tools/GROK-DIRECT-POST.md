# Letting the extractor post straight into the review queue

**Status: not built yet.** The app side is deliberately unwritten until we know
the extractor can actually make an authenticated HTTP request. Ask it the
question in step 1 before anything else — if the answer is no, the file picker
added in v247 is already the shortest path and nothing here is needed.

---

## Step 1 — ask the extractor this, word for word

> Can you make an HTTPS POST request to an arbitrary URL with a JSON body, and
> show me the actual response status and body you get back? Do not describe
> what you would do — actually make this request and paste the real response:
>
> `POST https://httpbin.org/post`
> body: `{"test": "hello"}`

Two things matter in the answer:

- It must come back with a **real response body** echoing `{"test": "hello"}`.
  If it describes the request, offers code for you to run, or says it cannot
  reach the network, the answer is **no**.
- Models are prone to claiming a capability they do not have. A pasted response
  that looks plausible but generic is not proof. Ask it to include the
  `origin` IP from the httpbin reply — that is hard to invent convincingly.

If the answer is no: stop here, keep using the file picker.

---

## Step 2 — the Firestore rules to add (only if step 1 said yes)

In the Firebase console for project `locknscroll`, under
**Firestore Database → Rules**, add this block alongside the existing rules.
Replace the token with a long random string of your own.

```
match /importInbox/{docId} {
  // Anyone holding the token may DROP OFF a batch. They cannot read, change
  // or delete anything, and nothing here is live data - it is a queue the app
  // pulls from and you review by hand.
  allow create: if request.resource.data.token == 'PUT-A-LONG-RANDOM-STRING-HERE'
                && request.resource.data.payload is string
                && request.resource.data.payload.size() < 900000;

  // Only a signed-in user can see or clear the inbox.
  allow read, delete: if request.auth != null;
  allow update: if false;
}
```

### What this does and does not risk

- **Worst case if the token leaks:** someone can add junk documents to
  `importInbox`. They cannot read your keys, prices, stock or job history, and
  cannot alter anything. You would see unexpected rows in the review queue and
  clear them.
- **This is deliberately not write access to `shared/data`.** That document is
  written with `.set(data, { merge: true })`, and merge only protects
  *top-level fields* — `customKeys` is one field holding the whole array, so a
  single write there would replace all your keys at once. The inbox exists so
  nothing external ever touches it.
- The token will sit in your extractor chat history. Treat it as low-value and
  rotate it by editing the rule if you ever want to.

---

## Step 3 — the instruction to give the extractor

> After you finish a batch, POST it to my inbox instead of printing it.
>
> ```
> POST https://firestore.googleapis.com/v1/projects/locknscroll/databases/(default)/documents/importInbox
> Content-Type: application/json
> ```
>
> Body — note that the whole batch goes in as **one JSON string** inside
> `payload`, not as nested Firestore fields:
>
> ```json
> {
>   "fields": {
>     "token":      { "stringValue": "PUT-A-LONG-RANDOM-STRING-HERE" },
>     "source":     { "stringValue": "Your Car Key Guys" },
>     "batchLabel": { "stringValue": "nissan-2026-09-24-01" },
>     "payload":    { "stringValue": "{\"source\":\"Your Car Key Guys\",\"keys\":[ ... ]}" }
>   }
> }
> ```
>
> Rules:
> - `payload` is the complete batch object, JSON-encoded as a string, exactly
>   the shape described in the extraction prompt.
> - Keep each POST under 900 KB. At roughly 20 keys per batch you are far
>   under, but split if a run gets large.
> - `batchLabel` must be unique per POST so a retry does not look like a new
>   batch.
> - **Show me the HTTP status and response body of every POST.** A silent
>   success is not a success.
> - If a POST fails, print the batch as JSON instead so nothing is lost.

---

## Step 4 — what I build once you confirm it works

- A **Pull from inbox** button on the import panel: reads `importInbox`,
  parses each `payload`, stages it through the same `parseImportBatch()` path
  the file picker uses, then deletes the inbox document.
- The same review queue. The route in changes; **nothing skips review.**

That last point is the reason this is safe to do at all. Direct posting removes
a copy-paste, not the human check — the extractor's own output has needed a
correction in every batch so far.
