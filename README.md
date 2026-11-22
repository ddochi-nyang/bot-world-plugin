<div align="center">
  <img src="assets/icon.png" width="72" height="72" alt="Bot World icon" />
  <h1>Bot World</h1>
  <p><strong>Read-only virtual office visualizer (HTML5 Canvas) for Orca bots and live sub-workers.</strong></p>
  <p>
    <code>Read-Only</code> · <code>4 Office Themes</code> · <code>Drag &amp; Drop Seating</code> · <code>24h Office Digest</code> · <code>Bilingual EN / 한국어</code> · <code>Redact Mode</code> · <code>24h Replay</code>
  </p>
  <br />
  <img src="assets/showcase/preview.gif" alt="Bot World animated preview showing 4 office themes (Startup, Corporate, Cozy Cafe, Cyber Ops), Day/Sunset/Night atmosphere, drag-and-drop custom seating, 24h Office Digest Report, Redact Mode with 24h Replay, and EN/KO toggle" />
  <p><em>Interactive preview: 4 office themes (Startup, Corporate, Cozy Cafe, Cyber Ops), Day / Sunset / Night atmosphere, drag-and-drop custom seating, 24h Office Digest Report, Redact Mode + 24h Replay, and instant EN / 한국어 toggle.</em></p>
</div>

---

## Showcase Gallery

### 4 Office Themes (`Startup` · `Corporate` · `Cozy Cafe` · `Cyber Ops`)

Open a `.botworld` file (**New File → New Bot World Board**) for the full two-column office view with live desks, drag-and-drop custom seating, sub-worker helpers, speech bubbles, landmark callouts, and an interactive bot inspector. Press `T` or use the toolbar selector to cycle across all four themes.

| Startup Office | Corporate Office |
| :---: | :---: |
| <img src="assets/showcase/startup-office.jpg" alt="Startup Office theme showing live bot desks, sub-workers, and event timeline" /> | <img src="assets/showcase/corporate-office.jpg" alt="Corporate Office theme highlighting Needs You approval badges, open items, and automation status" /> |
| *Warm studio floor plan with live desks, sub-workers, character switcher, and 24-hour event timeline.* | *Cool glass-walled office highlighting `Needs You` approval badges, open items, and automation status.* |

| Cozy Cafe | Cyber Ops |
| :---: | :---: |
| <img src="assets/showcase/cozy-cafe.jpg" alt="Bot World Cozy Cafe theme at sunset with 8 live bots spread across wooden desks and round cafe tables" /> | <img src="assets/showcase/cyber-ops.jpg" alt="Bot World Cyber Ops midnight neon control room theme with live bots, glowing monitors, and sub-workers" /> |
| *Warm botanical cafe studio at sunset with wooden desks, round cafe tables, and flying handoff couriers.* | *Midnight neon operations center with dual monitors, live desk lamps, and idle `Zzz` bubbles.* |

### 24h Daily Office Digest Report

Press `I` or click **Report** in the toolbar to review a 24-hour activity summary — KPIs (events, worker runs, collaborations, automation success rate, and pending owner inputs), the **Top 3** active bots, and a **12-bucket hourly activity bar chart** — with 1-click **Copy Markdown** and full **Redact Mode** compliance.

<div align="center">
  <img src="assets/showcase/office-report.jpg" alt="24h Daily Office Digest Report modal showing KPIs, Top 3 active bots, 12h activity bar chart, and Copy Markdown button" />
  <p><em>24h Daily Office Digest Report modal: KPIs, Top 3 active bots, 12-hour activity bar chart, and 1-click Copy Markdown (Redact-safe).</em></p>
</div>

### Living Office Atmosphere (`Day` · `Sunset` · `Night`)

Cycle `Auto`, `Day`, `Sunset`, and `Night` lighting from the toolbar or press `A` — in `Auto` mode, lighting follows the live clock or shifts seamlessly as you scrub the 24-hour replay timeline. Night mode adds warm desk lamp spotlights over working bots, steaming coffee icons, idle `Zzz` bubbles, and animated sub-worker door commutes alongside curved paper-plane and envelope couriers.

