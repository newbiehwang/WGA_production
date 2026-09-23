import Foundation
import Security

/// macOS 키체인에 AWS 자격 증명을 저장한다.
///
/// 키체인 접근 권한(ACL)을 헬퍼 하나로 모으는 설계
/// ------------------------------------------------
/// 로그인 키체인(파일 기반 키체인)의 항목은 "만든 프로그램"만 허용 창 없이 값을 읽을 수 있다.
/// 앱이 만든 항목을 헬퍼(wga-credential-helper)가 읽으면 "…이(가) 키체인의 기밀 정보를 사용하려고 합니다"
/// 창이 뜨고, 그동안 AWS CLI가 멈춘다. 서명하지 않은 빌드에서는 두 프로그램을 같은 서명 ID로 묶을 방법도 없다.
/// 그래서 저장·조회·삭제를 모두 헬퍼가 한다. 앱은 헬퍼를 `store`로 실행해 stdin으로 키를 넘길 뿐,
/// 키체인을 직접 만지지 않는다. 만든 프로그램과 읽는 프로그램이 같으므로 허용 창이 뜨지 않는다.
///
/// 데이터 보호 키체인(kSecUseDataProtectionKeychain)은 쓰지 않는다. 그 키체인은 keychain-access-groups
/// 권한(개발자 팀 ID로 서명)이 있어야 해서, Apple Developer Program 가입 전의 로컬 빌드에서는 쓸 수 없다.
///
/// 동작 확인 결과 (임시 키체인으로 확인, installer/macos/README.md "키체인 접근 확인" 참고)
/// - 헬퍼가 저장한 항목은 같은 헬퍼가 허용 창 없이 읽는다.
/// - 서명이 다른 프로그램(다시 빌드한 헬퍼)이 읽으면 창 없이 곧바로 거부된다 (accessDenied).
/// - 비밀 값을 읽지 않는 status는 서명이 달라도 된다.
/// - 서명이 다른 프로그램은 그 항목을 지우지도 못한다 (errSecInvalidOwnerEdit → ownedByOtherProgram).
///   로컬(ad-hoc) 빌드는 빌드마다 서명이 달라져 이 경우가 생기며, 사용자가 '키체인 접근' 앱에서 지워야 한다.
///   Developer ID로 서명한 배포본은 버전이 바뀌어도 서명 ID가 같아 이 문제가 없다.
public final class KeychainStore: SecretStore {
    public static let service = "com.wga.installer.aws"
    private static let label = "WGA Installer AWS 자격 증명"

    private let keychainPath: String?

    /// keychainPath: 로그인 키체인 대신 쓸 키체인 파일 (테스트·동작 확인용. 보통은 nil)
    public init(keychainPath: String? = nil) {
        self.keychainPath = keychainPath
    }

    /// 사용자에게 허용 창을 띄우지 않게 한다. credential_process는 AWS CLI가 화면 없이 실행하므로,
    /// 창이 뜨면 사용자가 알아채기 전까지 명령이 멈춘다. 창 대신 오류(errSecInteractionNotAllowed)로 끝나게 한다.
    public static func disableUserInteraction() {
        // 파일 기반 키체인의 허용 창을 끄는 API는 이것뿐이다 (macOS 10.10부터 사용 중단 표시가 있지만 동작한다)
        SecKeychainSetUserInteractionAllowed(false)
    }

    public func save(_ credentials: AWSCredentials, account: String) throws {
        let data = try JSONEncoder().encode(credentials)
        // 기존 항목을 고치지 않고 지운 뒤 새로 만든다. 새로 만들어야 지금 실행 중인 헬퍼가 항목의 주인(허용 목록)이
        // 되고, 이전에 저장한 값의 흔적(속성 등)이 남지 않는다.
        try delete(account: account)
        var query = baseQuery(account: account)
        query[kSecValueData as String] = data
        query[kSecAttrLabel as String] = Self.label
        // 가린 Key ID를 설명(comment)에 둔다. 속성은 복호화 권한 없이 읽을 수 있어 status가 창 없이 동작한다
        query[kSecAttrComment as String] = CredentialFormat.masked(credentials.accessKeyId)
        query[kSecAttrDescription as String] = "AWS CLI credential_process (wga-installer 프로필)"
        try check(SecItemAdd(query as CFDictionary, nil))
    }

    public func load(account: String) throws -> AWSCredentials? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data else { throw SecretStoreError.unexpected(errSecDecode) }
        return try JSONDecoder().decode(AWSCredentials.self, from: data)
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        if status == errSecItemNotFound { return }
        try check(status)
    }

    public func status(account: String) throws -> StoredStatus {
        var query = baseQuery(account: account)
        query[kSecReturnAttributes as String] = true   // 값(kSecReturnData)은 요청하지 않는다
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return StoredStatus(stored: false, maskedAccessKeyId: nil) }
        try check(status)
        let attributes = result as? [String: Any]
        return StoredStatus(stored: true, maskedAccessKeyId: attributes?[kSecAttrComment as String] as? String)
    }

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
        if let keychain = openKeychain() {
            // 항목을 만들 키체인과 찾을 키체인을 지정한 파일로 한정한다
            query[kSecUseKeychain as String] = keychain
            query[kSecMatchSearchList as String] = [keychain]
        }
        return query
    }

    private func openKeychain() -> SecKeychain? {
        guard let path = keychainPath else { return nil }
        var keychain: SecKeychain?
        // 파일 기반 키체인을 경로로 여는 API (사용 중단 표시가 있지만 대체 API가 없다)
        guard SecKeychainOpen(path, &keychain) == errSecSuccess else { return nil }
        return keychain
    }

    private func check(_ status: OSStatus) throws {
        switch status {
        case errSecSuccess:
            return
        case errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled:
            // 허용 목록에 없는 프로그램이 읽으려 했고, 창을 띄울 수 없거나 사용자가 거절함
            throw SecretStoreError.accessDenied
        case errSecInvalidOwnerEdit:
            throw SecretStoreError.ownedByOtherProgram
        case errSecNotAvailable, errSecNoSuchKeychain, -25294 /* errSecInvalidKeychain */:
            throw SecretStoreError.locked
        default:
            throw SecretStoreError.unexpected(status)
        }
    }
}
