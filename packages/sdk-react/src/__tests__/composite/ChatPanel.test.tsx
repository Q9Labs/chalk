import { describe, it, expect, vi, beforeAll } from 'bun:test';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPanel } from '../../components/composite/ChatPanel';

describe('ChatPanel', () => {
  beforeAll(() => {
    // Mock scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  const messages = [
    { id: '1', senderId: 'u1', senderName: 'Alice', content: 'Hello', timestamp: new Date() },
    { id: '2', senderId: 'u2', senderName: 'Bob', content: 'Hi', timestamp: new Date(), isLocal: true },
  ];

  it('renders messages correctly', () => {
    const { getByText, getByLabelText } = render(<ChatPanel messages={messages} onSendMessage={() => {}} />);
    expect(getByLabelText('Avatar for Alice')).toBeDefined();
    expect(getByText('Hello')).toBeDefined();
    expect(getByText('Hi')).toBeDefined();
  });

  it('calls onSendMessage when send button is clicked', async () => {
    const onSendMessage = vi.fn();
    const { getByPlaceholderText, getByLabelText } = render(
      <ChatPanel messages={[]} onSendMessage={onSendMessage} />
    );
    const user = userEvent.setup();
    const textarea = getByPlaceholderText('Type a message...');

    await user.type(textarea, 'New message');
    await user.click(getByLabelText('Send message'));

    expect(onSendMessage).toHaveBeenCalledWith('New message');
  });

  it('displays empty state message', () => {
    const { getByText } = render(<ChatPanel messages={[]} onSendMessage={() => {}} />);
    expect(getByText('No messages yet')).toBeDefined();
  });
});
