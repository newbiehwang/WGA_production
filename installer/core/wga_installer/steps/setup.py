"""setup: 배포 전에 한 번 해 두어야 하는 계정 설정 (계획서 4.2절)

1. quota           API Gateway 통합 타임아웃 할당량을 180000ms로 올려 달라고 요청한다.
2. ssm_parameters  Anthropic API 키와 Slack 값을 SSM Parameter Store에 SecureString으로 저장한다.

두 작업 모두 "현재 상태 확인 → 이미 되어 있으면 skipped → 할 일을 보여 주고 승인 → 실행" 순서를 따른다.
그래서 여러 번 실행해도 결과가 같고(멱등성), 중간에 실패해도 다시 실행하면 남은 일만 한다.

비밀 값 처리 (계획서 2.2절)
- 값은 앱이 stdin으로 넘기거나(JSON 모드) 터미널에서 보이지 않게 입력받는다.
- 명령 인자로 넘기지 않고, 권한 0600 임시 파일에 담아 `--cli-input-json file://...`로 넘긴 뒤 바로 지운다.
- 이미 있는 값은 읽지 않는다 (이름·형식만 확인). 덮어쓸지는 사용자가 고르고, 기본은 "유지"다.
"""
import json

from ..aws import (QUOTA_PENDING_STATUSES, QUOTA_REJECTED_STATUSES, QUOTA_SERVICE, REQUIRED_TIMEOUT_MS,
                   SECRET_PARAMS, SecretParam, error_text, existing_parameters, find_timeout_quota,
                   quota_requests)
from ..context import Context
from ..events import STEP_FAILED, STEP_OK, STEP_SKIPPED, Emitter
from ..runner import DECLINED, DRY_RUN, Runner, secret_file

# 선택지 id (앱은 이 id로 응답한다)
KEEP, OVERWRITE = "keep", "overwrite"


def run(ctx: Context, runner: Runner, emitter: Emitter) -> int:
    quota_ok = _request_quota(ctx, runner, emitter)
    ssm_ok = _store_parameters(ctx, runner, emitter)
    return 0 if quota_ok and ssm_ok else 1


# ---------------------------------------------------------------- 할당량

def _request_quota(ctx: Context, runner: Runner, emitter: Emitter) -> bool:
    """할당량이 부족하면 증가를 요청한다. 실패(조회 오류, 조정 불가, 요청 실패)면 False."""
    step = "quota"
    emitter.step_started(step, f"API Gateway 통합 타임아웃 할당량 ({ctx.region})")

    quota, error = find_timeout_quota(runner)
    if quota is None:
        emitter.error(step, f"할당량을 조회하지 못했습니다: {error}",
                      hint="Service Quotas 콘솔에서 API Gateway의 'Maximum integration timeout in milliseconds'를 "
                           "직접 확인하세요")
        emitter.step_finished(step, STEP_FAILED, "할당량 조회 실패")
        return False

    current = int(quota.value)
    if current >= REQUIRED_TIMEOUT_MS:
        emitter.step_finished(step, STEP_SKIPPED, f"이미 충분합니다 (현재 {current}ms)")
        return True
    if not quota.adjustable:
        emitter.error(step, f"이 리전에서는 할당량을 조정할 수 없습니다 (현재 {current}ms)",
                      hint="다른 리전을 쓰거나 AWS Support에 문의하세요")
        emitter.step_finished(step, STEP_FAILED, "조정 불가")
        return False

    # 이미 요청해 둔 것이 처리 중이면 또 요청하지 않는다 (중복 요청은 거절될 수 있다)
    history, error = quota_requests(runner, quota.code)
    if history is None:
        emitter.error(step, f"이전 요청 기록을 조회하지 못했습니다: {error}")
        emitter.step_finished(step, STEP_FAILED, "요청 기록 조회 실패")
        return False
    pending = next((r for r in history if r.get("Status") in QUOTA_PENDING_STATUSES), None)
    if pending:
        emitter.step_finished(step, STEP_SKIPPED,
                              f"이미 요청해 두었습니다 (상태 {pending['Status']}, 요청 값 "
                              f"{int(pending.get('DesiredValue', 0))}ms). 승인된 뒤 deploy를 실행하세요")
        return True
    if history and history[0].get("Status") in QUOTA_REJECTED_STATUSES:
        emitter.log(f"가장 최근 요청이 거절되었습니다 (상태 {history[0]['Status']}). 다시 요청합니다", stream="info")

    emitter.log(f"현재 {current}ms입니다. WGA는 LLM 응답을 최대 180초 기다리도록 통합 타임아웃을 "
                f"{REQUIRED_TIMEOUT_MS}ms로 설정하므로, 할당량이 오르기 전에는 배포가 실패합니다", stream="info")
    emitter.log("보통 자동으로 승인되지만, 무료 플랜 계정은 거절될 수 있습니다", stream="info")
    result = runner.change(
        ["aws", "service-quotas", "request-service-quota-increase", "--service-code", QUOTA_SERVICE,
         "--quota-code", quota.code, "--desired-value", str(REQUIRED_TIMEOUT_MS), "--output", "json"],
        id_="request_quota", reason=f"통합 타임아웃 할당량을 {REQUIRED_TIMEOUT_MS}ms로 올려 달라고 요청합니다",
        timeout=60)
    if result.outcome == DRY_RUN:
        emitter.step_finished(step, STEP_OK, "dry-run: 요청하지 않았습니다")
        return True
    if result.outcome == DECLINED:
        emitter.step_finished(step, STEP_SKIPPED, "요청하지 않았습니다 (할당량이 오르기 전에는 배포가 실패합니다)")
        return True
    if not result.ok:
        emitter.error(step, f"요청이 실패했습니다: {error_text(result)}")
        emitter.step_finished(step, STEP_FAILED, "요청 실패")
        return False
    try:
        status = json.loads(result.stdout)["RequestedQuota"]["Status"]
    except (json.JSONDecodeError, KeyError, TypeError):
        status = "알 수 없음"
    emitter.step_finished(step, STEP_OK, f"요청했습니다 (상태 {status}). 승인된 뒤 deploy를 실행하세요")
    return True


