import { workflow } from "praecise";

export default workflow({
  description: "Triage a message, draft a reply, and hold refunds for approval.",
  input: { message: "the customer's message" },
  steps: [
    { id: "sorted", ask: "{{message}}", agent: "triage" },
    {
      id: "reply",
      when: "{{sorted.category}}",
      is: {
        refund: [
          { id: "draft", ask: "Draft a reply about this refund: {{message}}", agent: "support" },
          { id: "approved", approve: "Send this refund reply?\n\n{{reply.draft}}" },
        ],
      },
      otherwise: [{ id: "draft", ask: "Reply to: {{message}}", agent: "support" }],
    },
  ],
});
