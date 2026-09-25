"""위협 모델 문서(docs/threat-model.md)가 코드와 어긋나지 않았는지

- 표에 적은 테스트(tests/test_x.py::test_name)가 모두 실제로 있다. 테스트 이름을 바꾸거나 지우면 문서도 고쳐야 한다
- 위협(T…)마다 확인하는 테스트가 하나 이상 있다
"""
import re

from conftest import ROOT

DOC = ROOT / "docs" / "threat-model.md"
REFERENCE = re.compile(r"`(tests/test_\w+\.py)::(test_\w+)`")


def threat_rows():
    """4절 표의 행: (번호, 행 전체)."""
    return [(match.group(1), line) for line in DOC.read_text(encoding="utf-8").splitlines()
            if (match := re.match(r"\| (T\d+) \|", line))]


def test_every_referenced_test_exists():
    references = REFERENCE.findall(DOC.read_text(encoding="utf-8"))
    assert references
    missing = [f"{path}::{name}" for path, name in references
               if not (ROOT / path).exists()
               or not re.search(rf"^def {name}\(", (ROOT / path).read_text(encoding="utf-8"), re.M)]
    assert missing == []


def test_every_threat_has_a_test():
    rows = threat_rows()
    assert len(rows) >= 30
    assert [number for number, line in rows if not REFERENCE.search(line)] == []
    # 번호가 빠지거나 겹치지 않는다
    assert [number for number, _ in rows] == [f"T{i}" for i in range(1, len(rows) + 1)]
