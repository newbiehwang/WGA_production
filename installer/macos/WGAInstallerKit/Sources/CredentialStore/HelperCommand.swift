import Foundation

/// wga-credential-helper의 명령 처리. 입출력을 인자로 받아, 실행 파일 없이 테스트할 수 있게 했다.
///
///     wga-credential-helper [get]   credential_process 출력(JSON)을 stdout에 쓴다 (AWS CLI가 부름)
///     wga-credential-helper store   stdin의 {"AccessKeyId": "...", "SecretAccessKey": "..."}를 저장한다 (앱이 부름)
///     wga-credential-helper status  {"stored": true, "maskedAccessKeyId": "AKIA****..."} (비밀 값은 읽지 않음)
///     wga-credential-helper delete  저장한 자격 증명을 지운다
///
/// 비밀 값은 명령 인자로 받지 않는다 (실행 중인 프로세스의 인자는 `ps`로 누구나 볼 수 있다).
/// 오류 메시지는 stderr에 쓴다. AWS CLI는 credential_process가 실패하면 stderr를 사용자에게 보여 준다.
public enum HelperCommand {
    /// 키체인 항목의 계정 이름. ~/.aws/config의 프로필 이름과 같게 둔다.
    public static let defaultAccount = "wga-installer"

    public struct Output: Equatable {
        public let exitCode: Int32
        public let stdout: String
        public let stderr: String
    }

    public static func run(arguments: [String], stdin: () -> Data, store: SecretStore,
                           account: String = defaultAccount) -> Output {
        let command = arguments.first ?? "get"
        do {
            switch command {
            case "get":
                guard let credentials = try store.load(account: account) else {
                    return fail("저장된 AWS 자격 증명이 없습니다. 설치 마법사의 'AWS 연결'에서 Access Key를 입력하세요")
                }
                return Output(exitCode: 0, stdout: CredentialFormat.processOutput(credentials) + "\n", stderr: "")
            case "store":
                let credentials: AWSCredentials
                do {
                    credentials = try JSONDecoder().decode(AWSCredentials.self, from: stdin())
                } catch {
                    // 받은 내용에 비밀 값이 있을 수 있으므로 오류 메시지에 원문을 넣지 않는다
                    return fail("stdin에서 {\"AccessKeyId\": ..., \"SecretAccessKey\": ...} 형식의 JSON을 읽지 못했습니다")
                }
                if let problem = CredentialFormat.validate(credentials) {
                    return fail(problem)
                }
                try store.save(credentials, account: account)
                return Output(exitCode: 0, stdout: "", stderr: "")
            case "status":
                let status = try store.status(account: account)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]   // 항상 같은 순서로 (앱·테스트가 비교하기 쉽게)
                let data = try encoder.encode(status)
                return Output(exitCode: 0, stdout: String(decoding: data, as: UTF8.self) + "\n", stderr: "")
            case "delete":
                try store.delete(account: account)
                return Output(exitCode: 0, stdout: "", stderr: "")
            default:
                return Output(exitCode: 2, stdout: "",
                              stderr: "사용법: wga-credential-helper [get|store|status|delete]\n")
            }
        } catch let error as SecretStoreError {
            return fail(error.description)
        } catch {
            return fail("오류: \(error)")
        }
    }

    private static func fail(_ message: String) -> Output {
        Output(exitCode: 1, stdout: "", stderr: "wga-credential-helper: \(message)\n")
    }
}
