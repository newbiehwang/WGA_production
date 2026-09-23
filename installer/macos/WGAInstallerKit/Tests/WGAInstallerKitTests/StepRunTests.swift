import XCTest
@testable import WGAInstallerKit

/// 이벤트 → 화면 상태 전이 (대기 → 진행 → 완료/건너뜀/실패/취소)
final class StepRunTests: XCTestCase {
    func run(_ command: String, _ events: [InstallerEvent], exit: Int32? = nil) -> StepRun {
        var state = StepRun(command: command)
        events.forEach { state.apply($0) }
        if let exit { state.finish(exitCode: exit) }
        return state
    }

    func testRunningUntilExit() {
        let state = run("check", [.stepStarted(step: "check", title: "사전 점검"),
                                  .stepFinished(step: "check", status: .ok, summary: "통과")])
        XCTAssertEqual(state.status, .running)   // 종료 코드를 받기 전까지는 진행 중
        XCTAssertEqual(state.title, "사전 점검")
    }

    func testFinalStatusComesFromExitCode() {
        let ok = run("setup", [.stepFinished(step: "setup", status: .skipped, summary: "")], exit: 0)
        XCTAssertEqual(ok.status, .skipped)
        let failed = run("check", [.stepFinished(step: "check", status: .ok, summary: "")], exit: 1)
        XCTAssertEqual(failed.status, .failed)   // 요약이 ok여도 종료 코드가 실패면 실패
        XCTAssertEqual(run("deploy", [], exit: 130).status, .cancelled)
        XCTAssertEqual(run("check", [], exit: 0).status, .ok)
    }

    func testChecksAreUpdatedInPlace() {
        let state = run("check", [
            .check(id: "aws_cli", title: "AWS CLI", status: .fail, detail: "없음", hint: nil, url: nil),
            .check(id: "node", title: "Node.js", status: .ok, detail: "20", hint: nil, url: nil),
            .check(id: "aws_cli", title: "AWS CLI", status: .ok, detail: "2.17", hint: nil, url: nil),
        ])
        XCTAssertEqual(state.checks.map(\.id), ["aws_cli", "node"])
        XCTAssertEqual(state.checks[0].status, .ok)
    }

    func testSubstepsAndUnfinishedOnes() {
        let state = run("setup", [
            .stepStarted(step: "setup", title: "설정"),
            .stepStarted(step: "quota", title: "할당량"),
            .stepFinished(step: "quota", status: .skipped, summary: "충분함"),
            .stepStarted(step: "ssm_parameters", title: "SSM"),
        ], exit: 130)
        XCTAssertEqual(state.substeps.map(\.status), [.skipped, .cancelled])
        XCTAssertEqual(state.substeps.map(\.title), ["할당량", "SSM"])
    }

    func testPromptIsClearedWhenAnsweredOrFinished() {
        var state = run("setup", [.confirmRequired(id: "put", command: "aws ...", reason: "저장")])
        XCTAssertEqual(state.pending, .confirm(id: "put", command: "aws ...", reason: "저장"))
        state.answered("other")
        XCTAssertNotNil(state.pending)          // 다른 질문의 답으로는 지우지 않는다
        state.answered("put")
        XCTAssertNil(state.pending)
        state.apply(.inputRequired(id: "secret_X", prompt: "키", secret: true))
        state.finish(exitCode: 1)
        XCTAssertNil(state.pending)             // 끝나면 남은 질문도 지운다
    }

    func testMissingPythonIsExplained() {
        let state = run("check", [], exit: 3)
        XCTAssertEqual(state.errors.first?.step, "python")
        XCTAssertTrue(state.errors.first?.hint?.contains("brew install python") == true)
    }

    func testLogIsCapped() {
        var state = StepRun(command: "deploy")
        for index in 0..<(StepRun.maxLogLines + 10) { state.apply(.log(stream: "stdout", line: "\(index)")) }
        XCTAssertEqual(state.logs.count, StepRun.maxLogLines)
        XCTAssertEqual(state.logs.first?.text, "10")
        XCTAssertEqual(state.logs.last?.id, StepRun.maxLogLines + 9)
    }

    func testProgressErrorsAndDryRuns() {
        let state = run("deploy", [
            .progress(step: "deploy", phase: "3/6", label: "패키징"),
            .dryRun(id: "deploy", command: "./deploy.sh dev", reason: "배포"),
            .error(step: "deploy", message: "실패", hint: "setup 먼저"),
            .unknown(type: "new"),
        ])
        XCTAssertEqual(state.progress?.phase, "3/6")
        XCTAssertEqual(state.dryRuns.map(\.command), ["./deploy.sh dev"])
        XCTAssertEqual(state.errors, [ErrorItem(step: "deploy", message: "실패", hint: "setup 먼저")])
    }
}