<div align="center">
  <img src="assets/showcase/night-office.jpg" alt="Bot World wide .botworld office board in Night atmosphere mode with warm desk lamp glows over working bots, steaming coffee icons, idle Zzz bubbles, and a sub-worker entering through the office door" />
  <p><em>Night atmosphere mode: warm desk lamp spotlights, steaming coffee, idle Zzz bubbles, and a sub-worker entering through the office door.</em></p>
</div>

### Privacy & Time Travel (`Redact Mode` + `24h Timeline Replay`)

Toggle **Redact ON** to mask sensitive task titles, tool names, message summaries, and sub-worker providers, or scrub back through the past 24 hours at `1x`, `2x`, `5x`, or `10x` playback speed.

<div align="center">
  <img src="assets/showcase/redact-replay.jpg" alt="Redact Mode privacy masking paired with 24-hour timeline scrubbing and playback" />
</div>

### Compact Sidebar Panel

Keep a live office overview docked beside your code and terminals without leaving your workspace.

<table>
  <tr>
    <td width="280" align="center" valign="top">
      <img src="assets/showcase/sidebar-panel.jpg" width="260" alt="Bot World compact sidebar panel" />
    </td>
    <td valign="top">
      <h4>Everything at a glance in the Orca sidebar</h4>
      <ul>
        <li><strong>Instant Theme &amp; Privacy Toggles</strong>: Cycle all 4 themes (<strong>Startup</strong>, <strong>Corporate</strong>, <strong>Cozy Cafe</strong>, <strong>Cyber Ops</strong>), open the <strong>24h Report</strong>, toggle <strong>Redact ON/OFF</strong>, and switch <strong>EN / 한</strong> directly from the top bar.</li>
        <li><strong>Live Bot Roster</strong>: Quick-select pills highlight bots awaiting your decision (<code>★</code>) alongside active status badges.</li>
        <li><strong>Bot Details &amp; Event Timeline Tabs</strong>: Inspect the active read-only task, recent requests/replies, open items, live sub-workers, linked automations, or switch to the chronological event timeline.</li>
        <li><strong>One-Click Character Picker</strong>: Override any bot's avatar across 10 animal characters right inside the detail pane.</li>
      </ul>
    </td>
  </tr>
</table>

---

## Key Features

- **Dual Surfaces**:
  - **Sidebar Panel (`Bot World`)**: Compact docked canvas, bot roster pills, detail inspector, 24h Report button, and recent event timeline.
  - **Wide `.botworld` Office Board**: Create via **New File → New Bot World Board (`.botworld`)** for a full-screen 2-column stage with a **24-hour timeline scrubber** and replay controls. `.botworld` files store view preferences only (`themeId`, `atmosphereMode`, `redactMode`, `selectedBotId`, `botAppearances`, `customDeskPositions`) and never persist sensitive task text.
  - **Status Bar Summary (`bot-world-status`)**: Live counts of active bots, running sub-workers, and bots awaiting owner input (anonymized in Redact Mode).
- **4 Office Themes (v0.3.0)**:
  - Cycle between `Startup Office` (`startup_office`), `Corporate Office` (`corporate_office`), `Cozy Cafe` (`cozy_cafe`), and `Cyber Ops` (`cyber_ops`) via the toolbar or `T`. Each theme maps 14 custom desk coordinates, landmarks, and an overflow grid for larger fleets.
- **Drag-and-Drop Custom Seat Layout (v0.3.0)**:
  - Drag any bot on the `.botworld` stage to reposition its desk (live sub-workers and courier flight endpoints follow automatically). Custom coordinates are bounded, sanitized, and saved in `.botworld` under `customDeskPositions` (up to 128 bots), with a **Reset Seats** button to restore theme defaults anytime.
