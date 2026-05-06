export type MessageKind = 'text' | 'media' | 'deleted' | 'system' | 'announcement';
export type ParsedMessage = {
    date: string;
    time: string;
    datetime: string;
    timestamp: number;
    sequence_in_minute: number;
    sender_raw: string;
    sender_normalized: string;
    text: string;
    kind: MessageKind;
};
export type HeaderVariant = 'ios' | 'aos' | 'english-ios' | 'english-aos' | 'mac-csv' | 'unknown';
export interface ParseOptions {
    force?: boolean;
}
export type ParseResult = {
    room_name: string;
    kakao_original_name: string;
    exported_at: string;
    messages: ParsedMessage[];
    header_variant: HeaderVariant;
    header_raw: {
        line1: string;
        line2: string;
    };
    error?: string;
};
export type ParseError = {
    line: number;
    raw: string;
    reason: string;
};
