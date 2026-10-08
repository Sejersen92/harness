import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): object => JSON.parse(readFileSync(join(root, path), "utf8")) as object;

// strict catches misspelt keywords; strictTypes is off because the small `is` matchers
// deliberately omit "type": "object" (the envelope already requires it).
export const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
// ajv-formats is CommonJS: under Node's ESM its default import is module.exports, whose .default is the plugin.
addFormats.default(ajv);
ajv.addSchema(readJson("schema/harness.events.v1.json"));
ajv.addSchema(readJson("schema/routing-log.v1.json"));
ajv.addSchema(readJson("schema/config.v1.json"));

const loaded = (id: string): ValidateFunction => {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`schema ${id} is not loaded`);
  return validate;
};

export const validators: Record<string, ValidateFunction | undefined> = {
  "harness.events/v1": loaded("https://github.com/Sejersen92/harness/schema/harness.events.v1.json"),
  "harness.routing-log/v1": loaded("https://github.com/Sejersen92/harness/schema/routing-log.v1.json"),
  "harness.config/v1": loaded("https://github.com/Sejersen92/harness/schema/config.v1.json"),
};

/** The validator for the schema a line names; a line naming no known schema fails the test. */
export const validatorFor = (value: Line): ValidateFunction => {
  const validate = validators[String(value.schema)];
  if (!validate) throw new Error(`no schema named ${String(value.schema)}`);
  return validate;
};

export const describe = (validate: ValidateFunction): string => ajv.errorsText(validate.errors, { separator: "\n  " });

/**
 * One JSON line read back from a spool. Deliberately loose: a test reads whichever fields it asserts on,
 * and the schema check (validatorFor) is what holds a line to its shape.
 */
// biome-ignore lint: tests read arbitrary JSON
export type Line = Record<string, any>;
