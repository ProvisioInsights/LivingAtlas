import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { DIALECT } from "./generate.js";
import type { LoadedContract } from "./manifest.js";
import type { JsonSchema } from "./shape.js";

/**
 * The validator the server and the tests share.
 *
 * Two properties are deliberate:
 *
 *  - **No network, structurally.** No `loadSchema` is configured, so Ajv cannot
 *    fetch anything, and every `$id` is a `urn:` with no retrieval semantics, so
 *    there would be nothing to fetch. A published contract that silently
 *    resolves a `$ref` over the network validates against whatever that host
 *    served today, which is not the contract anyone reviewed.
 *
 *  - **Unresolvable `$ref` is a failure, not a pass.** Ajv throws at compile
 *    time. A validator that skipped an unresolvable branch would report a
 *    malformed record as valid, which is worse than no validation at all.
 */

/**
 * `x-` keywords are annotations, not assertions: they carry the open-vocabulary
 * hints and the frozen-enum rationale. Declaring them keeps Ajv in strict mode —
 * which is what catches a genuine typo like `additionalProperites` — instead of
 * having to switch strictness off wholesale to accommodate our own extensions.
 */
export const ATLAS_ANNOTATION_KEYWORDS = [
  "x-atlas-vocabulary",
  "x-atlas-known-values",
  "x-atlas-registry-tool",
  "x-atlas-frozen-reason"
] as const;

export type ValidationOutcome = { valid: true } | { valid: false; errors: string[] };

function describe(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "#"} ${error.message ?? "failed"}`);
}

export class ContractValidator {
  private readonly ajv: Ajv2020;
  private readonly byToolInput = new Map<string, ValidateFunction>();
  private readonly byToolOutput = new Map<string, ValidateFunction>();
  private readonly byRecord = new Map<string, ValidateFunction>();

  constructor(private readonly contract: LoadedContract) {
    this.ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    this.ajv.addVocabulary([...ATLAS_ANNOTATION_KEYWORDS]);

    // Common and record documents are added before anything is compiled,
    // because a record schema `$ref`s the shared definitions and Ajv resolves
    // at compile time.
    for (const schema of Object.values(contract.common)) this.ajv.addSchema(schema);
    for (const schema of Object.values(contract.records)) this.ajv.addSchema(schema);

    // Tool documents are compiled each in a FRESH Ajv with nothing
    // pre-registered — the exact resolution context a conforming MCP client
    // has when it compiles one tools/list entry (protocol 2026-07-28 forbids
    // it from dereferencing anything external). Compiling them against this
    // instance's registry would prove only that the SERVER can resolve them,
    // which is precisely the gap that let 2026.08.3 publish documents no
    // client could compile. They cannot share the registry instance anyway:
    // each tool document embeds resources whose `$id`s the registry already
    // holds standalone.
    for (const tool of contract.tools) {
      this.byToolInput.set(tool.name, compileIsolated(tool.inputSchema, `${tool.name} input`));
      this.byToolOutput.set(tool.name, compileIsolated(tool.outputSchema, `${tool.name} output`));
    }
    for (const entry of contract.manifest.record_schemas) {
      const compiled = this.ajv.getSchema(entry.schema_id);
      if (!compiled) throw new Error(`record schema ${entry.schema_id} did not compile`);
      this.byRecord.set(entry.name, compiled);
    }
  }

  /**
   * Check every published document against the 2020-12 metaschema itself.
   *
   * Compiling proves Ajv accepted a document; it does not prove the document is
   * a well-formed schema in the dialect it claims. `{"type": 42}` compiles in
   * some configurations and is not a schema. This asks the metaschema.
   */
  validateAgainstMetaschema(): ValidationOutcome {
    const meta = this.ajv.getSchema(DIALECT);
    if (!meta) return { valid: false, errors: [`Ajv has no ${DIALECT} metaschema registered`] };

    const errors: string[] = [];
    const documents: [string, JsonSchema][] = [
      ...Object.entries(this.contract.common),
      ...Object.entries(this.contract.records),
      ...this.contract.tools.flatMap((tool): [string, JsonSchema][] => [
        [tool.input_schema_id, tool.inputSchema],
        [tool.output_schema_id, tool.outputSchema]
      ])
    ];
    for (const [id, document] of documents) {
      if (document["$schema"] !== DIALECT) {
        errors.push(`${id} declares $schema ${String(document["$schema"])}, expected ${DIALECT}`);
      }
      if (!meta(document)) {
        errors.push(...describe(meta.errors).map((detail) => `${id}: ${detail}`));
      }
    }
    return errors.length === 0 ? { valid: true } : { valid: false, errors };
  }

  validateToolInput(name: string, value: unknown): ValidationOutcome {
    return this.run(this.byToolInput.get(name), `input schema for ${name}`, value);
  }

  validateToolOutput(name: string, value: unknown): ValidationOutcome {
    return this.run(this.byToolOutput.get(name), `output schema for ${name}`, value);
  }

  validateRecord(recordSchema: string, value: unknown): ValidationOutcome {
    return this.run(this.byRecord.get(recordSchema), `record schema ${recordSchema}`, value);
  }

  private run(validate: ValidateFunction | undefined, label: string, value: unknown): ValidationOutcome {
    // An unknown tool or record name is a failure, never a pass. Treating a
    // missing validator as "nothing to check" is how an unvalidated surface
    // hides behind a validation layer that reports success.
    if (!validate) return { valid: false, errors: [`no ${label} is published`] };
    return validate(value) ? { valid: true } : { valid: false, errors: describe(validate.errors) };
  }
}

/**
 * Compile one published document with no registry, no pre-added schemas and no
 * network — a spec-conforming MCP client's entire resolution context. A
 * document that does not compile HERE is a document no client can use, however
 * happily a server holding the full corpus validates it.
 */
export function compileIsolated(schema: JsonSchema, label: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  ajv.addVocabulary([...ATLAS_ANNOTATION_KEYWORDS]);
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new Error(`${label} does not compile in isolation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createContractValidator(contract: LoadedContract): ContractValidator {
  return new ContractValidator(contract);
}
