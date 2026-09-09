import { classifyIntent } from '../../src/server/ai/intent';
import { mentionedTypes } from '../../src/server/ai/resolve';
import { detectGrouping } from '../../src/server/ai/metrics';
for (const q of process.argv.slice(2)) {
  console.log(q, '| intent:', JSON.stringify(classifyIntent(q)), '| types:', JSON.stringify(mentionedTypes(q)), '| group:', detectGrouping(q));
}
