"""deploy.sh 검증: AWS 없이 가짜 aws CLI로 스택 업데이트 처리와 배포 산출물 키를 확인한다"""
import json
import re
import subprocess
import textwrap
from pathlib import Path

import pytest

from conftest import ROOT

DEPLOY_SH = (ROOT / "deploy.sh").read_text()


def extract_function(name):
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", DEPLOY_SH, re.S | re.M)
    assert match, f"{name} 함수가 deploy.sh에 없습니다"
    return match.group(0)


@pytest.fixture
def fake_aws(tmp_path):
    """update-stack 동작을 스택 이름으로 바꿀 수 있는 가짜 aws CLI. 호출 내역을 calls.log에 남긴다"""
    log = tmp_path / "calls.log"
    script = tmp_path / "aws"
    script.write_text(textwrap.dedent(f"""\
        #!/bin/bash
        echo "$*" >> "{log}"
        case "$*" in
          *"update-stack --stack-name noop-stack"*)
            echo "An error occurred (ValidationError) when calling the UpdateStack operation: No updates are to be performed." >&2; exit 254 ;;
          *"update-stack --stack-name broken-stack"*)
            echo "An error occurred (ValidationError) when calling the UpdateStack operation: Template format error" >&2; exit 254 ;;
          *"update-stack"*) echo '{{"StackId": "arn:aws:cloudformation:::stack/x"}}' ;;
          *"wait stack-update-complete"*) exit 0 ;;
        esac
        """))
    script.chmod(0o755)
    return tmp_path, log


def run_cfn_update(fake_aws, stack):
    bin_dir, log = fake_aws
    script = "set -e\n" + extract_function("cfn_update") + f'cfn_update {stack} --template-url x\necho "계속 진행"\n'
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                            env={"PATH": f"{bin_dir}:/usr/bin:/bin"})
    calls = log.read_text().splitlines() if log.exists() else []
    return result, calls


def test_cfn_update_waits_after_real_update(fake_aws):
    result, calls = run_cfn_update(fake_aws, "real-stack")
    assert result.returncode == 0 and "계속 진행" in result.stdout
    assert calls[-1] == "cloudformation wait stack-update-complete --stack-name real-stack"


def test_cfn_update_treats_no_changes_as_success(fake_aws):
    # set -e 환경에서도 "변경 없음"으로 배포가 중단되지 않아야 한다
    result, calls = run_cfn_update(fake_aws, "noop-stack")
    assert result.returncode == 0 and "계속 진행" in result.stdout
    assert "변경 사항 없음" in result.stdout
    assert not any("wait" in c for c in calls)   # 존재하지 않는 업데이트를 기다리지 않음


def test_cfn_update_fails_on_other_errors(fake_aws):
    result, _ = run_cfn_update(fake_aws, "broken-stack")
    assert result.returncode != 0 and "계속 진행" not in result.stdout
    assert "Template format error" in result.stderr


def test_deploy_does_not_empty_buckets():
    # 모든 버킷이 DeletionPolicy: Retain이라 비울 필요가 없고, 비우면 사용자 데이터가 사라진다
    assert "aws s3 rm" not in DEPLOY_SH
    for template in (ROOT / "cloudformation").glob("*.yaml"):
        text = template.read_text()
        for block in re.split(r"\n(?=  \w+:\n)", text):
            if "Type: AWS::S3::Bucket\n" in block:
                assert "DeletionPolicy: Retain" in block, f"{template.name}에 Retain이 없는 버킷이 있습니다"


def test_base_stack_updates_keep_previous_domain_values():
    # 기존 스택 업데이트에서 placeholder 도메인으로 되돌리지 않는다
    update_calls = re.findall(r"cfn_update \$BASE_STACK_NAME.*?--capabilities", DEPLOY_SH, re.S)
    assert len(update_calls) == 3
    for call in update_calls:
        assert "placeholder" not in call
        assert "McpFunctionUrl" in call


