# Claude Code via Cursor Pro Subscription

## Quick Start

**Terminal 1 — Start proxy:**
```bash
/Users/khaihuynh/Desktop/work-space-Khai/amp/cursor-api-proxy-fork/start.sh
```

**Terminal 2 — Dùng Claude Code:**
```bash
claude
```

## Cách hoạt động

- Fork `cursor-api-proxy` đã patch bỏ `--mode ask` constraint
- Proxy spawn Cursor CLI bên dưới, dùng auth Cursor Pro đã login sẵn
- Claude Code gửi request tới proxy → proxy gọi Cursor CLI → trả response về Claude Code
- Streaming hoạt động (SSE format)

## Models đang dùng

- Chính: `claude-opus-4-7-thinking-max`
- Haiku/Sonnet: `claude-4.6-sonnet-medium-thinking`

## Xem tất cả models

```bash
agent --list-models
```

## Stop proxy

```bash
pkill -f "node dist/cli.js"
```

## Switch về HOCAI (AMP Code)

Edit `~/.claude/settings.json`, đổi:
```json
"ANTHROPIC_BASE_URL": "http://localhost:8317"
```

## Troubleshooting

**Port conflict:**
```bash
lsof -ti:8318 | xargs kill
```

**Auth error:**
```bash
agent login
```
