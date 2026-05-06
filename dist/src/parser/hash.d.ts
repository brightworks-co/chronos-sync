type MessageIdInput = {
    project_id: string;
    room_name: string;
    datetime: string;
    sequence_in_minute: number;
    text: string;
};
type ContentHashInput = {
    datetime: string;
    room_name: string;
    text: string;
};
export declare function messageId(input: MessageIdInput): Promise<string>;
export declare function contentHash(input: ContentHashInput): Promise<string>;
export {};
