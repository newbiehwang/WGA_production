"""setup: 할당량 요청과 SSM 파라미터 등록. 멱등성(두 번째 실행은 skipped)과 비밀 값 누출을 중점적으로 본다"""
import json

import pytest

from .helpers import events, run_cli

QUOTA_CODE = "L-E5AE38E3"
PREFIX = "/wga/dev"
SECRETS = {"ANTHROPIC_API_KEY": "sk-ant-api03-SECRETVALUE", "SlackbotToken": "xoxb-SECRET-TOKEN",
           "SlackSigningSecret": "abcdef0123456789SIGNING"}


def quotas(value, adjustable=True):
    return json.dumps({"Quotas": [
        {"QuotaName": "Maximum number of resources", "QuotaCode": "L-OTHER", "Value": 300.0},
        {"QuotaName": "Maximum integration timeout in milliseconds", "QuotaCode": QUOTA_CODE,
         "Value": float(value), "Adjustable": adjustable}]})


def history(*statuses):
    return json.dumps({"RequestedQuotas": [
        {"Status": status, "DesiredValue": 180000.0, "Created": f"2026-09-{10 + i:02d}T00:00:00+00:00"}
        for i, status in enumerate(statuses)]})


def params(**types):
    return json.dumps({"Parameters": [{"Name": f"{PREFIX}/{key}", "Type": t} for key, t in types.items()]})


def account(fake, *, quota=29000, adjustable=True, requests=(), existing=None):
    """setup이 보는 AWS 상태를 흉내 낸다."""
    fake.add("aws", "list-service-quotas", quotas(quota, adjustable))
    fake.add("aws", "list-requested-service-quota-change-history-by-quota", history(*requests))
    fake.add("aws", "request-service-quota-increase", json.dumps({"RequestedQuota": {"Status": "PENDING"}}))
    fake.add("aws", "describe-parameters", params(**(existing or {})))
    fake.add("aws", "put-parameter", json.dumps({"Version": 1, "Tier": "Standard"}))


def confirm(id_, approved=True):
    return json.dumps({"type": "confirm_response", "id": id_, "approved": approved})


def secret(key, value):
    return json.dumps({"type": "secret_response", "id": f"secret_{key}", "value": value})


def choice(key, value):
    return json.dumps({"type": "choice_response", "id": f"existing_{key}", "choice": value})


def setup_json(fake, *responses, extra=()):
    return run_cli(fake, "setup", "--json", "--region", "ap-northeast-2", *extra,
                   input="\n".join(responses) + ("\n" if responses else ""))


def mutating_calls(fake):
    return [c["args"] for c in fake.calls("aws")
            if any(verb in " ".join(c["args"]) for verb in ("request-service-quota-increase", "put-parameter"))]


def finished(stdout):
    return {e["step"]: e for e in events(stdout) if e["type"] == "step_finished"}


FIRST_RUN = [confirm("request_quota"),
             secret("ANTHROPIC_API_KEY", SECRETS["ANTHROPIC_API_KEY"]), confirm("put_ANTHROPIC_API_KEY"),
             secret("SlackbotToken", SECRETS["SlackbotToken"]), confirm("put_SlackbotToken"),
             secret("SlackSigningSecret", SECRETS["SlackSigningSecret"]), confirm("put_SlackSigningSecret")]


def test_first_run_requests_quota_and_stores_secrets(fake):
    account(fake)
    result = setup_json(fake, *FIRST_RUN)
    assert result.returncode == 0, result.stdout + result.stderr
    steps = finished(result.stdout)
    assert steps["quota"]["status"] == "ok" and "PENDING" in steps["quota"]["summary"]
    assert steps["ssm_parameters"] == {"type": "step_finished", "step": "ssm_parameters", "status": "ok",
                                       "summary": "등록 3개 · 유지 0개"}

    request = [c for c in mutating_calls(fake) if "request-service-quota-increase" in c]
    assert request == [["service-quotas", "request-service-quota-increase", "--service-code", "apigateway",
                        "--quota-code", QUOTA_CODE, "--desired-value", "180000", "--output", "json"]]

    stored = [json.loads(content) for _, content in fake.captures()]
    assert [(s["Name"], s["Type"], s["Overwrite"]) for s in stored] == [
        (f"{PREFIX}/{key}", "SecureString", False) for key in SECRETS]
    assert [s["Value"] for s in stored] == list(SECRETS.values())


