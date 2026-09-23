"""check: 사전 점검. 아무것도 바꾸지 않는다 (읽기 전용 명령만 실행하므로 --dry-run과 결과가 같다).

점검 항목은 계획서 4.1절을 따른다. 항목마다 `check` 이벤트를 하나씩 바로 내보내므로
읽는 쪽은 점검이 끝나기 전부터 목록을 채워 나갈 수 있다.

상태 판단 기준
- fail: 이 상태로는 배포할 수 없다 (필수 도구 없음, 자격 증명 없음, 저장소 없음 등). 종료 코드 1.
- warn: 배포는 가능하지만 확인이 필요하다 (루트 계정, gh 없음 — gh는 oidc 단계에서만 쓴다).
- info: 판단 없이 알려 준다 (리전, 무료 플랜 제약).
- ok:   통과.

항목 사이의 의존: AWS CLI가 없으면 자격 증명 확인을 건너뛰고(fail로 보고), 자격 증명이
실패하면 루트 계정 여부는 판단하지 않는다. 앞의 결과는 `results` 딕셔너리로 넘겨 본다.
"""
import json
import os
import re
import sys
from dataclasses import dataclass

from ..context import REGION_PATTERN, REGION_SOURCES, Context
from ..events import (CHECK_FAIL, CHECK_INFO, CHECK_OK, CHECK_WARN, STEP_FAILED, STEP_OK,
                      Emitter)
from ..runner import RC_NOT_EXECUTABLE, RC_NOT_FOUND, RC_TIMEOUT, Runner

STEP = "check"
TOOL_TIMEOUT = 30      # `--version` 같은 로컬 명령의 제한 시간(초)
AWS_TIMEOUT = 30       # STS 호출의 제한 시간(초). 네트워크 문제로 멈추면 이 시간 뒤 실패로 보고한다


@dataclass(frozen=True)
class Tool:
    """버전을 확인할 외부 도구 하나."""
    id: str                               # check 이벤트 id
    title: str                            # 화면에 보일 이름
    command: tuple[str, ...]              # 버전을 출력하는 명령
    pattern: str | None = None            # 출력에서 버전 숫자를 뽑는 정규식 (그룹 하나당 숫자 하나)
    minimum: tuple[int, ...] | None = None
    formula: str | None = None            # Homebrew 패키지 이름 (설치 안내용)
    required: bool = True                 # False면 없어도 warn (필요한 단계에서만 막는다)
    note: str | None = None               # 없거나 오래됐을 때 덧붙일 설명


TOOLS = (
    # 이후 단계의 명령·출력 해석을 v2 기준으로 맞추므로 v1은 통과시키지 않는다
    Tool("aws_cli", "AWS CLI", ("aws", "--version"), r"aws-cli/(\d+)\.(\d+)\.(\d+)", (2, 0, 0), "awscli",
         note="v1이 설치되어 있다면 먼저 제거하세요 (pip uninstall awscli)"),
    Tool("gh_cli", "GitHub CLI", ("gh", "--version"), r"gh version (\d+)\.(\d+)\.(\d+)", None, "gh",
         required=False, note="GitHub 자동 배포(oidc) 단계에만 필요합니다"),
    Tool("git", "git", ("git", "--version"), r"git version (\d+)\.(\d+)\.(\d+)", None, "git"),
    # 프론트엔드 빌드(vite)가 Node 18 이상을 요구한다
    Tool("node", "Node.js", ("node", "--version"), r"v(\d+)\.(\d+)\.(\d+)", (18, 0, 0), "node"),
    Tool("npm", "npm", ("npm", "--version"), r"(\d+)\.(\d+)\.(\d+)", None, "node"),
    # deploy.sh가 Lambda 패키지를 zip으로 묶고 unzip으로 내용을 확인한다 (버전은 따지지 않는다)
    Tool("zip", "zip", ("zip", "-v"), r"Zip (\d+)\.(\d+)", None, "zip"),
    Tool("unzip", "unzip", ("unzip", "-v"), r"UnZip (\d+)\.(\d+)", None, "unzip"),
)

# deploy.sh가 Lambda Layer 의존성을 설치할 때 pip를 찾는 순서와 같다 (deploy.sh의 PIP_CMD 결정 부분)
PIP_COMMANDS = (("pip", "--version"), ("pip3", "--version"), ("python3", "-m", "pip", "--version"))


@dataclass(frozen=True)
class CheckResult:
    status: str
    detail: str


