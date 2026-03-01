# Airi LLM 인퍼런스 트리거 & 컨텍스트 아키텍처 분석

## 1. LLM 인퍼런스 트리거 경로

Airi 에서 LLM 추론이 발생하는 경로는 **2가지**다.

---

### 경로 1: 채팅 입력 (User-Driven)

```
[외부 채팅 / UI 입력]
  → WebSocket input:text 이벤트
  → context-bridge.ts  onEvent('input:text')  (L62)
      navigator.locks.request('context-bridge:event:input:text', ...)
  → chatOrchestrator.ingest(text, options)
  → sendQueue (직렬화)
  → performSend()
      ① onBeforeMessageComposed 훅 발화
      ② 히스토리 + 현재 메시지 조합
      ③ chatContext.getContextsSnapshot()  ← 동적 컨텍스트 수집 (L263)
      ④ context 있으면 user-role 블록으로 삽입 (L268~283)
      ⑤ onAfterMessageComposed 훅 발화  (L287)
      ⑥ llmStore.stream() 호출  ← LLM 인퍼런스 시작
      ⑦ 스트리밍 토큰 → TTS Chunker → SpeechPipeline
      ⑧ onChatTurnComplete 훅 발화
```

**핵심 파일**: `packages/stage-ui/src/stores/chat.ts`

---

### 경로 2: 자율 발화 (Character-Driven, spark:notify)

```
[spark:notify WebSocket 이벤트]
  → character-orchestrator/store.ts
  → handleIncomingSparkNotify()
      urgency === 'immediate' → 즉시 processSparkNotify()
      urgency === 'soon'/'later' → scheduledNotifies 큐
  → tick() (2초 인터벌)
  → sparkNotifyAgent.handle()
  → llmStore.stream() 호출  ← 별도 LLM 인퍼런스
  → 결과 → spark:command WebSocket 이벤트로 발행
```

**핵심 파일**: `packages/stage-ui/src/stores/character/orchestrator/store.ts`

---

## 2. 컨텍스트 주입 구조

| 레이어 | 파일 | 내용 |
|--------|------|------|
| 시스템 프롬프트 | `airi-card.ts` → `session-store.ts` | 캐릭터 카드 고정 텍스트 |
| 동적 컨텍스트 | `chat/context-store.ts` | `ingestContextMessage()`로 외부 모듈이 push |
| 컨텍스트 수집 | `chat.ts` L263 `getContextsSnapshot()` | LLM 호출 직전 수집 후 user-role 블록으로 삽입 |
| 히스토리 | `chat/session-store.ts` | 전체 히스토리 (truncation 없음) |
| Context providers | `chat/context-providers/datetime.ts` | 현재 날짜/시간 자동 주입 (현재 유일) |

### 컨텍스트 주입 타이밍

```
chat.ts performSend() 흐름:
  L224: onBeforeMessageComposed 훅 (← Bouncer 삽입 지점)
  L240: 히스토리 + 메시지 조합
  L263: getContextsSnapshot()  ← 이 시점 이전에 ingest 해야 반영됨
  L268: user-role 컨텍스트 블록 삽입
  L287: onAfterMessageComposed 훅  ← 이미 늦음 (snapshot 이미 취득)
  L296: llmStore.stream()
```

> **주의**: `onAfterMessageComposed`는 이미 `getContextsSnapshot()`이 호출된 후이므로,
> Hot Context를 LLM에 반영하려면 **`onBeforeMessageComposed` 또는 그 이전**에 주입해야 한다.

---

## 3. 현재 Airi와 EchoCast 비교

| 기능 | EchoCast (Python) | 현재 Airi | echo-memory 담당 |
|------|-------------------|-----------|-----------------|
| 입력 필터링 | Fast-path regex | ❌ 없음 | ✅ fast-path.ts |
| Bouncer 판단 | sLLM HTTP 호출 | ❌ 없음 | ✅ bouncer.ts |
| Hot Context 주입 | `inject_hot_context()` | `context-store.ts` (외부서 push 필요) | ✅ hot-pool.ts → ingest |
| 히스토리 관리 | Sliding Window | 전체 무제한 | ✅ summarizer.ts |
| Cold DB RAG | LocalJSONVectorDB | ❌ (memory-pgvector WIP) | ✅ archiver.ts |
| 자율 발화 | auto-speak 루프 | spark:notify 경로 | ⚠️ 별도 어댑터 필요 |
| Progress 업데이트 | `progress_summary` 노드 | ❌ 없음 | ✅ hot-pool.ts |
| 치지직 연동 | chzzk_adapter (Python) | ❌ (input:text로 주입 가능) | ✅ WS 어댑터 |

---

## 4. echo-memory 컨텍스트 주입 타이밍 수정

이전 설계(onAfterMessageComposed 주입)는 **타이밍이 맞지 않음**.

**수정된 주입 전략**:

```typescript
// ① Bouncer: onBeforeMessageComposed 에 등록
chatOrchestrator.onBeforeMessageComposed(async (message) => {
  // Fast-path + sLLM 판단
  // + Hot Context 미리 ingestContextMessage() 호출 ← snapshot 전에 넣어야 함
  const topK = pool.getTopK(3)
  for (const node of topK)
    chatContext.ingestContextMessage(nodeToContextMessage(node))
})
// → L263 getContextsSnapshot() 호출 시 반영됨 ✅

// ② Summarizer + Progress: onChatTurnComplete
chatOrchestrator.onChatTurnComplete(async ({ outputText }) => {
  pool.updateProgress(outputText)
  pool.maybeRunSummarizer()
})
```
