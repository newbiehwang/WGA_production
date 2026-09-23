"""teardown: 한 환경의 WGA 리소스를 모두 지운다 (계획서 4.6절). 되돌릴 수 없다.

안전장치
- prod는 --allow-prod 없이는 거부한다.
- 먼저 지울 대상을 모두 찾아 보여 주고(읽기 전용), 환경 이름을 직접 입력해야 진행한다.
- 단계마다 지울 명령 목록을 보여 주고 다시 승인받는다. --yes는 적용하지 않는다(allow_assume_yes=False).
- 한 단계가 실패하거나 거절되면 거기서 멈춘다. 다시 실행하면 남은 것만 찾아 이어서 지운다.

지우는 순서
    1. 저장소 변수 AWS_DEPLOY_ROLE_ARN_<ENV>  정리 도중 main push가 배포를 다시 시작하지 않도록 가장 먼저
    2. 스택  wga-<env> → wga-mcp-<env> → wga-frontend-<env> → wga-base-<env> → wga-github-oidc-<env>
       (MCP 스택이 ECR 이미지 때문에 삭제에 실패하면 ECR 저장소를 강제 삭제하고 한 번 더 시도)
    3. ECR 저장소 wga-mcp-<env> (스택 삭제 뒤에도 남아 있으면)
    4. S3 버킷  DeletionPolicy: Retain이라 스택을 지워도 남는다. 버전 관리가 켜져 있으므로
       모든 버전과 삭제 마커를 지운 뒤 버킷을 지운다.
    5. 로그 그룹 /aws/lambda/wga-*-<env>
    6. setup이 만든 SSM 파라미터 3개
    7. GitHub Environment <env>

여러 환경이 함께 쓰는 자원은 다른 환경이 남아 있으면 지우지 않는다.
- wga-cloudformation-<계정ID> 버킷: deploy.sh가 모든 환경의 템플릿을 여기에 올린다.
- GitHub OIDC 공급자: 계정에 하나뿐이다. 이 환경의 OIDC 스택이 공급자를 가지고 있고 다른 환경의 OIDC 스택이
  남아 있으면, 이 스택을 지우는 순간 다른 환경의 자동 배포가 끊기므로 OIDC 스택을 남긴다.
"""
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .. import github
from ..aws import (SECRET_PARAMS, aws_json, env_buckets, error_text, existing_parameters, main_stacks,
                   mcp_repository, oidc_stack, shared_bucket, stack_failures)
from ..context import ENVIRONMENTS, Context
from ..events import CHECK_INFO, CHECK_WARN, STEP_FAILED, STEP_OK, STEP_SKIPPED, Emitter, format_command
from ..runner import DECLINED, DRY_RUN, EXECUTED, Runner, secret_file
from .oidc import PROVIDER_LOGICAL_ID

STEP = "teardown"
STACK_DELETE_TIMEOUT = 65 * 60   # `aws cloudformation wait`는 최대 60분 기다린 뒤 실패한다. 그보다 조금 길게
DELETE_BATCH = 1000              # delete-objects 한 번에 지울 수 있는 최대 개수
MAX_EMPTY_ROUNDS = 10000         # 버킷 비우기 반복 상한 (무한 반복 방지)
CLOCK_SKEW = timedelta(minutes=2)


@dataclass
class Plan:
    """지울 대상 (읽기 전용 조회 결과)."""
    account_id: str
    repo: str | None = None                 # GitHub 정리를 할 수 없으면 None
    role_variable: str | None = None        # 있으면 지울 저장소 변수 이름
    github_environment: bool = False
    stacks: list[str] = field(default_factory=list)
    ecr_repository: bool = False
    buckets: list[str] = field(default_factory=list)
    log_groups: list[str] = field(default_factory=list)
    parameters: list[str] = field(default_factory=list)

    def empty(self) -> bool:
        return not (self.role_variable or self.github_environment or self.stacks or self.ecr_repository
                    or self.buckets or self.log_groups or self.parameters)


