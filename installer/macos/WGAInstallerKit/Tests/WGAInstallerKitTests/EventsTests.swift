import XCTest
@testable import WGAInstallerKit

/// CLI 이벤트 해석과 응답 형식 (형식 원본: installer/core/README.md "앱과 주고받는 형식")
final class EventsTests: XCTestCase {
    func testDecodesEveryEventType() {
        let lines: [(String, InstallerEvent)] = [
            (#"{"type": "step_started", "step": "check", "title": "사전 점검"}"#,
             .stepStarted(step: "check", title: "사전 점검")),
            (#"{"type": "step_finished", "step": "check", "status": "skipped", "summary": "이미 됨"}"#,
             .stepFinished(step: "check", status: .skipped, summary: "이미 됨")),
            (#"{"type": "check", "id": "aws_cli", "title": "AWS CLI", "status": "fail", "detail": "없음", "hint": "brew install awscli"}"#,
             .check(id: "aws_cli", title: "AWS CLI", status: .fail, detail: "없음", hint: "brew install awscli", url: nil)),
            (#"{"type": "check", "id": "frontend", "title": "프론트엔드", "status": "ok", "detail": "200", "url": "https://x"}"#,
             .check(id: "frontend", title: "프론트엔드", status: .ok, detail: "200", hint: nil, url: "https://x")),
            (#"{"type": "log", "stream": "stderr", "line": "경고"}"#, .log(stream: "stderr", line: "경고")),
            (#"{"type": "progress", "step": "deploy", "phase": "3/6", "label": "Layer 및 Lambda 함수 패키징"}"#,
             .progress(step: "deploy", phase: "3/6", label: "Layer 및 Lambda 함수 패키징")),
            (#"{"type": "confirm_required", "id": "put", "command": "aws ssm put-parameter", "reason": "저장"}"#,
             .confirmRequired(id: "put", command: "aws ssm put-parameter", reason: "저장")),
            (#"{"type": "input_required", "id": "confirm_env", "prompt": "환경 이름", "secret": false}"#,
             .inputRequired(id: "confirm_env", prompt: "환경 이름", secret: false)),
            (#"{"type": "choice_required", "id": "c", "prompt": "있음", "default": "keep", "options": [{"id": "keep", "label": "유지"}]}"#,
             .choiceRequired(id: "c", prompt: "있음", options: [ChoiceOption(id: "keep", label: "유지")], defaultChoice: "keep")),
            (#"{"type": "dry_run", "id": "d", "command": "./deploy.sh dev", "reason": "배포"}"#,
             .dryRun(id: "d", command: "./deploy.sh dev", reason: "배포")),
            (#"{"type": "error", "step": "python", "message": "없음"}"#, .error(step: "python", message: "없음", hint: nil)),
        ]
        for (line, expected) in lines {
            XCTAssertEqual(InstallerEvent.parse(line: line), expected, line)
        }
    }

    func testUnknownTypeDoesNotBreak() {
        // 새 버전 CLI가 이벤트를 추가해도 앱이 멈추지 않는다
        XCTAssertEqual(InstallerEvent.parse(line: #"{"type": "something_new", "x": 1}"#), .unknown(type: "something_new"))
    }

    func testInvalidLinesAreNil() {
        XCTAssertNil(InstallerEvent.parse(line: "Traceback (most recent call last):"))
        XCTAssertNil(InstallerEvent.parse(line: ""))
        XCTAssertNil(InstallerEvent.parse(line: #"{"type": "check"}"#))   // 필수 필드 없음
    }

    func testResponsesMatchCLIProtocol() {
        XCTAssertEqual(InstallerResponse.confirm(id: "put", approved: true).jsonLine(),
                       #"{"approved":true,"id":"put","type":"confirm_response"}"# + "\n")
        XCTAssertEqual(InstallerResponse.choice(id: "c", choice: "keep").jsonLine(),
                       #"{"choice":"keep","id":"c","type":"choice_response"}"# + "\n")
        XCTAssertEqual(InstallerResponse.text(id: "confirm_env", value: "dev").jsonLine(),
                       #"{"id":"confirm_env","type":"text_response","value":"dev"}"# + "\n")
        // 따옴표·줄바꿈이 있어도 한 줄 JSON으로 안전하게 만든다
        let secret = InstallerResponse.secret(id: "s", value: "a\"b\nc").jsonLine()
        XCTAssertEqual(secret.filter { $0 == "\n" }.count, 1)
        let decoded = try! JSONSerialization.jsonObject(with: Data(secret.utf8)) as! [String: String]
        XCTAssertEqual(decoded["value"], "a\"b\nc")
    }

    func testLineBufferJoinsSplitChunks() {
        let buffer = LineBuffer()
        XCTAssertEqual(buffer.append(Data("{\"a\":".utf8)), [])
        XCTAssertEqual(buffer.append(Data("1}\n{\"b\"".utf8)), ["{\"a\":1}"])
        XCTAssertEqual(buffer.append(Data(":2}\n한글\n".utf8)), ["{\"b\":2}", "한글"])
        XCTAssertEqual(buffer.append(Data("끝".utf8)), [])
        XCTAssertEqual(buffer.flush(), "끝")
        XCTAssertNil(buffer.flush())
    }

    func testLineBufferKeepsMultibyteCharacterSplitAcrossChunks() {
        // 파이프는 UTF-8 한 글자(3바이트)의 중간에서 끊겨 도착할 수 있다
        let bytes = Array("가\n".utf8)
        let buffer = LineBuffer()
        XCTAssertEqual(buffer.append(Data(bytes[0..<2])), [])
        XCTAssertEqual(buffer.append(Data(bytes[2...])), ["가"])
    }

    func testToolPathAddsHomebrewForFinderLaunchedApp() {
        // Finder에서 연 앱의 PATH에는 Homebrew 폴더가 없다
        XCTAssertEqual(ToolPath.augmented("/usr/bin:/bin:/usr/sbin:/sbin"),
                       "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        XCTAssertEqual(ToolPath.augmented("/opt/homebrew/bin:/usr/bin"),
                       "/opt/homebrew/sbin:/usr/local/bin:/opt/homebrew/bin:/usr/bin")
        XCTAssertEqual(ToolPath.augmented(nil),
                       "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    }

    func testCopyableCommandFromHint() {
        // 실제 CLI 안내 문구 (installer/core/wga_installer/steps/check.py)
        XCTAssertEqual(CommandHint.copyableCommand(in: "brew install awscli v1이 설치되어 있다면 먼저 제거하세요 (pip uninstall awscli)"),
                       "brew install awscli")
        XCTAssertEqual(CommandHint.copyableCommand(in: "brew upgrade node"), "brew upgrade node")
        XCTAssertEqual(CommandHint.copyableCommand(in: "GitHub 자동 배포 단계 전에 gh auth login을 실행하세요"), "gh auth login")
        XCTAssertNil(CommandHint.copyableCommand(in: "IAM 콘솔에서 키 상태를 확인하세요"))
    }
}
