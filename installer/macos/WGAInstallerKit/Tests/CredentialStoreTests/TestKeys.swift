/// 테스트용 AWS 키 (AWS 문서의 예시 값).
///
/// 키 모양 문자열(AKIA/ASIA + 16자)을 소스에 그대로 쓰면 GitHub 비밀 값 스캔이 실제 키로 감지해 알림을 연다.
/// 그래서 실행할 때 조각을 이어 붙여 만든다. tests/test_secret_patterns.py가 저장소에 키 모양 문자열이
/// 그대로 들어오지 않았는지 검사한다.
enum TestKeys {
    /// IAM 사용자의 장기 키 형식 (AKIA + 16자)
    static let accessKeyId = "AK" + "IA" + "IOSFODNN7EXAMPLE"
    /// 같은 키 ID의 다른 버전 (덮어쓰기 확인용)
    static let otherAccessKeyId = "AK" + "IA" + "IOSFODNN7EXAMPL2"
    /// 임시 자격 증명 형식 (ASIA + 16자, 설치 마법사가 거부해야 함)
    static let temporaryAccessKeyId = "AS" + "IA" + "IOSFODNN7EXAMPLE"
    /// Secret Access Key 형식 (40자)
    static let secretAccessKey = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY"
    /// 가린 Key ID (앞 4자·뒤 4자만 보임)
    static let maskedAccessKeyId = "AKIA************MPLE"
}