def run(ctx: Context, runner: Runner, emitter: Emitter) -> int:
    emitter.step_started(STEP, f"WGA 정리 ({ctx.env}, {ctx.region}) — 되돌릴 수 없습니다")
    if ctx.env == "prod" and not ctx.allow_prod:
        emitter.error(STEP, "prod 환경은 --allow-prod 없이 지울 수 없습니다",
                      hint="정말 지우려면 --env prod --allow-prod로 다시 실행하세요")
        emitter.step_finished(STEP, STEP_FAILED, "prod는 지우지 않았습니다")
        return 1

    plan = _inventory(ctx, runner, emitter)
    if plan is None:
        emitter.step_finished(STEP, STEP_FAILED, "지울 대상을 확인하지 못해 아무것도 지우지 않았습니다")
        return 1
    if plan.empty():
        emitter.step_finished(STEP, STEP_OK, f"{ctx.env} 환경에 지울 것이 없습니다")
        return 0

    if not runner.dry_run:
        typed = runner.interaction.text("confirm_env", f"되돌릴 수 없습니다. 삭제하려면 환경 이름 '{ctx.env}'을(를) 입력하세요")
        if typed != ctx.env:
            emitter.error(STEP, "환경 이름이 일치하지 않아 아무것도 지우지 않았습니다")
            emitter.step_finished(STEP, STEP_SKIPPED, "취소했습니다 (아무것도 지우지 않음)")
            return 1

    for name, action in (("GitHub 저장소 변수", _delete_role_variable), ("CloudFormation 스택", _delete_stacks),
                         ("ECR 저장소", _delete_leftover_repository), ("S3 버킷", _delete_buckets),
                         ("로그 그룹", _delete_log_groups), ("SSM 파라미터", _delete_parameters),
                         ("GitHub Environment", _delete_github_environment)):
        outcome = action(ctx, runner, emitter, plan)
        if outcome == "failed":
            emitter.step_finished(STEP, STEP_FAILED, f"{name} 단계에서 멈췄습니다. 원인을 해결하고 다시 실행하면 남은 것만 지웁니다")
            return 1
        if outcome == "declined":
            emitter.step_finished(STEP, STEP_SKIPPED, f"{name} 단계에서 중단했습니다 (앞 단계까지만 지움)")
            return 1

    emitter.step_finished(STEP, STEP_OK, "정리 확인 끝 (지운 것 없음)" if runner.dry_run
                          else f"{ctx.env} 환경의 WGA 리소스를 모두 지웠습니다")
    return 0


# ---------------------------------------------------------------- 대상 찾기 (읽기 전용)

