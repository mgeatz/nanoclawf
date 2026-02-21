# NanoClaw Agent System Review

**Date:** 2026-02-20
**System uptime at review:** ~28 hours (with broken web search for entire duration)

---

## System Overview

NanoClaw runs 4 AI agents on a single Node.js process, each with an isolated workspace folder. Agents communicate via self-to-self emails (IMAP), IPC trigger files, and MCP tools. All agents use `ollama/qwen3:8b`.

| Agent | Persona | Tag | Folder | Role |
|-------|---------|-----|--------|------|
| Admin | Gatekeeper | `[admin]` | `main/` | Routes comms, reviews agents, approves content |
| Nova | Research | `[research]` | `research/` | Ecosystem scans, funding news, trend reports |
| Echo | Content | `[content]` | `content/` | Drafts tweets, replies, manages content pipeline |
| SocialSpark | Social | `[social]` | `social/` | Reddit engagement, trend scanning, DM outreach |

---

## Agent Details

### 1. Admin Agent (Gatekeeper)

**Scheduled Tasks:**

| Task | Schedule | Success Rate | Avg Duration |
|------|----------|-------------|--------------|
| `task-admin-review` | Every 4 hours | 100% (4 runs) | 152s |

**What it does:**
- Calls `get_activity_log(limit: 30)` to review recent agent activity
- Identifies the agent that needs direction most
- Sends 1 `trigger_email` with specific instructions to that agent
- Falls back to "Team status: all agents active, no issues" if nothing to direct

**Directory dependencies:**
- Reads: None (uses MCP tools only)
- Writes: `main/logs/`

**MCP tools used:** `get_activity_log`, `trigger_email`, `send_message`

**Interactions:**
- Sends triggers TO: content (5), social (2), research (1), admin (2)
- Receives triggers FROM: none
- Acts as gatekeeper for all user-facing notifications

**Issues:**
- Last result: "No recent activity log entries found" — admin can't see what agents are doing
- Has a rogue `post-twitter.applescript` (14 bytes, contains "404: Not Found") — agent tried to "fix" the script by writing to its own workspace

---

### 2. Research Agent (Nova)

**Scheduled Tasks:**

| Task | Schedule | Success Rate | Avg Duration |
|------|----------|-------------|--------------|
| `task-research-scan` | Every 2 hours | 100% (9 runs) | 105s |
| `task-research-weekly` | Friday 14:00 UTC | 100% (1 run) | 120s |

**What it does:**
- **Scan:** `web_search` for startup news → append to `daily/YYYY-MM-DD.md` → trigger `[content]` with finding + angle
- **Weekly:** Read week's daily files → write detailed report to `reports/YYYY-MM-DD.md` → notify admin

**Directory dependencies:**
- Reads: `daily/`, `reports/`
- Writes: `daily/YYYY-MM-DD.md`, `reports/YYYY-MM-DD.md`
- Reference files: `competitors.md`, `tools.md`, `trends.md` (all empty)

**MCP tools used:** `web_search`, `trigger_email`, `send_message`

**Interactions:**
- Sends triggers TO: content (with findings)
- Receives triggers FROM: admin

**Issues:**
- `web_search` has been failing for entire uptime (AppleScript compile error, now fixed)
- Agent reports "100% success" but last result is "web search script is still incomplete (14 bytes)" — it counts as "success" because the agent completes without error, it just doesn't produce useful output
- Nested directory created: `groups/research/groups/research/daily/` — agent used absolute path instead of relative
- Weekly report says "daily/ directory does not exist" even though it does — path resolution issue
- `competitors.md`, `tools.md`, `trends.md` all empty — never populated

**Actual output produced:**
- `daily/2026-02-19.md` — Q2 2026 Startup Ecosystem Trend Scan (real content, written Feb 19)
- `reports/2026-02-19-ecosystem-report.md` — Full Q2 report with strategic recommendations
- Nothing since Feb 19 (web search broken)

---

### 3. Content Agent (Echo)

**Scheduled Tasks:**

| Task | Schedule | Success Rate | Avg Duration |
|------|----------|-------------|--------------|
| `task-content-review` | Every 2 hours | 100% (8 runs) | 156s |
| `task-content-twitter-replies` | Every 4 hours | 71% (7 runs) | 353s |
| `task-content-daily-summary` | Daily 18:00 UTC | 0% (1 run) | TIMEOUT |

