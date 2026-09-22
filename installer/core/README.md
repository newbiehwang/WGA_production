# WGA 설치 마법사 — 단계 엔진 (`wga_installer`)

macOS 설치 마법사 앱이 실행하는 명령줄 도구입니다. 터미널에서 단독으로 써도 됩니다.
Python 표준 라이브러리만 쓰므로 `pip install`이 필요 없습니다 (Python 3.10 이상).

```bash
installer/core/wga-installer check                     # 사전 점검 (터미널용 출력)
installer/core/wga-installer check --json              # 앱용 JSON Lines 출력
installer/core/wga-installer check --profile wga-dev   # 기존 AWS CLI 프로필 사용
installer/core/wga-installer setup                     # 할당량 요청, SSM 비밀 값 등록
installer/core/wga-installer deploy --alarm-email me@example.com
installer/core/wga-installer verify                    # 배포 검증
```

| 명령 | 하는 일 | 바꾸는 것 |
|---|---|---|
| `check` | 도구·저장소·자격 증명·리전 점검 | 없음 |
| `setup` | ① API Gateway 통합 타임아웃 할당량을 120000ms로 요청(자동 승인되는 최댓값) ② `/wga/<env>/ANTHROPIC_API_KEY`·`SlackbotToken`·`SlackSigningSecret`을 SecureString으로 등록 | 할당량 요청, SSM 파라미터 |
| `deploy` | 사전 확인(필수 SSM 값, 할당량) 후 `./deploy.sh <env>` 실행, 진행 표시, 실패 원인 요약 | AWS 리소스 전체 |
| `verify` | 스택 상태, 인증 없는 API 호출 차단, `/health`, AccessDenied 로그, 프론트엔드, 대시보드 | 없음 |

`oidc`·`teardown`은 다음 마일스톤에서 추가합니다.

### 알아 둘 동작
- **할당량이 먼저입니다.** `cloudformation/llm.yaml`이 통합 타임아웃을 120000ms로 설정하므로 할당량이 오르기 전에는 스택 생성이 실패합니다. `deploy`는 할당량이 부족하면 배포를 시작하지 않고 멈춥니다.
- **Slack 값은 비워 둘 수 있습니다.** 비워 두면 등록하지 않고 건너뜁니다. Signing Secret이 없으면 Slack 요청은 모두 거부됩니다.
- **이미 있는 SSM 값은 읽지 않습니다.** 이름과 형식만 확인하고(`describe-parameters`), 유지할지 덮어쓸지 묻습니다. 기본은 유지입니다.
- **취소:** `deploy` 도중 Ctrl+C(또는 앱이 SIGINT·SIGTERM을 보냄)를 하면 deploy.sh와 그 자식 프로세스 전체에 중단 신호를 보내고, 최대 60초 기다린 뒤 강제 종료합니다. 스택이 업데이트 도중 상태로 남을 수 있습니다.

## 실행기와 Python 선택

`wga-installer`는 알맞은 Python을 골라 `python -m wga_installer`를 실행하는 bash 스크립트입니다.
macOS 기본 `/usr/bin/python3`는 3.9라서 설치 마법사를 실행할 수 없고, Command Line Tools가 없으면
실행하는 순간 설치 창이 뜨기 때문에 찾는 순서를 이 스크립트 한곳에 정해 두었습니다. 앱도 이 스크립트로 CLI를 실행합니다.

1. `WGA_PYTHON` 환경 변수 (직접 지정. 3.10 미만이면 다른 후보로 넘어가지 않고 오류)
2. `/opt/homebrew/bin/python3` (Apple Silicon Homebrew)
3. `/usr/local/bin/python3` (Intel Homebrew, python.org 설치본)
4. `PATH`의 `python3`
5. `/usr/bin/python3` (macOS에서는 Command Line Tools가 있을 때만)

쓸 수 있는 Python이 없거나 `python -m wga_installer`를 3.10 미만으로 직접 실행하면, 설치 방법을 담은 오류를 출력하고 종료 코드 3으로 끝납니다.

## 공통 옵션

