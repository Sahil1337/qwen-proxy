/**
 * `extract()` against a hosted provider: a JSON schema goes out as
 * `response_format: json_schema`, and `value` comes back parsed.
 *
 * The proxy turns the schema into a decoding grammar, so the output cannot be
 * malformed. A provider does not necessarily — support for `json_schema` (as
 * opposed to plain `json_object`) varies by provider and by model, and a model
 * that lacks it will either ignore the schema or reject the request. That is
 * the main behavioural difference to plan around when moving off the proxy.
 *
 *   bun examples/01-extraction.ts
 */
import { header, line, qwen, TRANSCRIPT } from "./lib.js";

interface Extraction {
  propositions: string[];
  people: string[];
}

const schema = {
  type: "object",
  properties: {
    propositions: { type: "array", items: { type: "string" } },
    people: { type: "array", items: { type: "string" } },
  },
  required: ["propositions", "people"],
  additionalProperties: false,
};

header("01 — schema-constrained extraction");

const { value, completion } = await qwen.extract<Extraction>(
  [
    { role: "system", content: "Extract atomic propositions and the people mentioned. Output JSON only." },
    { role: "user", content: TRANSCRIPT },
  ],
  schema,
);

line("finish", completion.choices[0]?.finish_reason ?? "?");
line("tokens", `in=${completion.usage.prompt_tokens} out=${completion.usage.completion_tokens}`);
console.log(JSON.stringify(value, null, 2));
