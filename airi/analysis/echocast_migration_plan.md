# EchoCast → Airi 마이그레이션 계획

## 개요

EchoCast(open_llm_vtuber 기반 Python)의 핵심 기능을 Airi(TypeScript/Electron)로 이식한다.
`packages/echo-memory` 독립 패키지로 분리하여 Airi 업스트림 업데이트에 최소 영향을 유지한다.

---

## 기능별 매핑 및 구현 위치

### 1. 입력 필터링 (Fast-path Filter)

| | EchoCast | Airi (echo-memory) |
|--|----------|-------------------|
| 위치 | `conversation_handler.py` | `echo-memory/bouncer/fast-path.ts` |
| 트리거 | 채팅 수신 즉시 | `context-bridge.ts onEvent('input:text')` 에 선등록 |
| 동작 | 1자/이모지/ㅋㅋ → drop | 동일 |

---

### 2. sLLM Bouncer

| | EchoCast | Airi (echo-memory) |
|--|----------|-------------------|
| 위치 | `sllm_bouncer.py` | `echo-memory/bouncer/bouncer.ts` |
| 트리거 | Fast-path 통과 후 | `onEvent('input:text')` 내부 |
| 판정 | HTTP → llama.cpp | HTTP → llama.cpp (동일) |
| 결과 | ignore / pass / rag | 동일 |

---

### 3. Hot Context Pool

| | EchoCast | Airi (echo-memory) |
|--|----------|-------------------|
| 위치 | `tri_core_memory_agent.py` | `echo-memory/memory/hot-pool.ts` |
| 주입 트리거 | LLM 호출 직전 | `onBeforeMessageComposed` 훅 (L224) |
| 주입 대상 | 시스템 프롬프트 append | `chatContext.ingestContextMessage()` |
| 노드 타입 | progress_summary / rag_result / fact | 동일 구조로 포팅 |

**⚠️ 타이밍 중요**: `getContextsSnapshot()`은 chat.ts L263에서 호출되므로,
`onBeforeMessageComposed`(L224) 훅 안에서 ingest 해야 반영됨.

---

### 4. Sliding Window & Summarizer

| | EchoCast | Airi (echo-memory) |
|--|----------|-------------------|
| 위치 | `tri_core_memory_agent.py` | `echo-memory/memory/summarizer.ts` |
| 트리거 | 턴 완료 후 | `onChatTurnComplete` 훅 |
| 동작 | 히스토리 초과 시 sLLM 요약 | 동일 |
| 요약 결과 | Hot Pool에 summry 노드로 추가 | 동일 |

Airi 현재 히스토리 truncation 없음 → Summarizer가 이를 대체.

---

### 5. Cold DB RAG

| | EchoCast | Airi (echo-memory) |
|--|----------|-------------------|
| 위치 | `pgvector_db.py` | `echo-memory/memory/archiver.ts` |
| 트리거 | Bouncer `rag` 판정 시 | 동일 (Bouncer 내부에서 호출) |
| 저장소 | LocalJSONVectorDB → pgvector | pgvector or DuckDB WASM |
| 임베딩 | BAAI/bge-m3 | 동일 or OpenAI Ada |

※ 나중에 Airi `memory-pgvector` 완성 시 교체 예정.

---

### 6. Progress Summary 업데이트

| | EchoCast | Airi (echo-memory) |
|--|----------|-------------------|
| 위치 | `tri_core_memory_agent.py` | `echo-memory/memory/hot-pool.ts` |
| 트리거 | AI 응답 완료 후 | `onChatTurnComplete` 훅 (outputText) |
| 동작 | progress_summary 노드 갱신 | 동일 |

---

### 7. 자율 발화 (Auto-Speak)

| | EchoCast | Airi |
|--|----------|------|
| 위치 | `conversation_handler.py` | `character-orchestrator/store.ts` |
| 트리거 | idle 타이머 (`_handoff_in_progress`) | `spark:notify` urgency 큐 |
| 컨텍스트 | `inject_live_status()` | **아직 미구현** → P6 단계 |

EchoCast의 `inject_live_status()` 에 해당하는 컨텍스트를 echo-memory가
`spark:notify` 처리 직전에 `ingestContextMessage()`로 주입하는 별도 어댑터 필요.

---

### 8. 치지직 어댑터

| | EchoCast | Airi |
|--|----------|------|
| 위치 | `chzzk_adapter/main.py` | 새 WebSocket 어댑터 |
| 방식 | Python → FastAPI WebSocket | Python 재활용 or TS 포팅 |
| 연결 | open_llm_vtuber WS | Airi server-runtime `input:text` 이벤트 |

가장 단순한 방법: 기존 Python 어댑터에서 엔드포인트 URL만 변경.

---

## 구현 로드맵

```
P0: echo-memory 패키지 스캐폴딩
  └── package.json, types.ts, index.ts
  └── pnpm workspace에 등록

P1: Hot Context Pool (Python → TS)
  └── hot-pool.ts: ContextNode, weight×TTL, getTopK()
  └── types.ts: NodeType 정의

P2: Fast-path Filter
  └── fast-path.ts: 정규식 기반 drop 판단

P3: Bouncer HTTP 클라이언트
  └── bouncer.ts: llama.cpp HTTP API 호출
  └── ignore / pass / rag 결과 반환

P4: ★ Airi 연결 레이어 (핵심)
  └── adapter/airi-adapter.ts
      ├── serverChannel.onEvent('input:text') → Fast-path → Bouncer
      ├── chatOrchestrator.onBeforeMessageComposed → Hot Pool 주입
      └── chatOrchestrator.onChatTurnComplete → Progress 업데이트

P5: Summarizer
  └── summarizer.ts: Sliding Window 초과 시 sLLM 요약
  └── 결과 → Hot Pool summary 노드 추가

P6: 자율 발화 컨텍스트 주입
  └── spark:notify 처리 직전 inject_live_status 등가 주입
  └── character-orchestrator와 연동

P7: 치지직 어댑터
  └── Python 어댑터 WS 엔드포인트 수정 or TS 포팅

P8: Cold DB RAG
  └── archiver.ts: pgvector or DuckDB WASM
  └── BAAI/bge-m3 임베딩 연동
```

---

## 충돌 위험도 평가

| Airi 변경 | 영향 파일 | 위험도 |
|-----------|-----------|--------|
| chat.ts 내부 로직 변경 | 없음 (훅 경유) | 🟢 낮음 |
| onBeforeMessageComposed 시그니처 변경 | airi-adapter.ts | 🟡 중간 |
| context-bridge.ts onEvent 제거/변경 | airi-adapter.ts | 🟡 중간 |
| getContextsSnapshot 타이밍 변경 | airi-adapter.ts | 🔴 높음 |
| spark:notify 구조 변경 | P6 어댑터 | 🟡 중간 |

---

## 최우선 확인 사항

> [!IMPORTANT]
> `onBeforeMessageComposed` 발화 시점(L224)이 `getContextsSnapshot()`(L263)보다
> 앞에 있는지 실제 코드에서 확인 필수. 현재 분석상 맞지만 테스트로 검증 필요.

> [!NOTE]
> `context-bridge.ts`의 `onEvent('input:text')` 리스너는 독립 실행이므로
> echo-memory 리스너가 drop해도 context-bridge 리스너는 별도 실행됨.
> 중복 ingest 방지를 위해 content-hash dedup 구현 예정(P4).
