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
| `src/auth/` | Cognito 로그인(Amplify Auth)과 로그인 상태 |
| `src/api/http.ts` | axios 공통 설정: API 주소, ID 토큰 붙이기, 401이면 로그인 화면으로 |
| `src/stores/` | 대화 목록·메시지(`chatStore`), 모델 목록(`modelsStore`) — Zustand |
| `src/components/layout/` | 위쪽 내비게이션, 프로필 메뉴, 로그인 화면 (AXPI) |
| `src/components/panel.css` | 패널·목록 행·버튼·확인창 (AXPI) |
| `src/features/home/` | 홈: 질문 입력, 자주 묻는 질문 |
| `src/features/chat/` | 대화: 대화 목록, 메시지, 질문 입력칸 |
| `src/utils/markdown.ts` | 답변 마크다운 → HTML (표·코드 블록·목록) |
| `src/utils/toolTrace.ts` | 답변을 만들며 부른 MCP 도구 목록 |
| `src/mock/api.ts` | mock 모드의 가짜 API (배포용 빌드에는 들어가지 않는다) |

## 환경 값 (`.env.local`, deploy.sh가 만든다)

| 이름 | 쓰는 곳 |
|---|---|
| `VITE_API_DEST` | API Gateway 주소 |
| `AWS_REGION` | Cognito 리전 |
| `USER_POOL_ID`, `COGNITO_CLIENT_ID` | Cognito 로그인 |
