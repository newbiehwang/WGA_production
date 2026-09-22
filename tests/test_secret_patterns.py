"""저장소에 실제 비밀 값 형식의 문자열이 들어오지 않았는지 검사한다.

이 저장소는 공개 저장소라, 키 모양 문자열이 한 번이라도 푸시되면 GitHub 비밀 값 스캔이 "공개 유출" 알림을 연다.
테스트용 가짜 값이라도 실제 형식과 같으면 감지된다 (예: AWS 문서 예시 키의 앞 네 글자를 ASIA로 바꾼 값).
테스트에서 이런 값이 필요하면 실행할 때 조각을 이어 붙여 만든다 (installer/macos/WGAInstallerKit/Tests/*/TestKeys.swift).
"""
import re
import subprocess

from conftest import ROOT

# 실제 발급 형식 (GitHub 비밀 값 스캔이 감지하는 형식과 같은 수준으로 좁게 잡는다)
PATTERNS = {
    "AWS Access Key ID": re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b"),
    "Anthropic API 키": re.compile(r"sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}"),
    "Slack 토큰": re.compile(r"xox[abprs]-\d{6,}-[A-Za-z0-9-]+"),
    "GitHub 토큰": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "개인 키": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
}


def tracked_files():
    output = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return [ROOT / name for name in output.decode().split("\0") if name]


def test_no_secret_shaped_strings_in_repository():
    offenders = []
    for path in tracked_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue   # 이미지 같은 바이너리, 작업 트리에서 지운 파일
        for name, pattern in PATTERNS.items():
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                offenders.append(f"{path.relative_to(ROOT)}:{line}: {name}")
    assert not offenders, "비밀 값 형식의 문자열이 있습니다 (테스트 값이면 조각을 이어 붙여 만드세요):\n" + "\n".join(offenders)


def test_patterns_catch_the_value_that_was_flagged():
    # GitHub가 감지했던 값과 같은 형식을 이 검사도 잡는지 (값은 조각으로 만든다)
    flagged = "AS" + "IA" + "IOSFODNN7EXAMPLE"
    assert PATTERNS["AWS Access Key ID"].search(flagged)
    assert not PATTERNS["AWS Access Key ID"].search("AKIA" + "SHORT")
