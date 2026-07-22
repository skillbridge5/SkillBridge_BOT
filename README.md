# SkillBridge Community Bot

Gamified learning platform Telegram bot for the SkillBridge community.

## Features

- **Daily Quizzes** — Auto-graded with scoring and explanations
- **Challenges** — Submit solutions, admin review workflow
- **Rewards Store** — Redeem SkillPoints for real rewards
- **Events** — Register for workshops, hackathons, meetups
- **Leaderboard** — Ranked by SkillPoints
- **Badges** — Auto-earned based on milestones (streaks, challenges, etc.)
- **Referral System** — Earn 25 SP per referral
- **Admin Panel** — Full CRUD for quizzes, challenges, rewards, events, badges + broadcast + submission review

## Setup

```bash
cp .env.example .env
# Edit .env with your Telegram bot token and admin IDs
npm install
npm run bot
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ADMIN_IDS` | No | Comma-separated Telegram user IDs |
| `BOT_USERNAME` | No | Bot username (default: skillbridge_hub_bot) |
| `DB_PATH` | No | SQLite database path (default: skillbridge.db) |
| `LOG_LEVEL` | No | debug/info/warn/error (default: info) |

## Docker

```bash
docker build -t skillbridge-bot .
docker run -d --name skillbridge-bot -v skillbridge-data:/app/data skillbridge-bot
```

## Commands

| Command | Description |
|---|---|
| `/start` | Home screen with quick actions |
| `/daily` | Today's quiz and challenge |
| `/quiz` | Browse all quizzes |
| `/challenges` | Browse all challenges |
| `/submit <id> <url>` | Submit challenge solution |
| `/profile` | View your profile and stats |
| `/badges` | View earned badges |
| `/leaderboard` | Top learners |
| `/rewards` | Rewards store |
| `/events` | Upcoming events |
| `/referral` | Your referral link |
| `/cancel` | Cancel current action |
| `/help` | Command reference |

## Admin Commands

| Command | Description |
|---|---|
| `/admin` | Admin panel |
| `/addquiz` | Create a quiz |
| `/addquestion <quiz_id>` | Add question to quiz |
| `/addchallenge` | Create a challenge |
| `/addreward` | Create a reward |
| `/addevent` | Create an event |
| `/addbadge` | Create a badge |
| `/broadcast <msg>` | Send message to all users |
