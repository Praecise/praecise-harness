/**
 * Starting points for `praecise init --template <name>`.
 *
 * Each one is a whole small app rather than a fragment, and each shows a
 * different shape the runner supports: one agent answering, a graph that fans
 * out, and a plan the model lays out itself. They are meant to be read and
 * edited, so they stay short.
 */

import type { FileContents, TemplateSpec } from "../define.js";

import { runtimeReadsTypeScript, scaffold } from "./scaffold.js";

function build(name: string, description: string, files: FileContents[]): TemplateSpec {
  return { kind: "template", name, description, files };
}

/** Every built-in template, already merged with the base scaffold. */
export function templates(app: string, language?: "ts" | "js"): TemplateSpec[] {
  // The same rule the base scaffold follows: a template writes what the runtime that
  // will run it can load. A template that scaffolds an app which does not start is a
  // worse first impression than no template.
  const ext = (language ?? (runtimeReadsTypeScript() ? "ts" : "js")) === "ts" ? "ts" : "js";
  const base = scaffold(app, ext);
  const merge = (name: string, description: string, files: FileContents[]): TemplateSpec => {
    const overridden = new Set(files.map((file) => file.path));
    return build(name, description, [
      ...base.filter((file) => !overridden.has(file.path)),
      ...files,
    ]);
  };

  return [
    merge("assistant", "One agent, grounded in a folder of notes.", []),

    merge("support", "An agent that can act, through a function you wrote.", [
      {
        path: `agents/assistant.${ext}`,
        contents: `import { agent } from "praecise";

export default agent({
  role: \`Customer support for ${app}. Answers from the notes it is given, and
issues a refund when a customer asks for one and has given their order id.\`,
  description: "Handles a customer's support question, refunds included.",
  knows: ["memory/*.md"],
  tools: ["refund"],
  rules: ["Never issue a refund without an order id."],
});
`,
      },
      {
        path: `functions/refund.${ext}`,
        contents: `import { fn } from "praecise";

export default fn({
  description: "Refund an order and return the confirmation.",
  input: { order: "the order id, like A-1042" },
  async run({ order }) {
    // Replace this with the call your billing system actually needs.
    return { order, status: "refunded" };
  },
});
`,
      },
    ]),

    merge("research", "A workflow that fans out, then pulls the findings together.", [
      {
        path: `workflows/research.${ext}`,
        contents: `import { workflow } from "praecise";

export default workflow({
  description: "Look into a question from several angles at once.",
  input: { question: "what to look into" },
  steps: [
    { id: "angles", ask: "List three angles worth investigating for: {{question}}" },
    {
      id: "dig",
      each: "{{angles}}",
      as: "angle",
      concurrency: 3,
      do: [{ id: "notes", ask: "Research this angle and note what you find: {{angle}}" }],
    },
    { id: "report", ask: "Write up these findings as one answer:\\n{{dig}}", after: ["dig"] },
  ],
});
`,
      },
    ]),

    merge("plan", "A workflow that decides its own steps, then runs them.", [
      {
        path: `workflows/handle.${ext}`,
        contents: `import { workflow } from "praecise";

export default workflow({
  description: "Work out what to do, then do it.",
  input: { task: "what needs doing" },
  steps: [
    // No steps are written here. The model lays them out from the agents and
    // functions this app has, and independent ones run at the same time.
    { id: "work", plan: "{{task}}", max: 6 },
    { id: "sign", approve: "Send this?\\n\\n{{work}}", after: ["work"] },
  ],
});
`,
      },
    ]),
  ];
}
