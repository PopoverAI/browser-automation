import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const scenario = {
  baseUrl: "https://www.google.com/travel/flights",
  steps: [
    { step: "arrange", description: "Set origin to SFO and destination to JFK" },
    { step: "arrange", description: "Set departure date to next Friday and select round trip" },
    { step: "act", description: "Click Search" },
    { step: "assert", key: "has-results", description: "Flight results are displayed" },
    { step: "assert", key: "has-prices", description: "At least one result shows a price" },
    { step: "assert", key: "correct-route", description: "Results show SFO to JFK" },
  ],
} as const;

// Build instruction from scenario
const assertSteps = scenario.steps.filter(s => s.step === "assert");
let assertIndex = 0;
const stepLines = scenario.steps.map((s) => {
  const urlPart = "url" in s && s.url ? ` (URL: ${s.url})` : "";
  if (s.step === "assert") {
    assertIndex++;
    const keyPart = "key" in s && s.key ? ` (key: ${s.key})` : "";
    return `${assertIndex}. [assert]${keyPart}${urlPart} ${s.description}`;
  }
  return `- [${s.step}]${urlPart} ${s.description}`;
});

const instruction = `Execute this test scenario against ${scenario.baseUrl}:

${stepLines.join("\n")}

Execute the arrange and act steps first. Then evaluate each assert step.
If an arrange or act step fails, mark all remaining assert steps as "blocked".
Return one result per assert step only, in order.`;

// Build structured output schema
const ResultSchema = z.object({
  results: z.array(z.object({
    key: z.string().optional().describe("The key from the assert step, if provided"),
    status: z.enum(["passed", "failed", "blocked"]),
    notes: z.string().describe("Brief explanation of the result"),
  })),
});

async function main() {
  const stagehand = new Stagehand({
    env: "LOCAL",
    model: {
      apiKey: process.env.GEMINI_API_KEY,
      modelName: "google/gemini-3-flash-preview",
    },
    experimental: true,
  });

  await stagehand.init();

  try {
    const page = stagehand.context.pages()[0];
    await page.goto(scenario.baseUrl);

    const agent = stagehand.agent({
      mode: "hybrid",
      model: "google/gemini-3-flash-preview",
    });

    console.error("[INFO] Executing scenario...");
    const result = await agent.execute({
      instruction,
      maxSteps: 30,
      output: ResultSchema,
    });

    console.log(JSON.stringify(result.output, null, 2));
    console.error(`[INFO] Completed: ${result.completed}, Actions: ${result.actions.length}`);
  } finally {
    await stagehand.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
