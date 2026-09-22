"""이벤트 출력(events.py): JSON Lines 형식, 사람용 텍스트, 비밀 값 가리기"""
import io
import json

from wga_installer.events import JsonEmitter, Redactor, TextEmitter


def test_json_emitter_writes_one_object_per_line():
    out = io.StringIO()
    emitter = JsonEmitter(Redactor(), out)
    emitter.step_started("check", "사전 점검")
    emitter.check("aws_cli", "AWS CLI", "ok", "2.17.0")
    emitter.step_finished("check", "ok", "통과")

    lines = out.getvalue().splitlines()
    assert [json.loads(line)["type"] for line in lines] == ["step_started", "check", "step_finished"]
    assert "사전 점검" in lines[0]   # 한글이 \uXXXX로 바뀌지 않음


def test_optional_fields_are_omitted_when_none():
    out = io.StringIO()
    JsonEmitter(Redactor(), out).check("region", "배포 리전", "info", "ap-northeast-2")
    assert "hint" not in json.loads(out.getvalue())


def test_redactor_masks_secrets_in_every_string_field():
    redactor = Redactor()
    redactor.add("sk-ant-SECRET")
    out = io.StringIO()
    JsonEmitter(redactor, out).emit("custom", message="키: sk-ant-SECRET", nested={"list": ["x sk-ant-SECRET"]})
    event = json.loads(out.getvalue())
    assert "sk-ant-SECRET" not in out.getvalue()
    assert event["message"] == "키: ***" and event["nested"]["list"] == ["x ***"]


def test_redactor_replaces_longer_secret_first():
    # 짧은 값("abc")을 먼저 바꾸면 긴 값("abcdef")의 나머지("def")가 드러난다
    redactor = Redactor()
    redactor.add("abc")
    redactor.add("abcdef")
    assert redactor.redact("값=abcdef") == "값=***"


def test_redactor_ignores_empty_secret():
    redactor = Redactor()
    redactor.add("")
    redactor.add(None)
    assert redactor.redact("그대로") == "그대로"


def test_text_emitter_formats_check_with_hint():
    out = io.StringIO()
    TextEmitter(Redactor(), out).check("aws_cli", "AWS CLI", "fail", "설치되어 있지 않습니다", "brew install awscli")
    assert out.getvalue() == "  [실패] AWS CLI: 설치되어 있지 않습니다\n         → brew install awscli\n"


def test_text_emitter_also_redacts():
    redactor = Redactor()
    redactor.add("xoxb-123")
    out = io.StringIO()
    TextEmitter(redactor, out).log("token=xoxb-123")
    assert "xoxb-123" not in out.getvalue()
