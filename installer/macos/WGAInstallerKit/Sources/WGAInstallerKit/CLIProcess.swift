import Foundation

/// CLI(installer/core)를 실행하는 방법. 실제로는 ProcessLauncher, 테스트에서는 가짜를 쓴다.
public protocol CLILaunching: Sendable {
    /// CLI를 실행한다. 이벤트와 종료는 콜백으로 알린다 (호출되는 스레드는 정해져 있지 않다).
    func launch(command: String, arguments: [String],
                onEvent: @escaping @Sendable (InstallerEvent) -> Void,
                onExit: @escaping @Sendable (Int32) -> Void) throws -> CLISession
}

/// 실행 중인 CLI 하나
public protocol CLISession: AnyObject, Sendable {
    /// 질문에 답한다 (stdin에 JSON 한 줄)
    func respond(_ response: InstallerResponse)
    /// 취소한다 (SIGINT). CLI가 자식 프로세스(deploy.sh 등)까지 정리한 뒤 종료 코드 130으로 끝난다
    func cancel()
}

public enum ProcessSignals {
    /// 닫힌 파이프에 쓰면 커널이 SIGPIPE를 보내고, 기본 동작은 프로세스 종료다. 앱은 CLI·헬퍼에 stdin으로 쓰는데
    /// 상대가 먼저 끝날 수 있으므로, 앱 시작 때 이 신호를 무시해 쓰기가 EPIPE 오류로 끝나게 한다.
    public static func ignoreBrokenPipe() {
        signal(SIGPIPE, SIG_IGN)
    }
}

/// 줄 단위로 끊어 읽는 버퍼. 파이프는 줄 중간에서 끊겨 도착할 수 있어서, 줄바꿈이 올 때까지 모았다가 넘긴다.
public final class LineBuffer: @unchecked Sendable {
    private var pending = Data()
    private let lock = NSLock()

    public init() {}

    /// 새로 받은 바이트를 넣고, 완성된 줄들을 돌려준다
    public func append(_ data: Data) -> [String] {
        lock.lock(); defer { lock.unlock() }
        pending.append(data)
        var lines: [String] = []
        while let index = pending.firstIndex(of: 0x0A) {   // "\n"
            let lineData = pending[pending.startIndex..<index]
            lines.append(String(decoding: lineData, as: UTF8.self))
            pending.removeSubrange(pending.startIndex...index)
        }
        return lines
    }

    /// 끝났을 때 줄바꿈 없이 남은 마지막 조각
    public func flush() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard !pending.isEmpty else { return nil }
        defer { pending.removeAll() }
        return String(decoding: pending, as: UTF8.self)
    }
}

/// `/bin/bash <core>/wga-installer <명령> --json ...`으로 CLI를 실행한다.
///
/// 실행기(wga-installer)를 거치는 이유: 3.10 이상 Python을 고르는 규칙(Homebrew 우선, Command Line Tools가 없으면
/// /usr/bin/python3를 건드리지 않음)이 그 스크립트 한곳에 있다. 앱이 따로 Python을 고르면 터미널과 규칙이 어긋난다.
public struct ProcessLauncher: CLILaunching {
    public let location: InstallerLocation
    public let environment: [String: String]

    public init(location: InstallerLocation, environment: [String: String] = ToolPath.environment()) {
        self.location = location
        self.environment = environment
    }

    public func launch(command: String, arguments: [String],
                       onEvent: @escaping @Sendable (InstallerEvent) -> Void,
                       onExit: @escaping @Sendable (Int32) -> Void) throws -> CLISession {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [location.launcher.path, command, "--json"] + arguments
        process.environment = environment
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        // stdout: 이벤트 (한 줄에 JSON 하나). 해석하지 못한 줄은 로그로 보여 준다
        let outBuffer = LineBuffer()
        let handleOut: @Sendable (String) -> Void = { line in
            onEvent(InstallerEvent.parse(line: line) ?? .log(stream: "stdout", line: line))
        }
        stdout.fileHandleForReading.readabilityHandler = { handle in
            outBuffer.append(handle.availableData).forEach(handleOut)
        }
        // stderr: CLI 자신의 오류 (예상하지 못한 예외의 스택 등, CLI가 비밀 값을 가린 상태로 쓴다)
        let errBuffer = LineBuffer()
        stderr.fileHandleForReading.readabilityHandler = { handle in
            errBuffer.append(handle.availableData).forEach { onEvent(.log(stream: "stderr", line: $0)) }
        }
        process.terminationHandler = { finished in
            // 종료된 뒤에도 파이프에 남은 내용을 마저 읽는다 (readabilityHandler가 마지막 조각을 놓칠 수 있다)
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            outBuffer.append(stdout.fileHandleForReading.readDataToEndOfFile()).forEach(handleOut)
            if let rest = outBuffer.flush() { handleOut(rest) }
            errBuffer.append(stderr.fileHandleForReading.readDataToEndOfFile()).forEach {
                onEvent(.log(stream: "stderr", line: $0))
            }
            onExit(finished.terminationStatus)
        }
        try process.run()
        return ProcessSession(process: process, stdin: stdin.fileHandleForWriting)
    }
}

final class ProcessSession: CLISession, @unchecked Sendable {
    private let process: Process
    private let stdin: FileHandle
    private let lock = NSLock()

    init(process: Process, stdin: FileHandle) {
        self.process = process
        self.stdin = stdin
    }

    func respond(_ response: InstallerResponse) {
        lock.lock(); defer { lock.unlock() }
        guard process.isRunning else { return }
        // 비밀 값이 담긴 줄은 파이프로만 넘기고 어디에도 기록하지 않는다.
        // CLI가 막 끝나 파이프가 닫혔으면 쓰기가 실패한다. SIGPIPE를 무시해 두었으므로(ignoreBrokenPipe)
        // 프로세스가 죽지 않고 오류로 돌아오며, 그 오류는 버린다 (종료는 onExit으로 따로 알린다)
        try? stdin.write(contentsOf: Data(response.jsonLine().utf8))
    }

    func cancel() {
        // SIGINT: CLI는 Ctrl+C와 똑같이 처리해 deploy.sh와 그 자식 프로세스 그룹까지 정리한다 (runner.py 참고)
        if process.isRunning { process.interrupt() }
    }
}
