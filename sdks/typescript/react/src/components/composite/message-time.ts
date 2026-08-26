const messageTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "numeric",
  hour12: true,
});

export function formatMessageTime(value: string): string {
  return messageTimeFormatter.format(new Date(value));
}
