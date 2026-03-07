# Handover Document: `feat/chat_upgrade`

이 문서는 `feat/chat_upgrade` 브랜치에서 다음 차례로 개발 및 개선해야 할 채팅 엔진 및 컨텍스트 파이프라인의 9가지 주요 목표를 정의하고 인수인계하기 위해 작성되었습니다.

## 작업 목표 목록 (Roadmap)

### 1. Bouncer 텍스트 중복 및 의도 생성 완료 [✅ 해결됨]
- **현상:** Bouncer(의도 검열 및 추론 LLM) 로직 처리 중 `text`와 `viewer` 필드나 시스템 프롬프트에 동일한 텍스트 내용이 두 번씩 중복으로 들어가는 현상이 발생.
- **조치:** `echo-memory` 내의 Bouncer 프롬프트 주입부 및 Stage UI의 `chat.ts` 입력 파이프라인에서 중복 전송되는 파라미터나 상태(State) 중복 렌더링 로직을 추적해 단일 컴포넌트화.

### 2. Hot Context 메모리 관리 로직 고도화
- **요구사항:** 현재의 단기/중기 기억(Hot Pool) 처리 로직과 구조를 개선.
- **조치:** 
  - 앱 초기 기동 시 읽어올 수 있는 전역(Global) 컨텍스트 주입 기능.
  - 사용자가 Tamagotchi 설정창(UI)에서 자유롭게 컨텍스트를 커스터마이징하고 튜닝할 수 있는 세팅 연동 로직 추가 (Pinia 스토어 및 JSON 파일 동기화).

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

### 6. Bouncer / Summarizer / Progressor Hash Log 관리
- **요구사항:** 에이전틱 LLM 파이프라인 3대장(판단, 요약, 기억 갱신)의 디버깅 및 추론 추적성 확보.
- **조치:** 
  - 이 3개의 핵심 모듈이 동작할 때 생성된 입출력 프롬프트 묶음에 각각 고유한 시그니처 Hash ID를 부여.
  - 인퍼런스 종료 시 파일(.log)이나 커스텀 콘솔 로거(`@guiiai/logg`)에 남겨, "어떤 Bouncer 로그가 이 요약을 만들었는가"를 역추적(Traceability) 가능하도록 설계.

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
