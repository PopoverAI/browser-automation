import { describe, it, expect } from "vitest";

import {
  exampleStepsFile,
  parseStepsFileText,
  StepsFileError,
  stepsFileJsonSchema,
  StepsFileSchema,
} from "../src/stepsFile.js";

describe("steps file", () => {
  it("accepts the example and a minimal file", () => {
    expect(StepsFileSchema.safeParse(exampleStepsFile()).success).toBe(true);
    const minimal = parseStepsFileText(
      JSON.stringify({ steps: [{ narrate: "x", commands: [["wait", "1"]] }] }),
    );
    expect(minimal.steps).toHaveLength(1);
    expect(minimal.url).toBeUndefined();
  });

  it("reports the path of a bad field and points at schema/example", () => {
    const err = (() => {
      try {
        parseStepsFileText(
          JSON.stringify({ steps: [{ narrate: "x", commands: "click" }] }),
          "steps.json",
        );
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(StepsFileError);
    expect((err as Error).message).toMatch(/steps\.0\.commands/);
    expect((err as Error).message).toMatch(/browser-demo schema/);
  });

  it("rejects invalid JSON with the file path", () => {
    expect(() => parseStepsFileText("{", "s.json")).toThrow(
      /s\.json: not valid JSON/,
    );
  });

  it("rejects empty command arrays and empty steps", () => {
    expect(
      StepsFileSchema.safeParse({ steps: [{ narrate: "x", commands: [[]] }] })
        .success,
    ).toBe(false);
    expect(StepsFileSchema.safeParse({ steps: [] }).success).toBe(false);
  });

  it("publishes a JSON Schema that describes the same shape", () => {
    const schema = stepsFileJsonSchema() as {
      $schema: string;
      required: string[];
      properties: Record<string, { description?: string; items?: unknown }>;
    };
    expect(schema.$schema).toContain("2020-12");
    expect(schema.required).toEqual(["steps"]);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["openArgs", "speech", "steps", "url"].sort(),
    );
    // Descriptions are what an agent reads; make sure they survive generation.
    expect(schema.properties.speech.description).toMatch(/openai/);
    const step = (
      schema.properties.steps.items as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(step.commands.description).toMatch(/argv arrays/);
  });
});
