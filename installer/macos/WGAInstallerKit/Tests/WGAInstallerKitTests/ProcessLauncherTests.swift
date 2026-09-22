import XCTest
@testable import WGAInstallerKit

/// 실제 프로세스로 CLI 연결을 확인한다: stdout 이벤트 해석, stdin 응답, 종료 코드, 취소(SIGINT).
/// installer/core 대신 같은 프로토콜로 동작하는 가짜 wga-installer 스크립트를 쓴다.
final class ProcessLauncherTests: XCTestCase {
    var core: URL!

    override func setUp() {
        ProcessSignals.ignoreBrokenPipe()
        core = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: core, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: core)
    }

    func writeLauncher(_ body: String) {
        let url = core.appendingPathComponent("wga-installer")
        try! ("#!/bin/bash\n" + body).write(to: url, atomically: true, encoding: .utf8)
    }

    /// 이벤트와 종료 코드를 모은다
    final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var _events: [InstallerEvent] = []
        let exited = XCTestExpectation(description: "종료")
        var code: Int32 = -1
        var events: [InstallerEvent] { lock.lock(); defer { lock.unlock() }; return _events }
        func add(_ event: InstallerEvent) { lock.lock(); _events.append(event); lock.unlock() }
    }

    func launch(_ command: String = "check", _ arguments: [String] = [], collector: Collector,
                environment: [String: String] = ToolPath.environment()) throws -> CLISession {
        let launcher = ProcessLauncher(location: InstallerLocation(coreDirectory: core,
                                                                   helperExecutable: URL(fileURLWithPath: "/dev/null")),
                                       environment: environment)
        return try launcher.launch(command: command, arguments: arguments, onEvent: { collector.add($0) },
                                   onExit: { code in collector.code = code; collector.exited.fulfill() })
    }

    func testEventsArgumentsAndExitCode() throws {
        writeLauncher(#"""
        echo "{\"type\": \"log\", \"stream\": \"info\", \"line\": \"args=$*\"}"
        echo '{"type": "check", "id": "aws_cli", "title": "AWS CLI", "status": "ok", "detail": "2.17"}'
        echo "이벤트가 아닌 줄"
        echo "stderr 줄" >&2
        printf '{"type": "step_finished", "step": "check", "status": "ok", "summary": "끝"}'
        exit 1
        """#)
        let collector = Collector()
        _ = try launch("check", ["--env", "dev"], collector: collector)
        wait(for: [collector.exited], timeout: 10)
        XCTAssertEqual(collector.code, 1)
        let events = collector.events
        XCTAssertTrue(events.contains(.log(stream: "info", line: "args=check --json --env dev")))
        XCTAssertTrue(events.contains(.check(id: "aws_cli", title: "AWS CLI", status: .ok, detail: "2.17", hint: nil, url: nil)))
        XCTAssertTrue(events.contains(.log(stream: "stdout", line: "이벤트가 아닌 줄")))
        XCTAssertTrue(events.contains(.log(stream: "stderr", line: "stderr 줄")))
        // 줄바꿈 없이 끝난 마지막 줄도 놓치지 않는다
        XCTAssertTrue(events.contains(.stepFinished(step: "check", status: .ok, summary: "끝")))
    }

    func testResponseReachesCLIThroughStdin() throws {
        writeLauncher(#"""
        echo '{"type": "confirm_required", "id": "put", "command": "aws", "reason": "저장"}'
        read -r answer
        # 받은 줄을 JSON 문자열로 되돌려 보낸다 (큰따옴표만 이스케이프. /usr/bin/python3는 Command Line Tools가
        # 없는 Mac에서 설치 창을 띄우므로 쓰지 않는다)
        escaped=${answer//\"/\\\"}
        echo "{\"type\": \"log\", \"stream\": \"info\", \"line\": \"$escaped\"}"
        """#)
        let collector = Collector()
        let session = try launch(collector: collector)
        // 질문이 올 때까지 기다린 뒤 답한다
        let deadline = Date().addingTimeInterval(10)
        while !collector.events.contains(where: { if case .confirmRequired = $0 { return true }; return false }),
              Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        session.respond(.confirm(id: "put", approved: true))
        wait(for: [collector.exited], timeout: 10)
        XCTAssertTrue(collector.events.contains(.log(stream: "info",
                                                     line: #"{"approved":true,"id":"put","type":"confirm_response"}"#)))
    }

    func testCancelSendsSigint() throws {
        // 실제 CLI처럼 SIGINT를 받으면 130으로 끝나는지
        writeLauncher(#"""
        trap 'echo "{\"type\": \"error\", \"step\": \"deploy\", \"message\": \"취소됨\"}"; exit 130' INT
        echo '{"type": "progress", "step": "deploy", "phase": "1/6", "label": "시작"}'
        while true; do /bin/sleep 0.1; done
        """#)
        let collector = Collector()
        let session = try launch("deploy", collector: collector)
        let deadline = Date().addingTimeInterval(10)
        while collector.events.isEmpty, Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        session.cancel()
        wait(for: [collector.exited], timeout: 10)
        XCTAssertEqual(collector.code, 130)
        XCTAssertTrue(collector.events.contains(.error(step: "deploy", message: "취소됨", hint: nil)))
    }

    func testPathIncludesHomebrew() throws {
        writeLauncher(#"echo "{\"type\": \"log\", \"stream\": \"info\", \"line\": \"$PATH\"}""#)
        let collector = Collector()
        _ = try launch(collector: collector, environment: ToolPath.environment(["PATH": "/usr/bin:/bin"]))
        wait(for: [collector.exited], timeout: 10)
        XCTAssertTrue(collector.events.contains(.log(stream: "info", line: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin")))
    }

    func testRespondAfterExitDoesNotCrash() throws {
        writeLauncher("exit 0\n")
        let collector = Collector()
        let session = try launch(collector: collector)
        wait(for: [collector.exited], timeout: 10)
        session.respond(.confirm(id: "x", approved: true))   // 닫힌 파이프에 써도 앱이 죽지 않는다
    }
}

/// 저장소의 진짜 installer/core와 연결되는지 (가짜 스크립트가 아닌 실제 CLI).
/// 실제 check는 이 Mac의 도구와 AWS 자격 증명을 조회하므로(읽기 전용) 기본으로는 건너뛴다.
/// 확인하려면: WGA_CORE_E2E=1 swift test --filter RealCoreTests
final class RealCoreTests: XCTestCase {
    func testCheckDryRunAgainstRealCore() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["WGA_CORE_E2E"] == "1", "WGA_CORE_E2E=1일 때만 실행")
        ProcessSignals.ignoreBrokenPipe()
        // 이 파일 위치에서 저장소의 installer/core를 찾는다: installer/macos/WGAInstallerKit/Tests/WGAInstallerKitTests/
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../..").standardizedFileURL
        let launcher = ProcessLauncher(location: InstallerLocation(
            coreDirectory: repo.appendingPathComponent("installer/core"), helperExecutable: URL(fileURLWithPath: "/dev/null")))
        let collector = ProcessLauncherTests.Collector()
        _ = try launcher.launch(command: "check", arguments: ["--dry-run", "--repo", repo.path],
                                onEvent: { collector.add($0) },
                                onExit: { code in collector.code = code; collector.exited.fulfill() })
        wait(for: [collector.exited], timeout: 120)

        var run = StepRun(command: "check")
        collector.events.forEach { run.apply($0) }
        run.finish(exitCode: collector.code)
        // 이 Mac의 자격 증명 상태에 따라 통과(0)나 실패(1)가 될 수 있다. 연결이 제대로 됐는지만 본다
        XCTAssertTrue([0, 1].contains(collector.code))
        XCTAssertEqual(run.title, "사전 점검")
        XCTAssertTrue(run.checks.contains { $0.id == "repo" && $0.status == .ok }, "\(run.checks)")
        XCTAssertTrue(run.checks.contains { $0.id == "python" && $0.status == .ok })
        XCTAssertNotNil(run.summary)
        print("실제 CLI 점검 결과:", run.checks.map { "\($0.id)=\($0.status.rawValue)" }.joined(separator: ", "))
    }

    /// dry-run으로 전 과정(사전 설정 → 배포 → 검증 → GitHub 자동 배포 → 정리)을 실제 CLI로 실행한다.
    /// 이 Mac의 자격 증명 상태에 따라 단계가 사전 확인에서 실패할 수는 있지만, 어느 단계도 변경 승인을
    /// 묻지 않아야 한다 (dry-run은 아무것도 바꾸지 않으므로 승인할 일이 없다).
    func testWholeFlowInDryRunNeverAsksToChangeAnything() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["WGA_CORE_E2E"] == "1", "WGA_CORE_E2E=1일 때만 실행")
        ProcessSignals.ignoreBrokenPipe()
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../..").standardizedFileURL
        let launcher = ProcessLauncher(location: InstallerLocation(
            coreDirectory: repo.appendingPathComponent("installer/core"), helperExecutable: URL(fileURLWithPath: "/dev/null")))

        for command in ["setup", "deploy", "verify", "oidc", "teardown"] {
            let collector = ProcessLauncherTests.Collector()
            var session: CLISession?
            session = try launcher.launch(command: command, arguments: ["--dry-run", "--repo", repo.path],
                                          onEvent: { event in
                                              collector.add(event)
                                              // 혹시 질문이 오면 바꾸지 않는 쪽으로 답해 멈추지 않게 한다
                                              switch event {
                                              case let .confirmRequired(id, _, _): session?.respond(.confirm(id: id, approved: false))
                                              case let .choiceRequired(id, _, _, choice): session?.respond(.choice(id: id, choice: choice))
                                              case let .inputRequired(id, _, _): session?.respond(.text(id: id, value: ""))
                                              default: break
                                              }
                                          },
                                          onExit: { code in collector.code = code; collector.exited.fulfill() })
            wait(for: [collector.exited], timeout: 180)
            var run = StepRun(command: command)
            collector.events.forEach { run.apply($0) }
            run.finish(exitCode: collector.code)

            XCTAssertTrue([0, 1].contains(collector.code), "\(command) 종료 코드 \(collector.code)")
            XCTAssertNotNil(run.title, "\(command)가 시작 이벤트를 보내지 않았습니다")
            let asked = collector.events.filter { if case .confirmRequired = $0 { return true }; return false }
            XCTAssertTrue(asked.isEmpty, "\(command)가 dry-run에서 변경 승인을 물었습니다: \(asked)")
            print("dry-run \(command): 종료 코드 \(collector.code), 실행하지 않은 명령 \(run.dryRuns.count)개, "
                  + "오류 \(run.errors.map(\.message).prefix(2))")
        }
    }
}
