import { createHotContextPool } from './src/memory/hot-pool';

const pool = createHotContextPool();

// 테스트: 초기 주입(파일 등) 시 컨텍스트 셋업 확인 (내용만 들어왔을 때)
const n1 = pool.addNode({ 
	content: '이 채널은 종합 게임 방송 채널입니다. 방송인은 Airi입니다.', 
	nodeType: 'context_summary',
});
console.log('--- n1 Initial Context Summary Defaults ---');
console.log(n1.content);
console.log('-------------------------------------------\n');
