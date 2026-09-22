"""사전 점검(check): CLI를 실제처럼 별도 프로세스로 실행하고 가짜 aws·gh 등의 결과로 판정을 확인한다"""
import json

import pytest

from .helpers import checks_by_id, events, healthy_mac, run_cli

# check가 호출해도 되는 aws·gh 명령 (모두 읽기 전용). 이 밖의 명령을 부르면 테스트가 실패한다
READ_ONLY = {
    "aws": ("--version", "configure get region", "sts get-caller-identity"),
    "gh": ("--version", "auth status"),
}


def check_json(fake, repo, *extra):
    return run_cli(fake, "check", "--json", "--repo", str(repo), *extra)


def test_healthy_mac_passes(fake, repo):
    healthy_mac(fake)
    result = check_json(fake, repo)
    assert result.returncode == 0, result.stdout + result.stderr

    evts = events(result.stdout)   # 모든 줄이 JSON이어야 앱이 읽을 수 있다
    assert evts[0] == {"type": "step_started", "step": "check", "title": "사전 점검"}
    assert evts[-1]["type"] == "step_finished" and evts[-1]["status"] == "ok"

    checks = checks_by_id(result.stdout)
    assert {"system", "aws_cli", "gh_cli", "git", "node", "npm", "zip", "unzip", "pip", "python",
            "homebrew", "repo", "aws_credentials", "root_account", "region", "free_plan",
            "github_auth"} == checks.keys()
    assert {c["status"] for c in checks.values()} <= {"ok", "info"}
    assert checks["aws_credentials"]["detail"] == "계정 123456789012 · arn:aws:iam::123456789012:user/wga-installer"
    assert checks["region"]["detail"] == "ap-northeast-2 (기본값)"
    assert checks["github_auth"]["detail"] == "octocat(으)로 로그인됨"
    assert checks["system"]["detail"] == "macOS 14.5 · Apple Silicon (arm64)"


def test_check_only_runs_read_only_commands(fake, repo):
    healthy_mac(fake)
    check_json(fake, repo)
    for tool, allowed in READ_ONLY.items():
        for call in fake.calls(tool):
            joined = " ".join(call["args"])
            assert any(a in joined for a in allowed), f"점검에서 허용되지 않은 명령: {tool} {joined}"


def test_dry_run_gives_same_result(fake, repo):
    healthy_mac(fake)
    normal = check_json(fake, repo)
    dry = check_json(fake, repo, "--dry-run")
    assert dry.returncode == normal.returncode == 0
    assert checks_by_id(dry.stdout) == checks_by_id(normal.stdout)


def test_aws_commands_get_region_and_no_pager(fake, repo):
    healthy_mac(fake)
    check_json(fake, repo, "--region", "us-west-2")
    sts = [c for c in fake.calls("aws") if "sts" in c["args"]][0]
    assert sts["env"]["AWS_REGION"] == sts["env"]["AWS_DEFAULT_REGION"] == "us-west-2"
    assert sts["env"]["AWS_PAGER"] == ""


def test_profile_is_passed_to_aws(fake, repo):
    fake.add("aws", "configure get region --profile wga-dev", "ap-northeast-2\n")
    healthy_mac(fake)
    result = run_cli(fake, "check", "--json", "--repo", str(repo), "--profile", "wga-dev",
                     env=fake.env(AWS_ACCESS_KEY_ID="AKIAOTHER"))
    sts = [c for c in fake.calls("aws") if "sts" in c["args"]][0]
    assert sts["env"]["AWS_PROFILE"] == "wga-dev" and "AWS_ACCESS_KEY_ID" not in sts["env"]
    checks = checks_by_id(result.stdout)
    assert checks["aws_credentials"]["title"] == "AWS 자격 증명 (프로필 wga-dev)"
    assert checks["region"]["detail"] == "ap-northeast-2 (AWS CLI 프로필 설정)"


def test_missing_aws_cli_fails_and_skips_sts(fake, repo):
    healthy_mac(fake)
    fake.remove("aws")
    result = check_json(fake, repo)
    checks = checks_by_id(result.stdout)
    assert result.returncode == 1
    assert checks["aws_cli"] == {"type": "check", "id": "aws_cli", "title": "AWS CLI", "status": "fail",
                                 "detail": "설치되어 있지 않습니다",
                                 "hint": "brew install awscli v1이 설치되어 있다면 먼저 제거하세요 (pip uninstall awscli)"}
    assert checks["aws_credentials"]["status"] == "fail"
    assert "root_account" not in checks
    assert events(result.stdout)[-1]["status"] == "failed"


