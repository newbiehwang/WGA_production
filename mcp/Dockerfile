# 공식 AWS Lambda Python 기본 이미지를 사용합니다
FROM public.ecr.aws/lambda/python:3.12

# 컨테이너 내 작업 디렉토리 설정
WORKDIR ${LAMBDA_TASK_ROOT}

# 실행할 때 필요한 시스템 패키지만 설치합니다.
# 이미지가 작을수록 콜드 스타트가 빠릅니다: Lambda는 이미지의 파일을 처음 읽을 때 받아 오기 때문입니다.
# - graphviz: 다이어그램 도구(diagrams 패키지)가 그림을 그릴 때 부르는 dot 프로그램
#   (파이썬 쪽 graphviz 패키지는 dot을 부르기만 하는 순수 파이썬이라 graphviz-devel·컴파일러가 필요 없다)
# - google-noto-sans-cjk-ttc-fonts, fontconfig: 다이어그램·차트의 한글 글꼴
#   (diagram_utils.py는 'Noto Sans CJK KR'을 먼저 찾는다. 세리프 글꼴은 그다음 후보라 넣지 않는다)
# 예전에 함께 설치하던 gcc·gcc-c++·make·pkgconfig·graphviz-devel은 빌드 도구라 뺐습니다.
# requirements.txt의 패키지는 모두 미리 빌드된 wheel로 설치되어 컴파일할 것이 없습니다.
# dnf update도 하지 않습니다: 기본 이미지를 AWS가 보안 업데이트와 함께 자주 새로 올리고,
# 업데이트하면 바뀐 패키지만큼 이미지가 커집니다.
RUN dnf install -y \
        graphviz \
        google-noto-sans-cjk-ttc-fonts \
        fontconfig \
    && fc-cache -f \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Docker 캐시를 활용하기 위해 먼저 요구 사항을 복사합니다
COPY requirements.txt .

# Python 종속성 설치
RUN pip install --no-cache-dir -r requirements.txt

# lambda_mcp 모듈 폴더 복사
COPY lambda_mcp/ lambda_mcp/

# 애플리케이션 코드의 나머지를 복사합니다
COPY app.py .

# 핸들러 함수 실행 명령 설정
CMD ["app.lambda_handler"]
