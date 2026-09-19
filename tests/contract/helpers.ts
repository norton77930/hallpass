import { expect } from "vitest";
import * as contracts from "@hallpass/contracts";

export type ZodLike = {
  safeParse: (input: unknown) => { success: boolean };
};

export function contractExport<T>(name: string): T {
  const value = (contracts as Record<string, unknown>)[name];
  expect(value, `contracts export '${name}' must exist`).not.toBeUndefined();
  return value as T;
}

export function contractSchema(name: string): ZodLike {
  const value = contractExport<ZodLike>(name);
  expect(value.safeParse, `contracts export '${name}' must be a schema`).toBeTypeOf("function");
  return value;
}

export function expectAccepted(schema: ZodLike, input: unknown, label: string): void {
  const result = schema.safeParse(input);
  expect(result.success, `${label} must be accepted`).toBe(true);
}

export function expectRejected(schema: ZodLike, input: unknown, label: string): void {
  const result = schema.safeParse(input);
  expect(result.success, `${label} must be rejected`).toBe(false);
}
