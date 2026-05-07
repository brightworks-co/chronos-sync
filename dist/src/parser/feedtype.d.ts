/**
 * KakaoTalk system event ("feedType") detection and placeholder rendering.
 *
 * `kakaocli messages --json` emits some non-user-message rows as raw JSON
 * payloads in the `text` field, e.g.
 *
 *   {"feedType":25,"logId":3835554415426912257,"hidden":true,"targetRevision":1}
 *   {"feedType":4,"members":[{"userId":6321186593654462422,"nickName":"드림솔져"}]}
 *
 * KakaoTalk macOS interprets these as system events (deletions, member
 * changes, voice/video call markers, etc.) and renders a localized
 * placeholder in the chat UI. chronos-sync used to forward the raw JSON
 * to the Chronos server unchanged, surfacing it as garbled text in the
 * web viewer. v0.2.9+ converts these payloads into Korean placeholders
 * so the server stores something a human can read.
 *
 * Mapping is observation-based (the feedType integers are not officially
 * documented). Unknown feedTypes fall through to a generic placeholder
 * so we never silently drop data.
 */
export interface FeedTypePayload {
    feedType: number;
    members?: Array<{
        userId?: number | string;
        nickName?: string;
    }>;
    hidden?: boolean;
    targetRevision?: number;
    logId?: number | string;
    [key: string]: unknown;
}
/**
 * Cheap pre-check for the feedType JSON shape. Avoids running JSON.parse
 * on every message body.
 */
export declare function isFeedTypeText(text: string): boolean;
/**
 * Parse a message text that *may* be a feedType payload. Returns the
 * parsed object on success, `null` if the text is not a feedType JSON
 * (or fails to parse, or has no integer `feedType` field).
 */
export declare function parseFeedTypeText(text: string): FeedTypePayload | null;
/**
 * Render a feedType payload into a human-readable Korean placeholder.
 *
 * The strings are chosen so that downstream `classifyMessage` (in
 * `parser/normalize.ts`) places them into a sensible `kind`:
 *   - feedType=25 → "삭제된 메시지" → kind='deleted' (DELETED_RE matches)
 *   - feedType=4 with members → "<nick>님이 들어왔습니다" → kind='announcement'
 *   - all others → "[시스템 이벤트:<N>]" → kind='system' (no keyword match)
 *
 * The fall-through generic shape is intentional: we never drop the row,
 * but we make it obvious in the viewer that the original payload was a
 * system event of an unknown kind. Once a new feedType code is observed
 * in the wild, add a case here.
 */
export declare function feedTypeToPlaceholder(payload: FeedTypePayload): string;
/**
 * One-shot helper: if `text` is a feedType payload, return the rendered
 * placeholder; otherwise return the original text unchanged.
 */
export declare function transformFeedTypeText(text: string): string;
