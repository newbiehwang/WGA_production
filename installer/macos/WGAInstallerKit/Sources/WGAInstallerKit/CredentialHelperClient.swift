import Foundation

/// 앱이 wga-credential-helper를 실행하는 방법. 키체인은 헬퍼만 다룬다 (CredentialStore/KeychainStore.swift 설명 참고).
public protocol CredentialHelping: Sendable {
    /// 자격 증명을 저장한다. 비밀 값은 stdin으로만 넘긴다. 실패하면 헬퍼가 쓴 오류 설명을 던진다.
    func store(accessKeyId: String, secretAccessKey: String) throws
    func status() throws -> HelperStatus
    func delete() throws
}

public struct HelperStatus: Decodable, Equatable, Sendable {
    public let stored: Bool
    public let maskedAccessKeyId: String?

    public init(stored: Bool, maskedAccessKeyId: String?) {
        self.stored = stored
        self.maskedAccessKeyId = maskedAccessKeyId
    }
}

public struct HelperError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

public struct CredentialHelperClient: CredentialHelping {
    public let executable: URL
    public let environment: [String: String]

    public init(executable: URL, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.executable = executable
        self.environment = environment
    }

    public func store(accessKeyId: String, secretAccessKey: String) throws {
        // JSONSerialization으로 만들어 따옴표·역슬래시가 있어도 형식이 깨지지 않게 한다
        let payload = try JSONSerialization.data(withJSONObject: ["AccessKeyId": accessKeyId,
                                                                  "SecretAccessKey": secretAccessKey])
        _ = try run(["store"], input: payload)
    }

    public func status() throws -> HelperStatus {
        let output = try run(["status"], input: Data())
        return try JSONDecoder().decode(HelperStatus.self, from: output)
    }

    public func delete() throws {
        _ = try run(["delete"], input: Data())
    }

    private func run(_ arguments: [String], input: Data) throws -> Data {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments          // 인자에는 명령 이름만 (비밀 값은 넣지 않는다)
        process.environment = environment
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        // 헬퍼가 입력을 읽기 전에 끝나면(예: 잘못된 명령) 파이프가 닫혀 있을 수 있다. SIGPIPE를 무시해 두었으므로
        // (ProcessSignals.ignoreBrokenPipe) 쓰기는 오류로 끝나고, 실제 원인은 아래의 종료 코드·stderr로 알린다.
        // 출력은 몇 줄뿐이라 stdout을 다 읽은 뒤 stderr를 읽어도 파이프가 차서 멈추는 일은 없다
        try? stdin.fileHandleForWriting.write(contentsOf: input)
        try? stdin.fileHandleForWriting.close()
        let out = stdout.fileHandleForReading.readDataToEndOfFile()
        let err = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(decoding: err, as: UTF8.self)
                .replacingOccurrences(of: "wga-credential-helper: ", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw HelperError(message: message.isEmpty ? "헬퍼가 종료 코드 \(process.terminationStatus)로 실패했습니다" : message)
        }
        return out
    }
}
