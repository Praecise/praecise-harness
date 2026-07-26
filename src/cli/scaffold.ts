/**
 * What `praecise init` writes.
 *
 * A new app is four small files. Everything the runtime needs beyond them —
 * routing, memory, grounding, tool wiring — is inferred, so there is nothing
 * here to configure and nothing to delete before starting.
 */

export interface ScaffoldFile {
  path: string;
  contents: string;
}

export function scaffold(name: string): ScaffoldFile[] {
  return [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: { dev: "praecise dev", start: "praecise dev" },
          dependencies: { praecise: "^0.1.0" },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "agents/assistant.ts",
      contents: `import { agent } from "praecise";

export default agent({
  role: \`The assistant for ${name}. Answers from the knowledge it is given, and
when it does not know something says so plainly and says what it would need in
order to answer.\`,
  description: "Answers questions about ${name} from its own notes.",
  knows: ["memory/*.md"],
  greeting: "Ask me about ${name}.",
});
`,
    },
    {
      path: "memory/about.md",
      contents: `# About ${name}

Replace this file with whatever the assistant should know: product notes,
policies, FAQs, runbooks. Every \`.md\` and \`.txt\` file in this folder is
available to agents that list it under \`knows\`.
`,
    },
    {
      path: ".env",
      contents: `# One key and the app runs: Praecise Cloud picks the models, and the
# ladder can reach every major one without any of them being set up here.
PRAECISE_API_KEY=

# To run on your own endpoints instead, describe them under \`models\` in
# praecise.config.ts and put their keys here.
`,
    },
    {
      path: ".gitignore",
      contents: "node_modules\n.praecise\n.env\n",
    },
  ];
}

export const NEXT_STEPS = `Next:
  1. put a key in .env
  2. npm install
  3. npx praecise dev`;