def run(ctx: Context, runner: Runner, emitter: Emitter) -> int:
    emitter.step_started(STEP, "사전 점검")
    results: dict[str, CheckResult] = {}

    def report(id_: str, title: str, status: str, detail: str, hint: str | None = None) -> None:
        results[id_] = CheckResult(status, detail)
        emitter.check(id_, title, status, detail, hint)

    _check_system(runner, report)
    for tool in TOOLS:
        _check_tool(runner, tool, report)
    _check_pip(runner, report)
    _check_python(report)
    _check_homebrew(runner, report)
    _check_repo(ctx, runner, report)
    _check_aws_identity(ctx, runner, results, report)
    _check_region(ctx, report)
    report("free_plan", "무료 플랜 제약", CHECK_INFO,
           "무료 플랜 계정은 IAM Identity Center·Organizations·GuardDuty를 쓸 수 없고, "
           "Organizations에 가입하면 유료 플랜으로 바뀝니다. WGA 배포에는 이 서비스들이 필요하지 않습니다")
    _check_github_auth(runner, results, report)

    counts = {status: sum(1 for r in results.values() if r.status == status)
              for status in (CHECK_OK, CHECK_WARN, CHECK_FAIL)}
    summary = f"통과 {counts[CHECK_OK]}개 · 주의 {counts[CHECK_WARN]}개 · 실패 {counts[CHECK_FAIL]}개"
    if counts[CHECK_FAIL]:
        emitter.step_finished(STEP, STEP_FAILED, summary + " — 실패 항목을 해결한 뒤 다시 점검하세요")
        return 1
    emitter.step_finished(STEP, STEP_OK, summary)
    return 0


def _first_line(text: str) -> str:
    return text.strip().splitlines()[0] if text.strip() else "(출력 없음)"


def _version_text(version: tuple[int, ...]) -> str:
    return ".".join(str(part) for part in version)


def _check_system(runner: Runner, report) -> None:
    """운영체제와 CPU. 어떤 OS에서도 동작하므로 막지 않고 무엇으로 실행 중인지만 알린다
    (문제가 생겼을 때 어떤 환경이었는지 알 수 있게 남긴다)."""
    system = runner.run(["uname", "-s"], timeout=TOOL_TIMEOUT)
    machine = runner.run(["uname", "-m"], timeout=TOOL_TIMEOUT)
    if not system.ok:
        report("system", "운영체제", CHECK_WARN, "운영체제를 확인하지 못했습니다")
        return
    arch = machine.stdout.strip() if machine.ok else "알 수 없음"
    arch_label = {"arm64": "Apple Silicon", "x86_64": "Intel"}.get(arch, arch)
    if system.stdout.strip() != "Darwin":
        # macOS 밖에서도 쓸 수 있다. deploy.sh는 bash와 아래 도구들만 쓰고, 그 도구들은 따로 점검한다
        report("system", "운영체제", CHECK_INFO, f"{system.stdout.strip()} ({arch})")
        return
    version = runner.run(["sw_vers", "-productVersion"], timeout=TOOL_TIMEOUT)
    version_text = version.stdout.strip() if version.ok else "버전 알 수 없음"
    report("system", "운영체제", CHECK_OK, f"macOS {version_text} · {arch_label} ({arch})")


def _check_tool(runner: Runner, tool: Tool, report) -> None:
    missing_status = CHECK_FAIL if tool.required else CHECK_WARN
    install_hint = " ".join(part for part in (
        f"brew install {tool.formula}" if tool.formula else None, tool.note) if part)

    result = runner.run(list(tool.command), timeout=TOOL_TIMEOUT)
    if result.returncode in (RC_NOT_FOUND, RC_NOT_EXECUTABLE):
        report(tool.id, tool.title, missing_status, "설치되어 있지 않습니다", install_hint or None)
        return
    if not result.ok:
        report(tool.id, tool.title, missing_status,
               f"실행 중 오류 (종료 코드 {result.returncode}): {_first_line(result.output)}", install_hint or None)
        return
    if tool.pattern is None:
        report(tool.id, tool.title, CHECK_OK, _first_line(result.output))
        return

    match = re.search(tool.pattern, result.output)
    if not match:
        # 버전 형식이 바뀐 새 버전일 수 있으므로 막지 않고 주의만 준다
        report(tool.id, tool.title, CHECK_WARN, f"버전을 확인하지 못했습니다: {_first_line(result.output)}")
        return
    version = tuple(int(part) for part in match.groups())
    if tool.minimum and version < tool.minimum:
        upgrade = " ".join(part for part in (
            f"brew upgrade {tool.formula}" if tool.formula else None, tool.note) if part)
        report(tool.id, tool.title, missing_status,
               f"{_version_text(version)} (필요: {_version_text(tool.minimum)} 이상)", upgrade or None)
        return
    report(tool.id, tool.title, CHECK_OK, _version_text(version))


