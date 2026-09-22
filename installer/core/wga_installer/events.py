"""이벤트 출력: 단계 엔진이 지금 무엇을 하는지 앱 또는 터미널에 알린다.

출력 형식은 두 가지이고, 단계 코드는 어느 형식인지 모른 채 같은 메서드를 호출한다.
- JSON Lines (`--json`): 한 줄에 JSON 객체 하나. macOS 앱이 줄 단위로 읽어 디코딩한다.
- 사람용 텍스트 (기본): 같은 이벤트를 터미널에서 읽기 좋은 모양으로 바꿔 출력한다.

이벤트 종류 (필드는 계획서 2.1절)
    step_started      단계 시작            {step, title}
    step_finished     단계 끝              {step, status: ok|skipped|failed, summary}
    check             점검 항목 하나의 결과  {id, title, status: ok|warn|fail|info, detail, hint?, url?}
                      (url: 앱이 "열기" 버튼을 붙일 주소. 예: 프론트엔드, CloudWatch 대시보드)
    log               출력 한 줄            {stream: stdout|stderr|info, line}
                      (stdout·stderr는 실행한 명령의 출력, info는 설치 마법사 자신의 안내)
    progress          긴 작업의 진행 단계    {step, phase, label}
    confirm_required  변경 작업 승인 요청    {id, command, reason}
    input_required    값 입력 요청          {id, prompt, secret}
    choice_required   선택지 중 하나 요청    {id, prompt, options: [{id, label}], default}
    dry_run           dry-run이라 실행하지 않은 변경 작업 {id, command, reason}
    error             오류와 해결 안내       {step, message, hint?}

비밀 값 가리기
    모든 이벤트는 출력 직전에 Redactor를 통과한다. 사용자가 입력한 비밀 값(API 키 등)을
    Redactor에 등록해 두면, 이벤트의 어떤 문자열 필드에 섞여 들어가도 `***`로 바뀐다.
    단계 코드가 실수로 비밀 값을 로그에 넣더라도 화면·로그 파일로 새지 않게 하는 마지막 방어선이다.
"""
import json
import shlex
import sys
from typing import Any, TextIO

MASK = "***"

# 점검 항목(check 이벤트)의 상태
CHECK_OK = "ok"       # 통과
CHECK_WARN = "warn"   # 진행은 가능하지만 알아 둘 것 (예: 루트 계정, gh 미설치)
CHECK_FAIL = "fail"   # 이 상태로는 다음 단계를 진행할 수 없음
CHECK_INFO = "info"   # 판단 없이 알려 주는 정보 (예: 리전, 무료 플랜 제약)

# 단계(step_finished 이벤트)의 상태
STEP_OK = "ok"
STEP_SKIPPED = "skipped"   # 이미 되어 있어 할 일이 없었음 (멱등성)
STEP_FAILED = "failed"


