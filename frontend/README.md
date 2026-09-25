# WGA 프론트엔드

React 18 + TypeScript + Vite. 디자인은 AXPI(LG Entrue) 화면의 CSS를 가져와 색만 WGA 색으로 바꿨다.

```bash
npm install
npm run dev        # 배포된 환경의 로그인·API 사용 (deploy.sh가 만든 .env.local 필요)
npm run dev:mock   # AWS 없이 화면만: 로그인된 상태로 시작하고 가짜 API로 응답
npm run build      # tsc 타입 검사 + vite 빌드 → dist/ (deploy.sh가 Amplify에 올린다)
```

## 구조

| 경로 | 내용 |
|---|---|
| `src/App.tsx` | 로그인 여부에 따라 로그인 화면 / 위쪽 내비게이션 + 화면(홈 `/`, 대화 `/chat`) |
| `src/auth/` | Cognito 로그인(로그인 버튼 → Cognito 로그인 페이지 → `/redirect`로 돌아옴, Amplify Auth)과 로그인 상태 |
| `src/api/http.ts` | axios 공통 설정: API 주소, ID 토큰 붙이기, 401이면 로그인 화면으로 |
| `src/stores/` | 대화 목록·메시지(`chatStore`), 모델 목록(`modelsStore`) — Zustand |
| `src/components/layout/` | 위쪽 내비게이션, 프로필 메뉴, 로그인 화면 (AXPI) |
| `src/components/panel.css` | 패널·목록 행·버튼·확인창 (AXPI) |
| `src/features/home/` | 홈: 큰 제목·설명·큰 입력칸 (FinGate-X 첫 화면 구성, 누르면 예시 질문이 펼쳐짐) |
| `src/features/chat/` | 대화: 메시지, 질문 입력칸, 대화 목록 팝업창, 답변을 만드는 과정(`ProgressTrace`: 사고 요약·도구 호출·'생각하는 중… (12초)') |
| `src/utils/markdown.ts` | 답변 마크다운 → HTML (표·코드 블록·목록) |
| `src/utils/toolTrace.ts` | 답변을 만드는 과정(사고 요약·MCP 도구 호출)을 화면에 그릴 목록으로 바꾸기 |
| `src/mock/api.ts` | mock 모드의 가짜 API (배포용 빌드에는 들어가지 않는다). 질문마다 몇 초짜리 진행 상황(사고 → 도구 → 사고)도 흉내 낸다 |

## 환경 값 (`.env.local`, deploy.sh가 만든다)

| 이름 | 쓰는 곳 |
|---|---|
| `VITE_API_DEST` | API Gateway 주소 |
| `AWS_REGION` | Cognito 리전 |
| `USER_POOL_ID`, `COGNITO_CLIENT_ID` | Cognito 로그인 |
| `COGNITO_DOMAIN` | Cognito 로그인 페이지 주소의 앞부분 (`<값>.auth.<리전>.amazoncognito.com`) |

로그인 뒤 돌아올 주소는 지금 열린 앱 주소 + `/redirect`로 정한다. Cognito에는 배포 주소와 `http://localhost:5173/redirect`가 등록되어 있어, 로컬에서는 포트 5173으로 띄워야 한다 (`.env.local`의 `COGNITO_REDIRECT_URI`는 쓰지 않는다).
