import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

// strict catches misspelt keywords; strictTypes is off because the small `is` matchers
// deliberately omit "type": "object" (the envelope already requires it).
export const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
addFormats(ajv);
ajv.addSchema(readJson("schema/harness.events.v1.json"));
ajv.addSchema(readJson("schema/routing-log.v1.json"));
ajv.addSchema(readJson("schema/config.v1.json"));

export const validators = {
  "harness.events/v1": ajv.getSchema("https://github.com/Sejersen92/harness/schema/harness.events.v1.json"),
  "harness.routing-log/v1": ajv.getSchema("https://github.com/Sejersen92/harness/schema/routing-log.v1.json"),
  "harness.config/v1": ajv.getSchema("https://github.com/Sejersen92/harness/schema/config.v1.json"),
};

export const describe = (validate) => ajv.errorsText(validate.errors, { separator: "\n  " });
