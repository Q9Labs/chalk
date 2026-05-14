export type Meeting = {
  id: string;
  room_id: string;
  room_name: string | null;
  status: "ready" | "processing" | "error";
  duration_seconds: number | null;
  size_bytes: number | null;
  created_at: string;
  transcript_status?: "pending" | "processing" | "completed" | "failed" | null;
  transcript_error_message?: string | null;
  transcript_summary: string | null;
  transcript_action_items: string[] | null;
};

export type MeetingsResponse = {
  meetings: Meeting[];
};