def _inventory(ctx: Context, runner: Runner, emitter: Emitter) -> Plan | None:
    identity, result = aws_json(runner, "sts", "get-caller-identity")
    if not identity:
        emitter.error(STEP, "AWS 계정을 확인하지 못했습니다", raw=error_text(result))
        return None
    plan = Plan(account_id=identity["Account"])

    data, result = aws_json(runner, "cloudformation", "describe-stacks")
    if data is None:
        emitter.error(STEP, "스택 목록을 조회하지 못했습니다", raw=error_text(result))
        return None
    existing = {s["StackName"] for s in data.get("Stacks", [])}
    others = [e for e in ENVIRONMENTS if e != ctx.env]
    other_main = sorted(s for e in others for s in main_stacks(e) if s in existing)
    other_oidc = sorted(oidc_stack(e) for e in others if oidc_stack(e) in existing)

    # 스택 (지우는 순서: deploy.sh 배포 순서의 반대, 마지막에 OIDC)
    plan.stacks = [s for s in reversed(main_stacks(ctx.env)) if s in existing]
    own_oidc = oidc_stack(ctx.env)
    if own_oidc in existing:
        if other_oidc and _owns_provider(runner, own_oidc):
            _report(emitter, "target_oidc", "OIDC 스택", CHECK_WARN, f"{own_oidc}을(를) 남깁니다",
                    f"이 스택이 계정의 GitHub OIDC 공급자를 가지고 있고 {', '.join(other_oidc)}이(가) 그것을 씁니다. "
                    "다른 환경을 먼저 정리한 뒤 다시 실행하세요")
        else:
            plan.stacks.append(own_oidc)
    _report(emitter, "target_stacks", "CloudFormation 스택", CHECK_INFO,
            ", ".join(plan.stacks) if plan.stacks else "없음")

    # GitHub (Role 변수가 남으면 main push가 배포를 다시 시작하므로, OIDC 스택이 있었다면 반드시 정리해야 한다)
    _inventory_github(ctx, runner, emitter, plan, needed=own_oidc in existing)
    if plan.repo is None and own_oidc in existing:
        return None

    repo_name = mcp_repository(ctx.env)
    _, result = aws_json(runner, "ecr", "describe-repositories", "--repository-names", repo_name)
    plan.ecr_repository = result.ok
    if plan.ecr_repository:
        _report(emitter, "target_ecr", "ECR 저장소", CHECK_INFO, f"{repo_name} (이미지 포함)")

    candidates = env_buckets(plan.account_id, ctx.env)
    if other_main:
        _report(emitter, "target_shared_bucket", "공유 버킷", CHECK_INFO,
                f"{shared_bucket(plan.account_id)}은(는) 남깁니다 (다른 환경이 사용 중: {', '.join(other_main)})")
    else:
        candidates.append(shared_bucket(plan.account_id))
    for bucket in candidates:
        result = runner.run(["aws", "s3api", "head-bucket", "--bucket", bucket], timeout=60)
        if result.ok:
            plan.buckets.append(bucket)
        elif not any(marker in result.stderr for marker in ("404", "Not Found", "NoSuchBucket")):
            emitter.error(STEP, f"버킷 {bucket}을(를) 확인하지 못했습니다", raw=error_text(result))
            return None
    _report(emitter, "target_buckets", "S3 버킷 (모든 버전 포함)", CHECK_INFO,
            ", ".join(plan.buckets) if plan.buckets else "없음")

    data, result = aws_json(runner, "logs", "describe-log-groups", "--log-group-name-prefix", "/aws/lambda/wga-")
    if data is None:
        emitter.error(STEP, "로그 그룹을 조회하지 못했습니다", raw=error_text(result))
        return None
    plan.log_groups = sorted(g["logGroupName"] for g in data.get("logGroups", [])
                             if g["logGroupName"].endswith(f"-{ctx.env}"))
    _report(emitter, "target_log_groups", "로그 그룹", CHECK_INFO,
            ", ".join(plan.log_groups) if plan.log_groups else "없음")

    names = [f"{ctx.ssm_prefix}/{param.key}" for param in SECRET_PARAMS]
    found, error = existing_parameters(runner, names)
    if found is None:
        emitter.error(STEP, "SSM 파라미터를 조회하지 못했습니다", raw=error)
        return None
    plan.parameters = [name for name in names if name in found]
    _report(emitter, "target_parameters", "SSM 파라미터", CHECK_INFO,
            ", ".join(plan.parameters) if plan.parameters else "없음")
    return plan