def test_secrets_only_travel_in_private_temp_files(fake):
    account(fake)
    result = setup_json(fake, *FIRST_RUN)
    # 1) 화면·로그(이벤트)에 비밀 값이 없다
    for value in SECRETS.values():
        assert value not in result.stdout and value not in result.stderr
    # 2) 명령 인자로 넘기지 않는다 (ps로 보이므로)
    for call in fake.calls():
        assert not any(value in arg for arg in call["args"] for value in SECRETS.values())
    # 3) 파일은 소유자만 읽을 수 있었고, 끝난 뒤 남지 않았다
    assert [mode for mode, _ in fake.captures()] == ["-rw-------"] * 3
    assert list(fake.tmp.iterdir()) == []


def test_second_run_changes_nothing(fake):
    # 멱등성: 할당량이 이미 충분하고 파라미터가 모두 있으면 아무것도 바꾸지 않는다 (응답이 없으면 기본값 "유지")
    account(fake, quota=180000, existing={key: "SecureString" for key in SECRETS})
    result = setup_json(fake)
    steps = finished(result.stdout)
    assert result.returncode == 0
    assert steps["quota"]["status"] == steps["ssm_parameters"]["status"] == "skipped"
    assert mutating_calls(fake) == []
    assert [e["type"] for e in events(result.stdout)].count("choice_required") == 3


def test_pending_request_is_not_repeated(fake):
    account(fake, requests=("CASE_OPENED",), existing={key: "SecureString" for key in SECRETS})
    result = setup_json(fake)
    quota = finished(result.stdout)["quota"]
    assert quota["status"] == "skipped" and "CASE_OPENED" in quota["summary"]
    assert mutating_calls(fake) == []


def test_rejected_request_is_retried(fake):
    account(fake, requests=("DENIED",), existing={key: "SecureString" for key in SECRETS})
    result = setup_json(fake, confirm("request_quota"))
    assert any(e["type"] == "log" and "거절" in e["line"] for e in events(result.stdout))
    assert len(mutating_calls(fake)) == 1


def test_unadjustable_quota_fails_but_ssm_still_runs(fake):
    account(fake, adjustable=False, existing={key: "SecureString" for key in SECRETS})
    result = setup_json(fake)
    steps = finished(result.stdout)
    assert result.returncode == 1
    assert steps["quota"]["status"] == "failed" and steps["ssm_parameters"]["status"] == "skipped"


def test_quota_lookup_error_is_reported(fake):
    fake.add("aws", "list-service-quotas", stderr="An error occurred (AccessDeniedException): not authorized\n",
             exit=254)
    account(fake, existing={key: "SecureString" for key in SECRETS})
    result = setup_json(fake)
    errors = [e for e in events(result.stdout) if e["type"] == "error"]
    assert result.returncode == 1 and "AccessDeniedException" in errors[0]["message"]


def test_quota_found_in_default_list(fake):
    # 조정한 적 없는 할당량은 적용 값 목록에 없을 수 있다 → AWS 기본값 목록에서 찾는다
    fake.add("aws", "list-service-quotas", json.dumps({"Quotas": []}))
    fake.add("aws", "list-aws-default-service-quotas", quotas(29000))
    account(fake, existing={key: "SecureString" for key in SECRETS})
    result = setup_json(fake, confirm("request_quota"))
    assert finished(result.stdout)["quota"]["status"] == "ok"


def test_overwrite_existing_parameter(fake):
    account(fake, quota=180000, existing={key: "SecureString" for key in SECRETS})
    result = setup_json(fake, choice("ANTHROPIC_API_KEY", "overwrite"),
                        secret("ANTHROPIC_API_KEY", "sk-ant-NEW"), confirm("put_ANTHROPIC_API_KEY"),
                        choice("SlackbotToken", "keep"), choice("SlackSigningSecret", "keep"))
    stored = [json.loads(content) for _, content in fake.captures()]
    assert [(s["Name"], s["Value"], s["Overwrite"]) for s in stored] == [
        (f"{PREFIX}/ANTHROPIC_API_KEY", "sk-ant-NEW", True)]
    assert finished(result.stdout)["ssm_parameters"]["summary"] == "등록 1개 · 유지 2개"


