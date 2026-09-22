import XCTest
@testable import CredentialStore

/// 실제 키체인 동작 확인. 로그인 키체인을 건드리지 않도록 임시 키체인 파일을 만들어 쓴다.
///
/// 키체인 파일을 만들고 여는 것은 사용자 환경(검색 목록)에 닿으므로 기본으로는 건너뛴다.
/// 확인하려면: WGA_KEYCHAIN_TESTS=1 swift test --filter KeychainIntegrationTests
final class KeychainIntegrationTests: XCTestCase {
    var path: String!
    var originalSearchList: String = ""

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["WGA_KEYCHAIN_TESTS"] == "1",
                          "WGA_KEYCHAIN_TESTS=1일 때만 실행")
        path = FileManager.default.temporaryDirectory.appendingPathComponent("wga-test-\(UUID().uuidString).keychain-db").path
        originalSearchList = try security(["list-keychains", "-d", "user"])
        _ = try security(["create-keychain", "-p", "test", path])
        _ = try security(["unlock-keychain", "-p", "test", path])
        // create-keychain은 검색 목록에 새 키체인을 넣는다. 원래 목록으로 곧바로 되돌린다 (경로로만 연다)
        let list = originalSearchList.split(separator: "\n").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"")) }
        _ = try security(["list-keychains", "-d", "user", "-s"] + list)
    }

    override func tearDownWithError() throws {
        guard let path else { return }
        _ = try? security(["delete-keychain", path])
    }

    func testSaveLoadStatusDelete() throws {
        KeychainStore.disableUserInteraction()
        let store = KeychainStore(keychainPath: path)
        let credentials = AWSCredentials(accessKeyId: "AKIAIOSFODNN7EXAMPLE",
                                         secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        XCTAssertEqual(try store.status(account: "t"), StoredStatus(stored: false, maskedAccessKeyId: nil))
        try store.save(credentials, account: "t")
        XCTAssertEqual(try store.load(account: "t"), credentials)
        XCTAssertEqual(try store.status(account: "t"), StoredStatus(stored: true, maskedAccessKeyId: "AKIA************MPLE"))
        try store.save(AWSCredentials(accessKeyId: "AKIAIOSFODNN7EXAMPL2", secretAccessKey: credentials.secretAccessKey),
                       account: "t")   // 다시 저장하면 덮어쓴다
        XCTAssertEqual(try store.load(account: "t")?.accessKeyId, "AKIAIOSFODNN7EXAMPL2")
        try store.delete(account: "t")
        XCTAssertNil(try store.load(account: "t"))
    }

    private func security(_ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = arguments
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }
}
