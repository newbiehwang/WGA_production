# WGA (WeGoAWS) - AWS 클라우드 운영 정보 챗봇 서비스

![thumbnail](./images/thumbnail.png)

## 개요

WGA는 AWS 클라우드 운영 정보를 자연어로 질의응답할 수 있는 서버리스 기반의 AI 챗봇 서비스입니다. 사용자는 복잡한 AWS 콘솔을 직접 조작하는 대신, 간단한 자연어 질문을 통해 클라우드 자원 상태, 비용 분석, 보안 이벤트, 로그 분석 등의 정보를 즉시 얻을 수 있습니다.

### 핵심 가치
- **간편한 접근성**: 자연어 기반 질의로 AWS 전문 지식 없이도 클라우드 정보 조회 가능
- **정확한 답변**: AWS 공식 문서를 기반으로 정확한 답변 제공
- **실시간 모니터링**: CloudWatch 로그와 대시보드를 통한 실시간 시스템 상태 파악
- **비용 최적화**: AWS 비용 분석 및 최적화 제안
- **보안 강화**: 보안 이벤트 모니터링 및 알림

### 팀 구성과 담당 범위
WeGoAWS 팀 프로젝트입니다. 본인([@newbiehwang](https://github.com/newbiehwang))은 다음 영역을 담당했습니다.
- **인프라 / IaC**: `cloudformation/` 전체 스택 설계 및 작성
- **배포 자동화**: `deploy.sh` 통합 배포 스크립트, CodeBuild 기반 MCP 컨테이너 이미지 빌드
- **LLM·MCP 백엔드**: `services/llm`, `mcp/`, `layers/common`

## 아키텍처

### 전체 시스템 아키텍처

![WGA 시스템 아키텍처](./images/architecture.png)

### 기술 스택
- **Frontend**: Vue 3, TypeScript, Pinia, Vue Router, Vite, Axios
- **Backend**: AWS Lambda (Python 3.12, MCP 서버는 Lambda Container Image), API Gateway (REST)
- **AI/ML**: Anthropic Claude (AWS Bedrock / Anthropic API), MCP (Model Context Protocol)
- **Database**: DynamoDB, Athena
- **Storage**: S3 (정적 파일, 로그, 다이어그램 이미지 저장)
- **Monitoring 대상**: CloudWatch Logs, CloudWatch Dashboard, Cost Explorer
- **Authentication**: AWS Cognito (User Pool, Identity Pool)
- **Infrastructure**: CloudFormation (Nested Stack 포함)
- **배포**: `deploy.sh` 배포 스크립트, CodeBuild(MCP 이미지 빌드), ECR, Amplify Hosting

### CloudFormation 스택 구성
| 스택 (템플릿) | 스택 이름 | 역할 |
|---|---|---|
| base (`base.yaml`) | `wga-base-{env}` | API Gateway RestApi, Cognito User/Identity Pool, DynamoDB 테이블 4개, S3 버킷 7개, SSM Parameter |
| frontend (`frontend.yaml`) | `wga-frontend-{env}` | Amplify App/Branch, 프론트엔드 버킷 정책 |
| mcp (`mcp.yaml`) | `wga-mcp-{env}` | MCP 이미지용 ECR 리포지토리, CodeBuild 프로젝트 |
| main (`main.yaml`) | `wga-{env}` | 아래 5개 Nested Stack과 API Gateway 최종 Deployment |
| └ llm (`llm.yaml`) | Nested | LLM Lambda, MCP Lambda(Container Image, Function URL), `/llm1`, `/llm2` 등 |
| └ logs (`logs.yaml`) | Nested | Athena 유틸리티 Lambda, `/execute-query`, `/create-table` |
| └ slackbot (`slackbot.yaml`) | Nested | Slack 봇 Lambda, `/login`, `/callback`, `/models`, `/req` 등 |
| └ chat-history (`chat-history.yaml`) | Nested | 대화 기록 Lambda, `/sessions/*` |
| └ monitoring (`monitoring.yaml`) | Nested | CloudWatch 알람 21개, SNS 알림 토픽, 서비스 대시보드, Logs Insights 저장 쿼리 |

**의존 관계**: base가 API Gateway·Cognito·DynamoDB·S3를 만들고, 나머지 스택은 base의 RestApi ID와 루트 리소스 ID를 파라미터로 받아 리소스와 메서드를 추가합니다. llm 스택은 mcp 스택이 ECR에 올린 이미지를 사용합니다.

**배포 순서** (`deploy.sh`):
1. 템플릿을 S3에 업로드
2. base 스택 배포
3. frontend 스택 배포 → Amplify 도메인을 base 스택에 반영(콜백 URL 갱신)
4. Lambda Layer·함수 코드 패키징 및 S3 업로드
5. mcp 스택 배포 → CodeBuild로 MCP 이미지 빌드 후 ECR에 푸시
6. main 스택 배포 (llm, logs, slackbot, chat-history, monitoring + API Deployment) → API 스테이지 재배포, X-Ray 추적 활성화
7. 프론트엔드 환경 변수 설정, 빌드, Amplify 배포
8. MCP Function URL을 base 스택 SSM 파라미터에 반영

## 주요 기능

### 1. 자연어 기반 질의응답
- **로그 분석**: "어제 S3에 접근한 사용자는 누구인가요?"
- **비용 분석**: "지난 주 Opensearch 비용이 얼마나 나왔나요?"
- **보안 조회**: "최근 실패한 로그인 시도가 있나요?"
- **AWS 문서 검색**: "GuardDuty 심각도는 어떤 의미인가요?"

### 2. 실시간 모니터링 및 분석
- **CloudWatch 로그 분석**: 서비스별 로그 조회 및 분석
- **CloudWatch 대시보드 모니터링**: 주요 서비스를 실시간으로 모니터링
- **CloudTrail 이벤트**: AWS API 호출 이력 및 사용자 활동 추적
- **GuardDuty 보안 이벤트**: 보안 위협 분석
- **비용 분석**: 서비스별, 리전별, 일별 비용 분석

### 3. 시각화 및 차트 생성
- **동적 차트**: 막대 차트, 라인 차트, 파이 차트, 산점도 등
- **아키텍처 다이어그램**: AWS 인프라 시각화
- **플로우차트**: 프로세스 흐름도 생성
- **마인드맵**: 구조화된 정보 표현

### 4. AWS 공식 문서 기반 답변 제공
- **실시간 문서 검색**: AWS 공식 문서에서 키워드 기반 검색
- **컨텍스트 기반 추천**: 현재 질문과 관련된 문서 자동 추천
- **다국어 지원**: 영문 문서를 한국어로 자동 번역하여 제공

### 5. 다중 인터페이스 지원
- **웹 인터페이스**: Vue 3 기반 웹 앱
- **Slack 봇**: 슬랙 채널에서 직접 질의 가능

### 6. 대화 기록 관리
- **세션 관리**: 사용자별 대화 히스토리 저장
- **컨텍스트 유지**: 이전 대화 내용을 기반으로 한 연속 질의
- **히스토리 검색**: 과거 질의 및 답변 검색

### 7. 간편한 배포
- **단일 스크립트 배포**: `deploy.sh` 하나로 전체 인프라와 프론트엔드 배포
- **CloudFormation 기반**: AWS 네이티브 IaC로 인프라 관리
- **이미지 빌드 자동화**: CodeBuild로 MCP 서버 Docker 이미지 빌드 후 ECR 푸시
- **환경별 분리**: dev/test/prod 환경 독립 배포 및 관리

## 프로젝트 구조

```
WGA_production/
├─cloudformation
├─frontend
│ ├─public
│ └─src
│   ├─assets
│   ├─components
│   ├─directives
│   ├─layouts
│   ├─router
│   ├─stores
│   ├─types
│   ├─utils
│   └─views
├─images
├─layers
│ └─common
├─mcp
│ └─lambda_mcp
├─services
│ ├─chat-history
│ ├─db
│ ├─llm
│ └─slackbot
└─deploy.sh
```

## 설치 및 배포

### 사전 요구사항
- AWS CLI 설정 및 적절한 권한
- 배포 리전: 기본값은 서울(`ap-northeast-2`)입니다. `AWS_REGION` 환경 변수 → CLI 프로필의 리전 → 서울 순서로 정해지며, 코드에 특정 리전을 고정하지 않습니다.
- Service Quotas -> API Gateway -> Maximum integration timeout in milliseconds -> 120000ms로 변경 요청(자동 승인. 120000ms를 넘는 값은 추가 승인이 필요)
- Node.js 18+ 
- Python 3.12+

### 환경 변수 설정
```bash
# AWS CLI 설정
aws configure
```

### 1단계: 기본 설정
```bash
# 프로젝트 클론
git clone https://github.com/WeGoAWS/WGA_production.git
cd WGA_production

# SSM 파라미터 설정 (필요한 경우)
aws ssm put-parameter --name "/wga/${Environment}/SlackbotToken" --value "your-slack-token" --type "SecureString"
aws ssm put-parameter --name "/wga/${Environment}/SlackSigningSecret" --value "your-slack-signing-secret" --type "SecureString"
aws ssm put-parameter --name "/wga/${Environment}/ANTHROPIC_API_KEY" --value "your-anthropic-key" --type "SecureString"
```

### 2단계: 통합 배포
```bash
# 개발 환경 배포
./deploy.sh dev

# 프로덕션 환경 배포
./deploy.sh prod

# 알람을 이메일로 받으려면 (구독 확인 메일의 링크를 눌러야 활성화됨)
ALARM_EMAIL=you@example.com ./deploy.sh dev
```

재배포 동작:
- **코드 버전**: Lambda zip의 S3 키와 MCP 이미지 태그에 git 커밋 SHA를 붙여, 코드를 바꾸면 CloudFormation이 변경을 감지해 새 코드를 배포합니다. 커밋하지 않은 변경이 있으면 `-dirty-<시각>`이 붙습니다.
- **데이터 보존**: 버킷 내용을 지우지 않습니다. 모든 버킷이 `DeletionPolicy: Retain`이라 내용물이 있어도 스택 업데이트·롤백에 영향이 없습니다. 배포 버킷의 오래된 빌드 산출물은 수명 주기 규칙(90일)으로 정리됩니다.
- **변경 없는 스택**: 바뀐 것이 없는 스택은 오류 없이 건너뜁니다.

모든 스택에 `Project=WGA`, `Environment={env}` 태그가 붙어 하위 리소스까지 전파됩니다. Cost Explorer에서 두 태그를 비용 할당 태그로 활성화하면 프로젝트·환경별 비용을 볼 수 있습니다.

### 3단계: 배포 확인
배포 완료 후 다음 정보가 출력됩니다:
- **프론트엔드 URL**: `https://ENVIRONMENT.xxxxxxxxxxxxx.amplifyapp.com`
- **API Gateway URL**: `https://xxxxxxxxxx.execute-api.AWSREGION.amazonaws.com/ENVIRONMENT`
- **MCP Function URL**: `https://xxxxxxxxxx.lambda-url.AWSREGION.on.aws/`

추가로, SSM Parameter 정보도 제공됩니다.

## 운영 및 모니터링

### 알람 (`monitoring.yaml`)
모든 알람은 SNS 토픽 `wga-alarms-{env}`로 발생·해소 알림을 보냅니다.

| 대상 | 지표 | 조건 | 의도 |
|---|---|---|---|
| Lambda 5개 | Errors | 5분 합계 1건 이상 | 함수 오류 즉시 감지 |
| Lambda 5개 | Throttles | 5분 합계 1건 이상 | 동시성 한도 도달 감지 |
| Lambda 5개 | Duration p95 | 함수 Timeout의 80% 초과, 2회 연속 | 타임아웃 임박 감지 (LLM·MCP 144초, Slack 봇 12초 등) |
| API Gateway | 5XXError | 5분 합계 5건 이상 | 백엔드 장애 감지 |
| API Gateway | Latency p95 | 100초 초과, 2회 연속 | 통합 타임아웃(120초) 임박 감지 |
| DynamoDB 4개 | Read + Write ThrottleEvents | 5분 합계 1건 이상 | 프로비저닝 용량(5 RCU/WCU) 부족 감지 |

Lambda 알람은 `Fn::ForEach`(AWS::LanguageExtensions)로 함수 목록과 임계값 매핑만 두고 한 번에 정의했습니다.

### 대시보드와 추적
- **대시보드** `wga-{env}-service`: API 요청 수·오류·응답 시간, Lambda 호출·오류·실행 시간 p95, DynamoDB 스로틀·소비 용량. 챗봇의 대시보드 조회 도구로도 확인할 수 있습니다.
- **X-Ray**: 모든 Lambda와 API Gateway 스테이지에서 Active 추적을 켜서 API → Lambda → MCP 호출 구간별 지연을 볼 수 있습니다.
- **구조화 로그**: Lambda 로그 형식을 JSON으로 설정했습니다. 플랫폼 `REPORT` 레코드의 `initDurationMs`, `durationMs`, `maxMemoryUsedMB`로 콜드 스타트와 메모리 사용률을 집계합니다.
- **저장 쿼리**: CloudWatch Logs Insights의 `wga-{env}/lambda-performance`(함수별 콜드 스타트 비율, p50/p95, 최대 메모리)와 `wga-{env}/cold-start-vs-warm`(콜드/웜 응답 시간 비교).

### 데이터 보호 정책
| 리소스 | 설정 | 이유 |
|---|---|---|
| S3 버킷 7개 | `DeletionPolicy: Retain`, 퍼블릭 액세스 차단 | 스택을 지워도 로그·산출물을 보존하고, 재배포 시 `deploy.sh`가 기존 버킷을 재사용 |
| DynamoDB 테이블 4개 | Point-in-Time Recovery, prod에서 삭제 방지 | 최근 35일 내 임의 시점 복구. 테이블 이름이 고정이라 Retain 대신 삭제 방지로 prod 데이터를 보호 |
| SSM 파라미터 | `DeletionPolicy: Delete` | 스택 출력값에서 파생되는 설정이라 재배포 시 다시 생성됨 |

## 설정 가이드

### Slack 봇 설정
1. Slack 앱 생성 및 봇 토큰 발급
2. SSM Parameter Store에 봇 토큰(`SlackbotToken`)과 Signing Secret(`SlackSigningSecret`) 저장
   - Signing Secret은 Slack 앱의 Basic Information → App Credentials에서 확인합니다.
   - Slack 요청은 이 값으로 서명을 검증하며, 설정되지 않으면 모든 Slack 요청을 거부합니다.
3. Slack 앱에 다음 기능 추가:
   - Slash Commands: `/models`
   - Interactive Components
   - Bot Token Scopes: `chat:write`, `im:write`

## 사용 예시

### 웹 인터페이스
1. 브라우저에서 프론트엔드 URL 접속
2. Cognito를 통한 로그인
3. 채팅 인터페이스에서 자연어 질문 입력

### Slack 봇
```
# 모델 설정
/models

# 질의 실행
어제 EC2 인스턴스를 시작한 사용자는 누구인가요?
지난 주 S3 비용 분석해주세요
GuardDuty에서 감지된 보안 이벤트가 있나요?
```

## 핵심 구현 로직

### Vue 3 기반 채팅 인터페이스
Vue 3(Composition API)와 TypeScript로 대화형 채팅 인터페이스를 구현했습니다. 메시지와 세션 상태는 Pinia store(`chatbot`, `chatHistoryStore`)로 관리하고, AI 응답은 글자 단위로 출력하는 타이핑 애니메이션으로 표시합니다. 대화 기록은 Chat History API(`/sessions/*`)를 통해 DynamoDB에 저장되어 이전 대화를 다시 불러올 수 있습니다. 커스텀 디렉티브(`v-markdown`)로 마크다운을 렌더링하여 코드 블록, 표, 링크를 표시하고, 서버에서 생성한 차트·다이어그램은 S3 이미지로 표시합니다.

### Cognito OAuth 2.0 인증
AWS Cognito User Pool의 Hosted UI와 OAuth 2.0 Authorization Code Flow로 로그인을 처리합니다. 발급된 토큰과 사용자 정보는 Pinia `auth` store에서 관리하며, 만료 시 refresh token으로 갱신합니다. Vue Router의 `beforeEach` 가드에서 `meta.requiresAuth`가 설정된 라우트에 대해 인증 여부를 확인하고, 미인증 사용자는 로그인 페이지로 이동시킵니다.

### Lambda 기반 MCP 서버 및 클라이언트 구현
기존 MCP 프로토콜의 HTTP+SSE(Server-Sent Events) 방식은 AWS Lambda의 제약사항과 호환되지 않아, Streamable HTTP 방식으로 재설계했습니다. Lambda의 서버리스 환경에서 지속적인 연결을 유지할 수 없는 특성을 고려하여, 요청-응답 기반의 HTTP 프로토콜로 MCP 스펙을 구현했습니다. 이를 위해 전용 MCP 서버와 클라이언트를 직접 설계하고 개발했으며, 기존에 존재하는 MCP 서버들을 우리의 Streamable HTTP 방식과 호환되도록 리팩토링했습니다. 추가로, analyze_log_groups_insights 등 필요한 MCP 도구를 직접 설계하고 구현하였고, 기존의 MCP 도구 중 fetch_cloudwatch_logs_for_service()의 치명적인 결함을 발견 후 수정하였으며, 원작자의 Github Repo에 해당 내용을 반영한 Pull Request를 생성했습니다.

### Lambda 기반 서버리스 백엔드 아키텍처
전체 백엔드 시스템을 AWS Lambda 함수 기반으로 구현하여 서버리스 아키텍처의 장점을 극대화했습니다. 각 마이크로서비스를 독립적인 Lambda 함수로 분리하여 개발, 배포, 확장이 용이하도록 설계했습니다. LLM Service, Database Service, Chat History Service, Slackbot Service를 각각 별도의 Lambda 함수로 구현하고, API Gateway를 통해 통합된 RESTful API로 제공합니다. Lambda의 이벤트 기반 실행 모델을 활용하여 요청이 있을 때만 실행되므로 비용 효율성을 확보했으며, AWS의 관리형 서비스와의 네이티브 통합을 통해 운영 부담을 최소화했습니다. Lambda Layer로 공통 라이브러리와 종속성을 관리하며, 함수별 메모리와 타임아웃은 역할에 따라 다르게 설정했습니다(예: MCP 서버 2048MB/180초, Slack 봇 256MB/15초).

### 세션 기반 컨텍스트 유지 시스템
이전 대화 내용을 활용한 연속적인 질의응답을 위해 DynamoDB 기반의 세션 관리 시스템을 구현했습니다. 각 사용자의 대화 히스토리를 Messages 배열 형태로 저장하고, 새로운 질의 시 이전 대화와 함께 AI 모델에 전달합니다. MCP 세션 테이블(`wga-mcp-sessions-{env}`)은 `expires_at` TTL로 오래된 세션을 자동 삭제합니다. MCP 클라이언트의 `process_user_input_with_history` 메서드로 히스토리가 있는 요청과 단일 요청을 구분해 처리합니다.

### API Gateway 통합 및 라우팅 시스템
모든 Lambda 함수들을 통합하는 단일 API Gateway를 구현하여 RESTful API 엔드포인트를 제공합니다. AWS_PROXY 통합 방식을 채택하여 Lambda 함수에서 HTTP 요청과 응답을 직접 처리할 수 있도록 했으며, 각 서비스별로 리소스를 분리하여 명확한 API 구조를 구성했습니다(/llm1, /llm2, /sessions, /execute-query, /create-table, /login, /callback, /models, /req 등). OPTIONS 메서드로 브라우저의 CORS preflight 요청을 처리합니다. 환경별 스테이지(dev/test/prod)로 독립적인 API 엔드포인트를 관리하며, API 리소스와 메서드는 CloudFormation으로 정의하고 main 스택의 Deployment로 한 번에 배포합니다. Slack 봇은 웹과 별도로 OAuth 로그인(`/login`, `/callback`)과 슬래시 커맨드(`/models`) 경로를 제공합니다.

### 배포 자동화 스크립트
CloudFormation 기반 IaC와 `deploy.sh` 스크립트로 전체 시스템 배포를 자동화했습니다. 스크립트 하나로 템플릿 업로드, 스택 생성·업데이트, Lambda 패키징, MCP 이미지 빌드, 프론트엔드 빌드·배포까지 수행하며, 환경(dev/test/prod)별로 스택을 분리합니다. MCP 서버는 Docker 이미지로 만들어 CodeBuild로 빌드한 뒤 ECR에 저장하고, Lambda Container Image로 배포합니다. 스택 간 의존 관계에 맞춰 배포 순서를 스크립트에서 제어하며(위 [스택 구성](#cloudformation-스택-구성) 참고), 개별 스택 배포가 실패하면 CloudFormation 기본 롤백이 적용됩니다.

## 기여 가이드

### 개발 환경 설정
```bash
# 프론트엔드 개발 서버
cd frontend && npm install && npm run dev

# 백엔드 테스트·정적 분석 (Python 3.12)
pip install -r requirements-dev.txt
ruff check .
pytest
```

### 테스트
`tests/`의 단위 테스트는 [moto](https://github.com/getmoto/moto)로 DynamoDB, CloudWatch Logs, CloudWatch를 모킹해 AWS 계정 없이 실행됩니다.

| 파일 | 검증 내용 |
|---|---|
| `test_chat_history.py` | 토큰 `sub` 기반 사용자 식별, 다른 사용자의 세션 조회·수정·삭제 차단 |
| `test_llm_service.py` | 웹 요청의 Slack 전용 필드 제거, 세션 히스토리 소유자 확인, CORS 허용 목록 |
| `test_mcp_client.py` | MCP Function URL 호출 시 SigV4 서명 |
| `test_slack_security.py` | Slack 요청 서명(위조·변조·재전송), Cognito ID 토큰(aud·iss·만료·서명) 검증 |
| `test_mcp_tools.py` | MCP 도구(로그 조회, 대시보드 조회)와 세션 저장소 동작 |

### CI (`.github/workflows/ci.yml`)
PR과 `main` 푸시마다 세 작업이 병렬로 실행됩니다. AWS 자격 증명은 사용하지 않습니다.

| 작업 | 내용 |
|---|---|
| Python | `ruff`(문법 오류·정의되지 않은 이름), `pytest` |
| IaC | `cfn-lint`(오류 시 실패), `checkov` 보안 스캔, `deploy.sh` 문법 검사 |
| 프론트엔드 | `vue-tsc` 타입 검사, `vite build` |

`checkov`는 도입 시점의 기존 결과를 `cloudformation/.checkov.baseline`에 기준선으로 저장하고, **새로 생기는 보안 문제만** 실패로 처리합니다. 기준선의 항목은 하나씩 해결하면서 기준선을 다시 만듭니다.

### 배포 파이프라인 (`.github/workflows/deploy.yml`)
`main`에 머지되면 dev에 자동 배포하고, prod는 GitHub Environment 승인 후 배포합니다. AWS 인증은 GitHub OIDC로 받은 단기 자격 증명만 사용하며 Access Key를 저장하지 않습니다.

```
main 머지 ──▶ dev 배포 (OIDC Role: wga-github-deploy-dev) ──▶ 승인 대기 ──▶ prod 배포 (wga-github-deploy-prod)
```

**처음 한 번 설정** (저장소 변수를 등록하기 전에는 배포 작업이 실행되지 않습니다)
1. 환경별로 OIDC Role 스택을 관리자 권한으로 배포합니다. 계정에 GitHub OIDC 공급자가 이미 있으면 `ExistingOidcProviderArn`에 그 ARN을 넘깁니다.
   ```bash
   aws cloudformation deploy --stack-name wga-github-oidc-dev \
     --template-file cloudformation/github-oidc.yaml \
     --parameter-overrides Environment=dev \
     --capabilities CAPABILITY_NAMED_IAM
   ```
2. GitHub 저장소 Settings → Environments에서 `dev`, `prod`를 만들고 다음을 설정합니다.
   - **두 Environment 모두** Deployment branches and tags를 `main`만 허용하도록 제한합니다.
     수동 실행(`workflow_dispatch`)은 브랜치를 고를 수 있어서, 제한하지 않으면 리뷰받지 않은 브랜치의 코드도 `environment:dev`로 실행되어 OIDC 신뢰 정책을 통과합니다. Environment 보호 규칙은 워크플로 파일 내용과 관계없이 GitHub가 강제하므로, `main`이 아닌 브랜치에서는 배포 작업이 시작되지 않고 OIDC 토큰도 발급되지 않습니다.
   - `prod`에는 Required reviewers를 지정합니다.
3. Settings → Variables → Actions에 스택 출력값 `DeployRoleArn`을 등록합니다.

| 변수 | 값 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN_DEV` | dev OIDC 스택의 `DeployRoleArn` |
| `AWS_DEPLOY_ROLE_ARN_PROD` | prod OIDC 스택의 `DeployRoleArn` |
| `AWS_REGION` | 배포 리전 (선택, 기본 `ap-northeast-2` 서울) |
| `ALARM_EMAIL` | CloudWatch 알람 수신 이메일 (선택) |

**배포 Role 권한 범위**: `PowerUserAccess`(IAM 제외 전 서비스) + `wga-*` Role에 한정한 IAM 관리 권한입니다. 관리형 정책은 템플릿에서 쓰는 목록만 연결할 수 있고, 배포 Role 자신은 수정할 수 없습니다. Role 신뢰 정책은 이 저장소의 해당 GitHub Environment에서 실행된 작업만 허용하고(`sub` 조건), Environment의 브랜치 제한과 승인 규칙이 그 작업을 실행할 수 있는 코드와 사람을 제한합니다.

## FAQ

### Q: 어떤 AWS 서비스를 지원하나요?
A: 현재 CloudWatch, CloudTrail, GuardDuty, Cost Explorer, EC2, Lambda 등을 지원하며, 지속적으로 확장 중입니다.

### Q: 비용은 얼마나 발생하나요?
A: 서버리스 구성이라 고정 비용은 낮고, 대부분 LLM 호출(토큰) 사용량에 따라 달라집니다. 실측 비용은 측정 후 추가할 예정입니다.

### Q: 온프레미스에서도 사용할 수 있나요?
A: 현재는 AWS 클라우드 전용입니다.

### Q: 다른 AI 모델을 사용할 수 있나요?
A: 네, Anthropic이 제공하는 다양한 모델을 지원하며, 설정에서 변경 가능합니다.

## 지원 및 문의

- **GitHub Issues**: [프로젝트 이슈 페이지](https://github.com/WeGoAWS/WGA_production/issues)
