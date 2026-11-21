# 봇 월드 (Bot World) Orca 플러그인

Orca 봇과 하위 워커의 실시간 협업 상태를 가상 사무실(HTML5 Canvas)로 시각화하는 읽기 전용 플러그인입니다.

## 주요 기능

- **우측 사이드바 패널 (`봇 월드`)**: 스타트업 / 대기업 테마 전환, 가림 모드(`redactMode`), 봇 클릭 상세 조회(진행 작업, 최근 요청/답변, 열린 항목, 소속 워커, 정기 자동화, 10종 캐릭터 교체), 최근 사건 타임라인.
- **넓은 에디터 뷰 (`.botworld` 커스텀 에디터)**: 새 파일 메뉴에서 `.botworld` 보드를 만들면 넓은 2단 오피스 화면과 24시간 타임라인 스크러버(`1x / 2x / 5x / 10x` 배속 리플레이)를 이용할 수 있습니다. `.botworld` 파일에는 뷰 설정(`themeId`, `redactMode`, `selectedBotId`, `botAppearances`)만 저장되며 민감한 작업 원문은 저장하지 않습니다.
- **상태바 요약 (`bot-world-status`)**: 작업 중인 봇, 활성 워커, 결정 대기 봇 수를 실시간으로 표시하며 가림 모드 시에는 숫자 요약만 표시합니다.

## 보안 및 최소 권한

- **최소 권한**: `storage:own`, `settings:own`, `agent:read`만 사용하며 쓰기/전송/실행 권한은 요청하지 않습니다.
- **명령 인젝션 차단**: `execFile(..., { shell: false })`, 고정 신뢰 경로 Allowlist, 최소 환경변수 집합, 읽기 전용 서브커맨드 Allowlist, 엄격한 인자 검증을 적용합니다.
- **XSS / 외부 네트워크 차단**: `innerHTML`·`eval` 미사용, `textContent` / `createTextNode` 전용 DOM 구성, 엄격한 CSP(`connect-src 'none'`) 적용.
- **비밀·PII 스크러빙**: 저장 및 UI 전송 전 AWS 키, Slack/GitHub/Bearer 토큰, 웹훅 URL, PEM 개인키 헤더, 이메일, 결제카드 번호, 12자리 AWS 계정번호를 자동 마스킹합니다.

## 검증 방법

```sh
orca plugin validate . --json
orca plugin inspect . --json
orca plugin test . --json
```