def _inventory_github(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan, *, needed: bool) -> None:
    status = CHECK_WARN
    hint = ("OIDC 스택이 있어 저장소 변수를 반드시 지워야 합니다. gh auth login 후 다시 실행하세요" if needed
            else "GitHub 쪽 정리(저장소 변수, Environment)는 건너뜁니다")
    error = github.check_login(runner)
    repo = None
    if not error:
        repo, error = github.resolve_repo(ctx, runner)
    if repo is None:
        if needed:
            emitter.error(STEP, error or "GitHub 저장소를 알 수 없습니다", hint=hint)
        else:
            _report(emitter, "target_github", "GitHub", status, error or "GitHub 저장소를 알 수 없습니다", hint)
        return
    current, error = github.variables(runner, repo)
    if current is None:
        emitter.error(STEP, "저장소 변수를 조회하지 못했습니다", raw=error)
        return
    environment, exists, error = github.environment(runner, repo, ctx.env)
    if error:
        emitter.error(STEP, "Environment를 조회하지 못했습니다", raw=error)
        return
    plan.repo = repo
    variable = github.role_variable(ctx.env)
    plan.role_variable = variable if variable in current else None
    plan.github_environment = exists
    items = ([f"저장소 변수 {variable}"] if plan.role_variable else []) + \
            ([f"Environment {ctx.env}"] if exists else [])
    _report(emitter, "target_github", f"GitHub ({repo})", CHECK_INFO, ", ".join(items) if items else "없음")


def _owns_provider(runner: Runner, stack: str) -> bool:
    _, result = aws_json(runner, "cloudformation", "describe-stack-resource", "--stack-name", stack,
                         "--logical-resource-id", PROVIDER_LOGICAL_ID)
    return result.ok


def _report(emitter: Emitter, id_: str, title: str, status: str, detail: str, hint: str | None = None) -> None:
    emitter.check(id_, title, status, detail, hint)


# ---------------------------------------------------------------- 지우기 (단계별 승인)

def _approve(runner: Runner, id_: str, reason: str, commands: list[list[str] | str]) -> str:
    shown = [c if isinstance(c, str) else format_command(c) for c in commands]
    return runner.approve(id_, reason, shown, allow_assume_yes=False)


def _delete_role_variable(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan) -> str:
    if not plan.role_variable:
        return "done"
    cmd = ["gh", "variable", "delete", plan.role_variable, "--repo", plan.repo]
    outcome = _approve(runner, "delete_role_variable",
                       f"자동 배포를 끄기 위해 저장소 변수 {plan.role_variable}을(를) 지웁니다", [cmd])
    if outcome != EXECUTED:
        return _skipped(outcome)
    result = runner.run_approved(cmd, timeout=60)
    if not result.ok:
        emitter.error(STEP, "저장소 변수를 지우지 못했습니다", raw=github.error_text(result))
        return "failed"
    return "done"


def _delete_stacks(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan) -> str:
    if not plan.stacks:
        return "done"
    repo_name = mcp_repository(ctx.env)
    force_ecr = ["aws", "ecr", "delete-repository", "--repository-name", repo_name, "--force"]
    commands: list[list[str] | str] = []
    for stack in plan.stacks:
        commands.append(["aws", "cloudformation", "delete-stack", "--stack-name", stack])
    if f"wga-mcp-{ctx.env}" in plan.stacks:
        commands.append(format_command(force_ecr) + "   # MCP 스택이 ECR 이미지 때문에 삭제에 실패할 때만, 이후 재시도")
    outcome = _approve(runner, "delete_stacks", f"스택 {len(plan.stacks)}개를 순서대로 지웁니다 (중첩 스택 포함, 수십 분 걸릴 수 있음)",
                       commands)
    if outcome != EXECUTED:
        return _skipped(outcome)

    for index, stack in enumerate(plan.stacks, 1):
        emitter.progress(STEP, f"{index}/{len(plan.stacks)}", f"스택 삭제: {stack}")
        started = datetime.now(timezone.utc)
        if _delete_stack(runner, stack):
            continue
        failures = stack_failures(runner, [stack], started - CLOCK_SKEW)
        if stack == f"wga-mcp-{ctx.env}" and any(f.resource_type == "AWS::ECR::Repository" for f in failures):
            emitter.log(f"ECR 저장소 {repo_name}에 이미지가 남아 스택 삭제가 실패했습니다. 저장소를 지우고 다시 시도합니다",
                        stream="info")
            result = runner.run_approved(force_ecr, timeout=120)
            if result.ok and _delete_stack(runner, stack):
                plan.ecr_repository = False
                continue
            failures = stack_failures(runner, [stack], started - CLOCK_SKEW)
        for failure in failures:
            emitter.error(STEP, f"{failure.stack}: {failure.logical_id} ({failure.resource_type})", raw=failure.reason)
        emitter.error(STEP, f"스택 {stack}을(를) 지우지 못했습니다",
                      hint="위 원인을 해결하거나 CloudFormation 콘솔에서 확인한 뒤 다시 실행하세요")
        return "failed"
    return "done"