| 옵션 | 설명 |
|---|---|
| `--json` | 이벤트를 JSON Lines로 출력 (앱용) |
| `--dry-run` | 상태 확인만 하고, 변경 명령은 보여 주기만 함 |
| `--yes` | 변경 작업을 묻지 않고 승인 (되돌릴 수 없는 삭제에는 적용되지 않음) |
| `--env dev\|test\|prod` | 배포 환경 (기본 `dev`) |
| `--region` | AWS 리전. 없으면 `AWS_REGION` → CLI 프로필의 region → `ap-northeast-2` (deploy.sh와 같은 순서) |
| `--profile` | AWS CLI 프로필. 지정하면 환경 변수의 `AWS_ACCESS_KEY_ID` 등은 자식 명령에 넘기지 않음 |
| `--repo` | 저장소 경로. 없으면 현재 폴더부터 상위로 `deploy.sh`와 `cloudformation/`을 찾음 |
| `--alarm-email` | (`deploy`만) CloudWatch 알람을 받을 이메일. 구독 확인 메일의 링크를 눌러야 알람이 옵니다 |

## 앱과 주고받는 형식

**CLI → 앱 (stdout, 한 줄에 JSON 하나)**

```json
{"type": "step_started", "step": "check", "title": "사전 점검"}
{"type": "check", "id": "aws_cli", "title": "AWS CLI", "status": "ok", "detail": "2.17.0"}
{"type": "check", "id": "node", "title": "Node.js", "status": "fail", "detail": "16.20.2 (필요: 18.0.0 이상)", "hint": "brew upgrade node"}
{"type": "confirm_required", "id": "put_ssm", "command": "aws ssm put-parameter ...", "reason": "SSM에 값을 저장합니다"}
{"type": "input_required", "id": "secret_ANTHROPIC_API_KEY", "prompt": "Anthropic API 키", "secret": true}
{"type": "choice_required", "id": "existing_SlackbotToken", "prompt": "/wga/dev/SlackbotToken이(가) 이미 있습니다", "options": [{"id": "keep", "label": "기존 값 유지"}, {"id": "overwrite", "label": "새 값으로 덮어쓰기"}], "default": "keep"}
{"type": "progress", "step": "deploy", "phase": "3/6", "label": "Layer 및 Lambda 함수 패키징"}
{"type": "dry_run", "id": "put_ssm", "command": "aws ssm put-parameter ...", "reason": "SSM에 값을 저장합니다"}
{"type": "log", "stream": "stdout", "line": "..."}
{"type": "step_finished", "step": "check", "status": "ok", "summary": "통과 14개 · 주의 1개 · 실패 0개"}
{"type": "error", "step": "check", "message": "...", "hint": "..."}
```

- `check.status`: `ok` 통과 / `warn` 진행 가능하지만 확인 필요 / `fail` 진행 불가 / `info` 정보
- `check.url`: 있으면 앱이 "열기" 버튼을 붙일 주소 (프론트엔드, CloudWatch 대시보드 등)
- `progress.phase`: deploy.sh의 번호 단계 `N/6`. 번호 없는 구분 줄(예: Layer 패키징)은 직전 번호를 유지하고 `label`만 바뀝니다
- `step_finished.status`: `ok` / `skipped`(이미 되어 있음) / `failed`
- `log.stream`: `stdout`·`stderr`(실행한 명령의 출력) / `info`(설치 마법사의 안내)
- 사용자가 입력한 비밀 값은 어떤 이벤트에도 그대로 나오지 않고 `***`로 가려집니다.

**앱 → CLI (stdin, 한 줄에 JSON 하나)**

```json
{"type": "confirm_response", "id": "put_ssm", "approved": true}
{"type": "secret_response", "id": "secret_ANTHROPIC_API_KEY", "value": "..."}
{"type": "choice_response", "id": "existing_SlackbotToken", "choice": "keep"}
```

응답이 없거나(stdin 닫힘) 형식이 틀리거나 `id`가 다르거나 `approved`가 정확히 `true`가 아니면 **거절**로 처리합니다.
선택(`choice_response`)은 응답이 없거나 선택지에 없는 값이면 `default`를 씁니다. 기본값은 항상 아무것도 바꾸지 않는 쪽입니다.

## 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 성공 |
| 1 | 단계 실패 (자세한 내용은 `check`·`error` 이벤트) |
| 2 | 명령줄 사용법 오류 |
| 3 | 쓸 수 있는 Python(3.10 이상)이 없음 |
| 130 | Ctrl+C로 중단 |

## 테스트

AWS·GitHub 없이 가짜 `aws`·`gh` 등으로 테스트합니다 (`tests/installer/`).

```bash
pytest tests/installer
```
