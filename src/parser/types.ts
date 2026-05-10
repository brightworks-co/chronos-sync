export type MessageKind = 'text' | 'media' | 'deleted' | 'system' | 'announcement'

export type ParsedMessage = {
  date: string
  time: string
  datetime: string
  timestamp: number
  sequence_in_minute: number
  sender_raw: string
  sender_normalized: string
  text: string
  kind: MessageKind
  /**
   * kakaocli's monotone-increasing row id (BigInt-safe stringified).
   * Populated when the CSV header is the v5 4-col variant
   * (`Date,User,Message,LogId`) or 6-col (`Date,User,Message,Seconds,LogId,ChatType`).
   * Zero-padded to LOGID_PAD_LENGTH chars so lexicographic ASC = numeric
   * ASC = utterance-time ASC. Powers chronos's v5 sort tuple.
   */
  log_id?: string
}

export type HeaderVariant = 'ios' | 'aos' | 'english-ios' | 'english-aos' | 'mac-csv' | 'unknown'

export interface ParseOptions {
  force?: boolean
}

export type ParseResult = {
  room_name: string
  kakao_original_name: string
  exported_at: string
  messages: ParsedMessage[]
  header_variant: HeaderVariant
  header_raw: { line1: string; line2: string }
  error?: string
}

export type ParseError = {
  line: number
  raw: string
  reason: string
}
