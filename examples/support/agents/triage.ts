import { agent } from "praecise";

export default agent({
  description: "Sorts an incoming message into a category and urgency.",
  role: "You classify inbound support messages. Be decisive.",
  quality: "fast",
  returns: {
    category: "one of: refund, shipping, account, other",
    urgency: "one of: low, normal, high",
    summary: "one sentence describing what the customer wants",
  },
  memory: false,
});
