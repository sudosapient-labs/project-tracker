#!/usr/bin/env node
/* Context budget: what an assistant loads from this server before doing anything (tools/list,
   resources, instructions), per tool and in total. Tokens are estimated at 4 characters each,
   close to what Claude and GPT tokenizers give for this kind of JSON. Usage:
     node packages/mcp/scripts/budget.js [--read-only] [--json] */
import { RESOURCES, RESOURCE_TEMPLATES, toolsFor } from '../src/tools.js';
import { INSTRUCTIONS } from '../src/protocol.js';

const readOnly = process.argv.includes('--read-only');
const tok = s => Math.ceil(s.length / 4);
const tools = toolsFor({ scope: readOnly ? 'read' : 'write' });
const rows = tools.map(t => ({
  tool: t.name,
  description: t.description.length,
  schema: JSON.stringify(t.inputSchema).length,
  total: JSON.stringify(t).length,
}));
const list = JSON.stringify({ tools });
const extra = JSON.stringify({ RESOURCES, RESOURCE_TEMPLATES }).length + INSTRUCTIONS.length;
const sum = {
  tools: tools.length,
  toolsListChars: list.length,
  toolsListTokens: tok(list),
  withResourcesAndInstructionsTokens: Math.ceil((list.length + extra) / 4),
};

if (process.argv.includes('--json')) console.log(JSON.stringify({ rows, sum }, null, 2));
else {
  console.log('| Tool | Description chars | Schema chars | Total chars | ≈ tokens |\n|---|---:|---:|---:|---:|');
  for (const r of rows) console.log(`| \`${r.tool}\` | ${r.description} | ${r.schema} | ${r.total} | ${tok('x'.repeat(r.total))} |`);
  console.log(
    `\n${sum.tools} tools · tools/list ${sum.toolsListChars} chars ≈ ${sum.toolsListTokens} tokens · with resources + instructions ≈ ${sum.withResourcesAndInstructionsTokens} tokens`,
  );
}
