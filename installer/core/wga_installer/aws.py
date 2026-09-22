"""여러 단계가 함께 쓰는 AWS 조회 도우미와 WGA 리소스 이름

리소스 이름은 deploy.sh와 cloudformation/*.yaml이 정한 것을 그대로 옮겨 적는다.
이름이 어긋나면 설치 마법사가 엉뚱한 리소스를 확인하게 되므로,
tests/installer/test_installer_aws.py가 deploy.sh·템플릿과 비교해 확인한다.

여기 있는 함수는 모두 읽기 전용이다 (Runner.run만 쓴다).
"""
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .runner import CommandResult, Runner

# ---- API Gateway 통합 타임아웃 할당량 ----
QUOTA_SERVICE = "apigateway"
# 할당량 코드(L-로 시작)는 문서화된 고정값이 아니어서 이름으로 찾는다
QUOTA_NAME = "Maximum integration timeout in milliseconds"
# cloudformation/llm.yaml의 TimeoutInMillis와 같아야 한다. 할당량이 이보다 작으면
# API Gateway가 이 타임아웃 값을 받아들이지 않아 스택 생성·업데이트가 실패한다.
REQUIRED_TIMEOUT_MS = 180000
# 아직 처리 중인 할당량 요청 상태 (이 상태면 새로 요청하지 않고 기다린다)
QUOTA_PENDING_STATUSES = ("PENDING", "CASE_OPENED")
QUOTA_REJECTED_STATUSES = ("DENIED", "NOT_APPROVED", "INVALID_REQUEST")


@dataclass(frozen=True)
class SecretParam:
    """SSM에 SecureString으로 저장하는 비밀 값 하나."""
    key: str                 # /wga/<env>/ 뒤의 이름
    title: str               # 화면에 보일 이름
    required: bool           # False면 비워 두어도 된다 (등록하지 않고 건너뜀)


SECRET_PARAMS = (
    SecretParam("ANTHROPIC_API_KEY", "Anthropic API 키", required=True),
    # Slack 값은 Slack 봇을 쓸 때만 필요하다. 없으면 Slack 요청이 서명 검증에서 모두 거부된다
    SecretParam("SlackbotToken", "Slack 봇 토큰 (xoxb-...)", required=False),
    SecretParam("SlackSigningSecret", "Slack Signing Secret", required=False),
)


def main_stacks(env: str) -> list[str]:
    """deploy.sh가 만드는 최상위 스택. deploy.sh의 배포 순서와 같다."""
    return [f"wga-base-{env}", f"wga-frontend-{env}", f"wga-mcp-{env}", f"wga-{env}"]


# 로그 그룹 /aws/lambda/<이름>-<env>를 가진 Lambda 함수들 (cloudformation의 FunctionName)
LAMBDA_FUNCTIONS = ("wga-mcp", "wga-llm", "wga-slackbot", "wga-chat-history", "wga-athena-utility")


def dashboard_name(env: str) -> str:
    return f"wga-{env}-service"   # cloudformation/monitoring.yaml의 DashboardName


# ---- 공통 호출 ----

def aws_json(runner: Runner, *args: str, timeout: float = 60) -> tuple[Any, CommandResult]:
    """`aws <args> --output json`을 실행해 (해석한 JSON, 실행 결과)를 돌려준다.
    실패하거나 JSON이 아니면 첫 번째 값이 None이다 (원인은 두 번째 값의 stderr로 안내한다)."""
    result = runner.run(["aws", *args, "--output", "json"], timeout=timeout)
    if not result.ok:
        return None, result
    try:
        return json.loads(result.stdout or "null"), result
    except json.JSONDecodeError:
        return None, result


def error_text(result: CommandResult) -> str:
    """실패한 명령의 오류를 한 줄로 (보통 stderr의 마지막 줄에 원인이 있다)."""
    lines = [line for line in (result.stderr or result.stdout).strip().splitlines() if line.strip()]
    return lines[-1].strip() if lines else f"종료 코드 {result.returncode}"


def is_not_found(result: CommandResult) -> bool:
    """리소스가 없어서 실패했는지 (없는 것은 오류가 아니라 '아직 안 만들어짐'으로 다루는 경우가 많다)."""
    text = result.stderr + result.stdout
    return any(marker in text for marker in (
        "ResourceNotFound", "does not exist", "ParameterNotFound", "NotFoundException"))


def parse_time(value: Any) -> datetime | None:
    """AWS CLI가 출력하는 ISO 8601 시각 (예: 2026-09-22T12:30:04.123000+00:00)."""
    if not isinstance(value, str):
        return None
    try:
        # Python 3.10의 fromisoformat은 끝의 'Z'를 모른다
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# ---- 할당량 ----

@dataclass(frozen=True)
class Quota:
    code: str
    value: float
    adjustable: bool


def find_timeout_quota(runner: Runner) -> tuple[Quota | None, str | None]:
    """(할당량, 오류). 계정에 적용된 값 목록에서 먼저 찾고, 없으면 AWS 기본값 목록에서 찾는다.
    (조정한 적 없는 할당량은 적용 값 목록에 없을 수 있다)"""
    for command in ("list-service-quotas", "list-aws-default-service-quotas"):
        data, result = aws_json(runner, "service-quotas", command, "--service-code", QUOTA_SERVICE)
        if data is None:
            return None, error_text(result)
        for quota in data.get("Quotas", []):
            if quota.get("QuotaName") == QUOTA_NAME:
                return Quota(quota["QuotaCode"], float(quota.get("Value", 0)),
                             bool(quota.get("Adjustable", False))), None
    return None, f"'{QUOTA_NAME}' 할당량을 찾지 못했습니다"


def quota_requests(runner: Runner, code: str) -> tuple[list[dict] | None, str | None]:
    """이 할당량에 대한 증가 요청 기록 (최근 것부터)."""
    data, result = aws_json(runner, "service-quotas", "list-requested-service-quota-change-history-by-quota",
                            "--service-code", QUOTA_SERVICE, "--quota-code", code)
    if data is None:
        return None, error_text(result)

    def created(request: dict) -> float:
        # 시각을 해석하지 못한 요청은 가장 오래된 것으로 본다
        moment = parse_time(request.get("Created"))
        return moment.timestamp() if moment else 0.0

    return sorted(data.get("RequestedQuotas", []), key=created, reverse=True), None


# ---- SSM 파라미터 ----

def existing_parameters(runner: Runner, names: list[str]) -> tuple[dict[str, str] | None, str | None]:
    """({이름: 형식(String|SecureString...)}, 오류). 이름만 확인하고 값은 읽지 않는다.

    get-parameter 대신 describe-parameters를 쓰는 이유: get-parameter는 복호화하지 않아도
    값(암호문)을 함께 돌려준다. describe-parameters는 이름·형식 같은 메타데이터만 돌려준다.
    """
    data, result = aws_json(runner, "ssm", "describe-parameters", "--parameter-filters",
                            f"Key=Name,Option=Equals,Values={','.join(names)}")
    if data is None:
        return None, error_text(result)
    return {p["Name"]: p.get("Type", "") for p in data.get("Parameters", [])}, None