def test_aws_cli_v1_is_rejected(fake, repo):
    fake.add("aws", "--version", stderr="aws-cli/1.32.0 Python/3.9.6 Darwin/23.5.0 botocore/1.34.0\n")
    healthy_mac(fake)
    checks = checks_by_id(check_json(fake, repo).stdout)
    assert checks["aws_cli"]["status"] == "fail"
    assert checks["aws_cli"]["detail"] == "1.32.0 (필요: 2.0.0 이상)"
    assert checks["aws_credentials"]["status"] == "fail"   # v1으로는 진행하지 않는다


def test_old_node_is_rejected(fake, repo):
    fake.add("node", "--version", "v16.20.2\n")
    healthy_mac(fake)
    result = check_json(fake, repo)
    assert result.returncode == 1
    assert checks_by_id(result.stdout)["node"]["detail"] == "16.20.2 (필요: 18.0.0 이상)"


def test_unparseable_version_is_only_a_warning(fake, repo):
    fake.add("node", "--version", "나중에 바뀐 출력 형식\n")
    healthy_mac(fake)
    result = check_json(fake, repo)
    assert result.returncode == 0
    assert checks_by_id(result.stdout)["node"]["status"] == "warn"


def test_gh_is_optional(fake, repo):
    # gh는 GitHub 자동 배포 단계에만 필요하므로 없어도 점검은 통과한다
    healthy_mac(fake)
    fake.remove("gh")
    result = check_json(fake, repo)
    checks = checks_by_id(result.stdout)
    assert result.returncode == 0
    assert checks["gh_cli"]["status"] == checks["github_auth"]["status"] == "warn"


def test_gh_not_logged_in_is_a_warning(fake, repo):
    fake.add("gh", "auth status", stderr="You are not logged into any GitHub hosts.\n", exit=1)
    healthy_mac(fake)
    result = check_json(fake, repo)
    assert result.returncode == 0
    assert "gh auth login" in checks_by_id(result.stdout)["github_auth"]["hint"]


def test_pip_found_the_same_way_as_deploy_sh(fake, repo):
    healthy_mac(fake)
    fake.remove("pip")
    fake.add("python3", "-m pip --version", "pip 24.0 from /x (python 3.12)\n")
    checks = checks_by_id(check_json(fake, repo).stdout)
    assert checks["pip"]["detail"] == "24.0 (`python3 -m pip` 사용)"


def test_missing_pip_fails(fake, repo):
    healthy_mac(fake)
    fake.remove("pip")
    result = check_json(fake, repo)
    assert result.returncode == 1 and checks_by_id(result.stdout)["pip"]["status"] == "fail"


def test_root_account_is_warned(fake, repo):
    healthy_mac(fake, identity={"UserId": "123456789012", "Account": "123456789012",
                                "Arn": "arn:aws:iam::123456789012:root"})
    result = check_json(fake, repo)
    root = checks_by_id(result.stdout)["root_account"]
    assert result.returncode == 0   # 배포는 가능하지만 경고한다
    assert root["status"] == "warn" and "IAM 사용자" in root["hint"]


def test_assumed_role_is_ok(fake, repo):
    healthy_mac(fake, identity={"UserId": "AROA:x", "Account": "123456789012",
                                "Arn": "arn:aws:sts::123456789012:assumed-role/Admin/x"})
    assert checks_by_id(check_json(fake, repo).stdout)["root_account"]["detail"] == "IAM 역할(임시 자격 증명)"


@pytest.mark.parametrize("stderr, detail", [
    ("Unable to locate credentials. You can configure credentials by running \"aws configure\".",
     "자격 증명이 설정되어 있지 않습니다"),
    ("An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: "
     "The security token included in the request is invalid.", "Access Key가 올바르지 않거나 비활성화되었습니다"),
    ("An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: expired",
     "자격 증명이 만료되었습니다"),
    ("The config profile (nope) could not be found", "지정한 AWS 프로필이 없습니다"),
    ("알 수 없는 오류 메시지", "알 수 없는 오류 메시지"),
])
def test_credential_errors_are_explained(fake, repo, stderr, detail):
    fake.add("aws", "sts get-caller-identity", stderr=stderr + "\n", exit=255)
    healthy_mac(fake)
    result = check_json(fake, repo)
    checks = checks_by_id(result.stdout)
    assert result.returncode == 1
    assert checks["aws_credentials"]["detail"] == detail
    assert "root_account" not in checks