def _check_pip(runner: Runner, report) -> None:
    """deploy.sh가 Layer 의존성을 설치할 때 쓰는 pip. deploy.sh와 같은 순서로 찾는다."""
    for command in PIP_COMMANDS:
        result = runner.run(list(command), timeout=TOOL_TIMEOUT)
        if result.ok:
            match = re.search(r"pip (\S+)", result.output)
            version = match.group(1) if match else _first_line(result.output)
            report("pip", "pip (Lambda Layer 패키징)", CHECK_OK, f"{version} (`{' '.join(command[:-1])}` 사용)")
            return
    report("pip", "pip (Lambda Layer 패키징)", CHECK_FAIL, "pip·pip3·python3 -m pip 모두 찾지 못했습니다",
           "brew install python 또는 python3 -m ensurepip --upgrade")


def _check_python(report) -> None:
    """설치 마법사를 실행 중인 Python. 3.10 미만이면 wga_installer/__init__.py에서 이미 종료되었으므로
    여기까지 왔다면 통과다. 어떤 인터프리터가 선택됐는지 보여 주는 것이 목적이다
    (installer/core/wga-installer 실행기가 Homebrew Python을 먼저 고른다)."""
    version = ".".join(str(part) for part in sys.version_info[:3])
    report("python", "Python (설치 마법사 실행용)", CHECK_OK, f"{version} ({sys.executable})")


def _check_homebrew(runner: Runner, report) -> None:
    """위 안내들이 `brew install`을 권하므로 Homebrew가 있는지도 알려 준다. 없어도 배포와는 무관해 warn."""
    result = runner.run(["brew", "--version"], timeout=TOOL_TIMEOUT)
    if result.ok:
        report("homebrew", "Homebrew", CHECK_OK, _first_line(result.output))
    else:
        report("homebrew", "Homebrew", CHECK_WARN, "설치되어 있지 않습니다",
               "도구를 brew install로 설치하려면 https://brew.sh 의 설치 명령을 먼저 실행하세요")


def _check_repo(ctx: Context, runner: Runner, report) -> None:
    title = "WGA 저장소"
    if ctx.repo_root is None:
        if ctx.repo_requested is not None:
            detail = f"{ctx.repo_requested}에 deploy.sh와 cloudformation/ 폴더가 없습니다"
        else:
            detail = "현재 폴더와 상위 폴더에서 저장소를 찾지 못했습니다"
        report("repo", title, CHECK_FAIL, detail,
               "--repo <저장소 경로>로 지정하거나, 저장소를 git clone 한 폴더에서 실행하세요")
        return

    deploy_sh = ctx.repo_root / "deploy.sh"
    if not os.access(deploy_sh, os.X_OK):
        # deploy 단계는 `./deploy.sh <env>`로 실행하므로 실행 권한이 있어야 한다
        report("repo", title, CHECK_FAIL, f"{deploy_sh}에 실행 권한이 없습니다", f"chmod +x {deploy_sh}")
        return

    commit = runner.run(["git", "-C", str(ctx.repo_root), "rev-parse", "--short=12", "HEAD"],
                        timeout=TOOL_TIMEOUT)
    if not commit.ok:
        # deploy.sh는 git이 없으면 코드 버전을 시각(build-YYYYmmddHHMMSS)으로 붙이므로 배포는 된다
        report("repo", title, CHECK_WARN, f"{ctx.repo_root} (git 저장소가 아님)",
               "배포는 가능하지만 코드 버전이 커밋 대신 시각으로 기록됩니다")
        return
    report("repo", title, CHECK_OK, f"{ctx.repo_root} (커밋 {commit.stdout.strip()})")


# `aws sts get-caller-identity` 실패 메시지 → (설명, 해결 안내). 위에서부터 먼저 맞는 것을 쓴다
_AWS_ERRORS = (
    (("Unable to locate credentials", "NoCredentialProviders"),
     "자격 증명이 설정되어 있지 않습니다",
     "aws configure로 자격 증명을 설정하거나, --profile <이름>으로 기존 프로필을 지정하세요"),
    (("could not be found",),
     "지정한 AWS 프로필이 없습니다",
     "aws configure list-profiles로 프로필 이름을 확인하세요"),
    (("InvalidClientTokenId", "SignatureDoesNotMatch"),
     "Access Key가 올바르지 않거나 비활성화되었습니다",
     "IAM 콘솔에서 키 상태를 확인하고 다시 입력하세요"),
    (("ExpiredToken", "expired"),
     "자격 증명이 만료되었습니다",
     "새 자격 증명을 발급받거나 다시 로그인하세요"),
    (("Could not connect", "EndpointConnectionError", "timed out"),
     "AWS에 연결하지 못했습니다",
     "네트워크 연결과 리전 이름을 확인하세요"),
)