**What it does:**
- **Review:** Read `inbox/` for ideas from other agents → draft tweet → send for approval
- **Twitter Replies:** `web_search` for founder tweets → draft 2-3 sentence reply → send for approval (max 3/day)
- **Daily Summary:** Count files in `drafts/` vs `published/` → update `calendar.md`

**Directory dependencies:**
- Reads: `inbox/`, `drafts/`, `published/`, `twitter-replies/`
- Writes: `drafts/draft-YYYYMMDD-HHMMSS.md`, `twitter-replies/reply-YYYYMMDD-HHMMSS.md`, `published/`, `calendar.md`
- Reference: `brand-voice.md`

**MCP tools used:** `web_search`, `send_message`, `post_to_social`

**Interactions:**
- Receives triggers FROM: admin (5), research (indirect via inbox)
- Sends triggers TO: content (1 self-trigger for missing directory)

**Approval workflow:**
1. Draft saved to `drafts/` with frontmatter (id, platform, status: pending)
2. `send_message(priority: "notify")` with full draft text
3. User replies "approve draft-{id}" → agent calls `post_to_social()`
4. Moves to `published/`

**Issues:**
- **Inbox is full of `.log` files, not content ideas.** 23 agent log files dumped into `inbox/`. The task reads inbox/ looking for ideas and finds only logs → "No new content ideas" every time.
- `task-content-daily-summary` TIMED OUT at 3,600 seconds (60 minutes!) on its only run. Likely the agent went into an endless loop trying to count/update files.
- `task-content-twitter-replies` reports "The webfetch failed because X.com (Twitter) requires JavaScript" — even with working web_search, Perplexity may not return actual tweet URLs the agent can use.
- 8 drafts sitting in `drafts/` — never posted because no approvals flowed back to the agent.
- Inconsistent file naming: `2026-02-18_launch80_x.md` vs `draft-20260219-094532.md` vs `blog-draft-1-20260219.md`

**Actual output produced:**
- 8 draft files in `drafts/` (tweets, LinkedIn posts, blog drafts)
- 2 published posts in `published/`
- Content calendar in `calendar.md`

---

### 4. Social Agent (SocialSpark)

**Scheduled Tasks:**

| Task | Schedule | Success Rate | Avg Duration |
|------|----------|-------------|--------------|
| `task-social-reddit-engagement` | Every 3 hours | 80% (10 runs) | 405s |
| `task-social-scan` | Every 3 hours | 100% (5 runs) | 167s |

**What it does:**
- **Reddit Engagement:** `web_search` for Reddit posts → draft 2-3 paragraph comment → send for approval (max 3/day)
- **Trend Scan:** `web_search` for trending topics → log to `daily/YYYY-MM-DD.md` → trigger `[content]` with trend + hook

**Directory dependencies:**
- Reads: `daily/`, `reddit-comments/`, `reddit-dms/`
- Writes: `daily/YYYY-MM-DD.md`, `reddit-comments/comment-YYYYMMDD-HHMMSS.md`, `reddit-dms/dm-YYYYMMDD-HHMMSS.md`
- Reference: `seo-keywords.md`, `competitors.md`, `platforms/` (reddit.md, x.md, instagram.md)

**MCP tools used:** `web_search`, `send_message`, `post_to_social`, `trigger_email`

**Interactions:**
- Sends triggers TO: content (with trends)
- Receives triggers FROM: admin (3)

**Issues:**
- `web_search` broken for entire uptime (same AppleScript issue)
- Has a rogue `web-search-perplexity.applescript` in its own folder (14 bytes, "404: Not Found") — agent tried to "fix" the script itself
- Nested directory: `groups/social/groups/social/daily/` — same path resolution issue as research
- Has `growth/funding-landscape.md` — leftover from when there were 8 agents
- 1 Reddit comment draft from Feb 19 sitting unapproved
- `reddit-dms/` empty — DM outreach workflow never activated

**Actual output produced:**
- `daily/2026-02-19.md` — Q2 Social Media Strategy
- `reddit-comments/001-comment-20260219-191226.md` — 1 pending comment draft
- Platform strategy docs: `platforms/reddit.md`, `platforms/x.md`, `platforms/instagram.md`
- `reports/week-3-trend-analysis.md` — Weekly trend report

