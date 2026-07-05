export function useChat() {
  return {
    messages: [],
    isEnabled: false,
    count: 0,
    unreadCount: 0,
    sendMessage: (_content: string) => {},
    sendMessageWithAttachments: async (_content: string, _files: File[]) => {},
    reactToMessage: (_messageId: string, _emoji: string) => {},
    markAsRead: () => {},
    markAsHidden: () => {},
    getMessage: (_id: string) => undefined,
    getAttachmentDownloadUrl: async (_attachmentId: string) => "",
  };
}
