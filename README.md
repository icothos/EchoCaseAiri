# EchoCaseAiri — 작업 메모

EchoCast × Airi 통합 프로젝트 메모장.

---

## 📁 구조

```
EchoCaseAiri/
├── airi/           # Project AIRI (upstream fork)
│   ├── packages/echo-memory/   # 커스텀 패키지: Tri-Core 메모리 + sLLM Bouncer
│   ├── packages/gemini-utils/  # 커스텀 패키지: @google/genai 공유 유틸
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
| P3 | ✅ | sLLM Bouncer (llama.cpp HTTP + **Gemini native SDK**) |
| P4 | ✅ | Airi 연결 레이어 (mountEchoMemory) |
| P5 | ✅ | Summarizer + Progress 업데이트 (**Gemini native SDK 지원**) |
| P6 | ✅ | 자율 발화 컨텍스트 주입 (spark:notify idle 어댑터) |
| P7 | ⬜ | 치지직 어댑터 연결 |
| P8 | ⬜ | Cold DB RAG (pgvector) |

---

## 📦 gemini-utils 패키지

`airi/packages/gemini-utils` — `@google/genai` SDK 공유 유틸리티.
`echo-memory`와 `stage-ui` 양쪽에서 공유하는 Gemini 전용 코드.

```
packages/gemini-utils/src/
├── client.ts   — GoogleGenAI 인스턴스 캐시(apiKey별), isGeminiUrl()
├── call.ts     — callGemini() 단건 completion (Bouncer/Summarizer용)
├── stream.ts   — streamGemini() 스트리밍 + 내부 로깅
└── tokens.ts   — countGeminiTokens() REST API 토큰 카운팅 (fallback용)
```

### 설계 원칙

- **인스턴스 캐싱**: `getGenAI(apiKey)` — 동일 apiKey로 재사용
- **로깅 내재화**: `streamGemini()`가 요청/응답/토큰을 `console.debug` + `onLog` 콜백으로 처리
- **xsai 비의존**: 범용 타입(role/content 객체)만 사용
- **URL 기반 감지**: `isGeminiUrl(url)` — `generativelanguage.googleapis.com` 포함 여부

---

## 🗄️ 채팅 DB 관리

### 관련 파일

| 파일 | 역할 |
|------|------|
| `packages/stage-ui/src/stores/chat/session-store.ts` | 세션 생성/로드/삭제/초기화 핵심 로직 |
| `packages/stage-ui/src/stores/chat/maintenance.ts` | UI용 래퍼 (`cleanupMessages`, `resetAllSessions`) |
| `packages/stage-ui/src/database/repos/chat-sessions.repo.ts` | IndexedDB CRUD (unstorage 기반) |
| `packages/stage-layouts/src/components/Widgets/ChatActionButtons.vue` | UI 버튼 (채팅 초기화, DB 초기화) |

### 초기화 방식 비교

| 방식 | 함수 | 범위 | 설명 |
|------|------|------|------|
| 🗑️ 현재 세션 초기화 | `cleanupMessages()` | 현재 세션만 | system 메시지만 남기고 메모리+DB 초기화 |
| 🗄️ DB 전체 초기화 | `resetAllSessions()` | 모든 세션 | IndexedDB에서 모든 채팅 데이터 삭제 후 새 세션 생성 |
| 🔧 개발 시작 시 자동 | `VITE_DEV_CLEAR_CHAT=1` | 모든 세션 | 앱 initialize 시점에 DB를 먼저 비움 (race condition 없음) |

### `VITE_DEV_CLEAR_CHAT` 동작 원리

```
앱 시작
  └─ session-store.initialize()
       ├─ [VITE_DEV_CLEAR_CHAT=1] chatSessionsRepo.getIndex() → 모든 session 삭제
       │   └─ chatSessionsRepo.saveIndex({ characters: {} })  ← 빈 index DB에 저장
       └─ ensureActiveSessionForCharacter() → 새 세션 생성
```

> **⚠️ 주의**: `dev-seed.ts`에서 IndexedDB를 직접 조작하면 `session-store` 로드와 race condition이 발생하므로, 반드시 `session-store.initialize()`에서 처리해야 합니다.

### `.env.local` 설정

```env
# 앱 시작 시 채팅 DB 전체 초기화 (개발용)
VITE_DEV_CLEAR_CHAT=1