def _delete_stack(runner: Runner, stack: str) -> bool:
    result = runner.run_approved(["aws", "cloudformation", "delete-stack", "--stack-name", stack], timeout=60)
    if not result.ok:
        return False
    # 기다리는 것은 읽기 전용이다. wait는 성공하면 아무것도 출력하지 않고 종료 코드 0으로 끝난다
    waited = runner.run(["aws", "cloudformation", "wait", "stack-delete-complete", "--stack-name", stack],
                        timeout=STACK_DELETE_TIMEOUT)
    return waited.ok


def _delete_leftover_repository(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan) -> str:
    if not plan.ecr_repository:
        return "done"
    repo_name = mcp_repository(ctx.env)
    if not runner.dry_run:
        # 스택 삭제로 이미 지워졌을 수 있다
        _, result = aws_json(runner, "ecr", "describe-repositories", "--repository-names", repo_name)
        if not result.ok:
            return "done"
    cmd = ["aws", "ecr", "delete-repository", "--repository-name", repo_name, "--force"]
    outcome = _approve(runner, "delete_ecr", f"남아 있는 ECR 저장소 {repo_name}을(를) 이미지와 함께 지웁니다", [cmd])
    if outcome != EXECUTED:
        return _skipped(outcome)
    result = runner.run_approved(cmd, timeout=120)
    if not result.ok:
        emitter.error(STEP, "ECR 저장소를 지우지 못했습니다", raw=error_text(result))
        return "failed"
    return "done"


def _delete_buckets(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan) -> str:
    if not plan.buckets:
        return "done"
    commands: list[list[str] | str] = []
    for bucket in plan.buckets:
        commands.append(f"aws s3api delete-objects --bucket {bucket} --delete file://<목록>   # 모든 버전·삭제 마커, 1000개씩 반복")
        commands.append(["aws", "s3api", "delete-bucket", "--bucket", bucket])
    outcome = _approve(runner, "delete_buckets", f"버킷 {len(plan.buckets)}개를 비우고 지웁니다 (저장된 파일이 모두 사라집니다)",
                       commands)
    if outcome != EXECUTED:
        return _skipped(outcome)
    for index, bucket in enumerate(plan.buckets, 1):
        emitter.progress(STEP, f"{index}/{len(plan.buckets)}", f"버킷 삭제: {bucket}")
        if not _empty_bucket(runner, emitter, bucket):
            return "failed"
        result = runner.run_approved(["aws", "s3api", "delete-bucket", "--bucket", bucket], timeout=120)
        if not result.ok:
            emitter.error(STEP, f"버킷 {bucket}을(를) 지우지 못했습니다", raw=error_text(result))
            return "failed"
    return "done"