def test_uploaded_lambda_keys_match_template_keys():
    # deploy.sh가 올리는 S3 키와 템플릿이 참조하는 키가 어긋나면 배포가 실패한다
    uploaded = {m.replace("$ENV", "{env}").replace("$CODE_VERSION", "{version}")
                for m in re.findall(r'"s3://\$DEPLOYMENT_BUCKET/([^"]+)"', DEPLOY_SH)}
    referenced = set()
    for template in (ROOT / "cloudformation").glob("*.yaml"):
        for key in re.findall(r"S3Key: !Sub ['\"]([^'\"]+)['\"]", template.read_text()):
            referenced.add(key.replace("${Environment}", "{env}").replace("${CodeVersion}", "{version}"))
    assert referenced, "템플릿에서 S3Key를 찾지 못했습니다"
    assert referenced == uploaded
    assert all("{version}" in key for key in referenced)   # 버전이 없으면 코드 변경이 반영되지 않음


def test_mcp_image_uses_code_version_tag():
    assert 'ECR_IMAGE_TAG="$CODE_VERSION"' in DEPLOY_SH
    assert "name=MCP_ECR_IMAGE_TAG,value=$CODE_VERSION" in DEPLOY_SH


def test_stack_parameters_do_not_reference_secure_strings():
    # CloudFormation 템플릿 파라미터(AWS::SSM::Parameter::Value<String>)는 SecureString을 지원하지 않으므로,
    # README가 SecureString으로 만들라고 안내하는 비밀 값을 스택 파라미터로 넘기면 스택 생성이 실패한다.
    readme = (ROOT / "README.md").read_text()
    secure_names = set(re.findall(r'put-parameter --name "/wga/\$\{Environment\}/([^"]+)"[^\n]*--type "SecureString"', readme))
    assert {"SlackbotToken", "SlackSigningSecret", "ANTHROPIC_API_KEY"} <= secure_names

    passed_ssm_paths = set(re.findall(r'ParameterValue="\$SSM_PATH_PREFIX/([^"]+)"', DEPLOY_SH))
    assert passed_ssm_paths, "deploy.sh에서 SSM 경로 파라미터를 찾지 못했습니다"
    assert not (passed_ssm_paths & secure_names), f"SecureString을 스택 파라미터로 전달: {passed_ssm_paths & secure_names}"


def test_region_is_not_hardcoded():
    # 배포 리전을 바꿔도 동작하도록 코드와 템플릿에 특정 리전·전역 S3 엔드포인트를 고정하지 않는다.
    # (전역 엔드포인트 s3.amazonaws.com은 us-east-1 외 리전 버킷의 템플릿 URL에서 실패할 수 있다)
    targets = [ROOT / "deploy.sh", *(ROOT / "cloudformation").glob("*.yaml"),
               *(ROOT / "frontend" / "src").rglob("*.ts"), *(ROOT / "frontend" / "src").rglob("*.tsx"),
               *(ROOT / "layers").rglob("*.py"), *(ROOT / "services").rglob("*.py"), *(ROOT / "mcp").rglob("*.py")]
    offenders = []
    for path in targets:
        text = path.read_text()
        for pattern in ("us-east-1", "https://s3.amazonaws.com/"):
            if pattern in text:
                offenders.append(f"{path.relative_to(ROOT)}: {pattern}")
    assert not offenders, offenders


def test_default_region_is_seoul():
    assert "REGION=${REGION:-ap-northeast-2}" in DEPLOY_SH
    workflow = (ROOT / ".github" / "workflows" / "deploy.yml").read_text()
    assert "vars.AWS_REGION || 'ap-northeast-2'" in workflow


# ---------------------------------------------------------------- 배포 직후 MCP Lambda 미리 깨우기 (warm_up_mcp)