def _check_aws_identity(ctx: Context, runner: Runner, results: dict[str, CheckResult], report) -> None:
    """누구로 AWS에 접속하는지. 성공하면 계정 ID와 ARN을 Context에 저장해 이후 단계가 쓴다."""
    title = "AWS 자격 증명" + (f" (프로필 {ctx.aws_profile})" if ctx.aws_profile else "")
    if results["aws_cli"].status == CHECK_FAIL:
        report("aws_credentials", title, CHECK_FAIL, "AWS CLI v2가 없어 확인하지 못했습니다",
               "위의 AWS CLI 항목을 먼저 해결하세요")
        return

    result = runner.run(["aws", "sts", "get-caller-identity", "--output", "json"], timeout=AWS_TIMEOUT)
    if not result.ok:
        if result.returncode == RC_TIMEOUT:
            detail, hint = "AWS 응답이 없어 중단했습니다", "네트워크 연결을 확인하세요"
        else:
            detail, hint = _first_line(result.stderr or result.stdout), None
            for needles, known_detail, known_hint in _AWS_ERRORS:
                if any(needle in result.output for needle in needles):
                    detail, hint = known_detail, known_hint
                    break
        report("aws_credentials", title, CHECK_FAIL, detail, hint)
        return

    try:
        identity = json.loads(result.stdout)
        ctx.account_id, ctx.caller_arn = identity["Account"], identity["Arn"]
    except (json.JSONDecodeError, KeyError, TypeError):
        report("aws_credentials", title, CHECK_FAIL, "sts get-caller-identity 응답을 해석하지 못했습니다")
        return
    report("aws_credentials", title, CHECK_OK, f"계정 {ctx.account_id} · {ctx.caller_arn}")

    # 루트 사용자 ARN은 arn:aws:iam::<계정ID>:root 형식이다
    if ctx.caller_arn.endswith(":root"):
        report("root_account", "루트 계정 사용 여부", CHECK_WARN, "루트 사용자의 Access Key를 쓰고 있습니다",
               "루트 키는 모든 권한을 가져 유출되면 피해가 큽니다. IAM 사용자를 만들어 그 사용자의 "
               "Access Key를 쓰고, 루트 키는 삭제하세요")
    elif ":assumed-role/" in ctx.caller_arn:
        report("root_account", "루트 계정 사용 여부", CHECK_OK, "IAM 역할(임시 자격 증명)")
    else:
        report("root_account", "루트 계정 사용 여부", CHECK_OK, "IAM 사용자")


def _check_region(ctx: Context, report) -> None:
    source = REGION_SOURCES.get(ctx.region_source, ctx.region_source)
    if not REGION_PATTERN.match(ctx.region):
        report("region", "배포 리전", CHECK_FAIL, f"'{ctx.region}'은(는) 리전 이름 형식이 아닙니다 ({source})",
               "예: ap-northeast-2 (서울), us-west-2 (오레곤)")
        return
    report("region", "배포 리전", CHECK_INFO, f"{ctx.region} ({source})")


def _check_github_auth(runner: Runner, results: dict[str, CheckResult], report) -> None:
    """gh 로그인 상태. GitHub 자동 배포(oidc) 단계에만 필요하므로 실패해도 warn."""
    title = "GitHub 로그인"
    if results["gh_cli"].status != CHECK_OK:
        report("github_auth", title, CHECK_WARN, "GitHub CLI가 없어 확인하지 못했습니다",
               "GitHub 자동 배포 단계 전에 brew install gh 후 gh auth login")
        return
    result = runner.run(["gh", "auth", "status", "--hostname", "github.com"], timeout=AWS_TIMEOUT)
    if not result.ok:
        report("github_auth", title, CHECK_WARN, "로그인되어 있지 않습니다",
               "GitHub 자동 배포 단계 전에 gh auth login을 실행하세요")
        return
    # gh 버전에 따라 "Logged in to github.com account <이름>" 또는 "... as <이름>" 형식이다
    match = re.search(r"Logged in to \S+ (?:account|as) (\S+)", result.output)
    report("github_auth", title, CHECK_OK, f"{match.group(1)}(으)로 로그인됨" if match else "로그인됨")