---

## Inter-Agent Collaboration

### Expected Flow
```
[research] --findings--> [content] inbox/
[social]   --trends----> [content] inbox/
[content]  --drafts----> [admin] (via send_message notify)
[admin]    --approvals-> [content] / [social] (via trigger_email)
[admin]    --direction-> all agents (via trigger_email)
```

### Actual Flow (Last 24 Hours)
```
[admin] --direction--> [content] (5 triggers)
[admin] --direction--> [social] (2 triggers)
[admin] --direction--> [research] (1 trigger)
[content] --self------> [content] (1 self-trigger: "Directory Missing")
[social] --self-------> [social] (1 self-trigger)
```

**What's broken:** Research and Social are NOT triggering Content with findings. The content pipeline is one-directional (admin pushing) instead of the intended pull model where research/social feed content.

### Collaboration Score: 37/100

| Agent | Triggers Sent | Triggers Received |
|-------|:------------:|:-----------------:|
| Admin | 10 | 0 |
| Content | 1 | 6 |
| Social | 1 | 3 |
| Research | 0 | 1 |

---

## Systemic Issues

### 1. Web Search Was Completely Broken (FIXED)
The Perplexity AppleScript had a compile-time error (`tell application "Arc"` block requiring Arc's dictionary). Every agent that called `web_search` got an error. Agents reported "success" because they completed their run — they just described the error in their output instead of producing useful content.

**Impact:** 4 out of 8 tasks were non-functional for the entire ~28-hour uptime.

### 2. Agents Writing to Wrong Paths
Agents are creating nested directory structures like `groups/research/groups/research/daily/` instead of using relative paths (`daily/`). The OpenCode agent's working directory is the group folder, but agents sometimes use paths as if they're at the project root.

**Affected agents:** Research, Social
**Result:** Content written to nested paths is invisible to subsequent task runs that read from the correct relative path.

### 3. Content Inbox Polluted with Log Files
The `content/inbox/` directory contains 23 agent `.log` files instead of content ideas. The `task-content-review` scans inbox/ for ideas and finds nothing actionable, reporting "No new content ideas" every 2 hours. Meanwhile, research and social triggers that SHOULD go to inbox/ are either not happening or writing to the wrong location.

### 4. No Approval Loop Closing
Agents draft content and send it for approval via `send_message(priority: "notify")`. But there's no evidence of approvals flowing back. The 8 drafts in `content/drafts/` and 1 comment in `social/reddit-comments/` are all still "pending". The approval workflow depends on the user replying to notification emails, but:
- The admin agent isn't forwarding approval requests effectively
- There's no automated approval path
- Drafts accumulate without being posted or cleaned up

### 5. Daily Summary Times Out
`task-content-daily-summary` ran for 60 minutes before timing out. This task should take seconds (count files, update calendar). The agent likely went off-track, possibly trying to read all draft contents, or got stuck in a loop. This task hasn't run successfully once.

### 6. Rogue Files Created by Agents
Agents attempted to "fix" broken scripts by writing files into their own workspace:
- `groups/main/post-twitter.applescript` (14 bytes: "404: Not Found")
- `groups/social/web-search-perplexity.applescript` (14 bytes: "404: Not Found")

The real scripts live in `scripts/`, but agents don't know that and tried to create them locally.

---

## Recommendations for Improved Autonomy

### Priority 1: Fix the Content Pipeline

**A. Clean up content/inbox/**
Delete the 23 `.log` files from `content/inbox/`. Ensure the OpenCode logging directory is NOT the inbox folder.

**B. Wire up research→content and social→content triggers**
Currently research and social task prompts say to `trigger_email(tag: "content")` but this creates an EMAIL to the content agent — it doesn't write to `inbox/`. The trigger becomes a message in the content queue, not a file. The `task-content-review` reads FILES from `inbox/`, not messages. These two mechanisms don't connect.

**Fix options:**
1. Change `task-content-review` to check recent messages (via `get_activity_log` filtering for triggers received) instead of reading `inbox/` files
2. Or change research/social to write findings directly to `content/inbox/` as `.md` files (requires filesystem MCP tool)
3. Or simplify: remove inbox/ dependency entirely and have content-review check the activity log for recent triggers from research/social

**C. Auto-approve low-risk content**
Add an auto-approval path for content that meets quality criteria (no links, under character limit, passes brand voice check). This removes the human bottleneck that's causing drafts to pile up.

### Priority 2: Fix Path Resolution

**A. Enforce relative paths in agent instructions**
Add explicit instructions to all CLAUDE.md files:
```
IMPORTANT: Your working directory is already your group folder.
Use RELATIVE paths only: daily/file.md, NOT groups/research/daily/file.md
```

**B. Clean up nested directories**
Delete the rogue nested structures:
- `groups/research/groups/`
- `groups/research/research/`
- `groups/social/groups/`
- `groups/social/social/`
- `groups/social/growth/`

**C. Delete rogue script files**
- `groups/main/post-twitter.applescript`
- `groups/social/web-search-perplexity.applescript`

### Priority 3: Fix Broken Tasks

**A. Fix `task-content-daily-summary`**
The prompt is too vague. The agent wastes time reading file contents instead of just counting. Rewrite to be more explicit:
```
List files in drafts/ and published/. Count how many are in each.
Update calendar.md with: "YYYY-MM-DD: X pending, Y posted".
send_message(text: "CONTENT STATUS: X pending, Y posted today", priority: "digest").
Do NOT read file contents. Just count files.
```

**B. Fix `task-content-twitter-replies` approach**
Perplexity won't reliably return tweet URLs for engagement. Options:
1. Change the workflow to find founder TOPICS (not specific tweets) and draft original content inspired by trends
2. Use a dedicated Twitter scraping tool/API instead of web_search
3. Accept that reply drafting needs manual tweet URL input from the user

### Priority 4: Improve Agent Autonomy

**A. Reduce admin bottleneck**
The admin agent is the only one sending triggers (10 of 12 in last 24h). Research and social should trigger content DIRECTLY without admin mediation. The admin review task should focus on quality control and anomaly detection, not routine routing.

**B. Add self-healing behaviors**
Agents currently don't recover from errors — they describe the error and move on. Add instructions like:
```
If web_search fails, log the error and proceed with your most recent daily/ findings.
If a directory is missing, create it. Do NOT trigger another agent about it.
Never attempt to modify scripts or system files.
```

**C. Add task result validation**
Currently "100% success rate" means the agent didn't crash — not that it produced useful output. Add output validation: if the task result mentions "error", "failed", "not found", or "incomplete", mark it as a failure in the activity log.

**D. Cross-agent awareness**
Agents operate in isolation. Add a shared `status-board.md` in the global workspace that each agent updates after completing tasks. Other agents can read it to know what's already been found/drafted/posted, reducing duplicate effort.

### Priority 5: Operational Improvements

**A. Reduce task frequency while broken**
With web_search failing, 4 tasks run every 2-3 hours and produce nothing useful. Wasted compute and log pollution. Consider pausing tasks until dependencies are verified working.

**B. Clean up removed groups**
`groups/growth/`, `groups/ops/`, `groups/product/`, `groups/community/` still exist with files but have no active tasks. Either delete them or archive them.

**C. Add a smoke test on startup**
Before starting the scheduler, run a quick `web_search("test")` and verify the AppleScript returns content. Log a warning if it fails. This would have caught the 28-hour outage immediately.

---

## Task Schedule Summary

```
Every 2 hours:
  [research] task-research-scan      — web_search for ecosystem news
  [content]  task-content-review     — check inbox for content ideas

Every 3 hours:
  [social]   task-social-reddit-engagement — web_search for Reddit posts
  [social]   task-social-scan              — web_search for trending topics

Every 4 hours:
  [admin]    task-admin-review             — review activity, direct agents
  [content]  task-content-twitter-replies  — web_search for tweets to reply to

Daily 18:00 UTC:
  [content]  task-content-daily-summary    — count drafts vs published

Weekly Friday 14:00 UTC:
  [research] task-research-weekly          — compile weekly deep-dive report
```

---

## System Configuration

| Setting | Value |
|---------|-------|
| Model | `ollama/qwen3:8b` |
| Agent Timeout | 10 minutes |
| Max Concurrent Agents | 4 |
| Max Trigger Depth | 3 |
| Trigger Cooldown | 30 seconds |
| Max Triggers/Hour | 120 |
| Digest Interval | 2 hours |
| IMAP Poll | 10 seconds |
| Dashboard | `http://localhost:3700` |
