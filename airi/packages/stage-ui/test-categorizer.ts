import { createStreamingCategorizer } from './src/composables/response-categoriser.ts';

const { filterToSpeech, consume } = createStreamingCategorizer('openai-compatible');

const chunks = ['이건 생각중.. ', '<tho', 'ught>생각할게</thought>', '그리고 마지막 진짜 대사, 아니면 네가 먼저 뭘 할 건데?'];
let pos = 0;
for (const chunk of chunks) {
    consume(chunk);
    const speech = filterToSpeech(chunk, pos);
    console.log('in:', chunk, '-> speech:', speech);
    pos += chunk.length;
}