FAKE_LAMBDA = r'''#!/usr/bin/env python3
# 가짜 aws CLI: lambda invoke를 MCP Lambda처럼 흉내 낸다. MODE로 동작을 바꾸고, 부른 내용을 calls.log에 남긴다
import json, os, sys

args = sys.argv[1:]
with open(os.environ["CALLS_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
mode = os.environ["MODE"]
if args[:2] == ["lambda", "wait"]:
    sys.exit(0)
if args[:2] != ["lambda", "invoke"]:
    sys.exit(0)
if mode == "cli-error":
    print("Could not connect to the endpoint URL", file=sys.stderr)
    sys.exit(255)

event = json.loads(args[args.index("--payload") + 1])
if mode == "function-error":  # Lambda 안에서 예외가 나도 aws CLI는 0으로 끝나고 결과 파일에 오류가 들어간다
    response = {"errorMessage": "Read-only file system", "errorType": "OSError"}
elif event["httpMethod"] == "DELETE":
    response = {"statusCode": 204}
else:
    method = json.loads(event["body"])["method"]
    if method == "initialize":
        response = {"statusCode": 200, "headers": {"MCP-Session-Id": "session-1"}, "body": "{}"}
    else:
        assert event["headers"]["mcp-session-id"] == "session-1"
        tools = [{"name": "describe_log_groups"}, {"name": "cost-explorer"}]
        response = {"statusCode": 200, "body": json.dumps({"result": {"tools": tools}})}
with open(args[-1], "w") as out:
    json.dump(response, out)
'''


def run_warm_up(tmp_path, mode):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "aws").write_text(FAKE_LAMBDA)
    (bin_dir / "aws").chmod(0o755)
    log = tmp_path / "calls.log"
    script = "set -e\n" + extract_function("warm_up_mcp") + 'warm_up_mcp wga-mcp-test\necho "계속 진행"\n'
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                            env={"PATH": f"{bin_dir}:/usr/bin:/bin", "CALLS_LOG": str(log), "MODE": mode})
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return result, calls


def invoked(calls):
    """lambda invoke로 보낸 이벤트 (HTTP 메서드, JSON-RPC 메서드) 순서"""
    events = [json.loads(c[c.index("--payload") + 1]) for c in calls if c[:2] == ["lambda", "invoke"]]
    return [(e["httpMethod"], json.loads(e["body"])["method"] if e["httpMethod"] == "POST" else None) for e in events]


def test_warm_up_mcp_loads_tools_like_llm_lambda(tmp_path):
    result, calls = run_warm_up(tmp_path, "ok")
    assert result.returncode == 0 and "계속 진행" in result.stdout
    assert "MCP Lambda 준비 완료: 도구 2개" in result.stdout
    # 이미지가 바뀐 뒤 새 버전을 부르도록 먼저 기다린다
    assert calls[0][:3] == ["lambda", "wait", "function-updated-v2"] and "wga-mcp-test" in calls[0]
    # LLM Lambda와 같은 순서로 부르고(tools/list에서 공식 서버를 불러온다), 만든 세션은 지운다
    assert invoked(calls) == [("POST", "initialize"), ("POST", "tools/list"), ("DELETE", None)]


@pytest.mark.parametrize("mode", ["function-error", "cli-error"])
def test_warm_up_mcp_failure_does_not_stop_deploy(tmp_path, mode):
    # 미리 깨우지 못해도 첫 질문이 느릴 뿐이므로, set -e 환경에서도 배포를 멈추지 않는다
    result, calls = run_warm_up(tmp_path, mode)
    assert result.returncode == 0 and "계속 진행" in result.stdout
    assert "MCP Lambda를 미리 깨우지 못했습니다" in result.stdout
    assert invoked(calls) == [("POST", "initialize")]  # 초기화가 실패하면 더 부르지 않는다


def test_deploy_warms_up_mcp_after_last_stack_update():
    # MCP 이미지를 바꾸는 메인 스택과 마지막 base 스택 업데이트가 끝난 뒤에 깨워야 새 이미지가 깨어난다
    call = DEPLOY_SH.index('warm_up_mcp "wga-mcp-$ENV"')
    assert DEPLOY_SH.rindex("cfn_update $BASE_STACK_NAME") < call < DEPLOY_SH.index("# 7. 배포 완료 요약")