# ---------------------------------------------------------------- SSM 파라미터

def _store_parameters(ctx: Context, runner: Runner, emitter: Emitter) -> bool:
    step = "ssm_parameters"
    emitter.step_started(step, "SSM 파라미터 등록")
    names = [f"{ctx.ssm_prefix}/{param.key}" for param in SECRET_PARAMS]
    existing, error = existing_parameters(runner, names)
    if existing is None:
        emitter.error(step, f"기존 파라미터를 조회하지 못했습니다: {error}")
        emitter.step_finished(step, STEP_FAILED, "조회 실패")
        return False

    stored, kept, declined, failed, planned = [], [], [], [], []
    for param, name in zip(SECRET_PARAMS, names, strict=True):
        param_type = existing.get(name)
        if param_type is not None:
            if param_type != "SecureString":
                emitter.log(f"{name}이(가) {param_type} 형식으로 저장되어 있습니다. 평문으로 보관되므로 "
                            "덮어써서 SecureString으로 바꾸기를 권장합니다", stream="info")
            choice = runner.interaction.choose(
                f"existing_{param.key}", f"{name}이(가) 이미 있습니다",
                [(KEEP, "기존 값 유지"), (OVERWRITE, "새 값으로 덮어쓰기")], default=KEEP)
            if choice == KEEP:
                kept.append(name)
                continue
        outcome = _put_parameter(ctx, runner, emitter, param, name, overwrite=param_type is not None)
        {"stored": stored, "failed": failed, "planned": planned, "declined": declined}[outcome].append(name)

    counts = f"등록 {len(stored)}개 · 유지 {len(kept)}개" + (f" · 건너뜀 {len(declined)}개" if declined else "")
    if failed:
        emitter.step_finished(step, STEP_FAILED, f"{counts} · 실패 {len(failed)}개")
        return False
    if planned:
        emitter.step_finished(step, STEP_OK, f"dry-run: {len(planned)}개를 등록할 예정 · 유지 {len(kept)}개")
    elif not stored and not declined:
        emitter.step_finished(step, STEP_SKIPPED, f"모두 이미 등록되어 있습니다 ({counts})")
    elif not stored:
        emitter.step_finished(step, STEP_SKIPPED, counts)
    else:
        emitter.step_finished(step, STEP_OK, counts)
    return True


def _put_parameter(ctx: Context, runner: Runner, emitter: Emitter, param: SecretParam, name: str,
                   *, overwrite: bool) -> str:
    """파라미터 하나를 저장한다. 결과: stored | failed | planned(dry-run) | declined."""
    step = "ssm_parameters"
    reason = f"{name}에 SecureString으로 저장합니다" + (" (덮어쓰기)" if overwrite else "")

    if runner.dry_run:
        # dry-run에서는 비밀 값을 묻지 않는다. 실제 명령과 같은 모양으로 보여 주기만 한다
        runner.change(["aws", "ssm", "put-parameter", "--cli-input-json", "file://<임시 파일>"],
                      id_=f"put_{param.key}", reason=reason)
        return "planned"

    value = runner.interaction.secret(f"secret_{param.key}", param.title)
    # 복사해 붙여 넣을 때 딸려 온 공백·줄바꿈을 지운다 (그대로 저장하면 API 호출이 인증 오류로 실패한다)
    value = (value or "").strip()
    runner.emitter.redactor.add(value)
    if not value:
        if param.required:
            emitter.error(step, f"{param.title}이(가) 비어 있어 저장하지 않았습니다",
                          hint="Anthropic 콘솔(console.anthropic.com)에서 API 키를 발급받아 입력하세요")
            return "failed"
        # Slack을 쓰지 않는 경우: 등록하지 않는다. Lambda 설정(layers/common/config.py)은 있는 파라미터만
        # 읽고, Signing Secret이 없으면 Slack 요청을 모두 거부하므로(services/slackbot/slack_security.py) 안전하다.
        emitter.log(f"{param.title}을(를) 비워 두어 등록하지 않습니다. Slack 기능은 꺼진 상태로 동작하며, "
                    "나중에 setup을 다시 실행해 등록할 수 있습니다", stream="info")
        return "declined"

    request = {"Name": name, "Value": value, "Type": "SecureString", "Overwrite": overwrite}
    with secret_file(request) as path:
        result = runner.change(["aws", "ssm", "put-parameter", "--cli-input-json", f"file://{path}",
                                "--output", "json"],
                               id_=f"put_{param.key}", reason=reason, timeout=60)
    if result.outcome == DECLINED:
        return "declined"
    if not result.ok:
        emitter.error(step, f"{name} 저장에 실패했습니다: {error_text(result)}")
        return "failed"
    return "stored"
