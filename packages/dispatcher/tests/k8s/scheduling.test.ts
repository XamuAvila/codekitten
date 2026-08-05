import { describe, it, expect } from "vitest";
import { AppError } from "@kitten/shared";
import { parsePodScheduling } from "../../src/k8s/scheduling.js";

/** Runs fn and returns the AppError it must throw; fails the test otherwise. */
function expectValidation(fn: () => unknown): AppError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const error = caught as AppError;
  expect(error.code).toBe("VALIDATION");
  return error;
}

describe("parsePodScheduling (v10)", () => {
  it("absent value → undefined", () => {
    expect(parsePodScheduling(undefined)).toBeUndefined();
  });

  it("empty string → undefined", () => {
    expect(parsePodScheduling("")).toBeUndefined();
    expect(parsePodScheduling("   ")).toBeUndefined();
  });

  it("valid full object → typed scheduling", () => {
    const result = parsePodScheduling(
      JSON.stringify({
        nodeSelector: { "workload-type": "kitten" },
        tolerations: [
          {
            key: "dedicated",
            operator: "Equal",
            value: "kitten",
            effect: "NoSchedule",
          },
        ],
        serviceAccountName: "kitten-reviewer",
      }),
    );
    expect(result).toEqual({
      nodeSelector: { "workload-type": "kitten" },
      tolerations: [
        {
          key: "dedicated",
          operator: "Equal",
          value: "kitten",
          effect: "NoSchedule",
        },
      ],
      serviceAccountName: "kitten-reviewer",
    });
  });

  it("malformed JSON → AppError VALIDATION", () => {
    const error = expectValidation(() => parsePodScheduling("{not json"));
    expect(error.message).toBeTruthy();
  });

  it("unknown key (nodeSelectors) → VALIDATION naming the path", () => {
    const error = expectValidation(() => parsePodScheduling('{"nodeSelectors":{}}'));
    const issue = (error.details ?? []).find((d) => String(d.path) === "nodeSelectors");
    expect(issue).toBeDefined();
  });

  it("invalid effect value → VALIDATION", () => {
    const error = expectValidation(() =>
      parsePodScheduling('{"tolerations":[{"effect":"Nope"}]}'),
    );
    const issue = (error.details ?? []).find((d) => String(d.path) === "tolerations.0.effect");
    expect(issue).toBeDefined();
  });

  it("{ operator: \"Exists\" } alone → accepted", () => {
    const result = parsePodScheduling('{"tolerations":[{"operator":"Exists"}]}');
    expect(result).toEqual({ tolerations: [{ operator: "Exists" }] });
  });
});