# 기존 설정 강제 덮어쓰기
VITE_DEV_FORCE=1
```

---

## 🏗️ LLM 콜 스택 (현재)

```
streamFrom(model, chatProvider, messages)
  │
  ├─ [Gemini 경로] isGeminiProvider() → true
  │    └─ streamGeminiNative()        ← stage-ui/gemini-utils.ts (xsai 타입 래퍼)
  │         └─ streamGemini()         ← @proj-airi/gemini-utils (SDK 직접 호출)
  │              └─ GoogleGenAI.models.generateContentStream()
  │
  └─ [xsai 경로] isGeminiProvider() → false
       └─ streamText()               ← @xsai/stream-text
            └─ fetch(baseURL + "/chat/completions")
```

**Bouncer / Summarizer (echo-memory):**

```
callLLM(baseUrl, model, messages)
  ├─ [Gemini] isGeminiUrl() → callGemini()         ← @proj-airi/gemini-utils
  └─ [그 외]  fetch(baseUrl + "/v1/chat/completions")
```

## 🎙️ 오디오 인터럽트 시스템 (Audio Interrupt)

사용자가 캐릭터 발화 도중 채팅을 입력할 때 발생하는 오디오 중단(Interrupt) 동작을 두 가지 모드로 지원합니다. 이 설정은 `Settings -> System -> General`의 **Hard Interrupt** 토글을 통해 제어됩니다.

| 모드 | 동작 방식 | 로직 특성 |
|------|-----------|-----------|
| **Soft Interrupt**<br/>(기본값) | 현재 입 밖으로 내뱉고 있던 문장까지만 끝까지 말하고 자연스럽게 재생을 마칩니다. | `playbackManager`의 현재 재생 노드(`active`)는 유지하고 대기 큐(`waiting`)만 비웁니다 (`clearWaitingByIntent`). |
| **Hard Interrupt** | 즉시 오디오 출력을 강제 종료하고 끊습니다. | 기존처럼 `playbackManager.stopByIntent`를 호출하여 재생 중인 노드와 대기 큐를 모두 즉시 파기합니다. |

*참고: 어떤 인터럽트 방식을 사용하든, LLM 대화 기록(Context)에는 구조적으로 "재생이 시작된(onStart) 문장"까지만 기록되므로 AI의 기억 동기화가 정확히 유지됩니다.*

---

## 💡 알려진 사항 & TODO

### Tools Compatibility (Gemini)

현재 Gemini provider도 `attemptForToolsCompatibilityDiscovery`를 거쳐 tools compatibility를 확인한다.
Gemini는 function calling을 natively 지원하므로 이 단계는 불필요하지만, 현재는 그대로 유지.

### LLM 로거 (echo-memory에 포함됨)

`echo-memory/src/logger.ts` — BOUNCER/SUMMARIZER 역할별 REQUEST/RESPONSE 로그.
Gemini 스트리밍 로그는 `gemini-utils/stream.ts` 내부에서 처리.

### 🐛 최근 발견된 이슈 (해결 필요)

1. **사용자 입력 중복**: 사용자가 채팅을 입력하면 화면(또는 시스템)에 두 번 입력 처리되는 버그가 있음.
2. **Auto-speak (Timeout) 루프 끊김**: 타임아웃 발생 시 LLM 프롬프트에 추가 대사(Context)를 주입하지 않고 `[user]` 형태로만 전송됨. 이로 인해 LLM이 아무 대사 없는 빈 토큰을 반환하는 경우가 발생하며, 아무 대사도 출력되지 않으면 auto-speak 루프가 완전히 끊기는 문제가 있음.
3. **Bouncer 설정(Setting) 누락**: Bouncer 초기화를 전역(`main` / `App.vue`)에서 개별 채팅 컴포넌트 내부로 옮기면서, Bouncer 관련 세팅값들이 제대로 적용(setup)되지 않는 이슈가 발생함.

---

## 🚀 다음 단계

1. P7: 치지직 어댑터 연결
2. P8: Cold DB RAG (pgvector)
3. (선택) Gemini tools 강제 활성화 — discovery 없이 항상 tools 사용 가능하게