- **24h Daily Office Digest Report (v0.3.0)**:
  - Open from the toolbar **Report** button or by pressing `I` in either surface. Summarizes the past 24 hours with 4 KPI cards (total events, sub-worker runs, collaborations, automation success rate), **Top 3** active bots, and a **12-bucket hourly activity bar chart** (2-hour windows), plus 1-click **Copy Markdown**. Automatically redacts sensitive titles and errors when **Redact Mode** is enabled.
- **Living Office Atmosphere & Motion**:
  - **Time-of-Day Atmosphere (`Auto`, `Day`, `Sunset`, `Night`)**: Automatically shifts between `Day` (07:00–16:59), `Sunset` (17:00–19:59), and `Night` (20:00–06:59) in `Auto` mode — synced to either the live clock or the scrubbed **24h Replay** timestamp — or locks to any phase via toolbar (`A`) or Settings. Night mode adds warm desk lamp spotlights over working bots, steaming coffee icons, and idle `Zzz` bubbles.
  - **Curved Courier Flights & Sub-Worker Commutes**: Handoff events launch curved flying paper-plane couriers (`paper_plane`) and message/reply events launch envelope couriers (`envelope`) between participants. Sub-workers animate entering from and departing through the **Entrance** door landmark as they start and finish.
- **Keyboard Shortcuts**:
  Press any key outside text inputs in both the Sidebar Panel and `.botworld` Office Board (`Space` applies to `.botworld` Replay):

  | Key | Action | Scope |
  | --- | --- | --- |
  | `T` | Cycle office theme (`Startup` → `Corporate` → `Cozy Cafe` → `Cyber Ops`) | Panel & `.botworld` |
  | `R` | Toggle Redact Mode (`ON` / `OFF`) | Panel & `.botworld` |
  | `L` | Switch language (`EN` / `한국어`) | Panel & `.botworld` |
  | `A` | Cycle atmosphere (`Auto` → `Day` → `Sunset` → `Night`) | Panel & `.botworld` |
  | `D` | Toggle Demo Office (`ON` / `OFF`) | Panel & `.botworld` |
  | `I` | Open / close 24h Office Digest Report | Panel & `.botworld` |
  | `Space` | Play / Pause 24h Replay | `.botworld` Editor |
  | `Esc` | Close modal or clear selected bot | Panel & `.botworld` |
  | `?` | Show / hide Keyboard Shortcuts modal | Panel & `.botworld` |

- **Works with Any Orca Workspace**:
  - **1-Click Try Demo Office (Read-Only Simulation)**: Start an interactive, read-only simulated office immediately from the **Try Demo Office** button on the 0-bot onboarding card or the toolbar **Demo** toggle (`Exit Demo` returns to live Orca status without touching workspace state or `.botworld` preferences).
  - **0 to 15+ Bots**: Greets empty workspaces with 0-bot onboarding, seats up to 14 bots at dedicated theme desks, and automatically arranges 15+ bots in an overflow desk grid with compact nameplates.
  - **Role-Aware Avatar Matching + 1-Click Overrides**: Automatically assigns matching animal avatars from English or Korean role keywords (`security`, `infra`, `cloud`, `cost`, `docs`, `cve`, `assist`, `coord`, `tool`, etc.) with a deterministic fallback, and lets you swap any bot manually among 10 characters: `Owl`, `Hedgehog`, `Octopus`, `Ice Fox`, `Frog`, `Raccoon`, `Penguin`, `Bear`, `Alpaca`, and `Cat Bot`.
- **Bilingual UI (`Auto`, `English`, `한국어`)**: Follows Orca's UI locale automatically in `auto` mode, or can be pinned in Settings or via the toolbar `EN` / `한` toggle.
- **Redact Mode & 24h Timeline Replay**: Mask sensitive operational details on demand for screen sharing or demos, and replay up to 24 hours of recorded snapshots at `1x`, `2x`, `5x`, or `10x` speed.

---

## Quick Start & Installation

### Install from Orca Plugin Catalog / GitHub

```sh
orca plugin install ddochi-nyang/bot-world-plugin
```

