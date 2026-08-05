import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/server";
import type { ContractValidator, LoadedContract } from "@living-atlas/atlas-contract";

/**
 * The validator the SDK uses for tool schemas, backed by the contract's own.
 *
 * This exists because of a real limit in the SDK, found by running it: the
 * default AJV provider compiles each schema in isolation, so a `$ref` into
 * another published document cannot resolve. Registering
 * `atlas.contract.describe.v1` with its published output schema fails at
 * compile time with
 *
 *   can't resolve reference urn:…:common:output#/$defs/recorded_at
 *
 * and every call to every tool answers `-32603`. The published contract is
 * deliberately multi-document — one `common.output.json` so a shared definition
 * exists once — so this is not a shape we can or should change.
 *
 * There were two ways out. Inlining every `$ref` before registration would make
 * the server validate against bytes no consumer ever fetched, which is the
 * schema-in-two-places defect the whole contract package exists to prevent. So
 * instead the SDK is handed the ALREADY-COMPILED validators: `ContractValidator`
 * loads the common and record documents first and compiles the tool schemas
 * against them, exactly as the published `$id`s require.
 *
 * The side effect is the valuable part. The SDK's pre-dispatch input check and
 * this package's own output check now run the SAME compiled function, so they
 * cannot disagree about what the contract says.
 */

/** Where a published `$id` sits: which tool, and which side of the wire. */
type SchemaSlot = { tool: string; position: "input" | "output" };

function slotsById(contract: LoadedContract): Map<string, SchemaSlot> {
  const slots = new Map<string, SchemaSlot>();
  for (const tool of contract.manifest.tools) {
    slots.set(tool.input_schema_id, { tool: tool.name, position: "input" });
    slots.set(tool.output_schema_id, { tool: tool.name, position: "output" });
  }
  return slots;
}

export function contractSchemaProvider(
  contract: LoadedContract,
  validator: ContractValidator
): jsonSchemaValidator {
  const slots = slotsById(contract);

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const id = typeof schema["$id"] === "string" ? schema["$id"] : undefined;
      const slot = id === undefined ? undefined : slots.get(id);

      if (!slot) {
        // An unknown schema is a failure, never a pass. Treating one as
        // "nothing to check" is how an unvalidated surface hides behind a
        // validation layer that reports success — the same rule
        // `ContractValidator.run` applies to an unknown tool name.
        const named = id ?? "a schema with no $id";
        return () => ({
          valid: false,
          data: undefined,
          errorMessage: `${named} is not a published document of contract revision ${contract.manifest.contract_revision}`
        });
      }

      return (input: unknown) => {
        const outcome =
          slot.position === "input"
            ? validator.validateToolInput(slot.tool, input)
            : validator.validateToolOutput(slot.tool, input);
        return outcome.valid
          ? { valid: true, data: input as T, errorMessage: undefined }
          : { valid: false, data: undefined, errorMessage: outcome.errors.join("; ") };
      };
    }
  };
}
