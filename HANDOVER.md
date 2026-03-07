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
  - Echo-Memory의 `HotContextPool`에 `onUpdate` 훅을 달아 메모리 변경점(`ADD`, `UPDATE`, `REMOVE`)을 추적할 수 있는 기반 마련.
  - **(New!) Lazy TTL 평가 기반 메모리 관리:** 노드의 수명(TTL) 초과 관리를 별도의 틱(Tick) 타이머로 삭제하는 방식이 아닌, 조회 시점(`getTopK`, `isActive`)에 실시간으로 나이(Age)를 검사해 필터링하는 게으른 판별(Lazy Evaluation) 방식을 채택하여 성능 낭비를 줄임. 만료된 노드들은 향후 Cold Context DB 이관 목적으로 `getArchivableNodes` 함수를 통해 일괄 수거할 수 있도록 파이프라인 정비 완료.
  - **(New!) Stateful History 추적 고도화:** `mood` 및 `progressSummary`를 단순 덮어쓰지 않고 `[]` 배열 형식으로 누적 관리. `rebuildContent()` 과정에서 누적 내역을 기반으로 `분위기 변화: A -> B`, `진행 변화: 1... 2...` 형태로 직관적인 시계열 텍스트로 자동 조합.
  - **(New!) 외부 컨텍스트 자동 요약 매핑:** 파일 병합 시 단순 `chat` 타입이 아닌 `context_summary`로 주입하고 원본 텍스트를 `contextSummary` 배경 맥락으로, `progressSummary`에 "방금 대화가 시작되었거나 진행 전 상태입니다." 문구를 자동 할당하도록 초기화 과정 매핑 구축 완료.

### 2-1. Auto-Speak 대기열(Queue) 최적화 및 발화 품질 개선 [✅ 해결됨]
- **요구사항:** 자율 발화(Auto-Speak) 시스템 동작 시 후속 채팅 지연 방지 및 문맥에 맞는 자연스러운 발화 유도.
- **조치:**
  - **쿨다운 룰 예외 처리:** 빈 텍스트 기반의 Auto-Speak 메시지가 LLM 큐에서 처리된 직후에는 `chatCooldownMs` 대기를 생략(Bypass)하도록 로직 적용. Auto-Speak 발동 직후 유저 입력이 들어왔을 때 답답한 딜레이 없이 즉시 응답 가능.
  - **프롬프트 강화:** Auto-Speak용 시스템 프롬프트에 "컨텍스트 로그와 이전 대화를 면밀히 분석하고 흐름을 잇도록" 지시하여 뜬금없는 화제 전환(맥락 파괴) 방지.

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
  - **지능형 API Caching 상태머신 & TTL 오토-리커버리:** `PromptCacheEntry` 모델을 도입해 실패/스킵 처리된 해시를 캐싱하여 불필요한 시도 스팸을 없앰. 캐시 수명(10분)이 1분 미만 남았을 땐 자동으로 `update`를 날려 연장하며, 이미 만료된 경우 당황하지 않고 인라인 폴백으로 그 자리에서 즉시 새로운 생성 절차를 시작함. (Gemini Flash는 3000자, Pro는 12000자 이상일 때만 동적으로 캐싱 조건 발동)
  - **Payload Schema Fix:** 기존에 껍데기에 있던 `systemInstruction` 인자 위치를 최신 SDK의 `config: { systemInstruction }` 규격으로 옮겨 `total_token_count=0`으로 인해 Caches.create()가 거부되던 이슈를 완벽 해결.
  - API Caching 시도 시 길이가 미달하여 조용히 스킵될 경우, 이것 역시 `llm.log`에 명시적으로 표출하여 추적성을 강화.
  - 콘솔 출력용엔 `.slice(0, 100)`의 길이 제한을 걸어 가독성을 살리고, 데스크톱 파일(`llm.log`, `chat.log`, `memory.log`) 저장 파이프라인에는 앱 구동 시점의 타임스탬프(`RUN_ID`)를 파일명에 부여하여, 앱을 켤 때마다 추론 흐름 3종 세트가 깔끔하게 매핑 보관되도록 구현함. 또한 응답 파일 기록은 800자 제한을 없애고 전문이 남도록 수정.
  - 다중 LLM 비동기 콜이 섞이는 것을 해결하기 위해 발급 시 자체적으로 Request ID (`[#0001]`)를 부여하여 요청과 응답 페어를 눈으로 즉시 매핑(`Pairing`)할 수 있도록 설계 완료 (`echo-memory` 및 `Gemini` 네이티브 스트림 모두 적용됨).

