# support

A small app showing the three pieces: an agent grounded in files, a fast agent
that returns structured data, and a workflow that branches on that data and
stops for a human before anything is sent.

```
agents/support.ts    grounded in memory/, remembers the conversation
agents/triage.ts     returns {category, urgency, summary}
workflows/handle.ts  triage → branch → draft → approve
memory/*.md          the policies both agents answer from
```

## Run it

```sh
echo "PRAECISE_API_KEY=..." > .env
npx praecise dev
```

Then open the dashboard, or call it directly:

```sh
npx praecise run support "how long do refunds take?"
npx praecise run handle message="I want my money back for order 4021"
```
