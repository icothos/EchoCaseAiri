import { useLlmmarkerParser } from './src/composables/llm-marker-parser.ts';

const parser = useLlmmarkerParser({
    onLiteral: (lit) => console.log('got literal:', lit),
    onSpecial: (sp) => console.log('got special:', sp),
    onEnd: () => console.log('parser ended'),
    minLiteralEmitLength: 24
});

async function run() {
    await parser.consume("Hello world, ");
    await parser.consume("this is a short ");
    await parser.consume("sentence.");
    await parser.end();
}
run().catch(console.error);
