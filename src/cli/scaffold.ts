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

/**
 * Whether the runtime that will RUN this app can load TypeScript source.
 *
 * `praecise init` used to write a `.ts` app unconditionally, and the folder loader
 * imports source files at runtime — so on a Node that cannot strip types, a freshly
 * scaffolded app did not run. Step one of the documented path produced a broken app,
 * which is the worst possible place to put a papercut.
 *
 * Node exposes the answer directly: `process.features.typescript` is `false` when there
 * is no support, `"strip"` or `"transform"` when there is. That is a better test than a
 * version comparison, because a build compiled without the feature reports honestly
 * while its version number would have said yes.
 */
export function runtimeReadsTypeScript(): boolean {
  return Boolean((process.features as { typescript?: unknown } | undefined)?.typescript);
}

/**
 * The files a new app starts as.
 *
 * `language` decides the extension of the code files, defaulting to whatever the current
 * runtime can actually run. An author who wants the other one says so; an author who
 * says nothing gets an app that starts.
 */
export function scaffold(name: string, language: "ts" | "js" = "ts"): ScaffoldFile[] {
  // TypeScript by default, as every example in the documentation shows, because the
  // framework compiles it now rather than hoping the runtime can. `js` is honoured for
  // an author who wants no build step at all.
  const ext = language === "js" ? "js" : "ts";
  return [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: { dev: "praecise dev", start: "praecise dev", typecheck: "tsc --noEmit" },
          dependencies: { praecise: "^0.1.0" },
          // praecise resolves the compiler from YOUR project, so the version here is the
          // version your app is built with — and praecise itself stays dependency-free.
          ...(language === "js" ? {} : { devDependencies: { typescript: "^7.0.2" } }),
        },
        null,
        2,
      )}\n`,
    },
    {
      path: `agents/assistant.${ext}`,
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