# ---------------------------------------------------------------- 루트 .env (환경 값과 Anthropic API 키)

def run_function(name, body, env, cwd=None):
    script = "set -e\n" + extract_function(name) + body + '\necho "계속 진행"\n'
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env, cwd=cwd)


def test_dotenv_set_keeps_other_lines(tmp_path):
    # deploy.sh는 프론트엔드 값만 바꾸고, 직접 적은 ANTHROPIC_API_KEY와 주석은 그대로 둔다
    env_file = tmp_path / ".env"
    env_file.write_text("# 직접 적는 값\nANTHROPIC_API_KEY=sk-ant-KEEP\nVITE_API_DEST=https://old\n")
    result = run_function("dotenv_set",
                          f'dotenv_set "{env_file}" VITE_API_DEST "https://new"\n'
                          f'dotenv_set "{env_file}" USER_POOL_ID "pool-1"',
                          {"PATH": "/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr
    assert env_file.read_text() == ("# 직접 적는 값\nANTHROPIC_API_KEY=sk-ant-KEEP\n"
                                    "VITE_API_DEST=https://new\nUSER_POOL_ID=pool-1\n")


FAKE_SSM = r'''#!/usr/bin/env python3
# 가짜 aws CLI: SSM get-parameter / put-parameter만 흉내 낸다. 부른 인자는 calls.log, 올린 요청은 put.json에 남긴다
import json, os, sys
args = sys.argv[1:]
work = os.environ["WORK"]
with open(os.path.join(work, "calls.log"), "a") as log:
    log.write(json.dumps(args) + "\n")
if args[:2] == ["ssm", "get-parameter"]:
    current = os.environ.get("CURRENT")
    if not current:
        print("ParameterNotFound", file=sys.stderr)
        sys.exit(254)
    print(json.dumps({"Parameter": {"Name": args[args.index("--name") + 1], "Value": current,
                                    "Type": "SecureString"}}))
elif args[:2] == ["ssm", "put-parameter"]:
    path = args[args.index("--cli-input-json") + 1].removeprefix("file://")
    with open(path) as src, open(os.path.join(work, "put.json"), "w") as dst:
        dst.write(src.read())
    print(json.dumps({"Version": 2}))
'''

KEY = "sk-ant-api03-FROM-DOTENV"


def run_sync(tmp_path, env_text=None, current=None):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "aws").write_text(FAKE_SSM)
    (bin_dir / "aws").chmod(0o755)
    env_file = tmp_path / ".env"
    if env_text is not None:
        env_file.write_text(env_text)
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "WORK": str(tmp_path)}
    if current:
        env["CURRENT"] = current
    body = f'ROOT_ENV_FILE="{env_file}"\nSSM_PATH_PREFIX=/wga/dev\nsync_anthropic_key'
    result = run_function("sync_anthropic_key", body, env)
    log = tmp_path / "calls.log"
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    put = tmp_path / "put.json"
    return result, calls, (json.loads(put.read_text()) if put.exists() else None)


def test_anthropic_key_from_dotenv_is_put_to_ssm_without_command_args(tmp_path):
    result, calls, put = run_sync(tmp_path, f'# 주석\nANTHROPIC_API_KEY="{KEY}"\nVITE_API_DEST=https://x\n')
    assert result.returncode == 0 and "계속 진행" in result.stdout, result.stderr
    assert put == {"Name": "/wga/dev/ANTHROPIC_API_KEY", "Value": KEY, "Type": "SecureString", "Overwrite": True}
    # 키 값은 명령 인자(ps로 보인다)에도, 화면 출력에도 나오지 않는다
    assert all(KEY not in arg for call in calls for arg in call)
    assert KEY not in result.stdout + result.stderr
    # 요청을 담았던 임시 파일은 지운다
    request = [c for c in calls if c[:2] == ["ssm", "put-parameter"]][0]
    assert not Path(request[request.index("--cli-input-json") + 1].removeprefix("file://")).exists()


