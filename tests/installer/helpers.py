"""설치 마법사 테스트 도우미: 가짜 CLI와 CLI 실행 함수 (픽스처는 conftest.py)

실제 AWS·GitHub에 요청이 나가지 않도록, CLI를 실행할 때 PATH를 가짜 명령만 있는 폴더 하나로 제한한다.
그래서 테스트가 설치하지 않은 도구는 "설치되어 있지 않음"으로 보인다.

가짜 명령은 fakes/fake_tool.sh 하나를 도구 이름으로 링크해 쓴다 (자세한 방식은 그 파일의 주석).
tests/test_deploy_sh.py의 fake_aws처럼 규칙을 bash case 문으로 표현한다.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "installer" / "core"
FAKE_TOOL = Path(__file__).parent / "fakes" / "fake_tool.sh"

IDENTITY = {"UserId": "AIDAEXAMPLE", "Account": "123456789012",
            "Arn": "arn:aws:iam::123456789012:user/wga-installer"}

# 호출 기록 한 줄의 구분 문자: 도구·인자 사이는 US(0x1f), 인자 부분과 환경 변수 부분 사이는 RS(0x1e).
# 인자에 공백·따옴표가 있어도 안전하게 나눌 수 있도록 일반 텍스트에 나오지 않는 제어 문자를 쓴다.
US, RS = "\x1f", "\x1e"


def sh_quote(text: str) -> str:
    """bash 작은따옴표 문자열로 감싼다 (안의 작은따옴표는 '\\''로 끊어 넣는다)."""
    return "'" + text.replace("'", "'\\''") + "'"


class FakeCli:
    """가짜 외부 명령 모음. 규칙: tool 실행 시 인자(공백으로 이은 문자열)에 match가 들어 있으면
    stdout·stderr·종료 코드를 돌려준다. 먼저 추가한 규칙이 우선이다.
    맞는 규칙이 없으면 종료 코드 99로 실패한다. 예상하지 못한 명령(특히 변경 명령)이
    조용히 성공한 것처럼 보이지 않게 하기 위해서다."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.bin = root / "bin"
        self.bin.mkdir()
        self.rules_dir = root / "rules"
        self.rules_dir.mkdir()
        self.log_path = root / "calls.log"
        self.rules: dict[str, list[dict]] = {}

    def add(self, tool: str, match: str, stdout: str = "", stderr: str = "", exit: int = 0,
            sleep: float = 0) -> "FakeCli":
        self.rules.setdefault(tool, []).append(
            {"match": match, "stdout": stdout, "stderr": stderr, "exit": exit, "sleep": sleep})
        self._write(tool)
        return self

    def remove(self, tool: str) -> None:
        """도구를 없앤다 (설치되지 않은 상황)."""
        (self.bin / tool).unlink(missing_ok=True)
        (self.rules_dir / f"{tool}.sh").unlink(missing_ok=True)
        self.rules.pop(tool, None)

    def calls(self, tool: str | None = None) -> list[dict]:
        """호출 기록: [{"tool": "aws", "args": [...], "env": {...}}, ...]"""
        if not self.log_path.exists():
            return []
        entries = []
        # splitlines()는 구분 문자(0x1e 등)도 줄바꿈으로 취급하므로 \n으로만 나눈다
        for line in self.log_path.read_text().split("\n")[:-1]:
            head, env_part = line.split(RS)
            name, *args = head.split(US)
            env = dict(pair.split("=", 1) for pair in env_part.split(US) if pair)
            entries.append({"tool": name, "args": args, "env": env})
        return [e for e in entries if tool is None or e["tool"] == tool]

    def env(self, **extra: str) -> dict[str, str]:
        return {"PATH": str(self.bin), "HOME": str(self.root), "PYTHONPATH": str(CORE),
                "FAKE_CLI_LOG": str(self.log_path), "FAKE_CLI_RULES": str(self.rules_dir), **extra}

    def _write(self, tool: str) -> None:
        """규칙을 case 문으로 옮긴 규칙 파일을 쓰고, 도구 이름의 링크를 만든다."""
        lines = ['case "$*" in']
        for rule in self.rules[tool]:
            body = []
            if rule["sleep"]:
                body.append(f"/bin/sleep {rule['sleep']}")   # 제한 시간 초과를 흉내 낸다
            body.append("printf '%s' " + sh_quote(rule["stdout"]))
            body.append("printf '%s' " + sh_quote(rule["stderr"]) + " >&2")
            body.append(f"exit {rule['exit']}")
            lines.append(f"  *{sh_quote(rule['match'])}*) " + "; ".join(body) + " ;;")
        lines += ["esac", ""]
        (self.rules_dir / f"{tool}.sh").write_text("\n".join(lines))
        link = self.bin / tool
        if not link.is_symlink():
            link.symlink_to(FAKE_TOOL)


def healthy_mac(fake: FakeCli, identity: dict | None = None) -> FakeCli:
    """모든 점검을 통과하는 Mac을 흉내 낸다. 테스트는 여기서 필요한 부분만 바꾼다
    (앞에 규칙을 추가하면 먼저 맞으므로, 바꿀 규칙은 이 함수 호출 전에 add한다)."""
    fake.add("uname", "-s", "Darwin\n").add("uname", "-m", "arm64\n")
    fake.add("sw_vers", "-productVersion", "14.5\n")
    fake.add("aws", "--version", "aws-cli/2.17.0 Python/3.11.8 Darwin/23.5.0 exe/arm64\n")
    fake.add("aws", "configure get region", exit=1)   # 프로필에 리전 없음 → 기본값 서울
    fake.add("aws", "sts get-caller-identity", json.dumps(identity or IDENTITY))
    fake.add("gh", "--version", "gh version 2.50.0 (2024-06-01)\n")
    fake.add("gh", "auth status", "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n")
    fake.add("git", "--version", "git version 2.45.1\n")
    fake.add("git", "rev-parse", "abcdef123456\n")
    fake.add("node", "--version", "v20.14.0\n")
    fake.add("npm", "--version", "10.7.0\n")
    fake.add("zip", "-v", "Copyright (c) 1990-2008 Info-ZIP\nThis is Zip 3.0 (July 5th 2008), by Info-ZIP.\n")
    fake.add("unzip", "-v", "UnZip 6.00 of 20 April 2009, by Info-ZIP.\n")
    fake.add("pip", "--version", "pip 24.0 from /opt/homebrew/lib/python3.12/site-packages/pip (python 3.12)\n")
    fake.add("brew", "--version", "Homebrew 4.3.5\n")
    return fake


def run_cli(fake: FakeCli, *args: str, input: str = "", cwd: Path | None = None,
            env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """`python -m wga_installer ...`를 별도 프로세스로 실행한다 (실제 사용과 같은 방식)."""
    return subprocess.run([sys.executable, "-m", "wga_installer", *args], input=input,
                          capture_output=True, text=True, cwd=cwd or fake.root,
                          env=env or fake.env(), timeout=60)


def events(stdout: str) -> list[dict]:
    """JSON Lines 출력을 이벤트 목록으로 바꾼다. 한 줄이라도 JSON이 아니면 실패한다 (앱이 파싱하지 못함)."""
    return [json.loads(line) for line in stdout.splitlines()]


def checks_by_id(stdout: str) -> dict[str, dict]:
    return {e["id"]: e for e in events(stdout) if e["type"] == "check"}
