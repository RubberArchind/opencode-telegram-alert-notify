import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

/**
 * OpenCode Telegram Alert/Notification Plugin (V2 plugin API)
 *
 * Sends Telegram notifications for:
 *   - 🔐 Permission requests (file access, command execution, etc.)
 *   - 🚨 Session errors
 *   - ✅ Task completions
 *
 * This is a V2 plugin: the module default-exports a plain object with an `id`
 * and a `setup(ctx)` function. It does not import the OpenCode plugin SDK at
 * runtime (only Node's `fs`/`path`/`url` modules).
 *
 * ## Installation (OpenCode v2)
 *
 * Add this file to the `plugin` array in `~/.config/opencode/config.json`:
 *
 * ```json
 * {
 *   "plugin": ["/home/landen/opencode-telegram-alert-notify/src/index.ts"]
 * }
 * ```
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

type AnyRecord = Record<string, any>

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
// V2 context helpers
//
// Event payloads and context shapes are read defensively: V2 uses
// `event.type` plus either `event.properties` or flat fields, and the session
// lookup methods are probed at runtime with `typeof` guards so a shape change
// can never throw out of the event loop.
// ---------------------------------------------------------------------------

function eventProps(event: unknown): AnyRecord {
  const e = (event ?? {}) as AnyRecord
  const props = e.properties
  if (props && typeof props === "object") return props as AnyRecord
  return e
}

function projectName(ctx: unknown): string {
  const location = (ctx as AnyRecord | undefined)?.location
  const project = location?.project
  const name = project?.canonical || project?.id
  return typeof name === "string" && name ? name : "Unknown"
}

function eventSessionID(props: AnyRecord): string | undefined {
  const id =
    props.sessionID ??
    props.sessionId ??
    props.session?.id ??
    props.info?.sessionID ??
    props.info?.id
  return typeof id === "string" && id ? id : undefined
}

/**
 * Try `ctx.session.get` / `ctx.session.context` (whichever exists) to resolve a
 * session title. Every call is guarded and wrapped in try/catch; failures fall
 * through to the next candidate shape and finally return `null`.
 */
async function getSessionTitle(
  ctx: unknown,
  sessionID: string | undefined,
): Promise<string | null> {
  if (!sessionID) return null
  const session = (ctx as AnyRecord | undefined)?.session
  if (!session || typeof session !== "object") return null

  const methods = ["get", "context", "info"] as const
  const args: AnyRecord[] = [
    { id: sessionID },
    { sessionID },
    { path: { id: sessionID } },
  ]

  for (const method of methods) {
    const fn = (session as AnyRecord)[method]
    if (typeof fn !== "function") continue

    for (const arg of args) {
      try {
        const res = await fn.call(session, arg)
        if (res == null) continue
        const data = (res as AnyRecord).data ?? res
        const title =
          data?.title ??
          data?.session?.title ??
          data?.info?.title ??
          data?.data?.title
        if (typeof title === "string" && title) return title
        // Call succeeded but carried no title: stop probing further shapes.
        return null
      } catch {
        // Wrong argument shape or unsupported method; try the next candidate.
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function handleEvent(
  ctx: unknown,
  config: TelegramConfig,
  event: unknown,
): Promise<void> {
  const raw = (event ?? {}) as AnyRecord
  const type = raw.type
  if (typeof type !== "string") return

  const props = eventProps(event)
  const flat = props === raw

  // ── Permission requested ──────────────────────────────────────
  if (type === "permission.asked") {
    const permission =
      props.permission && typeof props.permission === "object"
        ? (props.permission as AnyRecord)
        : undefined

    const permType =
      permission?.type ??
      props.permissionType ??
      (flat ? undefined : props.type) ??
      "unknown"
    const title = props.title ?? permission?.title ?? props.info ?? ""
    const pattern = props.pattern ?? permission?.pattern ?? props.patterns?.[0] ?? ""
    const sessionID = eventSessionID(props) ?? "unknown"

    let details = ""
    if (title) details += `\n<b>Info:</b> ${escapeHtml(String(title))}`
    if (pattern) {
      details += `\n<b>Target:</b>\n<code>${escapeHtml(String(pattern))}</code>`
    }

    fire(
      config,
      truncate(
        `🔐 <b>Permission Requested</b>\n\n` +
          `<b>Project:</b> ${escapeHtml(projectName(ctx))}\n` +
          `<b>Type:</b> ${escapeHtml(String(permType))}` +
          `${details}\n\n` +
          `<b>Session:</b> ${escapeHtml(String(sessionID))}`,
      ),
    )
    return
  }

  // ── Session error ─────────────────────────────────────────────
  if (type === "session.error") {
    const err = props.error ?? raw.error

    let msg: string
    if (err instanceof Error) {
      msg = err.message
    } else if (typeof err === "string") {
      msg = err
    } else if (err && typeof err === "object" && typeof (err as AnyRecord).message === "string") {
      msg = (err as AnyRecord).message
    } else if (err == null) {
      msg = typeof props.message === "string" ? props.message : "Unknown error"
    } else {
      msg = String(err)
    }

    fire(
      config,
      truncate(
        `🚨 <b>Error</b>\n\n` +
          `<b>Project:</b> ${escapeHtml(projectName(ctx))}\n` +
          `<b>Error:</b> ${escapeHtml(msg)}`,
      ),
    )
    return
  }

  // ── Session idle (task completed) ─────────────────────────────
  if (type === "session.idle") {
    const title =
      (await getSessionTitle(ctx, eventSessionID(props))) ?? projectName(ctx)

    fire(config, `✅ <b>Task Completed</b>\n\n<b>${escapeHtml(title)}</b>`)
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point (V2: plain default-exported object)
// ---------------------------------------------------------------------------

export default {
  id: "telegram-notify",
  setup(ctx: any) {
    const config = getConfig()
    if (!config) {
      console.warn(
        "[telegram-notify] No config found. Plugin disabled. " +
          "Create ~/.config/opencode/telegram-notify.json with your bot token and chat ID.",
      )
      return () => {}
    }

    const controller = new AbortController()

    void (async () => {
      const events = ctx?.event
      if (!events || typeof events.subscribe !== "function") {
        console.warn(
          "[telegram-notify] ctx.event.subscribe is unavailable. Plugin disabled.",
        )
        return
      }

      try {
        const stream = events.subscribe({ signal: controller.signal })
        for await (const event of stream) {
          if (controller.signal.aborted) break
          try {
            await handleEvent(ctx, config, event)
          } catch (err) {
            // Never let a handler failure end the subscription loop.
            console.error("[telegram-notify] handler failed:", err)
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("[telegram-notify] event subscription ended:", err)
        }
      }
    })()

    return () => controller.abort()
  },
}
