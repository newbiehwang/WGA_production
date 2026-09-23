import Foundation
import Security

/// IAM 사용자의 장기 Access Key 한 쌍.
/// JSON 키 이름은 AWS CLI credential_process 출력 형식과 같게 둔다 (AccessKeyId, SecretAccessKey).
public struct AWSCredentials: Codable, Equatable, Sendable {
    public let accessKeyId: String
    public let secretAccessKey: String

    public init(accessKeyId: String, secretAccessKey: String) {
        self.accessKeyId = accessKeyId
        self.secretAccessKey = secretAccessKey
    }

    enum CodingKeys: String, CodingKey {
        case accessKeyId = "AccessKeyId"
        case secretAccessKey = "SecretAccessKey"
    }
}

public enum CredentialFormat {
    /// 입력값 검사 결과. nil이면 통과.
    ///
    /// - Access Key ID: IAM 사용자의 장기 키는 AKIA로 시작하는 20자다. ASIA로 시작하는 임시 키는 세션 토큰이 함께
    ///   있어야 하고 몇 시간 뒤 만료되므로, 키체인에 오래 보관하는 이 방식에는 맞지 않아 받지 않는다.
    /// - Secret Access Key: 40자 (영문·숫자·/·+).
    public static func validate(_ credentials: AWSCredentials) -> String? {
        let id = credentials.accessKeyId
        if id.hasPrefix("ASIA") {
            return "ASIA로 시작하는 임시 자격 증명은 쓸 수 없습니다. IAM 사용자의 Access Key(AKIA...)를 입력하세요"
        }
        if id.range(of: "^AKIA[A-Z0-9]{16}$", options: .regularExpression) == nil {
            return "Access Key ID 형식이 아닙니다 (AKIA로 시작하는 20자)"
        }
        if credentials.secretAccessKey.range(of: "^[A-Za-z0-9/+]{40}$", options: .regularExpression) == nil {
            return "Secret Access Key 형식이 아닙니다 (40자)"
        }
        return nil
    }

    /// AWS CLI credential_process가 요구하는 출력 (https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sourcing-external.html)
    /// Version은 항상 1이다. 만료 시각(Expiration)을 쓰지 않으면 장기 자격 증명으로 취급된다.
    public static func processOutput(_ credentials: AWSCredentials) -> String {
        let object: [String: Any] = ["Version": 1, "AccessKeyId": credentials.accessKeyId,
                                     "SecretAccessKey": credentials.secretAccessKey]
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    /// 화면에 보여 줄 가린 Access Key ID (예: AKIA************WXYZ). Access Key ID는 비밀 값은 아니지만
    /// 계정을 특정할 수 있어 전부 보여 주지 않는다.
    public static func masked(_ accessKeyId: String) -> String {
        guard accessKeyId.count > 8 else { return String(repeating: "*", count: accessKeyId.count) }
        return accessKeyId.prefix(4) + String(repeating: "*", count: accessKeyId.count - 8) + accessKeyId.suffix(4)
    }
}

/// 저장된 자격 증명의 공개 정보 (비밀 값을 읽지 않고 알 수 있는 것만)
public struct StoredStatus: Codable, Equatable, Sendable {
    public let stored: Bool
    public let maskedAccessKeyId: String?

    public init(stored: Bool, maskedAccessKeyId: String?) {
        self.stored = stored
        self.maskedAccessKeyId = maskedAccessKeyId
    }
}

public enum SecretStoreError: Error, Equatable, CustomStringConvertible {
    case accessDenied            // 이 프로그램이 항목을 읽을 권한이 없음 (키체인 허용 목록에 없음)
    case ownedByOtherProgram     // 다른 프로그램(이전 빌드의 헬퍼 등)이 만든 항목이라 지우거나 바꿀 수 없음
    case locked                  // 키체인이 잠겨 있음
    case unexpected(OSStatus)

    public var description: String {
        switch self {
        case .accessDenied:
            // 다시 저장만으로는 고쳐지지 않는다: 서명이 다른 프로그램은 기존 항목을 지우지도 못한다 (ownedByOtherProgram)
            return "키체인 항목에 접근할 수 없습니다. 헬퍼가 다시 빌드되어 서명이 바뀌었을 수 있습니다. '키체인 접근' 앱에서 "
                + "'WGA Installer AWS 자격 증명' 항목을 삭제한 뒤, 설치 마법사의 'AWS 연결'에서 Access Key를 다시 저장하세요"
        case .ownedByOtherProgram:
            // 서명이 다른 프로그램은 항목의 주인을 바꿀 수 없다 (errSecInvalidOwnerEdit). 로컬 빌드는 빌드마다
            // 서명(cdhash)이 달라져 이 상황이 생긴다. 사용자가 직접 지우는 수밖에 없다.
            return "이전에 다른 버전의 헬퍼가 만든 키체인 항목이라 바꿀 수 없습니다. '키체인 접근' 앱에서 "
                + "'WGA Installer AWS 자격 증명' 항목(로그인 키체인)을 삭제한 뒤 다시 저장하세요"
        case .locked:
            return "키체인이 잠겨 있습니다. Mac에 로그인한 상태에서 다시 시도하세요"
        case let .unexpected(status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "알 수 없는 오류"
            return "키체인 오류 \(status): \(message)"
        }
    }
}

/// 자격 증명 저장소. 실제로는 KeychainStore, 테스트에서는 메모리 저장소를 쓴다.
public protocol SecretStore {
    func save(_ credentials: AWSCredentials, account: String) throws
    func load(account: String) throws -> AWSCredentials?
    func delete(account: String) throws
    /// 비밀 값을 읽지 않고(복호화 권한 없이) 저장 여부와 가린 Key ID만 확인한다
    func status(account: String) throws -> StoredStatus
}