### 6-1. 재생 파이프라인 디버그 로그 정리 [✅ 해결됨]
- **요구사항:** 음성 파이프라인(`speech-pipeline`, `playback-manager`)에 남아있는 불필요한 콘솔 출력(TTS Chunk, SEGMENT 등) 제거.
- **조치:**
  - `console.warn`으로 임시 출력되던 스트리밍 오디오 세그먼트, 스케줄링 로그를 모두 제거하여 터미널과 브라우저 콘솔 가독성 향상.

### 7. 전용 Grok API 추가 [✅ 해결됨]
- **요구사항:** xAI의 Grok 모델 서빙 프로바이더 연동 추가.
- **조치:** 
  - `grok-utils` 패키지를 신설하고 `stage-ui`의 `llm.ts` 파이프라인에 네이티브 모델로 병합 연결 완료.
  - Vercel AI SDK (`@ai-sdk/xai`) 기반의 스트리밍 및 텍스트 델타, 툴 콜(Function Call) 포맷 처리 및 `GrokStreamChunk` 맵핑 구현.
  - `gemini-utils`와 동일한 수준의 측정(관측성) 보장을 위해 DJB2(cyrb53) 기반 프롬프트 해싱, 정적 캐시 중복 텍스트 생략 필터, Request ID 매핑 로직 구축.
  - xAI API의 브라우저 전면단 CORS(OPTIONS Preflight 405 Error) 차단 정책을 로컬에서 우회하기 위해, Electron Main 프로세스의 렌더러 창 생성 구문(`mainWindow`, `chatWindow`, `settingsWindow`, `captionWindow`, `widgetsWindow`)들에 `webSecurity: false` 속성을 부여하여 에러 없이 통신되도록 조치.

### 8. 전용 Fish Audio API 추가
- **요구사항:** TTS 파이프라인(목소리)의 오픈소스/고품질 대안 모델로 다변화.
- **조치:** 
  - 기존 ElevenLabs 외에 Fish Audio (Fish Speech) API 또는 로컬 서버를 `speech-pipeline.ts` 호환으로 렌더러에 연동 가능 하도록 Provider 확장.
  - 버퍼링 오디오 플레이어 로직에 Fish Audio의 스트리밍 chunk PCM 규격 적용.

### 9. Summarizer 및 Progressor 로직 고도화 (다음 진행 목표)
- **요구사항:** 대화 요약 밀도 확보 및 장기 상태 업데이트 품질 향상.
- **조치 (완료 및 예정):** 
  - **(New!) Snapshot & Delayed Decision 아키텍처 [✅ 해결됨]:** AI 자율 발화(Auto-Speak) 시나 유저의 인터럽트 발화 시점의 정확한 컨텍스트 상태(T_1 Snapshot)와 UI에서 실제로 낭독된 텍스트(`turnSpokenText` in `Stage.vue`)를 분리 수집 및 누적. TTS 오디오 기반의 실제 발화 내용을 Progress Summarizer 판단에 직접 주석으로 던져, 컨텍스트 왜곡(문맥 Drift)을 방지하고 완벽한 상태 동기화 매커니즘을 구축 완료.
  - **(New!) 노드 ID 기반 개별 업데이트 및 Weight 유지 [✅ 해결됨]:** 기존의 단순 "최상위 노드 덮어쓰기" 대신, Progress LLM이 직접 타겟 노드(`targetNodeId`)를 지정하여 개별 노드의 변화(Progress/Mood)만 정밀하게 업데이트하도록 개선. 누락 시 이전 가중치(Weight)를 보존하는 로직 적용 완료.
  - **(New!) 슬라이딩 윈도우 기반 효율적 컨텍스트 전송 [✅ 해결됨]:** 파일/DB 시각적 로그 보존성은 100% 유지하면서, LLM API 호환을 위해 전송 직전에만 `VITE_CHAT_HISTORY_LIMIT` (기본: 40) 기반으로 최근 채팅만 잘라서 전송하는 안전한 슬라이딩 윈도우 구현.
  - **채팅 요약 기반 Hot Pool 노드 Update/Add 분기:** 대화 슬라이딩 윈도우가 가득 찼을 때 단순 요약(Summarizer)하는 것에 그치지 않고, 새로 파악한 내용을 새 노드로 만들지 기존 요약 노드들에 병합 및 업데이트 할지 상태 추론 엔진 추가 로직 마련.
  - **장문 Content 동일 포맷 압축(Freeze):** 단일 노드의 `content`가 컨텍스트 한계를 위협할 만큼 너무 길어질 경우, `isContentFrozen` (의도적 덮어쓰기) 기능을 활용하여 낡은 텍스트를 버리지 않고 동일한 프롬프트 포맷 규격으로 한 번 더 압축해 덮어쓰고, 또 다시 배열로 새로운 맥락을 이어나가는 효율화 관리 로직 추가.