def test_plain_string_parameter_is_flagged(fake):
    account(fake, quota=180000, existing={"ANTHROPIC_API_KEY": "String", "SlackbotToken": "SecureString",
                                          "SlackSigningSecret": "SecureString"})
    result = setup_json(fake)
    assert any(e["type"] == "log" and "String 형식" in e["line"] for e in events(result.stdout))


def test_value_is_trimmed(fake):
    # 복사해 붙여 넣을 때 딸려 온 공백·줄바꿈은 지우고 저장한다
    account(fake, quota=180000, existing={"SlackbotToken": "SecureString", "SlackSigningSecret": "SecureString"})
    setup_json(fake, secret("ANTHROPIC_API_KEY", "  sk-ant-TRIM \n"), confirm("put_ANTHROPIC_API_KEY"))
    assert json.loads(fake.captures()[0][1])["Value"] == "sk-ant-TRIM"


def test_empty_slack_values_are_skipped(fake):
    account(fake, quota=180000, existing={"ANTHROPIC_API_KEY": "SecureString"})
    result = setup_json(fake, choice("ANTHROPIC_API_KEY", "keep"),
                        secret("SlackbotToken", ""), secret("SlackSigningSecret", ""))
    assert result.returncode == 0
    assert mutating_calls(fake) == []
    assert finished(result.stdout)["ssm_parameters"]["summary"] == "등록 0개 · 유지 1개 · 건너뜀 2개"


def test_empty_anthropic_key_fails(fake):
    account(fake, quota=180000, existing={"SlackbotToken": "SecureString", "SlackSigningSecret": "SecureString"})
    result = setup_json(fake, secret("ANTHROPIC_API_KEY", ""))
    assert result.returncode == 1 and mutating_calls(fake) == []
    assert finished(result.stdout)["ssm_parameters"]["status"] == "failed"


def test_declined_put_is_not_executed(fake):
    account(fake, quota=180000, existing={"SlackbotToken": "SecureString", "SlackSigningSecret": "SecureString"})
    result = setup_json(fake, secret("ANTHROPIC_API_KEY", "sk-ant-x"), confirm("put_ANTHROPIC_API_KEY", False))
    assert mutating_calls(fake) == [] and list(fake.tmp.iterdir()) == []
    assert "건너뜀 1개" in finished(result.stdout)["ssm_parameters"]["summary"]


def test_put_failure_is_reported(fake):
    fake.add("aws", "put-parameter", stderr="An error occurred (AccessDeniedException) when calling the "
                                            "PutParameter operation\n", exit=254)
    account(fake, quota=180000, existing={"SlackbotToken": "SecureString", "SlackSigningSecret": "SecureString"})
    result = setup_json(fake, secret("ANTHROPIC_API_KEY", "sk-ant-x"), confirm("put_ANTHROPIC_API_KEY"))
    assert result.returncode == 1
    assert finished(result.stdout)["ssm_parameters"]["status"] == "failed"


def test_dry_run_asks_no_secrets_and_changes_nothing(fake):
    account(fake)
    result = setup_json(fake, extra=("--dry-run",))
    kinds = [e["type"] for e in events(result.stdout)]
    assert result.returncode == 0
    assert "input_required" not in kinds and "confirm_required" not in kinds
    assert kinds.count("dry_run") == 4   # 할당량 요청 1 + 파라미터 3
    assert mutating_calls(fake) == []


@pytest.mark.parametrize("answer, expected_calls", [("y\n", 1), ("n\n", 0)])
def test_text_mode(fake, answer, expected_calls):
    # 터미널에서는 y/N 질문, 번호 선택, 보이지 않는 입력(파이프일 때는 한 줄 읽기)을 쓴다
    account(fake, quota=180000, existing={"SlackbotToken": "SecureString", "SlackSigningSecret": "SecureString"})
    result = run_cli(fake, "setup", "--region", "ap-northeast-2", input=f"sk-ant-TEXT\n{answer}\n\n")
    assert "[y/N]" in result.stdout and "번호를 입력하세요" in result.stdout
    assert "sk-ant-TEXT" not in result.stdout
    assert len(mutating_calls(fake)) == expected_calls