def _empty_bucket(runner: Runner, emitter: Emitter, bucket: str) -> bool:
    """버전 관리 버킷을 완전히 비운다. 현재 객체만 지우면(aws s3 rm) 이전 버전과 삭제 마커가 남아 버킷을 지울 수 없다.
    목록을 읽고 → 지우고를 목록이 빌 때까지 반복한다 (지운 만큼 목록이 줄어들므로 페이지 토큰이 필요 없다)."""
    for _ in range(MAX_EMPTY_ROUNDS):
        data, result = aws_json(runner, "s3api", "list-object-versions", "--bucket", bucket,
                                "--max-items", str(DELETE_BATCH), timeout=120)
        if data is None:
            emitter.error(STEP, f"버킷 {bucket}의 객체 목록을 읽지 못했습니다", raw=error_text(result))
            return False
        objects = [{"Key": item["Key"], "VersionId": item["VersionId"]}
                   for item in (data.get("Versions") or []) + (data.get("DeleteMarkers") or [])]
        if not objects:
            return True
        for start in range(0, len(objects), DELETE_BATCH):
            batch = {"Objects": objects[start:start + DELETE_BATCH], "Quiet": True}
            with secret_file(batch) as path:
                result = runner.run_approved(["aws", "s3api", "delete-objects", "--bucket", bucket,
                                              "--delete", f"file://{path}", "--output", "json"], timeout=300)
            errors = _delete_errors(result.stdout) if result.ok else []
            if not result.ok or errors:
                emitter.error(STEP, f"버킷 {bucket}의 객체를 지우지 못했습니다",
                              raw=errors[0] if errors else error_text(result))
                return False
    emitter.error(STEP, f"버킷 {bucket}을(를) 비우는 데 너무 오래 걸려 멈췄습니다")
    return False


def _delete_errors(stdout: str) -> list[str]:
    """delete-objects는 일부가 실패해도 종료 코드 0으로 끝나고 Errors 목록에 적는다."""
    try:
        data = json.loads(stdout or "{}")
    except json.JSONDecodeError:
        return []
    return [f"{e.get('Key')}: {e.get('Code')} {e.get('Message', '')}".strip() for e in data.get("Errors", [])]


def _delete_log_groups(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan) -> str:
    if not plan.log_groups:
        return "done"
    commands = [["aws", "logs", "delete-log-group", "--log-group-name", group] for group in plan.log_groups]
    outcome = _approve(runner, "delete_log_groups", f"로그 그룹 {len(commands)}개를 지웁니다 (로그 기록이 사라집니다)",
                       commands)
    if outcome != EXECUTED:
        return _skipped(outcome)
    for cmd in commands:
        result = runner.run_approved(cmd, timeout=60)
        if not result.ok and "ResourceNotFound" not in result.stderr:
            emitter.error(STEP, f"로그 그룹 {cmd[-1]}을(를) 지우지 못했습니다", raw=error_text(result))
            return "failed"
    return "done"


def _delete_parameters(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan) -> str:
    if not plan.parameters:
        return "done"
    cmd = ["aws", "ssm", "delete-parameters", "--names", *plan.parameters, "--output", "json"]
    outcome = _approve(runner, "delete_parameters", "setup이 등록한 SSM 파라미터를 지웁니다 (API 키 등)", [cmd])
    if outcome != EXECUTED:
        return _skipped(outcome)
    result = runner.run_approved(cmd, timeout=60)
    if not result.ok:
        emitter.error(STEP, "SSM 파라미터를 지우지 못했습니다", raw=error_text(result))
        return "failed"
    return "done"


def _delete_github_environment(ctx: Context, runner: Runner, emitter: Emitter, plan: Plan) -> str:
    if not plan.github_environment:
        return "done"
    cmd = ["gh", "api", "-X", "DELETE", f"repos/{plan.repo}/environments/{ctx.env}"]
    outcome = _approve(runner, "delete_github_environment", f"GitHub Environment {ctx.env}을(를) 지웁니다", [cmd])
    if outcome != EXECUTED:
        return _skipped(outcome)
    result = runner.run_approved(cmd, timeout=60)
    if not result.ok:
        emitter.error(STEP, "GitHub Environment를 지우지 못했습니다", raw=github.error_text(result))
        return "failed"
    return "done"


def _skipped(outcome: str) -> str:
    """approve 결과를 단계 결과로: dry-run이면 계속 진행(다음 단계도 보여 줌), 거절이면 중단."""
    return "done" if outcome == DRY_RUN else "declined" if outcome == DECLINED else outcome
