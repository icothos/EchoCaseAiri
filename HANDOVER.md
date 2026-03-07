# Handover Document: `feat/chat_upgrade`

이 문서는 `feat/chat_upgrade` 브랜치에서 다음 차례로 개발 및 개선해야 할 채팅 엔진 및 컨텍스트 파이프라인의 9가지 주요 목표를 정의하고 인수인계하기 위해 작성되었습니다.

## 작업 목표 목록 (Roadmap)

### 1. Bouncer 텍스트 중복 및 의도 생성 완료 [✅ 해결됨]
- **현상:** Bouncer(의도 검열 및 추론 LLM) 로직 처리 중 `text`와 `viewer` 필드나 시스템 프롬프트에 동일한 텍스트 내용이 두 번씩 중복으로 들어가는 현상이 발생.
- **조치:** `echo-memory` 내의 Bouncer 프롬프트 주입부 및 Stage UI의 `chat.ts` 입력 파이프라인에서 중복 전송되는 파라미터나 상태(State) 중복 렌더링 로직을 추적해 단일 컴포넌트화.

### 2. Hot Context 메모리 관리 로직 고도화 [✅ 해결됨]
- **요구사항:** 현재의 단기/중기 기억(Hot Pool) 처리 로직과 구조를 개선.
- **조치:** 
  - 앱 초기 기동 시 읽어올 수 있는 전역 컨텍스트(`run_context.md`) 주입 기능 완료.
  - 외부 연동이나 이벤트 트리거로 작동하는 동적 컨텍스트(`hot_context.md`) 연동 방식(폴링) 신설. 파일 내용이 수정될 때만 무한 TTL(`999999999`) 노드를 강제로 갈아치워(Remove -> Add) 불필요한 풀 업데이트 스팸을 방지.
  - 앱 초기 기동 시 Echo-Memory Pool이 마운트되기 직전에 `hot-context.ts`가 싱크를 맞추려다 5초를 날려먹는 지연(Race Condition)을 막기 위해, Pool이 준비되지 않았을 경우 1초(1000ms) 뒤 자가 재시도(Retry)하도록 회복 코드 작성 완료.
  - Echo-Memory의 `HotContextPool`에 `onUpdate` 훅을 달아 메모리 변경점(`ADD`, `UPDATE`, `REMOVE`)을 추적할 수 있는 기반 마련.

### 3. Cold Context 추가 및 관리 로직 (RAG & Vector Embedding)
- **요구사항:** 장기 기억(Cold Context)의 물리적 보관 및 조회(검색) 기능 신설.
- **조치:**
  - 사용자 채팅 데이터를 영구 저장하고 텍스트 임베딩(Vector)으로 변환하여 DB(예: pgvector, 302.ai API, 또는 local DuckDB WASM vector)에 저장.
  - Bouncer가 의도 판단 중 `rag` 트리거를 발동했을 때 해당 DB 모델을 조회해 프롬프트 상단 Context에 동적으로 가져오는 검색 파이프라인 완성.

### 4. 치지직(Chzzk) 챗 입력/출력 포맷 검증
- **요구사항:** 새롭게 구현된 치지직 어댑터를 거쳐 들어오는 채팅의 정합성 확인과 UI 표시 품질 향상.
- **조치:**
  - `server-runtime`에서 치지직 채팅 데이터가 전달되는 구조(`chzzk-adapter` -> websocket -> Airi Core) 명확화.
  - 이모티콘 기호 포함, 후원 메시지 등 치지직 특유의 JSON 페이로드를 Airi가 낭독하거나 UI 채팅창에 예쁘게 그릴 수 있도록 텍스트 출력 포맷 파싱 및 챗 컴포넌트(`ChatOverlay`) 파서 업데이트.

### 5. Tamagotchi 설정 및 채팅창 UI On/Off 기능
- **요구사항:** 데스크톱 앱(Tamagotchi) 화면과 팝업 사용성 개선.
- **조치:**
  - 메인 화면 구동 중 `windows:chat` 팝업창(채팅창 레이어)과 각종 데브툴, 설정창을 사용자가 원할 때 단축키나 설정 메뉴를 통해 켜고 끌 수 있는 토글(Toggle) 기능 구현.
  - 각종 AI 모델 파라미터 조정 메뉴를 UI에 노출.