### Local Development Load

```sh
git clone https://github.com/ddochi-nyang/bot-world-plugin.git
cd bot-world-plugin
orca plugin dev load .
```

### Opening the Views

1. **Sidebar Panel**: Click the **Bot World** status bar item or run the **Open Bot World** command.
2. **Wide Office Board**: Choose **New File → New Bot World Board (`.botworld`)** in Orca to open the wide 2-column office canvas and 24-hour timeline scrubber.
3. **Try Demo Office**: In an empty workspace, click **Try Demo Office** on the onboarding card—or click **Demo** in the toolbar at any time—to preview live bot interactions, themes, Redact Mode, and 24h Replay; click **Exit Demo** to return to live status.

---

## Settings Reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultTheme` | `string` (`startup_office`, `corporate_office`, `cozy_cafe`, `cyber_ops`) | `startup_office` | Default office canvas theme (`Startup Office`, `Corporate Office`, `Cozy Cafe`, or `Cyber Ops`). |
| `redactMode` | `boolean` | `false` | Hide sensitive task titles, tool names, message bodies, and event summaries. |
| `pollIntervalSec` | `integer` (`2`–`60`) | `5` | Default status polling interval in seconds. |
| `language` | `string` (`auto`, `en`, `ko`) | `auto` | Display language for Bot World (`auto` follows Orca UI locale). |
| `atmosphereMode` | `string` (`auto`, `day`, `sunset`, `night`) | `auto` | Office time-of-day lighting atmosphere (`auto` follows live or replay timestamp; `day`, `sunset`, or `night` overrides lighting). |

---

## Security & Privacy Architecture

Bot World is engineered as a strictly read-only, zero-egress observer:

- **Least-Privilege Capabilities**: Requests only `agent:read`, `storage:own`, and `settings:own` — never write, terminal-send, or command-execution capabilities.
- **Strict Content Security Policy & Zero Network Egress**: Isolated custom editor frame (`frame: "isolated"`) with `connect-src 'none'`. No external HTTP requests, telemetry, or analytics.
- **XSS-Safe DOM & Safe Process Invocation**: Uses `textContent` and `createTextNode` exclusively (zero `innerHTML` or `eval`), and invokes Orca CLI reads via `execFile(..., { shell: false })` with a strict binary path allowlist, minimal environment variables, read-only subcommand allowlist, and argument validation.
- **Automatic Secret & PII Scrubbing + Redact Mode**: Masks AWS access keys, Slack/GitHub/Bearer/API tokens, webhook URLs, PEM private key blocks, email addresses, payment card numbers, and 12-digit AWS account IDs before storage or rendering, with one-click **Redact Mode** for presentations and screenshots.

---

## Verification

```sh
orca plugin validate . --json
orca plugin check . --json
orca plugin test . --json
```

---

## 한국어 요약 (Korean Overview)

**봇 월드 (Bot World)** 는 Orca 봇과 실시간 하위 워커의 협업 상태를 HTML5 Canvas 기반 가상 사무실로 시각화하는 **읽기 전용** 플러그인입니다.

- **이중 화면 구성**:
  - **우측 사이드바 패널 (`봇 월드`)**: 4가지 사무실 테마 순환, 24시간 리포트(`I`), 시간대 분위기 전환(`자동`·`낮`·`노을`·`야간`), 가림 모드(`가림 ON/OFF`), 언어 전환(`EN` / `한`), 봇별 진행 작업·요청/답변·세부 항목·하위 워커·정기 자동화 조회, 10종 동물 캐릭터 즉시 교체.
  - **넓은 `.botworld` 오피스 보드**: **새 파일 → 새 봇 월드 보드 (`.botworld`)** 로 생성하면 2단 전체 오피스 뷰와 **24시간 타임라인 스크러버(`1x / 2x / 5x / 10x` 재생)**, 드래그 앤 드롭 좌석 배치를 사용할 수 있습니다. `.botworld` 파일은 화면 설정(`themeId`, `atmosphereMode`, `redactMode`, `selectedBotId`, `botAppearances`, `customDeskPositions`)만 저장하며 민감한 작업 내용은 저장하지 않습니다.
