"""deploy.sh 검증: AWS 없이 가짜 aws CLI로 스택 업데이트 처리와 배포 산출물 키를 확인한다"""
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