class Redactor:
    """등록된 비밀 값을 문자열에서 찾아 `***`로 바꾼다."""

    def __init__(self) -> None:
        self._secrets: set[str] = set()

    def add(self, secret: str | None) -> None:
        # 빈 문자열을 등록하면 모든 문자 사이에 ***가 끼어들므로 무시한다
        if secret:
            self._secrets.add(secret)

    def redact(self, text: str) -> str:
        # 긴 값부터 바꾼다. 짧은 비밀 값이 긴 비밀 값의 일부일 때 짧은 것부터 바꾸면
        # 긴 값의 나머지 부분이 가려지지 않은 채 남기 때문이다.
        for secret in sorted(self._secrets, key=len, reverse=True):
            text = text.replace(secret, MASK)
        return text

    def redact_obj(self, value: Any) -> Any:
        """dict·list 안쪽까지 내려가 모든 문자열을 가린다 (키는 우리가 정한 이름이라 그대로 둔다)."""
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, dict):
            return {key: self.redact_obj(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.redact_obj(item) for item in value]
        return value


def format_command(cmd: list[str], env: dict[str, str] | None = None) -> str:
    """사용자에게 보여 줄 명령 문자열. 셸에 그대로 붙여 넣어도 되도록 인자를 따옴표로 감싼다.
    env를 주면 `AWS_REGION=ap-northeast-2 ./deploy.sh dev`처럼 앞에 붙여, 명령이 어떤 설정으로
    실행되는지 한눈에 보이게 한다. (비밀 값은 이 문자열이 이벤트로 나갈 때 Redactor가 가린다)"""
    prefix = [f"{name}={shlex.quote(value)}" for name, value in (env or {}).items()]
    return " ".join([*prefix, shlex.join(cmd)])


class Emitter:
    """이벤트를 만드는 공통 부분. 실제로 쓰는 방식은 하위 클래스의 `_write`가 정한다."""

    def __init__(self, redactor: Redactor, stream: TextIO | None = None) -> None:
        self.redactor = redactor
        self.stream = stream or sys.stdout

    def emit(self, type_: str, **fields: Any) -> dict:
        # None인 선택 필드(hint 등)는 빼서 앱이 "값 없음"과 "빈 문자열"을 구분하지 않아도 되게 한다
        event = {"type": type_, **{k: v for k, v in fields.items() if v is not None}}
        event = self.redactor.redact_obj(event)
        self._write(event)
        return event

    def _write(self, event: dict) -> None:  # pragma: no cover - 하위 클래스에서 구현
        raise NotImplementedError

    # 아래는 단계 코드가 이벤트 필드 이름을 외우지 않아도 되게 하는 편의 메서드다.

    def step_started(self, step: str, title: str) -> None:
        self.emit("step_started", step=step, title=title)

    def step_finished(self, step: str, status: str, summary: str) -> None:
        self.emit("step_finished", step=step, status=status, summary=summary)

    def check(self, id_: str, title: str, status: str, detail: str, hint: str | None = None,
              url: str | None = None) -> None:
        self.emit("check", id=id_, title=title, status=status, detail=detail, hint=hint, url=url)

    def log(self, line: str, stream: str = "stdout") -> None:
        self.emit("log", stream=stream, line=line)

    def progress(self, step: str, phase: str, label: str) -> None:
        self.emit("progress", step=step, phase=phase, label=label)

    def confirm_required(self, id_: str, command: str, reason: str) -> None:
        self.emit("confirm_required", id=id_, command=command, reason=reason)

    def input_required(self, id_: str, prompt: str, secret: bool = True) -> None:
        self.emit("input_required", id=id_, prompt=prompt, secret=secret)

    def choice_required(self, id_: str, prompt: str, options: list[tuple[str, str]], default: str) -> None:
        self.emit("choice_required", id=id_, prompt=prompt, default=default,
                  options=[{"id": option_id, "label": label} for option_id, label in options])

    def dry_run(self, id_: str, command: str, reason: str) -> None:
        self.emit("dry_run", id=id_, command=command, reason=reason)

    def error(self, step: str, message: str, hint: str | None = None) -> None:
        self.emit("error", step=step, message=message, hint=hint)


class JsonEmitter(Emitter):
    """앱용: 이벤트 하나를 JSON 한 줄로 쓴다."""

    def _write(self, event: dict) -> None:
        # ensure_ascii=False: 한글을 \uXXXX로 바꾸지 않아 로그를 그대로 읽을 수 있다.
        # flush: 파이프로 연결되면 출력이 버퍼에 쌓여 앱 화면이 늦게 갱신되므로 줄마다 내보낸다.
        self.stream.write(json.dumps(event, ensure_ascii=False) + "\n")
        self.stream.flush()


# 사람용 출력에서 상태마다 앞에 붙이는 표시
_CHECK_MARKS = {CHECK_OK: "[ OK ]", CHECK_WARN: "[주의]", CHECK_FAIL: "[실패]", CHECK_INFO: "[정보]"}
_STEP_LABELS = {STEP_OK: "완료", STEP_SKIPPED: "건너뜀", STEP_FAILED: "실패"}


class TextEmitter(Emitter):
    """터미널용: 이벤트 종류별로 읽기 좋은 텍스트를 쓴다."""

    def _write(self, event: dict) -> None:
        kind = event["type"]
        lines: list[str]
        if kind == "step_started":
            lines = ["", f"▶ {event['title']}"]
        elif kind == "step_finished":
            lines = [f"■ {_STEP_LABELS.get(event['status'], event['status'])}: {event['summary']}"]
        elif kind == "check":
            mark = _CHECK_MARKS.get(event["status"], event["status"])
            lines = [f"  {mark} {event['title']}: {event['detail']}"]
            if "hint" in event:
                lines.append(f"         → {event['hint']}")
            if "url" in event:
                lines.append(f"         {event['url']}")
        elif kind == "log":
            prefix = {"stderr": "    ! ", "info": "  · "}.get(event["stream"], "    | ")
            lines = [prefix + event["line"]]
        elif kind == "progress":
            lines = [f"  [{event['phase']}] {event['label']}"]
        elif kind in ("confirm_required", "dry_run"):
            title = "변경 작업" if kind == "confirm_required" else "dry-run (실행하지 않음)"
            lines = [f"  {title}: {event['reason']}", f"    $ {event['command']}"]
        elif kind in ("input_required", "choice_required"):
            lines = []   # 질문 문구는 입력을 받는 쪽(runner.Interaction)이 프롬프트로 직접 보여 준다
        elif kind == "error":
            lines = [f"✗ 오류 ({event['step']}): {event['message']}"]
            if "hint" in event:
                lines.append(f"  → {event['hint']}")
        else:
            lines = [json.dumps(event, ensure_ascii=False)]   # 모르는 종류는 원본 그대로
        for line in lines:
            self.stream.write(line + "\n")
        self.stream.flush()