- **v0.3.0 주요 기능**:
  - **4가지 오피스 테마**: `스타트업 오피스`, `대기업 오피스`, `코지 카페(Cozy Cafe)`, `사이버 관제실(Cyber Ops)` 테마를 `T` 키 또는 상단 메뉴에서 순환합니다.
  - **드래그 앤 드롭 좌석 배치**: `.botworld` 캔버스에서 봇을 드래그해 원하는 책상 위치로 옮기면 하위 워커와 전달 애니메이션 좌표가 함께 이동하며 `.botworld` 파일에 저장됩니다. **좌석 초기화** 버튼으로 기본 배치로 되돌릴 수 있습니다.
  - **24시간 사무실 다이제스트 리포트 (`I`)**: 최근 24시간 핵심 지표(사건, 워커 실행, 협업, 자동화 성공률), **상위 3개 활성 봇**, **12개 시간대별 활동 막대 그래프**를 요약해 보여주며, 클릭 한 번으로 Markdown 복사를 지원합니다(가림 모드 자동 준수).
- **살아 움직이는 사무실 분위기와 단축키**:
  - **시간대 조명 (`자동` · `낮` · `노을` · `야간`)**: `자동` 모드에서는 현재 시각과 24시간 리플레이 타임스탬프에 맞춰 조명이 전환되며, 야간에는 작업 중인 봇 책상의 조명 스포트라이트·김이 오르는 커피·대기 `Zzz` 말풍선을 표시합니다.
  - **곡선 전달 애니메이션 & 도우미 출입**: 인계 사건은 종이비행기, 질문/답변 사건은 편지봉투 곡선 비행으로 표현하고, 하위 도우미는 출입구를 통해 사무실로 들어가고 나가는 이동 애니메이션을 보여 줍니다.
  - **키보드 단축키**: `T`(4종 테마 순환), `R`(가림 모드), `L`(언어), `A`(시간대 분위기), `D`(데모 오피스), `I`(24시간 리포트), `Space`(리플레이 재생/일시정지), `Esc`(창 닫기/선택 해제), `?`(단축키 안내)를 지원합니다.
- **모든 Orca 워크스페이스 자동 대응 및 1클릭 데모 체험**:
  - **데모 오피스 체험(읽기 전용 시뮬레이션)**: 실행 중인 봇이 없을 때 표시되는 초기 안내 카드의 **데모 오피스 체험** 버튼이나 상단 도구 모음의 **데모** 버튼으로 가상 봇·하위 워커 협업, 테마 전환, 가림 모드, 24시간 타임라인 재생을 바로 체험할 수 있습니다. **데모 종료**를 누르면 `.botworld` 설정을 변경하지 않고 실시간 Orca 상태로 돌아갑니다.
  - **0개부터 15개 이상 봇까지 자동 배치**: 봇이 없는 초기 안내 상태부터 14개 전용 책상, 15개 이상 봇을 위한 확장 좌석 그리드와 축약 이름표까지 자동으로 배치합니다. 영문·한글 역할 키워드(`security`, `infra`, `cloud`, `cost`, `docs`, `cve`, `보안`, `인프라` 등)에 맞춰 부엉이·고슴도치·문어·여우·개구리·너구리·펭귄·탐정 곰·알파카·고양이 봇 캐릭터를 자동 배정하며 클릭 한 번으로 바꿀 수 있습니다.
- **보안 및 개인정보 보호**: 최소 권한(`agent:read`, `storage:own`, `settings:own`), 외부 통신 차단 CSP(`connect-src 'none'`), `shell: false` 기반 읽기 전용 조회, `textContent` 전용 DOM, 비밀 키·토큰·이메일·카드번호·12자리 AWS 계정 ID 자동 마스킹 및 가림 모드를 제공합니다.