def test_malformed_identity_response_fails(fake, repo):
    fake.add("aws", "sts get-caller-identity", "{}")
    healthy_mac(fake)
    assert checks_by_id(check_json(fake, repo).stdout)["aws_credentials"]["status"] == "fail"


def test_invalid_region_fails(fake, repo):
    healthy_mac(fake)
    result = check_json(fake, repo, "--region", "seoul")
    assert result.returncode == 1 and checks_by_id(result.stdout)["region"]["status"] == "fail"


def test_non_mac_is_only_a_warning(fake, repo):
    fake.add("uname", "-s", "Linux\n").add("uname", "-m", "x86_64\n")
    healthy_mac(fake)
    result = check_json(fake, repo)
    system = checks_by_id(result.stdout)["system"]
    assert result.returncode == 0
    assert system["status"] == "warn" and system["detail"] == "Linux (x86_64)"
    assert fake.calls("sw_vers") == []


def test_old_macos_is_warned(fake, repo):
    fake.add("sw_vers", "-productVersion", "12.7.4\n")
    fake.add("uname", "-m", "x86_64\n")
    healthy_mac(fake)
    system = checks_by_id(check_json(fake, repo).stdout)["system"]
    assert system["status"] == "warn" and system["detail"] == "macOS 12.7.4 · Intel (x86_64)"


def test_repo_not_found(fake, tmp_path):
    healthy_mac(fake)
    result = run_cli(fake, "check", "--json", cwd=tmp_path)   # --repo 없이 저장소 밖에서 실행
    repo_check = checks_by_id(result.stdout)["repo"]
    assert result.returncode == 1 and repo_check["status"] == "fail" and "--repo" in repo_check["hint"]


def test_repo_found_from_subdirectory(fake, repo):
    healthy_mac(fake)
    result = run_cli(fake, "check", "--json", cwd=repo / "cloudformation")
    assert checks_by_id(result.stdout)["repo"]["detail"] == f"{repo.resolve()} (커밋 abcdef123456)"


def test_deploy_sh_must_be_executable(fake, repo):
    healthy_mac(fake)
    (repo / "deploy.sh").chmod(0o644)
    repo_check = checks_by_id(check_json(fake, repo).stdout)["repo"]
    assert repo_check["status"] == "fail" and repo_check["hint"].startswith("chmod +x")


def test_repo_without_git_is_a_warning(fake, repo):
    fake.add("git", "rev-parse", stderr="fatal: not a git repository\n", exit=128)
    healthy_mac(fake)
    result = check_json(fake, repo)
    assert result.returncode == 0 and checks_by_id(result.stdout)["repo"]["status"] == "warn"


def test_text_mode_is_human_readable(fake, repo):
    healthy_mac(fake)
    result = run_cli(fake, "check", "--repo", str(repo))
    assert result.returncode == 0
    assert "▶ 사전 점검" in result.stdout and "[ OK ] AWS CLI: 2.17.0" in result.stdout
    assert not any(line.startswith("{") for line in result.stdout.splitlines())


def test_usage_error_exit_code(fake):
    result = run_cli(fake, "check", "--env", "staging")
    assert result.returncode == 2 and "invalid choice" in result.stderr


def test_unexpected_error_becomes_error_event(fake, repo):
    # sts 응답의 Arn이 문자열이 아닌 경우처럼 예상하지 못한 예외도 JSON 이벤트로 알려야 앱이 멈추지 않는다
    fake.add("aws", "sts get-caller-identity", json.dumps({"Account": "1", "Arn": 123}))
    healthy_mac(fake)
    result = check_json(fake, repo)
    last = events(result.stdout)[-1]
    assert result.returncode == 1
    assert last["type"] == "error" and last["message"].startswith("예상하지 못한 오류: AttributeError")
    assert "Traceback" in result.stderr
