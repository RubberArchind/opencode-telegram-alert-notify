import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

/**
 * OpenCode Telegram Alert/Notification Plugin
 *
 * Sends Telegram notifications for:
 *   - 🔐 Permission requests (file access, command execution, etc.)
 *   - 🚨 Session errors
 *   - ✅ Task completions
 *
 * ## Configuration
 *
 * Create a config JSON file in one of these locations (checked in order):
 *   1. `TELEGRAM_NOTIFY_CONFIG` environment variable (path to config)
 *   2. `~/.config/opencode/telegram-notify.json` (original location)
 *   3. `~/.config/opencode/config.json` (generic config; uses "telegram" key)
 *   4. Environment variables: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
 *
 * ### Config file format:
 * ```json
 * {
 *   "token": "6509228094:ABCdef...",
 *   "chatId": "1397773925",
 *   "silent": false,
 *   "threadId": null
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TelegramConfig {
  token: string
  chatId: string
  silent: boolean
  threadId?: number
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = "telegram-notify.json"

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ""
}

function getDefaultConfigDir(): string {
  return join(getHomeDir(), ".config", "opencode")
}

function loadConfigFromFile(filePath: string): TelegramConfig | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    if (!data.token || !data.chatId) return null
    return {
      token: String(data.token),
      chatId: String(data.chatId),
      silent: data.silent ?? false,
      threadId: data.threadId ?? undefined,
    }
  } catch {
    return null
  }
}

function getConfig(): TelegramConfig | null {
  // 1. Explicit config path from env var
  const envPath = process.env.TELEGRAM_NOTIFY_CONFIG
  if (envPath) {
    const cfg = loadConfigFromFile(envPath)
    if (cfg) return cfg
  }

  // 2. Original location: ~/.config/opencode/telegram-notify.json
  const originalPath = join(getDefaultConfigDir(), CONFIG_FILENAME)
  const cfg1 = loadConfigFromFile(originalPath)
  if (cfg1) return cfg1

  // 3. Generic config: ~/.config/opencode/config.json with "telegram" key
  const genericPath = join(getDefaultConfigDir(), "config.json")
  try {
    if (existsSync(genericPath)) {
      const raw = readFileSync(genericPath, "utf-8")
      const data = JSON.parse(raw)
      const tg = data.telegram
      if (tg?.token && tg?.chatId) {
        return {
          token: String(tg.token),
          chatId: String(tg.chatId),
          silent: tg.silent ?? false,
          threadId: tg.threadId ?? undefined,
        }
      }
    }
  } catch {
    // fall through
  }

  // 4. Environment variables
  const envToken = process.env.TELEGRAM_BOT_TOKEN
  const envChatId = process.env.TELEGRAM_CHAT_ID
  if (envToken && envChatId) {
    return {
      token: envToken,
      chatId: envChatId,
      silent: false,
      threadId: undefined,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function sendTelegramMessage(
  config: TelegramConfig,
  message: string,
): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${config.token}/sendMessage`
    const body: Record<string, unknown> = {
      chat_id: config.chatId,
      text: message,
      disable_notification: config.silent,
      parse_mode: "HTML",
    }
    if (config.threadId != null) {
      body.message_thread_id = config.threadId
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "unknown")
      console.error(`[telegram-notify] API error ${response.status}: ${text}`)
    }
    return response.ok
  } catch (err) {
    console.error("[telegram-notify] send failed:", err)
    return false
  }
}

function fire(config: TelegramConfig, message: string) {
  sendTelegramMessage(config, message).catch(() => {})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function truncate(text: string, maxLen = 2000): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + "..."
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const TelegramNotify: Plugin = async ({ project, client }) => {
  const config = getConfig()
  if (!config) {
    console.warn(
      "[telegram-notify] No config found. Plugin disabled. " +
        "Create ~/.config/opencode/telegram-notify.json with your bot token and chat ID.",
    )
    return {}
  }

  return {
    event: async ({ event }) => {
      const { type } = event

      // ── Permission requested ──────────────────────────────────────
      if (type === "permission.asked") {
        const props = (event as any).properties ?? {}
        const permType = props.type ?? props.permission ?? "unknown"
        const title = props.title ?? ""
        const pattern = props.pattern ?? ""
        const sessionID = props.sessionID ?? "unknown"
        const projectName = project?.name || project?.id || "Unknown"

        let details = ""
        if (title) details += `\n<b>Info:</b> ${escapeHtml(title)}`
        if (pattern) {
          details += `\n<b>Target:</b>\n<code>${escapeHtml(String(pattern))}</code>`
        }

        fire(
          config,
          truncate(
            `🔐 <b>Permission Requested</b>\n\n` +
              `<b>Project:</b> ${escapeHtml(projectName)}\n` +
              `<b>Type:</b> ${escapeHtml(permType)}` +
              `${details}\n\n` +
              `<b>Session:</b> ${escapeHtml(sessionID)}`,
          ),
        )
      }

      // ── Session error ─────────────────────────────────────────────
      if (type === "session.error") {
        const err = (event as any).properties?.error
        const msg = err instanceof Error ? err.message : String(err)
        const projectName = project?.name || project?.id || "Unknown"

        fire(
          config,
          truncate(
            `🚨 <b>Error</b>\n\n` +
              `<b>Project:</b> ${escapeHtml(projectName)}\n` +
              `<b>Error:</b> ${escapeHtml(msg)}`,
          ),
        )
      }

      // ── Session idle (task completed) ─────────────────────────────
      if (type === "session.idle") {
        let title = ""
        const sessionID = (event as any).properties?.sessionID
        if (sessionID) {
          try {
            const res = await client.session.get({ path: { id: sessionID } })
            const session = (res as any).data ?? res
            if (session?.title) title = session.title
          } catch {
            // fallback to project id
          }
        }
        if (!title) title = project?.id || "Unknown"

        fire(config, `✅ <b>Task Completed</b>\n\n<b>${escapeHtml(title)}</b>`)
      }
    },
  }
}

export default TelegramNotify