### 6. Bouncer / Summarizer / Progressor Hash Log 관리 및 추적성 확보 [✅ 해결됨]
- **요구사항:** 에이전틱 LLM 파이프라인 3대장(판단, 요약, 기억 갱신)의 디버깅 및 추론 추적성 확보.
- **조치:** 
  - `logger.ts`에서 각 프롬프트 시스템 지시문을 해싱 연산(DJB2)하여, 최초에는 전문을, 이후에는 중복 감지되어 해시만 출력되도록 길이를 압축함.
  - **프롬프트 캐싱 & 스팸 방어 (Decoupling):** 동적 컨텍스트(Hot/Run Context)가 시스템 프롬프트에 병합되면 해싱 문자가 매번 깨지고 Gemini의 Native API Caching(`systemInstruction`)이 무력화되는 치명적인 문제를 방지하기 위해, 오리지널 페르소나(`rawSystemPrompt`)만 로깅/캐싱에 사용하도록 분리함. 가변 컨텍스트 텍스트는 첫 번째 User 텍스트 맨 앞에 주입(Prepend)하여 Prompt Injection 필터 회피와 로깅 스팸 감소 두 마리 토끼를 다 잡음.
  - API Caching 시도 시 문자 수가 3만 자를 넘지 않아 조용히 스킵될 경우, 이것 역시 `llm.log`에 명시적으로 `[CACHE] Skipped` 로그로 표출하여 추적성을 강화.
  - 콘솔 출력용엔 `.slice(0, 100)`의 길이 제한을 걸어 가독성을 살리고, 데스크톱 파일(`llm.log`, `chat.log`, `memory.log`) 저장 파이프라인에는 앱 구동 시점의 타임스탬프(`RUN_ID`)를 파일명에 부여하여, 앱을 켤 때마다 추론 흐름 3종 세트가 깔끔하게 매핑 보관되도록 구현함.
  - 다중 LLM 비동기 콜이 섞이는 것을 해결하기 위해 발급 시 자체적으로 Request ID (`[#0001]`)를 부여하여 요청과 응답 페어를 눈으로 즉시 매핑(`Pairing`)할 수 있도록 설계 완료 (`echo-memory` 및 `Gemini` 네이티브 스트림 모두 적용됨).

### 6-1. 재생 파이프라인 디버그 로그 정리 [✅ 해결됨]
- **요구사항:** 음성 파이프라인(`speech-pipeline`, `playback-manager`)에 남아있는 불필요한 콘솔 출력(TTS Chunk, SEGMENT 등) 제거.
- **조치:**
  - `console.warn`으로 임시 출력되던 스트리밍 오디오 세그먼트, 스케줄링 로그를 모두 제거하여 터미널과 브라우저 콘솔 가독성 향상.

### 7. 전용 Grok API 추가
- **요구사항:** xAI의 Grok 모델 서빙 프로바이더 연동 추가.
- **조치:** 
  - `xsai` 패키지 또는 내부 LLM 라우팅 로직(stage-ui `llm.ts`)에 Grok 전용 엔드포인트 호환 어댑터 작성. (Vision/Function Call 지원 여부 포함)

### 8. 전용 Fish Audio API 추가
- **요구사항:** TTS 파이프라인(목소리)의 오픈소스/고품질 대안 모델로 다변화.
- **조치:** 
  - 기존 ElevenLabs 외에 Fish Audio (Fish Speech) API 또는 로컬 서버를 `speech-pipeline.ts` 호환으로 렌더러에 연동 가능 하도록 Provider 확장.
  - 버퍼링 오디오 플레이어 로직에 Fish Audio의 스트리밍 chunk PCM 규격 적용.

### 9. Summarizer 및 Progressor 로직 고도화
- **요구사항:** 대화 요약 밀도 확보 및 장기 상태 업데이트 품질 향상.
- **조치:** 
  - 대화 슬라이딩 윈도우가 가득 찼을 때 요약(Summarizer)하는 프롬프트를 개선하여, 캐릭터 성격과 맥락이 묽어지는(Catastrophic Forgetting) 현상 최소화.
  - 사용자와 캐릭터 간의 관계성 진척도나 특이사항이 바뀌었을 때, 이를 장기 기억 노드(`progress_summary`)에 얼마나 섬세하게 갱신(Update/Merge)할지 Prompting 최적화 및 평가 모니터링 방식 도입.