def test_same_key_is_not_put_again(tmp_path):
    result, calls, put = run_sync(tmp_path, f"ANTHROPIC_API_KEY={KEY}\n", current=KEY)
    assert result.returncode == 0 and put is None
    assert "SSM 값과 같아" in result.stdout


@pytest.mark.parametrize("env_text", [None, "ANTHROPIC_API_KEY=\nVITE_API_DEST=https://x\n"])
def test_missing_key_keeps_ssm_value(tmp_path, env_text):
    # GitHub Actions처럼 .env가 없거나 키를 비워 두면 SSM에 있는 값을 그대로 쓴다
    result, _, put = run_sync(tmp_path, env_text)
    assert result.returncode == 0 and "계속 진행" in result.stdout and put is None


def test_deploy_syncs_key_before_stacks_and_fills_root_env():
    assert DEPLOY_SH.index("\nsync_anthropic_key\n") < DEPLOY_SH.index("# 1. CloudFormation 버킷 확인")
    # 프론트엔드 값은 루트 .env에만 쓰고, 예전 frontend/.env.local과 쓰지 않는 값은 만들지 않는다
    assert "frontend/.env.local" not in DEPLOY_SH
    for unused in ("API_DEST=", "VITE_API_URL", "COGNITO_REDIRECT_URI", "COGNITO_IDENTITY_POOL_ID"):
        assert f"dotenv_set \"$ROOT_ENV_FILE\" {unused}" not in DEPLOY_SH
    written = set(re.findall(r'dotenv_set "\$ROOT_ENV_FILE" (\w+)', DEPLOY_SH))
    example = set(re.findall(r"^(\w+)=", (ROOT / ".env.example").read_text(), re.M))
    assert written == {"VITE_API_DEST", "AWS_REGION", "USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_DOMAIN"}
    assert example == written | {"ANTHROPIC_API_KEY"}


def test_root_env_is_ignored_but_example_is_committed():
    def ignored(path):
        return subprocess.run(["git", "check-ignore", "-q", path], cwd=ROOT).returncode == 0
    assert ignored(".env")
    assert not ignored(".env.example")


def test_frontend_bundle_takes_only_chosen_env_values():
    # 루트 .env에 ANTHROPIC_API_KEY가 함께 있으므로, 번들에 넣는 값을 정해 둔 것만 넣어야 한다.
    # envPrefix를 바꾸면 그 접두사로 시작하는 값이 모두 번들에 들어간다
    config = (ROOT / "frontend" / "vite.config.ts").read_text()
    assert "envPrefix:" not in config  # 설정으로 쓰지 않는다 (주석의 설명은 괜찮다)
    assert "env.ANTHROPIC" not in config  # 비밀 값을 읽어 쓰지 않는다
    assert set(re.findall(r"'import\.meta\.env\.(\w+)'", config)) == {
        "AWS_REGION", "USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_DOMAIN"}


@pytest.mark.parametrize("text", [
    'ANTHROPIC_API_KEY="sk-ant-q"\n', "  ANTHROPIC_API_KEY = sk-ant-s  \n", "ANTHROPIC_API_KEY=a\nANTHROPIC_API_KEY=b\n",
    "# ANTHROPIC_API_KEY=commented\n", "ANTHROPIC_API_KEY=\n",
])
def test_installer_reads_dotenv_like_deploy_sh(tmp_path, text):
    # 설치 마법사(wga_installer/dotenv.py)가 "키가 있다"고 보면 deploy.sh도 같은 값을 SSM에 올려야 한다.
    # 두 쪽이 다르게 읽으면 설치 마법사는 배포를 진행시켰는데 deploy.sh는 키를 건너뛰는 일이 생긴다
    from wga_installer import dotenv

    (tmp_path / "repo").mkdir()
    (tmp_path / "repo" / ".env").write_text(text)
    expected = dotenv.read_value(tmp_path / "repo", "ANTHROPIC_API_KEY")
    _, _, put = run_sync(tmp_path, text)
    assert (put["Value"] if put else None) == expected
