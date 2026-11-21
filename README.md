# Bot World (Orca Plugin)

A read-only virtual office visualizer (HTML5 Canvas) for Orca bots and their live sub-workers.

## Installation

```sh
orca plugin install ddochi-nyang/bot-world-plugin
```

## Features

- **Sidebar Panel (`Bot World`)**: Switch between **Startup Office** and **Corporate Office** themes, toggle **Redact Mode**, inspect any bot in detail (active task, recent requests/replies, open items, sub-workers, scheduled automations, and 10 swappable character avatars), and browse the recent event timeline.
- **Wide Office Board (`.botworld` Custom Editor)**: Create a new `.botworld` file via **New File → New Bot World Board** to open the full 2-column office view with a **24-hour timeline scrubber** and `1x / 2x / 5x / 10x` replay playback. `.botworld` files persist view preferences only (`themeId`, `redactMode`, `selectedBotId`, `botAppearances`) and never store sensitive task text.
- **Status Bar Summary (`bot-world-status`)**: Displays active bots, running sub-workers, and bots awaiting your decision in real time (or anonymized counts in Redact Mode).
- **Bilingual UI (English & Korean)**: Automatically follows Orca's UI language (`auto`) or can be pinned to `en` or `ko` from Settings or the toolbar `EN` / `한` toggle.

## Settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `language` | `string` (`auto`, `en`, `ko`) | `auto` | Display language for Bot World (`auto` follows Orca UI locale). |
| `defaultTheme` | `string` (`startup_office`, `corporate_office`) | `startup_office` | Default office canvas theme. |
| `redactMode` | `boolean` | `false` | Hide sensitive task titles, tool names, message bodies, and event summaries. |
| `pollIntervalSec` | `integer` (`2`–`60`) | `5` | Default status polling interval in seconds. |

## Security Model

- **Least-Privilege Capabilities**: Requests only `storage:own`, `settings:own`, and `agent:read` — never write, terminal-send, or execution capabilities.
- **Command-Injection Prevention**: Uses `execFile(..., { shell: false })`, a strict trusted-binary path allowlist, a minimal environment variable set, a read-only subcommand allowlist, and strict argument validation.
- **XSS & Network Isolation**: Zero `innerHTML` or `eval` usage, `textContent` / `createTextNode`-only DOM rendering, and a strict Content Security Policy (`connect-src 'none'`).
- **Secret & PII Scrubbing**: Automatically masks AWS access keys, Slack/GitHub/Bearer/API tokens, webhook URLs, PEM private key blocks, email addresses, payment card numbers, and 12-digit AWS account IDs before storage or UI rendering.

## Verification

```sh
orca plugin validate . --json
orca plugin check . --json
orca plugin test . --json
```

---

## 한국어 요약

**봇 월드 (Bot World)** 는 Orca 봇과 하위 워커의 실시간 협업 상태를 가상 사무실(HTML5 Canvas)로 시각화하는 읽기 전용 플러그인입니다.

- **설치**: `orca plugin install ddochi-nyang/bot-world-plugin`
- **우측 사이드바 패널 (`봇 월드`)**: 스타트업 / 대기업 테마 전환, 가림 모드(`redactMode`), 언어 전환(`EN` / `한`), 봇 상세 조회(진행 작업, 최근 요청/답변, 열린 항목, 소속 워커, 정기 자동화, 10종 캐릭터 교체), 사건 타임라인.
- **넓은 에디터 뷰 (`.botworld`)**: **새 파일 → 새 봇 월드 보드**로 생성하면 넓은 2단 오피스 화면과 24시간 타임라인 스크러버(`1x / 2x / 5x / 10x` 리플레이)를 사용할 수 있습니다.
- **설정**: `language` (`auto` | `en` | `ko`), `defaultTheme`, `redactMode`, `pollIntervalSec`.
- **보안 모델**: 최소 권한(`storage:own`, `settings:own`, `agent:read`), `execFile(..., { shell: false })` 및 읽기 전용 서브커맨드 Allowlist, `connect-src 'none'` CSP, `textContent` 전용 DOM, 비밀·PII 자동 마스킹.
