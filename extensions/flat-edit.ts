/**
 * flat-edit: replaces pi's built-in `edit` tool (nested `edits[]` array schema)
 * with a flat-string schema variant.
 *
 * Why: DeepSeek V4 Pro (cheaper) via NanoGPT deterministically fails to emit
 * nested-array tool schemas — NanoGPT's DSML translation chokes and returns
 * `malformed_tool_call` (experiments/results/FINDINGS.md). Flat string
 * parameters round-trip 100%.
 *
 * Use with the built-in edit excluded, e.g.:
 *   pi --tools read,write,ls,bash -e extensions/flat-edit.ts ...
 */
import { Type, type Static } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const EditParams = Type.Object({
	path: Type.String({ description: "Path to the file to edit" }),
	oldText: Type.String({ description: "Exact existing text to replace (must be unique in the file)" }),
	newText: Type.String({ description: "Replacement text" }),
});

// Narrow structural type for the one pi extension API this file calls. Deliberately not importing
// pi's SDK (CLAUDE.md: "Never import from pi's SDK") — this keeps typecheck decoupled from pi's
// frequently-reshuffled package.
interface ExtensionAPI {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: typeof EditParams;
		execute: (
			toolCallId: string,
			params: Static<typeof EditParams>,
			signal: AbortSignal,
			onUpdate: (update: unknown) => void,
			ctx: unknown,
		) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	}): void;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "Edit (flat)",
		description:
			"Edit a single file using exact text replacement. oldText must match exactly one region of the file; it is replaced with newText. Include enough surrounding context in oldText to make the match unique.",
		parameters: EditParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const file = path.resolve(params.path);
			if (!fs.existsSync(file)) throw new Error(`File not found: ${params.path}`);
			const text = fs.readFileSync(file, "utf8");
			const first = text.indexOf(params.oldText);
			if (first === -1) throw new Error(`oldText not found in ${params.path}`);
			if (text.indexOf(params.oldText, first + 1) !== -1)
				throw new Error(`oldText matches more than once in ${params.path}; add surrounding context to make it unique`);
			fs.writeFileSync(file, text.slice(0, first) + params.newText + text.slice(first + params.oldText.length));
			return {
				content: [{ type: "text", text: `Edited ${params.path}` }],
				details: {},
			};
		},
	});
}
