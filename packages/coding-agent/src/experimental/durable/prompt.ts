// Pi's prompt and project resources for Durable's coding tools.
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";
import { editToolSystemPromptContribution } from "../../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../../core/tools/write.ts";

/** Register Durable's tools with Pi's prompt, guidelines, AGENTS.md, and skills. */
export function createCodingRegistry(cwd: string, resources: ResourceLoader) {
	const tools = CodingTools.tools!;
	const sections = buildSystemPromptSections({
		cwd,
		selectedTools: tools.map((tool) => tool.name),
		toolSnippets: Object.fromEntries(tools.map((tool) => [tool.name, tool.description])),
		toolGuidelines: {
			read: [...readToolSystemPromptContribution.guidelines],
			edit: [...editToolSystemPromptContribution.guidelines],
			write: [...writeToolSystemPromptContribution.guidelines],
		},
		customPrompt: resources.getSystemPrompt(),
		appendSystemPrompt: resources.getAppendSystemPrompt().join("\n\n"),
		contextFiles: resources.getAgentsFiles().agentsFiles,
		skills: resources.getSkills().skills,
	});
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(
		defineExtension({
			name: "pi-coding",
			sections: Object.entries(sections).map(([key, text]) => section(key, () => text, { tag: false })),
		}),
	);
	return registry;
}
