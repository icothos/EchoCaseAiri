# EchoCaseAiri — 작업 메모

EchoCast × Airi 통합 프로젝트 메모장.

---

## 📁 구조

```
EchoCaseAiri/
├── airi/           # Project AIRI (upstream fork)
│   ├── packages/echo-memory/   # 우리가 추가한 커스텀 패키지
│   └── analysis/               # 아키텍처 분석 문서들
└── EchoCast/       # 기존 EchoCast (Python 원본)
```

---

## 🔍 분석 문서

| 파일 | 내용 |
|------|------|
| [`airi/analysis/airi_llm_triggers.md`](./airi/analysis/airi_llm_triggers.md) | LLM 인퍼런스 트리거 & 컨텍스트 주입 구조 |
| [`airi/analysis/echocast_migration_plan.md`](./airi/analysis/echocast_migration_plan.md) | EchoCast → Airi 이식 로드맵 (P0~P8) |
| [`airi/analysis/input_flow_overview.md`](./airi/analysis/input_flow_overview.md) | 채팅/오디오 입력 플로우 개요 |

---

## 📦 echo-memory 패키지

`airi/packages/echo-memory` — Tri-Core 메모리 + sLLM Bouncer Airi 통합 패키지.

### 구현 현황

| 단계 | 상태 | 내용 |
|------|------|------|
| P0 | ✅ | 패키지 스캐폴딩 |
| P1 | ✅ | Hot Context Pool (ContextNode, Top-K, updateNode) |
| P2 | ✅ | Fast-path Filter (정규식 즉시 drop) |
| P3 | ✅ | sLLM Bouncer (llama.cpp HTTP, ignore/pass/rag) |
| P4 | ✅ | Airi 연결 레이어 (mountEchoMemory) |
| P5 | ✅ | Summarizer + Progress 업데이트 |
| P6 | ⬜ | 자율 발화 컨텍스트 주입 (spark:notify 어댑터) |
| P7 | ⬜ | 치지직 어댑터 연결 |
| P8 | ⬜ | Cold DB RAG (pgvector) |

---

## 🏗️ LLM 콜 스택 (분석 완료)

```
ChatProvider.chat(model)            ← { baseURL, apiKey, model }
  → streamText({ ...options })      ← @xsai/stream-text
      → chat({ stream: true })      ← @xsai/shared-chat
          → (options.fetch ?? globalThis.fetch)(baseURL + "/chat/completions")
```

### 후킹 포인트

`options.fetch` 커스텀 주입으로 **Airi 코드 수정 없이** 모든 HTTP 요청/응답 로깅 가능.

---

## 💡 미결 아이디어 & TODO

### Native Provider Adapter (미구현, 후순위)

Gemini/Grok 등 네이티브 API가 OpenAI 호환보다 빠를 수 있음.
`options.fetch`를 교체하는 방식으로 `ChatProvider` 인터페이스를 유지하면서
내부 구현만 네이티브 SDK로 교체 가능.

```typescript
// 아이디어: packages/ai-provider (미구현)
createGeminiNativeProvider(apiKey) → ChatProvider
  └─ chat(model).fetch = 네이티브 Gemini SDK로 교체
  └─ Airi streamText()에 그대로 전달 (인터페이스 동일)
```

> **현재 결정**: OpenAI 호환 엔드포인트로 진행.
> Gemini OpenAI compat (`generativelanguage.googleapis.com/v1beta/openai/`)도 구글 직접 운영이라 성능 차 미미함.

### LLM 로거 (echo-memory에 포함됨)

`echo-memory/src/logger.ts` — BOUNCER/SUMMARIZER 역할별 REQUEST/RESPONSE 로그.
메인 LLM은 `onBeforeMessageComposed` / `onChatTurnComplete` 훅에서 캡처 가능.

---

## 🚀 다음 단계

1. `pnpm i` 완료 후 typecheck 실행
2. `stage-web` app에서 `mountEchoMemory()` 호출 연결 (실제 테스트)
3. P6: spark:notify 자율 발화 컨텍스트 주입 어댑터
